// src/routes/admin/translation.js
require('dotenv').config();
const express = require('express');
const router  = express.Router();
const db      = require('../../db');
const OpenAI  = require('openai');

/** ───────────────────────────────────────────────────────────────
 *  Konfiguration
 *  ───────────────────────────────────────────────────────────── */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const LOG_ENABLED = process.env.TRANSLATION_LOGS !== '0';

/** ───────────────────────────────────────────────────────────────
 *  Logging
 *  ───────────────────────────────────────────────────────────── */
function logStep(step, data) {
  if (!LOG_ENABLED) return;
  const ts = new Date().toISOString();
  if (data !== undefined) {
    console.log(`[TRANSLATION] ${ts} ${step}:`, data);
  } else {
    console.log(`[TRANSLATION] ${ts} ${step}`);
  }
}

/** ───────────────────────────────────────────────────────────────
 *  Admin-Guard: nur eingeloggte Admins (role === 9)
 *  ───────────────────────────────────────────────────────────── */
router.use((req, res, next) => {
  if (!req.session?.userId) return res.redirect('/admin/login');
  if (req.session.role !== 9) return res.status(403).send('Nur für Admins');
  next();
});

/** ───────────────────────────────────────────────────────────────
 *  Helpers
 *  ───────────────────────────────────────────────────────────── */
function getTargetLangs() {
  return (process.env.TRANSLATION_TARGET_LANGS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Titelspalte je Tabelle bestimmen (name|title; Fallback name)
function resolveTitleColumn(columns) {
  const lc = new Set(columns.map(c => c.toLowerCase()));
  if (lc.has('name'))  return 'name';
  if (lc.has('title')) return 'title';
  return 'name';
}

/** Sprache erkennen (ISO 639-1) */
async function detectLanguage({ title, description }) {
  const text = [title||'', description||''].join('\n').slice(0, 6000);

  const resp = await aiClient.responses.create({
    model: AI_MODEL,
    input: [
      { role: 'system', content: 'Return only JSON {"lang":"xx"} where xx is ISO 639-1.' },
      { role: 'user', content: text || ' ' }
    ],
    // NEW: Responses API erwartet das hier
    text: { format: 'json' }
  });

  try {
    const obj = JSON.parse(resp.output_text || '{}');
    return (obj.lang || '').toLowerCase().slice(0,2) || 'auto';
  } catch {
    return 'auto';
  }
}

/** Übersetzen (sourceLang='auto' → Modell erkennt selbst) */
async function translateFields({ title, description, sourceLang, targetLang }) {
  const system = `Du bist ein professioneller Übersetzer.
- Wenn sourceLang="auto", erkenne die Quellsprache.
- Übersetze präzise von ${sourceLang || 'auto'} nach ${targetLang}.
- Stil & Bedeutung für Inserate beibehalten.
- Antworte NUR als JSON: {"title":"...","description":"..."}.`;

  const user = `sourceLang: ${sourceLang || 'auto'}
TITLE: ${title || ''}
DESCRIPTION: ${description || ''}
targetLang: ${targetLang}`;

  const resp = await aiClient.responses.create({
    model: AI_MODEL,
    input: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ],
    // NEW: Responses API erwartet das hier
    text: { format: 'json' }
  });

  let data = {};
  try { data = JSON.parse(resp.output_text || '{}'); } catch {}
  return {
    title:       data.title ?? title ?? '',
    description: data.description ?? description ?? ''
  };
}


/** ───────────────────────────────────────────────────────────────
 *  Route: Freischalten & Übersetzen
 *  POST /admin/translation/:category/:id/approve-translate
 *  ───────────────────────────────────────────────────────────── */
router.post('/:category/:id/approve-translate', async (req, res) => {
  const { category, id } = req.params;
  logStep('START approve-translate', { category, id });

  const targetLangs = getTargetLangs();
  logStep('Target languages', targetLangs);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Entität laden
    const [[ent]] = await conn.query(
      'SELECT id, route, table_name FROM ententies WHERE route = ? LIMIT 1',
      [category]
    );
    if (!ent) {
      logStep('ERROR: Entität nicht gefunden', category);
      await conn.rollback();
      req.flash('error', 'Ungültige Kategorie');
      return res.redirect(req.get('referer') || '/admin/listings');
    }
    logStep('Entity', ent);

    // 2) Spalten + Titelspalte bestimmen
    const [schema] = await conn.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?`,
      [ent.table_name]
    );
    const cols     = schema.map(r => r.COLUMN_NAME);
    const titleCol = resolveTitleColumn(cols);
    const hasDesc    = cols.includes('description');
    const hasStatus  = cols.includes('status');
    const hasVisible = cols.includes('visible');
    const hasSource  = cols.includes('source_lang');
    logStep('Table columns', cols);

    // 3) Inserat laden
    const [[row]] = await conn.query(
      `SELECT id,
              \`${titleCol}\` AS title,
              ${hasDesc ? 'description' : 'NULL AS description'}
              ${hasSource ? ', source_lang' : ''}
         FROM \`${ent.table_name}\`
        WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!row) {
      logStep('ERROR: Inserat nicht gefunden', id);
      await conn.rollback();
      req.flash('error', 'Inserat nicht gefunden');
      return res.redirect(req.get('referer') || '/admin/listings');
    }
    logStep('Original row', {
      id: row.id,
      title: row.title,
      hasDesc: !!row.description,
      source_lang: row.source_lang
    });

    // 4) Quellsprache ermitteln/speichern
    let sourceLang = (hasSource && row.source_lang) ? row.source_lang : null;
    if (!sourceLang) {
      sourceLang = await detectLanguage({ title: row.title, description: row.description });
      logStep('Detected sourceLang', sourceLang);
      if (hasSource && sourceLang && sourceLang !== 'auto') {
        await conn.query(
          `UPDATE \`${ent.table_name}\` SET source_lang = ? WHERE id = ?`,
          [sourceLang, id]
        );
        logStep('Persisted source_lang', { id, sourceLang });
      }
    } else {
      logStep('Using stored source_lang', sourceLang);
    }

    // 5) Freischalten (status=3, visible=1 – falls Spalten existieren)
    if (hasStatus || hasVisible) {
      const sets = [];
      const vals = [];
      if (hasStatus)  { sets.push('`status` = ?');  vals.push(3); }
      if (hasVisible) { sets.push('`visible` = ?'); vals.push(1); }
      vals.push(id);
      await conn.query(
        `UPDATE \`${ent.table_name}\` SET ${sets.join(', ')} WHERE id = ?`,
        vals
      );
      logStep('Approved listing', { id, sets });
    }

    // 6) Übersetzen & Upsert je Zielsprache
    for (const lang of targetLangs) {
      if (!lang) continue;
      if (sourceLang && lang === sourceLang) {
        logStep('Skip same language', { sourceLang, lang });
        continue;
      }

      logStep(`Translating ${sourceLang || 'auto'} -> ${lang}`, {
        sampleTitle: (row.title || '').slice(0, 80)
      });

      const { title, description } = await translateFields({
        title: row.title,
        description: row.description,
        sourceLang: sourceLang || 'auto',
        targetLang: lang
      });

      logStep(`Result ${lang}`, {
        titlePreview: (title || '').slice(0, 80),
        descPreview:  (description || '').slice(0, 80)
      });

      await conn.query(
        `INSERT INTO listing_translations
           (entitie_id, advert_id, language, title, description)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           description = VALUES(description),
           updated_at = CURRENT_TIMESTAMP`,
        [ent.id, id, lang, title, description]
      );
    }

    await conn.commit();
    logStep('SUCCESS approve-translate', { id, category, sourceLang });
    req.flash('success', `#${id} freigeschaltet. Quelle: ${sourceLang || 'auto'}. Übersetzungen erstellt.`);
    return res.redirect(req.get('referer') || '/admin/listings');

  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[TRANSLATION ERROR][approve-translate]', e);
    req.flash('error', 'Fehler beim Freischalten/Übersetzen.');
    return res.redirect(req.get('referer') || '/admin/listings');
  } finally {
    conn.release();
  }
});

/** ───────────────────────────────────────────────────────────────
 *  Route: Nur neu übersetzen (ohne Statusänderung)
 *  POST /admin/translation/:category/:id/retranslate
 *  ───────────────────────────────────────────────────────────── */
router.post('/:category/:id/retranslate', async (req, res) => {
  const { category, id } = req.params;
  const targetLangs = getTargetLangs();

  logStep('START retranslate', { category, id });
  logStep('Target languages', targetLangs);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Entität
    const [[ent]] = await conn.query(
      'SELECT id, route, table_name FROM ententies WHERE route = ? LIMIT 1',
      [category]
    );
    if (!ent) {
      logStep('ERROR: Ungültige Kategorie', category);
      await conn.rollback();
      req.flash('error', 'Ungültige Kategorie');
      return res.redirect(req.get('referer') || '/admin/listings');
    }
    logStep('Entity', ent);

    // 2) Spalten + Titelspalte
    const [schema] = await conn.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?`,
      [ent.table_name]
    );
    const cols     = schema.map(r => r.COLUMN_NAME);
    const titleCol = resolveTitleColumn(cols);
    const hasDesc   = cols.includes('description');
    const hasSource = cols.includes('source_lang');
    logStep('Table columns', cols);

    // 3) Inserat
    const [[row]] = await conn.query(
      `SELECT id,
              \`${titleCol}\` AS title,
              ${hasDesc ? 'description' : 'NULL AS description'}
              ${hasSource ? ', source_lang' : ''}
         FROM \`${ent.table_name}\`
        WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!row) {
      logStep('ERROR: Inserat nicht gefunden', id);
      await conn.rollback();
      req.flash('error', 'Inserat nicht gefunden');
      return res.redirect(req.get('referer') || '/admin/listings');
    }
    logStep('Original row', {
      id: row.id,
      title: row.title,
      hasDesc: !!row.description,
      source_lang: row.source_lang
    });

    // 4) Quelle ermitteln/speichern
    let sourceLang = (hasSource && row.source_lang) ? row.source_lang : null;
    if (!sourceLang) {
      sourceLang = await detectLanguage({ title: row.title, description: row.description });
      logStep('Detected sourceLang', sourceLang);
      if (hasSource && sourceLang && sourceLang !== 'auto') {
        await conn.query(
          `UPDATE \`${ent.table_name}\` SET source_lang = ? WHERE id = ?`,
          [sourceLang, id]
        );
        logStep('Persisted source_lang', { id, sourceLang });
      }
    } else {
      logStep('Using stored source_lang', sourceLang);
    }

    // 5) Übersetzen & Upsert
    for (const lang of targetLangs) {
      if (!lang) continue;
      if (sourceLang && lang === sourceLang) {
        logStep('Skip same language', { sourceLang, lang });
        continue;
      }

      logStep(`Translating ${sourceLang || 'auto'} -> ${lang}`, {
        sampleTitle: (row.title || '').slice(0, 80)
      });

      const { title, description } = await translateFields({
        title: row.title,
        description: row.description,
        sourceLang: sourceLang || 'auto',
        targetLang: lang
      });

      logStep(`Result ${lang}`, {
        titlePreview: (title || '').slice(0, 80),
        descPreview:  (description || '').slice(0, 80)
      });

      await conn.query(
        `INSERT INTO listing_translations
           (entitie_id, advert_id, language, title, description)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           description = VALUES(description),
           updated_at = CURRENT_TIMESTAMP`,
        [ent.id, id, lang, title, description]
      );
    }

    await conn.commit();
    logStep('SUCCESS retranslate', { id, category, sourceLang });
    req.flash('success', `Übersetzungen für #${id} neu erzeugt (Quelle: ${sourceLang || 'auto'}).`);
    return res.redirect(req.get('referer') || '/admin/listings');

  } catch (e) {
    try { await conn.rollback(); } catch {}
    console.error('[TRANSLATION ERROR][retranslate]', e);
    req.flash('error', 'Fehler beim Neuübersetzen.');
    return res.redirect(req.get('referer') || '/admin/listings');
  } finally {
    conn.release();
  }
});

/** ───────────────────────────────────────────────────────────────
 *  (Optional) Healthcheck: prüft OpenAI-Zugriff
 *  GET /admin/translation/health
 *  ───────────────────────────────────────────────────────────── */
router.get('/health', async (req, res) => {
  logStep('HEALTH: ping OpenAI');
  try {
    const ping = await client.responses.create({
      model: MODEL,
      input: [{ role: 'user', content: 'Return JSON {"ok":true}' }],
      response_format: { type: 'json_object' }
    });
    logStep('HEALTH OK', ping.output_text);
    res.json({ ok: true });
  } catch (e) {
    console.error('[TRANSLATION ERROR][health]', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

module.exports = router;

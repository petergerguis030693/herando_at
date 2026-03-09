// src/routes/admin/listings.js
const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { pick } = require('lodash');
const db      = require('../../db'); 
const { serialize } = require('php-serialize');
const { unserialize } = require('php-unserialize');

const fs    = require('fs');
const path  = require('path');

// Multer: temporäre Speicherung im Arbeitsspeicher
const upload = multer({ storage: multer.memoryStorage() });
// === Übersetzungs-Helfer (oben in listings.js ergänzen) ===
const OpenAI  = require('openai');
const aiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano'; // oder dein Modell

const TLOG = (process.env.TRANSLATION_LOGS !== '0');
const MAX_TRANSLATION_INPUT_CHARS = (() => {
  const n = parseInt(process.env.TRANSLATION_INPUT_MAX_CHARS || '12000', 10);
  return Number.isInteger(n) && n > 0 ? n : 12000;
})();
const MAX_TRANSLATION_TITLE_INPUT_CHARS = (() => {
  const n = parseInt(process.env.TRANSLATION_TITLE_INPUT_MAX_CHARS || '600', 10);
  return Number.isInteger(n) && n > 0 ? n : 600;
})();
const TRANSLATION_DESC_CHUNK_CHARS = (() => {
  const n = parseInt(process.env.TRANSLATION_DESC_CHUNK_CHARS || '1800', 10);
  return Number.isInteger(n) && n >= 400 ? n : 1800;
})();
const MAX_TRANSLATION_OUTPUT_TOKENS = (() => {
  const n = parseInt(process.env.TRANSLATION_MAX_OUTPUT_TOKENS || '8000', 10);
  return Number.isInteger(n) && n >= 256 ? n : 8000;
})();
const MIN_TRANSLATION_SPLIT_CHARS = 220;
const MAX_TRANSLATION_SPLIT_DEPTH = (() => {
  const n = parseInt(process.env.TRANSLATION_MAX_SPLIT_DEPTH || '4', 10);
  return Number.isInteger(n) && n >= 1 ? n : 4;
})();
const AI_ERROR_PREVIEW_CHARS = 500;

function tlog(...args){ if (TLOG) console.log('[BULK-TRANSLATE]', ...args); }

function clipText(value, max = MAX_TRANSLATION_INPUT_CHARS) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function compactForLog(value, max = AI_ERROR_PREVIEW_CHARS) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function logAiParseError(scope, err, raw) {
  console.error(`[AI ${scope}] JSON parse error: ${err.message}`, {
    rawLength: String(raw ?? '').length,
    preview: compactForLog(raw)
  });
}

function extractFirstJsonObject(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function parseJsonObjectLoose(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    const candidate = extractFirstJsonObject(text);
    if (!candidate || candidate === text) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

function splitTextByLimit(text, limit) {
  const value = String(text ?? '');
  if (!value) return [];
  if (value.length <= limit) return [value];

  const chunks = [];
  let start = 0;

  while (start < value.length) {
    let end = Math.min(start + limit, value.length);
    if (end < value.length) {
      const window = value.slice(start, end);
      const breakpoints = [
        window.lastIndexOf('\n'),
        window.lastIndexOf(' '),
        window.lastIndexOf('>'),
        window.lastIndexOf('.')
      ];
      const splitAt = Math.max(...breakpoints);
      if (splitAt >= Math.floor(limit * 0.6)) end = start + splitAt + 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }

  return chunks.filter(Boolean);
}

function splitTextInHalf(text) {
  const value = String(text ?? '');
  if (value.length <= 1) return [value, ''];

  const mid = Math.floor(value.length / 2);
  let splitAt = mid;
  const right = value.slice(mid);

  const rightBreak = right.search(/[\s\n>]/);
  if (rightBreak >= 0) {
    splitAt = mid + rightBreak + 1;
  } else {
    const left = value.slice(0, mid);
    const leftBreak = Math.max(left.lastIndexOf('\n'), left.lastIndexOf(' '), left.lastIndexOf('>'));
    if (leftBreak > 0) splitAt = leftBreak + 1;
  }

  if (splitAt <= 0 || splitAt >= value.length) splitAt = mid;
  return [value.slice(0, splitAt), value.slice(splitAt)];
}

function estimateCompletionTokens(textLength) {
  const chars = Number(textLength) || 0;
  const inputEstimate = Math.ceil(chars / 3);
  const estimate = (inputEstimate * 3) + 512;
  return Math.min(MAX_TRANSLATION_OUTPUT_TOKENS, Math.max(900, estimate));
}

async function translateChunkJson({ text, sourceLang, targetLang, fieldLabel }) {
  const payload = {
    sourceLang: sourceLang || 'auto',
    targetLang,
    text: String(text ?? '')
  };
  const system = `Du bist ein professioneller Übersetzer für Inserate.
- Wenn sourceLang="auto", erkenne die Quellsprache.
- Übersetze präzise und vollständig nach ${targetLang}.
- Bewahre HTML-Tags, Zeilenumbrüche, Zahlen und Sonderzeichen exakt.
- Antworte NUR als JSON: {"text":"..."}.`;

  const resp = await aiClient.chat.completions.create({
    model: AI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) }
    ],
    temperature: 0,
    max_completion_tokens: estimateCompletionTokens(payload.text.length),
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'translated_chunk',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string' }
          }
        }
      }
    }
  });

  const out = resp.choices?.[0]?.message?.content || '{}';
  const finishReason = resp.choices?.[0]?.finish_reason;
  if (finishReason === 'length') {
    const err = new Error(`token limit reached (${fieldLabel})`);
    err.code = 'TRUNCATED';
    err.raw = out;
    throw err;
  }

  const data = parseJsonObjectLoose(out);
  if (!data || typeof data !== 'object' || typeof data.text !== 'string') {
    const err = new Error(`invalid JSON object (${fieldLabel})`);
    err.code = 'INVALID_JSON';
    err.raw = out;
    throw err;
  }

  return data.text;
}

async function translateTextRobust({ text, sourceLang, targetLang, fieldLabel, depth = 0 }) {
  const value = String(text ?? '');
  if (!value) return '';
  if (depth > MAX_TRANSLATION_SPLIT_DEPTH) {
    console.warn('[AI translateFields] Max split depth reached, keep original chunk', { field: fieldLabel, depth });
    return value;
  }

  const isTopLevelDescription = depth === 0 && fieldLabel === 'description';
  const parts = (isTopLevelDescription && value.length > TRANSLATION_DESC_CHUNK_CHARS)
    ? splitTextByLimit(value, TRANSLATION_DESC_CHUNK_CHARS)
    : [value];

  const translatedParts = [];

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const label = parts.length > 1 ? `${fieldLabel}#${i + 1}/${parts.length}` : fieldLabel;

    try {
      translatedParts.push(await translateChunkJson({
        text: part,
        sourceLang,
        targetLang,
        fieldLabel: label
      }));
      continue;
    } catch (err) {
      if (err.code === 'TRUNCATED') {
        console.warn('[AI translateFields] Response truncated by token limit', { field: label });
      } else if (err.code === 'INVALID_JSON') {
        logAiParseError('translateFields', err, err.raw);
      } else {
        console.error('[AI translateFields] chunk request failed', { field: label, message: err.message });
      }

      if (
        (err.code === 'TRUNCATED' || err.code === 'INVALID_JSON')
        && part.length > MIN_TRANSLATION_SPLIT_CHARS
        && depth < MAX_TRANSLATION_SPLIT_DEPTH
      ) {
        const [left, right] = splitTextInHalf(part);
        const leftTranslated = await translateTextRobust({
          text: left,
          sourceLang,
          targetLang,
          fieldLabel: `${label}.a`,
          depth: depth + 1
        });
        const rightTranslated = await translateTextRobust({
          text: right,
          sourceLang,
          targetLang,
          fieldLabel: `${label}.b`,
          depth: depth + 1
        });
        translatedParts.push(leftTranslated + rightTranslated);
        continue;
      }

      if (err.code === 'TRUNCATED' || err.code === 'INVALID_JSON') {
        console.warn('[AI translateFields] Keep original chunk after split fallback', { field: label });
        translatedParts.push(part);
        continue;
      }

      throw err;
    }
  }

  return translatedParts.join('');
}

function getTargetLangs() {
  return (process.env.TRANSLATION_TARGET_LANGS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function resolveTitleColumn(columns) {
  const lc = new Set(columns.map(c => c.toLowerCase()));
  if (lc.has('name'))  return 'name';
  if (lc.has('title')) return 'title';
  return 'name';
}

async function detectLanguage({ title, description }) {
  const text = [title || '', description || ''].join('\n').slice(0, 6000);

  const attempts = [
    {
      label: 'json_schema',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'detected_language',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['lang'],
            properties: {
              lang: { type: 'string' }
            }
          }
        }
      }
    },
    {
      label: 'json_object',
      response_format: { type: 'json_object' }
    }
  ];

  for (const attempt of attempts) {
    try {
      const resp = await aiClient.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'Return only JSON {"lang":"xx"} where xx is ISO 639-1.' },
          { role: 'user', content: text || ' ' }
        ],
        response_format: attempt.response_format
      });

      const out = resp.choices?.[0]?.message?.content || '{}';
      const obj = parseJsonObjectLoose(out);
      if (!obj || typeof obj !== 'object') {
        logAiParseError('detectLanguage', new Error(`invalid JSON object (${attempt.label})`), out);
        continue;
      }
      return (String(obj.lang || '')).toLowerCase().slice(0, 2) || 'auto';
    } catch (err) {
      console.error(`[AI detectLanguage] request failed (${attempt.label}):`, err.message);
    }
  }

  return 'auto';
}

// Übersetzt title/description robust und akzeptiert nur gültiges JSON.
async function translateFields({ title, description, sourceLang, targetLang }) {
  const originalTitle = String(title ?? '');
  const originalDescription = String(description ?? '');
  const clippedTitle = clipText(originalTitle, MAX_TRANSLATION_TITLE_INPUT_CHARS);
  const clippedDescription = clipText(originalDescription);

  let translatedTitle = originalTitle;
  let translatedDescription = originalDescription;

  try {
    translatedTitle = await translateTextRobust({
      text: clippedTitle,
      sourceLang: sourceLang || 'auto',
      targetLang,
      fieldLabel: 'title'
    });
  } catch (err) {
    console.error('[AI translateFields] title translation failed:', err.message);
    translatedTitle = originalTitle;
  }

  try {
    translatedDescription = await translateTextRobust({
      text: clippedDescription,
      sourceLang: sourceLang || 'auto',
      targetLang,
      fieldLabel: 'description'
    });
  } catch (err) {
    console.error('[AI translateFields] description translation failed:', err.message);
    translatedDescription = originalDescription;
  }

  return { title: translatedTitle, description: translatedDescription };
}

// Middleware: Lade dynamische Entieties
async function loadEntities(req, res, next) {
  try {
    const [rows] = await db.query(
      `SELECT id, name, route, table_name FROM ententies`
    );
    res.locals.entieties = rows;
    next();
  } catch (err) {
    next(err);
  }
}

// Lade alle Pakete aus der DB (Tabelle `packages`)
async function loadPackages(req, res, next) {
  try {
    const [pkgs] = await db.query(
      `SELECT id, name AS label, duration_unit, duration_amt, featured 
         FROM packages 
        ORDER BY sort_order`
    );
    res.locals.packages = pkgs.map(p => ({
      id:       p.id,
      label:    p.label,
      duration: { unit: p.duration_unit, amount: p.duration_amt },
      featured: !!p.featured
    }));
    next();
  } catch (err) {
    next(err);
  }
}

// Helper: eine ID übersetzen + Originalsprache/Originaltext persistieren
async function translateOne({ id, table, ent }) {
  try {
    const targetLangs = [...new Set(
      getTargetLangs()
        .map((lang) => String(lang || '').trim().toLowerCase())
        .filter(Boolean)
    )];
    if (!targetLangs.length) {
      console.warn('[TRANSLATE] target langs leer'); 
      // wir übersetzen zwar nicht, aber Originalsprache können wir trotzdem speichern:
      // (der Block unten läuft trotzdem)
    }

    // Schema ermitteln
    const [schema] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    const cols     = schema.map(r => r.COLUMN_NAME);
    const titleCol = resolveTitleColumn(cols);
    const hasDesc  = cols.includes('description');
    const hasSrc   = cols.includes('source_lang');

    // Originaldaten laden
    const [[row]] = await db.query(
      `SELECT id,
              \`${titleCol}\` AS title,
              ${hasDesc ? 'description' : 'NULL AS description'}
              ${hasSrc ? ', source_lang' : ''}
       FROM \`${table}\` WHERE id=?`,
      [id]
    );
    if (!row) { console.warn('[TRANSLATE] keine row für id', id); return; }

    // Quellsprache bestimmen/setzen
    let source = (hasSrc && row.source_lang) ? row.source_lang : null;
    if (!source) {
      source = await detectLanguage({ title: row.title, description: row.description });
      source = (source || '').toLowerCase().slice(0,2) || 'auto';
      console.log('[TRANSLATE] detected', { id, source });
      if (hasSrc && source && source !== 'auto') {
        await db.query(`UPDATE \`${table}\` SET source_lang=? WHERE id=?`, [source, id]);
      }
    }

    const originalTitle = row.title || '';
    const originalDesc  = row.description || '';
    const sourceLc = String(source || '').toLowerCase();

    const [existingRows] = await db.query(
      `SELECT language, title, description
         FROM listing_translations
        WHERE entitie_id = ? AND advert_id = ?`,
      [ent.id, id]
    );
    const existingByLang = new Map(
      existingRows.map((r) => [String(r.language || '').toLowerCase(), r])
    );
    const sourceSnapshot = (sourceLc && sourceLc !== 'auto') ? existingByLang.get(sourceLc) : null;
    const sourceUnchanged = !!sourceSnapshot
      && String(sourceSnapshot.title ?? '') === originalTitle
      && String(sourceSnapshot.description ?? '') === originalDesc;

    let pendingTargetLangs = targetLangs.filter((lang) => !sourceLc || lang !== sourceLc);
    if (sourceUnchanged) {
      pendingTargetLangs = pendingTargetLangs.filter((lang) => !existingByLang.has(lang));
      if (!pendingTargetLangs.length) {
        console.log('[TRANSLATE] skip unchanged source + all target languages already present', { id, source: sourceLc });
        return;
      }
      console.log('[TRANSLATE] unchanged source, translate only missing target languages', {
        id,
        source: sourceLc,
        missing: pendingTargetLangs
      });
    }

    // (A) IMMER: Originalsprache + Originaltext in listing_translations sichern
    if (source && source !== 'auto') {
      if (!sourceUnchanged) {
        await db.query(
          `INSERT INTO listing_translations
             (entitie_id, advert_id, language, title, description)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             title=VALUES(title),
             description=VALUES(description),
             updated_at=CURRENT_TIMESTAMP`,
          [ent.id, id, source, originalTitle, originalDesc]
        );
        console.log('[TRANSLATE] saved ORIGINAL', { id, source, titlePreview: originalTitle.slice(0,60) });
      } else {
        console.log('[TRANSLATE] ORIGINAL unchanged', { id, source });
      }
    } else {
      // Fallback: wenn "auto", Original nicht einsortieren – dann nur Zielsprachen
      console.warn('[TRANSLATE] source=auto – Original nicht als Sprache gespeichert');
    }

    // (B) Zielsprachen übersetzen & speichern
    for (const lang of pendingTargetLangs) {
      if (!lang) continue;
      if (source && lang.toLowerCase() === source.toLowerCase()) {
        console.log('[TRANSLATE] skip same', { id, lang });
        continue;
      }

      const { title, description } = await translateFields({
        title: originalTitle,
        description: originalDesc,
        sourceLang: source || 'auto',
        targetLang: lang
      });

      await db.query(
        `INSERT INTO listing_translations
           (entitie_id, advert_id, language, title, description)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title=VALUES(title),
           description=VALUES(description),
           updated_at=CURRENT_TIMESTAMP`,
        [ent.id, id, lang, title, description]
      );

      console.log('[TRANSLATE] saved', { id, lang, titlePreview: (title||'').slice(0,60) });
    }
  } catch (err) {
    console.error('[TRANSLATE] Fehler bei ID', id, err);
  }
}


// === BULK ===
router.post('/:category/bulk', loadEntities, async (req, res, next) => {
  try {
    console.log('––> [BULK] Route getroffen');
    const { category } = req.params;

    const ent = res.locals.entieties.find(e => e.route === category);
    if (!ent) {
      console.warn('[BULK] Entität nicht gefunden für category=', category);
      return res.redirect(`/admin/listings?state=${req.body.state || ''}`);
    }
    const table = ent.table_name;

    // IDs einsammeln & normalisieren
    let rawIds = req.body.ids ?? req.body['ids[]'] ?? [];
    if (!Array.isArray(rawIds)) rawIds = [rawIds];
    const cleanIds = rawIds
      .map(i => parseInt(String(i ?? '').trim(), 10))
      .filter(i => Number.isInteger(i) && i > 0);
    console.log('[BULK] IDs erkannt:', cleanIds);

    // Action normalisieren
    let action = Array.isArray(req.body.action) ? req.body.action[0] : req.body.action;
    action = (action || '').toString().toLowerCase();
    console.log('[BULK] action =', action);

    if (!cleanIds.length || !action) {
      console.warn('[BULK] Abbruch: fehlende IDs oder Action');
      return res.redirect(`/admin/listings/${category}?state=${req.body.state || ''}`);
    }

    const map = {
      approve: { status: 3, visible: 1 },
      pend:    { status: 7, visible: 0 },
      reject:  { status: 8, keepVisible: true },
      stop:    { status: 3, visible: 0 },
      delete:  { status: 9, visible: 0 },
      restore: { status: 1, visible: 0 }
    };
    const m = map[action];
    if (!m) {
      console.warn('[BULK] Unbekannte Action:', action);
      return res.redirect(`/admin/listings/${category}?state=${req.body.state || ''}`);
    }

    // Sofort UPDATE
    const placeholders = cleanIds.map(() => '?').join(',');
    if (m.keepVisible) {
      await db.query(
        `UPDATE \`${table}\` SET status=? WHERE id IN (${placeholders})`,
        [m.status, ...cleanIds]
      );
    } else {
      await db.query(
        `UPDATE \`${table}\` SET status=?, visible=? WHERE id IN (${placeholders})`,
        [m.status, m.visible, ...cleanIds]
      );
    }
    console.log('[BULK] Update OK', { count: cleanIds.length, action });

    // Sofort Redirect
    const qs = new URLSearchParams({
      category,
      state: req.body.state || ''
    });
    if (req.body.search)   qs.set('search', req.body.search);
    if (req.body.adType)   qs.set('adType', req.body.adType);
    if (req.body.priceMin) qs.set('priceMin', req.body.priceMin);
    if (req.body.priceMax) qs.set('priceMax', req.body.priceMax);
    if (req.body.sort)     qs.set('sort', req.body.sort);
    res.redirect(`/admin/listings?${qs.toString()}`);

    // Hintergrund-Übersetzung
    const shouldTranslate = action === 'approve' || String(req.body.translate || '') === '1';
    if (shouldTranslate && process.env.OPENAI_API_KEY) {
      const entCopy   = { ...ent };
      const tableCopy = table;
      const idsCopy   = [...cleanIds];

      setImmediate(async () => {
        console.log('✅ [BULK] BACKGROUND TRANSLATE START', { ids: idsCopy });
        for (const id of idsCopy) {
          try {
            await translateOne({ id, table: tableCopy, ent: entCopy });
            console.log(`✅ [BULK] Übersetzt ID=${id}`);
          } catch (e) {
            console.error('[BULK] Fehler bei Übersetzung ID', id, e.message);
          }
        }
        console.log('✅ [BULK] BACKGROUND TRANSLATE DONE');
      });
    }
  } catch (err) {
    console.error('❌ Fehler in Bulk-Route:', err);
    next(err);
  }
});

// === SINGLE ===
router.post('/:category/:id/action', loadEntities, async (req, res, next) => {
  try {
    console.log('––> [SINGLE] Route getroffen');
    const { category, id } = req.params;
    let action = (req.body.action || '').toLowerCase();
    console.log('[SINGLE] action =', action, 'ID =', id);

    const ent = res.locals.entieties.find(e => e.route === category);
    if (!ent) {
      console.warn('[SINGLE] Entität nicht gefunden:', category);
      return res.redirect('/admin/listings');
    }
    const table = ent.table_name;

    const map = {
      approve: { status: 3, visible: 1 },
      pend:    { status: 7, visible: 0 },
      reject:  { status: 8, keepVisible: true },
      stop:    { status: 3, visible: 0 },
      delete:  { status: 9, visible: 0 },
      restore: { status: 1, visible: 0 }
    };
    const m = map[action];
    if (!m) {
      console.warn('[SINGLE] Unbekannte Action:', action);
      return res.redirect(`/admin/listings?category=${category}`);
    }

    // Update sofort
    if (m.keepVisible) {
      await db.query(
        `UPDATE \`${table}\` SET status=? WHERE id=?`,
        [m.status, id]
      );
    } else {
      await db.query(
        `UPDATE \`${table}\` SET status=?, visible=? WHERE id=?`,
        [m.status, m.visible, id]
      );
    }
    console.log('[SINGLE] Update OK:', { id, action });

    // Redirect sofort
    const qs = new URLSearchParams({
      category,
      state: req.body.state || ''
    });
    if (req.body.search)   qs.set('search', req.body.search);
    if (req.body.adType)   qs.set('adType', req.body.adType);
    if (req.body.priceMin) qs.set('priceMin', req.body.priceMin);
    if (req.body.priceMax) qs.set('priceMax', req.body.priceMax);
    if (req.body.sort)     qs.set('sort', req.body.sort);
    res.redirect(`/admin/listings?${qs.toString()}`);

    // Übersetzung im Hintergrund
    if (action === 'approve' && process.env.OPENAI_API_KEY) {
      const entCopy   = { ...ent };
      const tableCopy = table;
      const idNum     = parseInt(id, 10);
      setImmediate(async () => {
        try {
          console.log('✅ [SINGLE] BACKGROUND TRANSLATE START', { id: idNum });
          await translateOne({ id: idNum, table: tableCopy, ent: entCopy });
          console.log('✅ [SINGLE] BACKGROUND TRANSLATE DONE', { id: idNum });
        } catch (e) {
          console.error('[SINGLE] Background translate failed', e);
        }
      });
    }
  } catch (err) {
    console.error('❌ Fehler in Single-Action-Route:', err);
    next(err);
  }
});

// === TRANSLATE MANUELL ===
router.post('/:category/:id/translate', loadEntities, async (req, res, next) => {
  try {
    console.log('––> [TRANSLATE] Route getroffen');
    const { category, id } = req.params;

    const ent = res.locals.entieties.find(e => e.route === category);
    if (!ent) {
      console.warn('[TRANSLATE] Entität nicht gefunden:', category);
      return res.status(404).json({ ok: false, message: 'Entität nicht gefunden' });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error('[TRANSLATE] OPENAI_API_KEY fehlt – Übersetzung übersprungen.');
      return res.status(204).end();
    }

    const table = ent.table_name;
    await translateOne({ id: parseInt(id, 10), table, ent });
    console.log(`[TRANSLATE] Erfolgreich für ID=${id}`);

    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('❌ Fehler in Translate-Route:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});


router.post('/:category/:id/setDate', loadEntities, async (req, res, next) => {
  try {
    const { category, id } = req.params;
    const ent = res.locals.entieties.find(e => e.route === category);
    if (!ent) {
    return res.redirect(`/admin/listings?category=cars&state=toapprove`);
    }
    const table = ent.table_name;

    const newPub = req.body.published;
    if (!newPub) {
    return res.redirect(`/admin/listings?category=cars&state=toapprove`);
    }

    await db.query( 
      `UPDATE \`${table}\` 
          SET published = ?
        WHERE id = ?`,
      [ newPub, id ]
    );

    return res.redirect(`/admin/listings?category=cars&state=toapprove`);
  } catch (err) {
    next(err);
  }
});

function resolveAdvertSource(adType){
  switch ((adType || '').toLowerCase()) {

    case 'inserat':
      return { table: 'advert_inserat', fk: 'advert_id' };

    case 'catalog':
      return { table: 'catalog_ads', fk: 'advert_id' };

    case 'slider':
      return { table: 'slider_ads', fk: 'advert_id' };

    case 'katalog_slider':
      return { table: 'katalog_slider', fk: 'advert_id' };

    default:
      return null;
  }
}

router.get('/:category/:id/ad-period', loadEntities, async (req, res) => {
  const { category, id } = req.params;
  const { adType } = req.query;

  console.log('[AD-PERIOD][GET]', { category, id, adType });

  const ent = res.locals.entieties.find(e => e.route === category);
  if (!ent) return res.json({});

  const src = resolveAdvertSource(adType);
  if (!src) return res.json({});

  const [[row]] = await db.query(`
    SELECT
      DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
      DATE_FORMAT(end_date, '%Y-%m-%d')   AS end_date
    FROM ${src.table}
    WHERE entitie_id = ? AND ${src.fk} = ?
    ORDER BY id DESC
    LIMIT 1
  `, [ent.id, id]);

  console.log('[AD-PERIOD][GET] FOUND:', row);

  res.json({
    from: row?.start_date || null,
    to: row?.end_date || null
  });
});

router.post('/:category/:id/ad-period', loadEntities, async (req, res) => {
  const { category, id } = req.params;
  const { from, to, adType } = req.body;

  console.log('[AD-PERIOD][POST]', { category, id, from, to, adType });

  const ent = res.locals.entieties.find(e => e.route === category);
  if (!ent) return res.json({ ok:false });

  const src = resolveAdvertSource(adType);
  if (!src) return res.json({ ok:false });

  const [[exists]] = await db.query(`
    SELECT id FROM ${src.table}
    WHERE entitie_id = ? AND ${src.fk} = ?
    LIMIT 1
  `, [ent.id, id]);

  if (exists) {
    console.log('UPDATE');
    await db.query(`
      UPDATE ${src.table}
      SET start_date = ?, end_date = ?
      WHERE entitie_id = ? AND ${src.fk} = ?
    `, [from, to, ent.id, id]);
  } else {
    console.log('INSERT');
    await db.query(`
      INSERT INTO ${src.table}
      (entitie_id, ${src.fk}, start_date, end_date)
      VALUES (?, ?, ?, ?)
    `, [ent.id, id, from, to]);
  }

  res.json({ ok:true });
});



const booleanFields = [
  'abs','esp','asr','airbags','isofix','xenon','bixenon','led','laser',
  'foglamp','daytime_lights','adaptive_lights','glare_free',
  'highbeam_assistant','headlight_washer','immobilizer','electric_windows',
  'electric_adjusted_seats','electric_heated_seats','ventilated_seats',
  'electric_mirrors','electric_tailgate','assisted_steering','light_sensor',
  'cruise_control','adaptive_cruise_control','collision_avoidance',
  'blind_spot_monitor','lane_departure_warning','aux_heating','central_locking',
  'keyless_central_locking','rain_sensor','head_up_display','climatisation',
  'parking_front','parking_rear','parking_camera','parking_self','tuner_radio',
  'radio_dab','mp3interface','navigation','tv','soundsystem','touchscreen',
  'voice_control','usb','apple_car_play','android_auto','wifi_hotspot',
  'music_streaming','inductive_charging','digital_cockpit',
  'multifunction_steeringwheel','cdplayer','bluetooth','onboard_computer',
  'handsfree_kit','alloy_wheels','sports_suspension','sports_package',
  'sports_seats','trailer_coupling','sunroof','panoramic_roof','roof_rack',
  'skibag','disabled_accessible','taxi','summer_tires','winter_tires',
  'all_season_tires','tire_pressure_monitoring','winter_package',
  'smokers_package','air_suspension','startstop_system','rental','hill_climb',
  'fatigue','dimming_mirror','nightvision','emergency_call','traffic_signs',
  'speed_limiter','distance_warning','heated_windshield',
  'heated_steering_wheel','arm_rest','lumbar_support','massage_seats',
  'fold_flat_passenger_seat','ambient_lighting','leather_steering_wheel',
  'checkbook','accident_free','non_smoking'
];

// Welche Felder pro Route erlaubt sind
const allowedFieldsByRoute = {
 cars: [
    'country_id','city','brand_id','model_id','model','cartype','mileage',
    'gearbox','fuel','consumption_city','consumption_country','consumption_combined',
    'emission_co2','emission_class','pollution_class','environmental_badge',
    'color','metallic','interior','interior_color','drive','engine',
    'capacity','power','horsepower','drivetrain',
    // alle Boolean-Flags
    'abs','esp','asr','airbags','isofix','xenon','bixenon','led','laser',
    'foglamp','daytime_lights','adaptive_lights','glare_free',
    'highbeam_assistant','headlight_washer','immobilizer','electric_windows',
    'electric_adjusted_seats','electric_heated_seats','ventilated_seats',
    'electric_mirrors','electric_tailgate','assisted_steering','light_sensor',
    'cruise_control','adaptive_cruise_control','collision_avoidance',
    'blind_spot_monitor','lane_departure_warning','aux_heating','central_locking',
    'keyless_central_locking','rain_sensor','head_up_display','climatisation',
    'parking_front','parking_rear','parking_camera','parking_self','tuner_radio',
    'radio_dab','mp3interface','navigation','tv','soundsystem','touchscreen',
    'voice_control','usb','apple_car_play','android_auto','wifi_hotspot',
    'music_streaming','inductive_charging','digital_cockpit',
    'multifunction_steeringwheel','cdplayer','bluetooth','onboard_computer',
    'handsfree_kit','alloy_wheels','sports_suspension','sports_package',
    'sports_seats','trailer_coupling','sunroof','panoramic_roof','roof_rack',
    'skibag','disabled_accessible','taxi','summer_tires','winter_tires',
    'all_season_tires','tire_pressure_monitoring','winter_package',
    'smokers_package','air_suspension','startstop_system','rental','hill_climb',
    'fatigue','dimming_mirror','nightvision','emergency_call','traffic_signs',
    'speed_limiter','distance_warning','heated_windshield',
    'heated_steering_wheel','arm_rest','lumbar_support','massage_seats',
    'fold_flat_passenger_seat','ambient_lighting','leather_steering_wheel',
    'shape','used','name','base_price','price','currency','vat','taxrate',
    'checkbook','accident_free','non_smoking','firstregistration',
    'firstregistration_month','maininspection','maininspection_month',
    'year','description','video'
  ],
  yachts: [
    'country_id','city',
    'brand_id','model','category','yachttype','hull',
    'length','beam','displacement','draft','crew',
    'engine','engines','power','horsepower','engine_hours',
    'cruising_speed','cruising_speed_kn','max_speed','max_speed_kn',
    'fuel','fuel_tankage','water_tankage',
    'naval_architect','interior_designer',
    'shape','used','name','base_price','price','currency','vat',
    'year','splashdown',
    'berths',
    'description','video'
  ],

  properties: [
    'country_id','city',
    'propertytype','investmenttype',
    'heating','energysource','energypass','energypass_type','energypass_value',
    'landarea','livingarea','floors','bedrooms','bathrooms',
    'quality','propertyshape','monument_protection','stage',
    'name','base_price','price','currency','vat','year',
    'description','video'
  ],
watches: [
    // Allgemeine Angaben
    'brand_id','model_id','model','reference','adnumber','name',
    'price','currency','vat','taxrate','year','shape','used',
    // Technische Daten
    'watchtype','gender','case_material','strap_material','strap_color',
    'dial_color','dial_shape','dial_numbers','movement','movement_caliber',
    'caliber','power_reserve','jewels_number','frequency','crystal',
    'diameter','height','clasp_type','clasp_material','bezel_material','waterproof',
    // Echtheit
    'authenticity_papers','authenticity_box','authenticity_warranty',
    // Funktionen
    'function_alarm','function_chronograph','function_date','function_day',
    'function_month','function_year','function_4year','function_perpetual_calendar',
    'function_gmt','function_timeequation','function_minuterepeater','function_repetition',
    'function_jumping_hour','function_double_chronograph','function_panorama',
    'function_calendar','function_moonphase','function_smallseconds',
    'function_tachymeter','function_centralseconds','function_flyback','function_striking_mechanism',
    // Features
    'feature_heliumvalve','feature_tourbillon','feature_diamondsbezel',
    'feature_chronometer','feature_master_chronometer','feature_rotatingbezel',
    'feature_powerreserve','feature_luminescenthands','feature_pocketwatch',
    'feature_luminescentnumerals','feature_luminous_indexes','feature_waterresistant',
    'feature_screwedcrone','feature_screwed_pushers','feature_crown_left',
    'feature_skeletonized','feature_guilloched','feature_hand_guilloched',
    'feature_gemsetting','feature_geneva_seal','feature_limited_edition',
    'feature_quickset_mechanism','feature_original','feature_pvd','feature_solar',
    'feature_display_back','feature_bluedsteel_hands','feature_worldtime_clock',
    'feature_smartwatch','feature_onehand_watch',
    // Beschreibung & Standort
    'description','video','country_id','state_id','city'
  ], 
  lifestyles: [
      'brand_id','model_id','used','name','base_price','price','currency','vat',
      'year','description','video'
  ]
};



// Human-readable Labels
const labelMap = {
  // ─── Gemeinsame Felder ─────────────────────────────────────────
  brand_id:    'Marke',
  model_id:    'Modell',
  model:       'Modell (frei)',
  name:        'Titel',
  city:        'Ort',
  country_id:  'Land',
  price:       'Preis',
  base_price:  'Listenpreis',
  currency:    'Währung',
  vat:         'inkl. MwSt.',
  description: 'Beschreibung',
  video:       'Video-URL',
  year:        'Baujahr',

  // ─── Cars ───────────────────────────────────────────────────────
  cartype:             'Karosserie',
  mileage:             'Kilometerstand',
  gearbox:             'Getriebe',
  fuel:                'Treibstoff',
  consumption_city:    'Verbrauch Stadt (l/100 km)',
  consumption_country: 'Verbrauch Land (l/100 km)',
  consumption_combined:'Verbrauch kombiniert (l/100 km)',
  emission_co2:        'CO₂-Emission (g/km)',
  emission_class:      'Emissionsklasse',
  pollution_class:     'Abgasnorm',
  environmental_badge: 'Umweltplakette',
  color:               'Farbe',
  metallic:            'Metallic-Lack',
  interior:            'Innenausstattung',
  interior_color:      'Innenfarbe',
  drive:               'Antrieb',
  engine:              'Zylinderanzahl',
  capacity:            'Hubraum (ccm)',
  power:               'Leistung (kW)',
  horsepower:          'Leistung (PS)',
  drivetrain:          'Antriebsart',
  // Boolean-Flags (jeweils Ja/Nein)
  abs:                   'ABS',
  esp:                   'ESP',
  asr:                   'ASR',
  airbags:               'Airbags',
  isofix:                'Isofix',
  xenon:                 'Xenon-Licht',
  bixenon:               'Bi-Xenon-Licht',
  led:                   'LED-Scheinwerfer',
  laser:                 'Laserlicht',
  foglamp:               'Nebelscheinwerfer',
  daytime_lights:        'Tagfahrlicht',
  adaptive_lights:       'Adaptive Scheinwerfer',
  glare_free:            'Blendfreies Licht',
  highbeam_assistant:    'Fernlichtassistent',
  headlight_washer:      'Scheinwerfer-Reinigung',
  immobilizer:           'Diebstahlschutz',
  electric_windows:      'Elektr. Fensterheber',
  electric_adjusted_seats:'Elektr. Sitzeinstellung',
  electric_heated_seats: 'Elektr. Sitzheizung',
  ventilated_seats:      'Belüftete Sitze',
  electric_mirrors:      'Elektr. Spiegel',
  electric_tailgate:     'Elektr. Heckklappe',
  assisted_steering:     'Servolenkung',
  light_sensor:          'Lichtsensor',
  cruise_control:        'Tempomat',
  adaptive_cruise_control:'Abstandsregel-Tempomat',
  collision_avoidance:   'Kollisionswarnung',
  blind_spot_monitor:    'Totwinkelwarnung',
  lane_departure_warning:'Spurhalteassistent',
  aux_heating:           'Zusatzheizung',
  central_locking:       'Zentralverriegelung',
  keyless_central_locking:'Keyless Entry',
  rain_sensor:           'Regensensor',
  head_up_display:       'Head-Up-Display',
  climatisation:         'Klimaanlage',
  parking_front:         'Parksensor vorne',
  parking_rear:          'Parksensor hinten',
  parking_camera:        'Rückfahrkamera',
  parking_self:          'Einparkhilfe automatisch',
  tuner_radio:           'UKW-Radio',
  radio_dab:             'DAB+',
  mp3interface:          'MP3-Schnittstelle',
  navigation:            'Navigationssystem',
  tv:                    'TV',
  soundsystem:           'Soundsystem',
  touchscreen:           'Touchscreen',
  voice_control:         'Sprachsteuerung',
  usb:                   'USB-Anschluss',
  apple_car_play:        'Apple CarPlay',
  android_auto:          'Android Auto',
  wifi_hotspot:          'WLAN-Hotspot',
  music_streaming:       'Musik-Streaming',
  inductive_charging:    'Induktives Laden',
  digital_cockpit:       'Digitales Cockpit',
  multifunction_steeringwheel:'Multifunktionslenkrad',
  cdplayer:              'CD-Player',
  bluetooth:             'Bluetooth',
  onboard_computer:      'On-board Computer',
  handsfree_kit:         'Freisprecheinrichtung',
  alloy_wheels:          'Leichtmetallfelgen',
  sports_suspension:     'Sportfahrwerk',
  sports_package:        'Sportpaket',
  sports_seats:          'Sportsitze',
  trailer_coupling:      'Anhängerkupplung',
  sunroof:               'Schiebedach',
  panoramic_roof:        'Panoramadach',
  roof_rack:             'Dachgepäckträger',
  skibag:                'Skitaschenhalter',
  disabled_accessible:   'Rollstuhlgerecht',
  taxi:                  'Taxi-Ausstattung',
  summer_tires:          'Sommerreifen',
  winter_tires:          'Winterreifen',
  all_season_tires:      'Ganzjahresreifen',
  tire_pressure_monitoring:'Reifendruckkontrolle',
  winter_package:        'Winterpaket',
  smokers_package:       'Nichtraucher-Paket',
  air_suspension:        'Luftfederung',
  startstop_system:      'Start-Stopp-Automatik',
  rental:                'Vermietfähig',
  hill_climb:            'Berganfahrhilfe',
  fatigue:               'Müdigkeitserkennung',
  dimming_mirror:        'Abblendender Spiegel',
  nightvision:           'Nachtsichtassistent',
  emergency_call:        'Notruffunktion',
  traffic_signs:         'Verkehrsschilderkennung',
  speed_limiter:         'Geschwindigkeitsbegrenzer',
  distance_warning:      'Abstandswarnung',
  heated_windshield:     'Heizbare Frontscheibe',
  heated_steering_wheel: 'Beheiztes Lenkrad',
  arm_rest:              'Armlehne',
  lumbar_support:        'Lendenwirbelstütze',
  massage_seats:         'Massagesitze',
  fold_flat_passenger_seat:'Umklappbarer Beifahrersitz',
  ambient_lighting:      'Ambientebeleuchtung',
  leather_steering_wheel:'Lederlenkrad',
  shape:                 'Zustand',
  used:                  'Gebraucht/New',
  checkbook:             'Scheckheft gepflegt',
  accident_free:         'Unfallfrei',
  non_smoking:           'Nichtraucherfahrzeug',
  firstregistration:     'EZ Jahr',
  firstregistration_month:'EZ Monat',
  maininspection:        'TÜV Jahr',
  maininspection_month:  'TÜV Monat',

  // ─── Properties ─────────────────────────────────────────────────
  propertytype:    'Immobilientyp',
  investmenttype:  'Investmenttyp',
  heating:         'Heizung',
  energysource:    'Energiequelle',
  energypass:      'Energypass vorhanden',
  energypass_type: 'Pass-Typ',
  energypass_value:'Pass-Wert',
  landarea:        'Grundstück (m²)',
  livingarea:      'Wohnfläche (m²)',
  floors:          'Etagen',
  bedrooms:        'Schlafzimmer',
  bathrooms:       'Badezimmer',
  quality:         'Qualität',
  propertyshape:   'Zustand',
  monument_protection:'Denkmalschutz',
  stage:           'Bauphase',

  // ─── Yachts ───────────────────────────────────────────────────────
  category:         'Kategorie',
  yachttype:        'Yachttyp',
  hull:             'Rumpfmaterial',
  beam:             'Breite (m)',
  length:           'Länge (m)',
  engine:           'Motor',
  berths:           'Kojen',
  displacement:     'Verdrängung (t)',
  draft:            'Tiefgang (m)',
  engines:          'Anzahl Motoren',
  power:            'Leistung (kW)',
  horsepower:       'Leistung (PS)',
  engine_hours:     'Motorstunden',
  cruising_speed:   'Reisegeschwindigkeit (kn)',
  cruising_speed_kn:'Reisegeschwindigkeit (kn)',
  max_speed:        'Höchstgeschwindigkeit (kn)',
  max_speed_kn:     'Höchstgeschwindigkeit (kn)',
  fuel_tankage:     'Tankvol.',  
  water_tankage:    'Wassertank',
  naval_architect:  'Schiffarchitekt',
  interior_designer:'Innenarchitekt',
  crew:             'Crewplätze',

  // ─── Watches ─────────────────────────────────────────────────────
  watchtype:                 'Uhrentyp',
  gender:                    'Geschlecht',
  case_material:             'Gehäusematerial',
  strap_material:            'Armbandmaterial',
  strap_color:               'Armbandfarbe',
  dial_color:                'Zifferblattfarbe',
  dial_shape:                'Zifferblattform',
  dial_numbers:              'Zifferblattnummern',
  movement:                  'Werktyp',
  movement_caliber:          'Kaliber',
  caliber:                   'Kaliber (frei)',
  power_reserve:             'Gangreserve (h)',
  jewels_number:             'Anzahl Steine',
  frequency:                 'Frequenz (Hz)',
  crystal:                   'Glas',
  diameter:                  'Durchmesser (mm)',
  height:                    'Höhe (mm)',
  clasp_type:                'Schließe',
  clasp_material:            'Schließenmaterial',
  bezel_material:            'Lünettenmaterial',
  waterproof:                'Wasserdichtigkeit',
  authenticity_papers:       'Echtheitszertifikat',
  authenticity_box:          'Originalbox',
  authenticity_warranty:     'Garantie',
  function_alarm:            'Alarmfunktion',
  function_chronograph:      'Chronograph',
  function_date:             'Datumsfunktion',
  function_day:              'Tagesanzeige',
  function_month:            'Monatsanzeige',
  function_year:             'Jahresanzeige',
  function_4year:            'Schaltjahresanzeige',
  function_perpetual_calendar:'Ewiger Kalender',
  function_gmt:              'GMT',
  function_timeequation:     'Zeitunterschied',
  function_minuterepeater:   'Minutenrepetition',
  function_repetition:       'Repetition',
  function_jumping_hour:     'Springende Stunde',
  function_double_chronograph:'Rattrapante',
  function_panorama:         'Panorama-Anzeige',
  function_calendar:         'Kalenderfunktion',
  function_moonphase:        'Mondphase',
  function_smallseconds:     'Kleine Sekunde',
  function_tachymeter:       'Tachymeter',
  function_centralseconds:   'Zentrale Sekunde',
  function_flyback:          'Flyback',
  function_striking_mechanism:'Schlagwerk',
  // Features
  feature_heliumvalve:       'Heliumventil',
  feature_tourbillon:        'Tourbillon',
  feature_diamondsbezel:     'Diamant-Lünette',
  feature_chronometer:       'Chronometer',
  feature_master_chronometer:'Master Chronometer',
  feature_rotatingbezel:     'Drehbare Lünette',
  feature_powerreserve:      'Gangreserve-Anzeige',
  feature_luminescenthands:  'Leuchtzeiger',
  feature_pocketwatch:       'Taschenuhr',
  feature_luminescentnumerals:'Leuchtziffern',
  feature_luminous_indexes:  'Leuchtindizes',
  feature_waterresistant:    'Wasserfest',
  feature_screwedcrone:      'Verschraubte Krone',
  feature_screwed_pushers:   'Verschraubte Drücker',
  feature_crown_left:        'Krone links',
  feature_skeletonized:      'Skelettiert',
  feature_guilloched:        'Guillochierung',
  feature_hand_guilloched:   'Handguillochierung',
  feature_gemsetting:        'Edelsteinbesatz',
  feature_geneva_seal:       'Genfer Siegel',
  feature_limited_edition:   'Limitierte Edition',
  feature_quickset_mechanism:'Schnelleinstellung',
  feature_original:          'Original',
  feature_pvd:               'PVD-Beschichtung',
  feature_solar:             'Solarbetrieb',
  feature_display_back:      'Sichtboden',
  feature_bluedsteel_hands:  'Blaustahlzeiger',
  feature_worldtime_clock:   'Weltzeituhr',
  feature_smartwatch:        'Smartwatch',
  feature_onehand_watch:     'Einzeigeruhr',
  reference:                 'Referenz',
  adnumber:                  'Anzeigen-Nr.'
};

const lifestyleCategories = [
  { id: 4105, label: 'Accessoires' },
  { id: 4111, label: 'Events' },
  { id: 4113, label: 'Feinkost / Weine / Spirituosen' },
  { id: 4107, label: 'Gesundheit' },
  { id: 4110, label: 'Hotels & Resorts' },
  { id: 4115, label: 'Inneneinrichtungen' },
  { id: 4114, label: 'Wohnmobile und Freizeitfahrzeuge' },
  { id: 4109, label: 'Vermietung' },
  { id: 4106, label: 'Dienstleistungen' },
  { id: 4112, label: 'Reisen' },
  { id: 4108, label: 'Wellness & Spa' }
];

const lifestyleSubcategories = {
  4105: [ // Accessoires
    { id: 6426, label: 'Kunst' },
    { id: 6419, label: 'Bekleidung und Schuhe' },
    { id: 6425, label: 'Kosmetik und Parfüm' },
    { id: 6424, label: 'Dekoration' },
    { id: 6421, label: 'Elektronik - Elektro Geräte' },
    { id: 6422, label: 'Fun- und Sportgeräte' },
    { id: 6420, label: 'Brillen' },
    { id: 6423, label: 'Handtaschen' },
    { id: 6427, label: 'Schmuck und Juwelen' },
    { id: 6428, label: 'Sonstige' }
  ],
  4107: [ // Gesundheit
    { id: 6438, label: 'Zahnmedizin' },
    { id: 6433, label: 'Detox Clinics' },
    { id: 6434, label: 'Gesundheitszentren' },
    { id: 6435, label: 'Health Tech' },
    { id: 6437, label: 'Hotels' },
    { id: 6436, label: 'Longevity Clinics' }
  ],
  4109: [ // Vermietung
    { id: 6430, label: 'Flugzeuge' },
    { id: 6429, label: 'Boote / Yachten' },
    { id: 6431, label: 'Autos' },
    { id: 6432, label: 'Wohnmobile und Freizeitfahrzeuge' }
  ],
  4112: [ // Reisen
    { id: 6418, label: 'Aktivsport' }
  ]
};

// Middleware: entieties + packages laden
async function loadEntities(req, res, next) {
  const [rows] = await db.query(`SELECT id,name,route,table_name FROM ententies`);
  res.locals.entieties = rows;
  next();
}
async function loadPackages(req, res, next) {
  const [pkgs] = await db.query(`SELECT id,name AS label,duration_unit,duration_amt,featured FROM packages ORDER BY sort_order`);
  res.locals.packages = pkgs.map(p => ({
    id: p.id,
    label: p.label,
    duration: { unit: p.duration_unit, amount: p.duration_amt },
    featured: !!p.featured
  }));
  next();
}

// GET /admin/users/:userId/new-listing
router.get(
  '/users/:userId/new-listing',
  loadEntities,
  loadPackages,
  async (req, res, next) => {
    try {
      const { userId } = req.params;

      // Session-Draft speziell für diesen User
      if (!req.session.newListing) req.session.newListing = {};
      const data = req.session.newListing;
      data.userId = parseInt(userId, 10);

      const step = parseInt(req.query.step, 10) || 1;

      // 1) Alle Entitäten laden (aus Middleware)
      const allEntieties = res.locals.entieties;

      // 2) Nur Entitäten holen, die dieser User tatsächlich hat
      const [userListings] = await db.query(`
        SELECT 'cars' AS table_name FROM cars WHERE user_id = ?
        UNION
        SELECT 'properties' FROM properties WHERE user_id = ?
        UNION
        SELECT 'watches' FROM watches WHERE user_id = ?
        UNION
        SELECT 'yachts' FROM yachts WHERE user_id = ?
        UNION
        SELECT 'lifestyles' FROM lifestyles WHERE user_id = ?
      `, [userId, userId, userId, userId, userId]);

      const entieties = allEntieties.filter(e =>
        userListings.some(l => l.table_name === e.table_name)
      );

      // 3) Falls noch keine Entität ausgewählt ist, automatisch erste setzen
      if (!data.entId && entieties.length > 0) {
        data.entId = entieties[0].id;
      }

      // 4) Entity bestimmen
if (!data.entId || !entieties.some(e => e.id === data.entId)) {
  data.entId = entieties.length > 0 ? entieties[0].id : null;
}

const entity = data.entId
  ? entieties.find(e => e.id === data.entId)
  : null;


      // 5) Länder laden
      const [countries] = await db.query(
        `SELECT id, en AS label FROM countries ORDER BY en`
      );

      // 6) Marken & Modelle laden (falls relevant)
      let brands = [], models = [];
      if (entity) {
        const routeTypeMap = { properties: 1, watches: 2, cars: 3, yachts: 4, lifestyles: 5 };
        [brands] = await db.query(
          `SELECT id, name FROM brands WHERE type = ? ORDER BY name`,
          [routeTypeMap[entity.route]]
        );
      }
      if (data.brand_id) {
        [models] = await db.query(
          `SELECT id, name FROM models WHERE brand_id = ? ORDER BY name`,
          [data.brand_id]
        );
      }

      // 7) Dynamische Attribute vorbereiten
      let attrs = [];
      if (entity) {
        const table = entity.table_name;
        const allowed = allowedFieldsByRoute[entity.route] || [];

        attrs = await Promise.all(allowed.map(async col => {
          const attr = { column_name: col, label: labelMap[col] || col, field_type: 'text', options: [] };

          const [optRows] = await db.query(
            `SELECT option_value AS id, option_label AS label
               FROM attribute_options
              WHERE entitie_route = ? AND column_name = ?
              ORDER BY sort_order`,
            [entity.route, col]
          );
          if (optRows.length) {
            attr.field_type = 'select';
            attr.options = optRows;
            return attr;
          }

          const [[colDef]] = await db.query(
            `SELECT DATA_TYPE, COLUMN_TYPE
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
            [table, col]
          );
          if (colDef && colDef.DATA_TYPE === 'tinyint' && colDef.COLUMN_TYPE === 'tinyint(1)') {
            attr.field_type = 'boolean';
            return attr;
          }

          if (col === 'brand_id')   { attr.field_type = 'select'; attr.options = brands.map(b => ({ id: b.id, label: b.name })); }
          if (col === 'model_id')   { attr.field_type = 'select'; attr.options = models.map(m => ({ id: m.id, label: m.name })); }
          if (col === 'currency')   { attr.field_type = 'select'; attr.options = ['EUR','USD','CHF'].map(c => ({ id: c, label: c })); }
          if (col === 'country_id') { attr.field_type = 'select'; attr.options = countries; }

          const nums = ['price','mileage','year','length','beam','berths','energypass_value','livingarea','landarea','floors','bedrooms','bathrooms'];
          if (nums.includes(col)) attr.field_type = 'number';
          if (col === 'description') attr.field_type = 'textarea';

          return attr;
        }));
      }

          console.log("➡ entity:", entity);
    console.log("➡ data.entId:", data.entId);
    console.log("➡ allowedFields:", allowedFieldsByRoute[entity?.route]);

      // 8) Rendern
      res.render('admin/listings/new-wizard', {
        active: 'listings',
        entieties,
        entity,
        step,
        data,
        brands,
        models,
        countries,
        attrs,
        isCars: entity?.table_name === 'cars',
        isWatches: entity?.table_name === 'watches',
        isYachts: entity?.table_name === 'yachts',
        isProperties: entity?.table_name === 'properties',
        isLifestyles: entity?.table_name === 'lifestyles'
      });
    } catch (err) {
      next(err);
    }
  }
);


// POST /admin/users/:userId/new-listing
router.post(
  '/users/:userId/new-listing',
  loadEntities,
  loadPackages,
  upload.fields([
    { name: 'mainpicture', maxCount: 1 },
    { name: 'pictures',    maxCount: 20 }
  ]),
  async (req, res, next) => {
    try {
      const { userId } = req.params;
      const step = parseInt(req.body.step, 10) || 1;

      // Session-Draft laden oder neu
      const data = req.session.newListing || {};
      data.userId = parseInt(userId, 10);

      // entId sichern
      data.entId = data.entId || (req.body.entId ? parseInt(req.body.entId, 10) : null);
      if (!data.entId) {
        req.flash('error','Kategorie nicht ausgewählt.');
        return res.redirect(`/admin/users/${userId}/new-listing?step=1`);
      }

      // Schritt 1: Eingaben & Preview-Upload
      if (step === 1) {
        data.name    = req.body.name   || null;
        data.status  = 1;
        data.visible = 0;

        const ent = res.locals.entieties.find(e => e.id == data.entId);

        // Boolean-Spalten bestimmen
        const [tinyRows] = await db.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? 
             AND DATA_TYPE='tinyint' AND COLUMN_TYPE='tinyint(1)'`,
          [ent.table_name]
        );
        const boolCols = tinyRows.map(r => r.COLUMN_NAME);

        const allowed = allowedFieldsByRoute[ent.route] || [];
        const intCols = [
          'firstregistration','firstregistration_month',
          'maininspection','maininspection_month','year'
        ];

        for (const key of Object.keys(req.body)) {
          if (!allowed.includes(key) || key === 'name') continue;
          let v = req.body[key];
          if (
            key.endsWith('_id') ||
            key === 'country_id' ||
            boolCols.includes(key) ||
            intCols.includes(key)
          ) {
            v = v ? parseInt(v, 10) : null;
          }
          data[key] = v;
        }

        // Upload-Ordner vorbereiten (unter /media/herando/images)
        const routeName  = ent.route;
        const previewDir = path.join('/media/herando/images', routeName, String(userId));
        fs.mkdirSync(previewDir, { recursive:true });

        if (req.files.mainpicture?.[0]) {
          const f = req.files.mainpicture[0];
          const filename = f.originalname || f.filename || 'unnamed';
          const dst = path.join(previewDir, filename);
          if (f.buffer) fs.writeFileSync(dst, f.buffer);
          else fs.copyFileSync(f.path, dst);
          data.mainpicture = `${routeName}/${userId}/${filename}`;
        }

        if (req.files.pictures) {
          data.pictures = [];
          for (const f of req.files.pictures) {
            const filename = f.originalname || f.filename || 'unnamed';
            const dst = path.join(previewDir, filename);
            if (f.buffer) fs.writeFileSync(dst, f.buffer);
            else fs.copyFileSync(f.path, dst);
            data.pictures.push(`${routeName}/${userId}/${filename}`);
          }
        }

        req.session.newListing = data;
        return res.redirect(`/admin/users/${userId}/new-listing?step=2&entId=${data.entId}`);
      }

      // Schritt 2: Finale Speicherung
      return await finalizeInsert(data, res.locals.entieties, req, res);

    } catch (err) {
      next(err);
    }
  }
);


// GET /admin/listings/new
router.get(
  '/new',
  loadEntities,
  loadPackages,
  async (req, res, next) => {
    try {
      const step = parseInt(req.query.step, 10) || 1;
      if (!req.session.newListing) req.session.newListing = {};
      const data = req.session.newListing;

      // Query‑Parameter
      if (req.query.entId)    data.entId    = parseInt(req.query.entId, 10);
      if (req.query.brand_id) data.brand_id = parseInt(req.query.brand_id, 10);
      if (req.query.model_id) data.model_id = parseInt(req.query.model_id, 10);

      // Guard für Step 2
      if (step === 2 && !data.name) {
        req.flash('error','Bitte zuerst alle Eingaben ausfüllen.');
        return res.redirect(
          `/admin/listings/new?step=1&entId=${data.entId||''}` +
          `&brand_id=${data.brand_id||''}&model_id=${data.model_id||''}`
        );
      }

      const entieties = res.locals.entieties;
      const entity    = entieties.find(e => e.id === data.entId) || null;
      const [countries] = await db.query(
        `SELECT id,en AS label FROM countries ORDER BY en`
      );

      // Brands nach Entitätstyp filtern
      const routeTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles:5 };
      let brands = [];
      if (entity) {
        [brands] = await db.query(
          `SELECT id,name FROM brands WHERE type = ? ORDER BY name`,
          [ routeTypeMap[entity.route] ]
        );
      }

      // Modelle
      let models = [];
      if (data.brand_id) {
        [models] = await db.query(
          `SELECT id,name FROM models WHERE brand_id = ? ORDER BY name`,
          [ data.brand_id ]
        );
      }

      // Dynamische Attribute
      let attrs = [];
      if (entity) {
        const table = entity.table_name;
        const allowed = allowedFieldsByRoute[entity.route] || [];

        attrs = await Promise.all(allowed.map(async col => {
          const attr = { column_name: col, label: labelMap[col]||col, field_type:'text', options:[] };

          // attribute_options?
          const [optRows] = await db.query(
            `SELECT option_value AS id, option_label AS label
               FROM attribute_options
              WHERE entitie_route = ? AND column_name = ?
              ORDER BY sort_order`,
            [entity.route, col]
          );
          if (optRows.length) {
            attr.field_type='select';
            attr.options   = optRows;
            return attr;
          }

          // tinyint(1) → boolean
          const [[colDef]] = await db.query(
            `SELECT DATA_TYPE,COLUMN_TYPE
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE()
                AND TABLE_NAME=? AND COLUMN_NAME=?`,
            [table, col]
          );
          if (colDef && colDef.DATA_TYPE==='tinyint' && colDef.COLUMN_TYPE==='tinyint(1)') {
            attr.field_type='boolean';
            return attr;
          }

          // spezielle Selects
          if (col==='brand_id')   { attr.field_type='select'; attr.options = brands.map(b=>({id:b.id,label:b.name})); }
          if (col==='model_id')   { attr.field_type='select'; attr.options = models.map(m=>({id:m.id,label:m.name})); }
          if (col==='currency')   { attr.field_type='select'; attr.options=['EUR','USD','CHF'].map(c=>({id:c,label:c})); }
          if (col==='country_id') { attr.field_type='select'; attr.options=countries; }

          // number / textarea
          const nums = ['price','mileage','year','length','beam','berths','energypass_value','livingarea','landarea','floors','bedrooms','bathrooms'];
          if (nums.includes(col)) attr.field_type='number';
          if (col==='description') attr.field_type='textarea';

          return attr;
        }));
      }

      // Render mit entity
      res.render('admin/listings/new-wizard', {
        active:    'listings',
        entieties,
        entity,
        step,
        data,
        brands,
        models,
        countries,
        attrs
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/new',
  loadEntities,
  loadPackages,
  upload.fields([
    { name: 'mainpicture', maxCount: 1 },
    { name: 'pictures',    maxCount: 20 }
  ]),
  async (req, res, next) => {
    try {
      const step = parseInt(req.body.step, 10) || 1;
      const data = req.session.newListing || {};

      // entId sichern
      data.entId = data.entId || (req.body.entId ? parseInt(req.body.entId, 10) : null);
      if (!data.entId) {
        req.flash('error','Kategorie nicht ausgewählt.');
        return res.redirect('/admin/listings/new?step=1');
      }

      // Schritt 1: mappen & Preview‑Upload
      if (step === 1) {
        data.name    = req.body.name   || null;
        data.status  = 1;
        data.visible = 0;

        const ent = res.locals.entieties.find(e => e.id == data.entId);
        // alle Boolean-Spalten (tinyint(1))
        const [tinyRows] = await db.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
             AND DATA_TYPE='tinyint' AND COLUMN_TYPE='tinyint(1)'`,
          [ent.table_name]
        );
        const boolCols = tinyRows.map(r=>r.COLUMN_NAME);

        // erlaubte Felder pro Route
        const allowed = allowedFieldsByRoute[ent.route] || [];

        // INT-Felder, die wir mappen wollen
        const intCols = [
          'firstregistration',
          'firstregistration_month',
          'maininspection',
          'maininspection_month',
          'year'
        ];

        for (const key of Object.keys(req.body)) {
          if (!allowed.includes(key) || key === 'name') continue;
          let v = req.body[key];
          // _id‑Felder, country_id, Boolean‑Felder und unsere neuen INT-Felder als Integer parsen
          if (
            key.endsWith('_id') ||
            key === 'country_id' ||
            boolCols.includes(key) ||
            intCols.includes(key)
          ) {
            v = v ? parseInt(v, 10) : null;
          }
          data[key] = v;
        }

        // Bilder-Upload in Session kopieren
        const routeName  = ent.route;
        const userId     = req.user?.id||req.session.userId;
        const previewDir = path.join('/media/herando/images', routeName, String(userId));
        fs.mkdirSync(previewDir, { recursive:true });

        if (req.files.mainpicture?.[0]) {
          const f = req.files.mainpicture[0];
          const filename = f.originalname || f.filename || 'unnamed';
          const dst = path.join(previewDir, filename);
          if (f.buffer) fs.writeFileSync(dst, f.buffer);
          else fs.copyFileSync(f.path, dst);
          data.mainpicture = `${routeName}/${userId}/${filename}`;
        }

        if (req.files.pictures) {
          data.pictures = [];
          for (const f of req.files.pictures) {
            const filename = f.originalname || f.filename || 'unnamed';
            const dst = path.join(previewDir, filename);
            if (f.buffer) fs.writeFileSync(dst, f.buffer);
            else fs.copyFileSync(f.path, dst);
            data.pictures.push(`${routeName}/${userId}/${filename}`);
          }
        }

        req.session.newListing = data;
        return res.redirect(`/admin/listings/new?step=2&entId=${data.entId}`);
      }

      // Schritt 2: finale Speicherung
      return await finalizeInsert(data, res.locals.entieties, req, res);

    } catch (err) {
      next(err);
    }
  }
);

async function finalizeInsert(data, entieties, req, res) {
  const ent   = entieties.find(e => e.id == data.entId);
  const table = ent.table_name;

  // Paket-Meta
  const pkgMeta = (res.locals.packages || []).find(p => p.id === data.package) || {
    duration: { unit:'DAY', amount:0 },
    featured: false
  };

  // 👉 Hier wird die User-ID aus der Route bevorzugt
  const effectiveUserId = req.params.userId || req.user?.id || req.session.userId;
  data.user_id   = effectiveUserId;
  data.featured  = pkgMeta.featured ? 1 : 0;
  data._stopExpr = pkgMeta.duration.amount > 0
    ? `DATE_ADD(NOW(), INTERVAL ${pkgMeta.duration.amount} ${pkgMeta.duration.unit})`
    : 'NULL';

  // Boolean-Spalten ermitteln (tinyint(1))
  const [tinyRows] = await db.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = ?
        AND DATA_TYPE    = 'tinyint'
        AND COLUMN_TYPE = 'tinyint(1)'`,
    [table]
  );
  const boolCols = tinyRows.map(r => r.COLUMN_NAME);

  // Volles Schema auslesen
  const [schema] = await db.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = ?`,
    [table]
  );
  const existing = schema.map(r => r.COLUMN_NAME);

  // Core-Spalten
  const core = [
    'entity','external','duration','price','currency',
    'visible','name','user_id','status','featured',
    'stopdate','published','created','modified'
  ].filter(c => existing.includes(c));

  // Eigene Felder über allowedFieldsByRoute + Bilder-Felder
  const allowed = allowedFieldsByRoute[ent.route] || [];
  const custom  = allowed.filter(c => existing.includes(c) && !core.includes(c));
  if (existing.includes('mainpicture'))   custom.push('mainpicture');
  if (existing.includes('sliderpicture')) custom.push('sliderpicture');
  if (existing.includes('pictures'))      custom.push('pictures');

  // Spaltenliste ohne Duplikate
  const cols = Array.from(new Set([...core, ...custom]));

  // Placeholder-Mapping
  const placeholderMap = cols.map(c => {
    if (c === 'created' || c === 'modified')  return { sql: 'NOW()',      isParam: false };
    if (c === 'stopdate')                     return { sql: data._stopExpr, isParam: false };
    return { sql: '?',                         isParam: true };
  });

  // Integer-Felder
  const intCols = [
    'firstregistration','firstregistration_month',
    'maininspection','maininspection_month',
    'year'
  ];

  // Werte zusammenstellen
  const vals = cols
    .map((col,i) => ({ col, slot: placeholderMap[i] }))
    .filter(x => x.slot.isParam)
    .map(x => {
      let v;
      switch (x.col) {
        case 'entity':
          v = data.entId;
          break;
        case 'external':
          v = data.external || null;
          break;
        case 'duration':
          v = data.package  || null;
          break;
        case 'mainpicture':
          v = data.mainpicture
            ? path.basename(data.mainpicture)
            : null;
          break;
        case 'sliderpicture':
          v = data.sliderpicture
            ? path.basename(data.sliderpicture)
            : null;
          break;
        case 'pictures':
          const pics = (data.pictures || []).map(p => path.basename(p));
          v = serialize(pics);
          break;
        default:
          v = data[x.col] ?? null;
      }

      if (Array.isArray(v)) {
        v = v.length ? v[v.length - 1] : null;
      }
      if (v === '') v = null;

      if (v != null && intCols.includes(x.col)) {
        const p = parseInt(v, 10);
        v = isNaN(p) ? null : p;
      }

      if (boolCols.includes(x.col)) {
        v = v ? 1 : 0;
      }

      return v;
    });

  // ——— Logging ———————————————————————
  console.log('🗄 TABLE:', table);
  console.log('🟢 COLS:', cols);
  console.log('🔤 placeholders:', placeholderMap.map(p => p.sql).join(','));
  console.log('🔢 vals.length =', vals.length);
  console.log('📦 vals =', vals);
  // ————————————————————————————————————

  // INSERT bauen und ausführen
  const insertCols = cols.map(c => `\`${c}\``).join(',');
  const sql        = `INSERT INTO \`${table}\`(${insertCols})
                      VALUES(${placeholderMap.map(p => p.sql).join(',')})`;
  console.log('🛠 SQL:', sql);

  const [insResult] = await db.query(sql, vals);
  const listingId   = insResult.insertId;

  // Bilder-Verzeichnis verschieben
  const previewDir = path.join('/media/herando/images', ent.route, String(effectiveUserId));
  const finalDir   = path.join('/media/herando/images', ent.route, String(listingId));
  try {
    fs.renameSync(previewDir, finalDir);
  } catch (e) {
    console.error('❌ Fehler beim Verschieben des Bilder-Verzeichnisses:', e);
  }

  delete req.session.newListing;
  req.flash('success', 'Inserat erfolgreich angelegt.');
  return res.redirect('/admin');
}


router.get('/admin/models', async (req,res) => {
  const brandId = req.query.brand_id;
  const [models] = await db.query('SELECT id,name FROM models WHERE brand_id=? ORDER BY name',[brandId]);
  res.json(models);
});



router.get('/:category/:id/change-category', loadEntities, async (req, res, next) => {
  try {
    const { category, id } = req.params;

    // 1) Entität/Kategorie finden
    const ent = res.locals.entieties.find(
      e => e.route === category || String(e.id) === category
    );
    if (!ent) {
      return res.status(404).json({ error: 'Kategorie nicht gefunden' });
    }

    // 2) Spaltenauswahl (für Debug bei lifestyles alle Spalten)
    let selectCols = ['id', 'name'];
    if (ent.route === 'lifestyles') {
      selectCols = ['*'];  // Debug: lade alle Spalten
    } else {
      const routeCols = {
        cars:       ['brand_id', 'model_id'],
        watches:    ['brand_id', 'model_id', 'watchtype'],
        properties: ['investmenttype', 'propertytype'],
        yachts:     ['brand_id'],
        lifestyles: ['entity', 'duration']  // Haupt- und Unterkategorie-Spalten
      };
      selectCols = selectCols.concat(routeCols[ent.route] || []);
    }

    // 3) SQL zusammenbauen
    const sql = selectCols.includes('*')
      ? `SELECT * FROM \`${ent.table_name}\` WHERE id = ?`
      : `SELECT ${selectCols.map(c => `\`${c}\``).join(', ')} FROM \`${ent.table_name}\` WHERE id = ?`;

    // 4) Datensatz laden
    const [[record]] = await db.query(sql, [id]);
    if (!record) {
      return res.status(404).json({ error: 'Inserat nicht gefunden' });
    }

    // 5) Debug-Logs für lifestyles
    if (ent.route === 'lifestyles') {
      console.log('DEBUG GET change-category – record keys:', Object.keys(record));
      console.log('DEBUG GET change-category – record values:', record);
    }

    // 6) ExtraOptions für Frontend
    const extraOptions = {};
    const q = (s, p) => db.query(s, p).then(r => r[0]);
    switch (ent.route) {
      case 'cars':
        [extraOptions.brands, extraOptions.models] = await Promise.all([
          q('SELECT id,name FROM brands ORDER BY name'),
          q('SELECT id,name FROM models WHERE brand_id = ? ORDER BY name', [record.brand_id])
        ]);
        break;
      case 'watches':
        [extraOptions.brands, extraOptions.models, extraOptions.watchTypes] = await Promise.all([
          q('SELECT id,name FROM brands ORDER BY name'),
          q('SELECT id,name FROM models WHERE brand_id = ? ORDER BY name', [record.brand_id]),
          q(`SELECT option_value AS id, option_label AS label
             FROM attribute_options
            WHERE entitie_route='watches' AND column_name='watchtype'
            ORDER BY sort_order`)
        ]);
        break;
      case 'properties':
        [extraOptions.investmentTypes, extraOptions.propertyTypes] = await Promise.all([
          q(`SELECT option_value AS id, option_label AS label
             FROM attribute_options
            WHERE entitie_route='properties' AND column_name='investmenttype'
            ORDER BY sort_order`),
          q(`SELECT option_value AS id, option_label AS label
             FROM attribute_options
            WHERE entitie_route='properties' AND column_name='propertytype'
            ORDER BY sort_order`)
        ]);
        break;
      case 'yachts':
        extraOptions.brands = await q('SELECT id,name FROM brands ORDER BY name');
        break;
      case 'lifestyles':
        extraOptions.categories    = lifestyleCategories;
        extraOptions.subcategories = lifestyleSubcategories[record.entity] || [];
        break;
      default:
        break;
    }

    // 7) ExtraOptionsAll für alle Entitäten
    const extraOptionsAll = {};
    for (const e of res.locals.entieties) {
      switch (e.route) {
        case 'cars':
          extraOptionsAll[e.id] = {
            brands: await q('SELECT id,name FROM brands ORDER BY name'),
            models: []
          };
          break;
        case 'watches':
          extraOptionsAll[e.id] = {
            brands: await q('SELECT id,name FROM brands ORDER BY name'),
            models: [],
            watchTypes: await q(`SELECT option_value AS id, option_label AS label
                                 FROM attribute_options
                                WHERE entitie_route='watches' AND column_name='watchtype'
                                ORDER BY sort_order`)
          };
          break;
        case 'properties':
          extraOptionsAll[e.id] = {
            investmentTypes: await q(`SELECT option_value AS id, option_label AS label
                                      FROM attribute_options
                                     WHERE entitie_route='properties' AND column_name='investmenttype'
                                     ORDER BY sort_order`),
            propertyTypes: await q(`SELECT option_value AS id, option_label AS label
                                    FROM attribute_options
                                   WHERE entitie_route='properties' AND column_name='propertytype'
                                   ORDER BY sort_order`)
          };
          break;
        case 'yachts':
          extraOptionsAll[e.id] = {
            brands: await q('SELECT id,name FROM brands ORDER BY name')
          };
          break;
        case 'lifestyles':
          extraOptionsAll[e.id] = {
            categories:    lifestyleCategories,
            subcategories: lifestyleSubcategories
          };
          break;
        default:
          extraOptionsAll[e.id] = {};
      }
    }

    // 8) JSON-Antwort inklusive Labels
    res.json({
      entieties:      res.locals.entieties,
      currentEnt:     { id: ent.id, route: ent.route, name: ent.name },
      record,
      ...(ent.route === 'lifestyles' ? {
        selectedCategory: lifestyleCategories.find(c => c.id === record.entity) || null,
        selectedSubcategory: (lifestyleSubcategories[record.entity] || [])
          .find(sc => sc.id === record.duration) || null
      } : {}),
      extraOptions,
      extraOptionsAll
    });

  } catch (err) {
    next(err);
  }
});


// POST /admin/listings/:category/:id/change-category
router.post(
  '/:category/:id/change-category',
  loadEntities,
  async (req, res, next) => {
    try {
      const { category, id } = req.params;
      const newEntId = Number(req.body.newCategoryId);
      const oldEnt   = res.locals.entieties.find(e => e.route === category);
      const newEnt   = res.locals.entieties.find(e => e.id === newEntId);
      if (!oldEnt || !newEnt) throw new Error('Kategorie nicht gefunden');

      // 1) Bestehenden Datensatz laden
      const [[record]] = await db.query(
        `SELECT * FROM \`${oldEnt.table_name}\` WHERE id = ?`,
        [id]
      );
      if (!record) throw new Error('Inserat nicht gefunden');

      // 2) Für lifestyles übernehmen wir einfach die übergebenen IDs
      if (oldEnt.route === 'lifestyles') {
        const catId = Number(req.body.category);       // entspricht brands.id
        const subId = Number(req.body.subcategory);    // entspricht models.id

        // Validierung: existieren diese IDs?
        const [[brandCheck]] = await db.query(
          'SELECT id FROM brands WHERE id = ? AND type = 5',
          [catId]
        );
        if (!brandCheck) {
          throw new Error(`Ungültige Lifestyle-Kategorie: ${catId}`);
        }
        const [[modelCheck]] = await db.query(
          'SELECT id FROM models WHERE id = ? AND brand_id = ?',
          [subId, catId]
        );
        if (subId && !modelCheck) {
          throw new Error(`Ungültige Lifestyle-Unterkategorie: ${subId} für Kategorie ${catId}`);
        }

        record.brand_id = catId;
        record.model_id = subId || null;
      }

      // 3) Weitere routespezifische Felder
      if (oldEnt.route === 'cars') {
        record.brand_id = req.body.newBrandId ? parseInt(req.body.newBrandId, 10) : null;
        record.model_id = req.body.newModelId ? parseInt(req.body.newModelId, 10) : null;
      }
      if (oldEnt.route === 'watches') {
        if (req.body.newBrandId)   record.brand_id  = parseInt(req.body.newBrandId, 10);
        if (req.body.newModelId)   record.model_id  = parseInt(req.body.newModelId, 10);
        if (req.body.newWatchType) record.watchtype = parseInt(req.body.newWatchType, 10);
      }
      if (oldEnt.route === 'properties') {
        if (req.body.newInvestmentType)
          record.investmenttype = parseInt(req.body.newInvestmentType, 10);
        if (req.body.newPropertyType)
          record.propertytype   = parseInt(req.body.newPropertyType, 10);
      }
      if (oldEnt.route === 'yachts') {
        record.brand_id = req.body.newBrandId ? parseInt(req.body.newBrandId, 10) : null;
      }

      // 4) Gemeinsame Spalten ermitteln
      const [oldColsRows] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = ?`,
        [oldEnt.table_name]
      );
      const [newColsRows] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = ?`,
        [newEnt.table_name]
      );
      const oldCols = oldColsRows.map(r => r.COLUMN_NAME);
      const newCols = newColsRows.map(r => r.COLUMN_NAME);

      let copyCols = oldCols.filter(c => c !== 'id' && newCols.includes(c));
      const entityCol = newCols.includes('entitie')
        ? 'entitie'
        : newCols.includes('entity')
          ? 'entity'
          : null;
      if (!entityCol) throw new Error('Ziel-Tabelle hat keine entitie/entity-Spalte');
      if (!copyCols.includes(entityCol)) copyCols.unshift(entityCol);

      // 5) INSERT‑Vorbereitung
      const colsList     = copyCols.map(c => `\`${c}\``).join(',');
      const placeholders = copyCols.map(() => '?').join(',');
      const values       = copyCols.map(c => {
        let v = record[c];
        if (c === 'description' && typeof v === 'string' && v.length > 65535) {
          return v.slice(0, 65535);
        }
        return v;
      });

      // 6) Insert in neue Tabelle
      const [ins] = await db.query(
        `INSERT INTO \`${newEnt.table_name}\` (${colsList})
         VALUES (${placeholders})`,
        values
      );
      const newId = ins.insertId;

      // 7) Bilder verschieben
      const mediaRoot = '/media/herando/images';
      const oldDir    = path.join(mediaRoot, oldEnt.route, String(id));
      const newDir    = path.join(mediaRoot, newEnt.route, String(newId));
      if (fs.existsSync(oldDir)) {
        fs.mkdirSync(newDir, { recursive: true });
        for (const fn of fs.readdirSync(oldDir)) {
          fs.copyFileSync(path.join(oldDir, fn), path.join(newDir, fn));
        }
      }

      // 8) Alten Datensatz löschen
      await db.query(`DELETE FROM \`${oldEnt.table_name}\` WHERE id = ?`, [id]);

      req.flash('success', 'Kategorie und Typ erfolgreich geändert.');
      res.redirect(`/admin/listings/${newEnt.route}/${newId}/edit`);
    } catch (err) {
      console.error('Fehler beim Kategorie-/Typ-Wechsel:', err);
      next(err);
    }
  }
);


// POST /admin/listings/:category/:id/setAllDates
router.post(
  '/:category/:id/setAllDates',
  loadEntities,
  async (req, res, next) => {
    try {
      const { category, id } = req.params;
      const newDate = req.body.newDate;
      if (!newDate) throw new Error('Kein Datum angegeben');

      // Entität ermitteln
      const ent = res.locals.entieties.find(e =>
        e.route === category || String(e.id) === category
      );
      if (!ent) return res.status(404).send('Kategorie nicht gefunden');

      const table = ent.table_name;
      // Update aller drei Spalten
      await db.query(
        `UPDATE \`${table}\`
            SET created   = ?,
                modified  = ?,
                published = ?
          WHERE id = ?`,
        [ newDate, newDate, newDate, id ]
      );

      req.flash(
        'success',
        `Erstellt, Aktualisiert und Veröffentlicht auf ${new Date(newDate).toLocaleDateString('de-DE')} gesetzt.`
      );
      res.redirect(req.get('Referer') || `/admin/listings/${category}/${id}/edit`);
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/listings/:category/:id/revert-approval
router.post(
  '/:category/:id/revert-approval',
  loadEntities,
  async (req, res, next) => {
    try {
      const { category, id } = req.params;

      // 1) Entitätstabelle ermitteln
      const ent = res.locals.entieties.find(e =>
        e.route === category || String(e.id) === category
      );
      if (!ent) return res.status(404).send('Kategorie nicht gefunden');

      // 2) Update: visible = 0, status = 1 (oder 2, je nach Wunsch)
      const table = ent.table_name;
      await db.query(
        `UPDATE \`${table}\`
            SET visible = 0,
                status  = 1
          WHERE id = ?`,
        [ id ]
      );

      req.flash('success', 'Inserat zurückgestuft: sichtbar=false, status=1');
      // zurück zur Listing‑Übersicht
      res.redirect(req.get('Referer') || `/admin/listings/${category}?state=active`);
    } catch (err) {
      next(err);
    }
  }
);


router.post('/listing-advert', async (req, res, next) => {
  console.log('🔔 POST /admin/listings/listing-advert', req.body);

  try {
    const { entitie_id, advert_id } = req.body;
    if (!entitie_id || !advert_id) {
      req.flash('error', 'Entität und Inserat müssen angegeben sein.');
      return res.redirect('back');
    }

    await db.query(
      `INSERT INTO advert_inserat
         (entitie_id, advert_id, start_date, end_date)
       VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 14 DAY))`,
      [entitie_id, advert_id]
    );

    req.flash('success', 'Inserat 14 Tage beworben.');
    res.redirect('back');
  } catch (err) {
    console.error('Fehler in /listing-advert:', err);
    next(err);
  }
});

router.get('/:category/:id/back', (req, res) => {
  // wenn Referer gesendet wurde, dorthin
  const referer = req.get('Referer');
  if (referer) return res.redirect(referer);

  // sonst Fallback auf Listen-Übersicht der Kategorie
  return res.redirect(`/admin/listings?category=${encodeURIComponent(req.params.category)}`);
});








module.exports = router;

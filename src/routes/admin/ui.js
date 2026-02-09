// routes/admin/ui.js
// Admin-CRUD für UI-Übersetzungen (eine Tabelle, Key + 11 Sprachspalten)

const express = require('express');
const router = express.Router();

// ⬇️ Passen: falls dein DB-Modul woanders liegt, z.B. '../../src/config/db'
const db = require('../../db');

const SUPPORTED = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
const PAGE_SIZE = 25;

// Hilfsfunktion: sicheres Lesen von body-Feldern (verhindert undefined)
const val = (x) => (typeof x === 'string' ? x : (x ?? '')).trim();

/**
 * LISTE: /admin/ui (mit Suche, Vorschau-Sprache, Pagination)
 * Query-Parameter:
 *   - q: Key-Suche (LIKE)
 *   - preview: Sprachcode für Vorschau-Spalte (default 'de')
 *   - page: Seite (1-basiert)
 */
router.get('/', async (req, res, next) => {
  try {
    const q = val(req.query.q || '');
    const preview = SUPPORTED.includes(String(req.query.preview || '').toLowerCase())
      ? String(req.query.preview).toLowerCase()
      : 'de';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const offset = (page - 1) * PAGE_SIZE;

    const where = [];
    const params = [];
    if (q) {
      where.push('`key` LIKE ?');
      params.push(`%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [[{ cnt }]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM ui_translations ${whereSql}`,
      params
    );

    const [rows] = await db.query(
      `SELECT id, \`key\`, ${preview} AS preview_text, updated_at
       FROM ui_translations
       ${whereSql}
       ORDER BY \`key\` ASC
       LIMIT ? OFFSET ?`,
      [...params, PAGE_SIZE, offset]
    );

    const totalPages = Math.max(1, Math.ceil(cnt / PAGE_SIZE));

    res.render('admin/ui-translations/index', {
      items: rows,
      q,
      preview,
      page,
      totalPages,
      SUPPORTED,
      headerTitle: 'UI-Übersetzungen',
      login_user: req.user,
      currentUrl: req.url, 
      active: 'ui-translations',   // <- WICHTIG

    });
  } catch (err) {
    next(err);
  }
});

/**
 * NEU (Form): /admin/ui/new
 */
router.get('/new', (req, res) => {
  res.render('admin/ui-translations/form', {
    mode: 'create',
    item: {
      key: '',
      de: '', en: '', fr: '', it: '', tr: '',
      ja: '', cs: '', ru: '', es: '', nl: '', pl: ''
    },
    headerTitle: 'Neue UI-Zeile',
    login_user: req.user,
    currentUrl: req.url, 
    active: 'ui-translations',
  });
});

/**
 * NEU (Speichern): POST /admin/ui
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const key = val(body.key);

    if (!key) {
      return res.status(400).send('Key ist erforderlich.');
    }

    const payload = {
      de: val(body.de), en: val(body.en), fr: val(body.fr), it: val(body.it),
      tr: val(body.tr), ja: val(body.ja), cs: val(body.cs), ru: val(body.ru),
      es: val(body.es), nl: val(body.nl), pl: val(body.pl)
    };

    await db.query(
      `INSERT INTO ui_translations
        (\`key\`, de, en, fr, it, tr, ja, cs, ru, es, nl, pl)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        key,
        payload.de, payload.en, payload.fr, payload.it, payload.tr,
        payload.ja, payload.cs, payload.ru, payload.es, payload.nl, payload.pl
      ]
    );

    res.redirect('/admin/ui');
  } catch (err) {
    // Duplicate-Key sauber abfangen
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).send('Key existiert bereits.');
    }
    next(err);
  }
});

/**
 * EDIT (Form): /admin/ui/edit/:id
 */
router.get('/edit/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[item]] = await db.query('SELECT * FROM ui_translations WHERE id=?', [id]);
    if (!item) return res.status(404).send('Datensatz nicht gefunden.');

    res.render('admin/ui-translations/form', {
      mode: 'edit',
      item,
      headerTitle: `UI-Zeile bearbeiten: ${item.key}`,
      login_user: req.user,
      currentUrl: req.url, 
      active: 'ui-translations', 

    });
  } catch (err) {
    next(err);
  }
});

/**
 * EDIT (Speichern): POST /admin/ui/edit/:id
 */
router.post('/edit/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    const body = req.body || {};
    const key = val(body.key);
    if (!key) return res.status(400).send('Key ist erforderlich.');

    const payload = {
      de: val(body.de), en: val(body.en), fr: val(body.fr), it: val(body.it),
      tr: val(body.tr), ja: val(body.ja), cs: val(body.cs), ru: val(body.ru),
      es: val(body.es), nl: val(body.nl), pl: val(body.pl)
    };

    await db.query(
      `UPDATE ui_translations
         SET \`key\`=?, de=?, en=?, fr=?, it=?, tr=?, ja=?, cs=?, ru=?, es=?, nl=?, pl=?
       WHERE id=?`,
      [
        key,
        payload.de, payload.en, payload.fr, payload.it, payload.tr,
        payload.ja, payload.cs, payload.ru, payload.es, payload.nl, payload.pl,
        id
      ]
    );

    res.redirect('/admin/ui');
  } catch (err) {
    // Optional: Duplicate-Key beim Update erkennen (wenn Key geändert wird)
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).send('Key existiert bereits.');
    }
    next(err);
  }
});

/**
 * LÖSCHEN: POST /admin/ui/delete/:id
 */
router.post('/delete/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    await db.query('DELETE FROM ui_translations WHERE id=?', [id]);
    res.redirect('/admin/ui');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
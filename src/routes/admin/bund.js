const express = require('express');
const router = express.Router();
const db = require('../../db');

const LANG_FIELDS = ['en', 'de', 'fr', 'it', 'tr', 'ja', 'cs', 'ru', 'es', 'nl', 'pl'];

let ensureBundTablesPromise = null;

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeCode(value, maxLen) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, maxLen);
}

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeTranslations(body) {
  const values = {};
  for (const lang of LANG_FIELDS) {
    values[lang] = normalizeName(body?.[lang]);
  }
  const firstNonEmpty =
    values.en || values.de || values.fr || values.it || values.tr ||
    values.ja || values.cs || values.ru || values.es || values.nl || values.pl;
  values.en = values.en || firstNonEmpty || '';
  return values;
}

function normalizeTab(tab) {
  const t = String(tab || '').trim().toLowerCase();
  return ['countries', 'states'].includes(t) ? t : 'countries';
}

function redirectToTab(res, tab) {
  return res.redirect(`/admin/bund?tab=${normalizeTab(tab)}`);
}

function redirectToStates(res, countryId) {
  const id = parsePositiveInt(countryId);
  if (id) return res.redirect(`/admin/bund?tab=states&stateCountryId=${id}`);
  return res.redirect('/admin/bund?tab=states');
}

async function ensureBundTables() {
  if (!ensureBundTablesPromise) {
    ensureBundTablesPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS states (
          id INT NOT NULL AUTO_INCREMENT,
          country_id INT NOT NULL,
          name VARCHAR(120) NOT NULL,
          code VARCHAR(20) DEFAULT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_states_country (country_id),
          KEY idx_states_country_name (country_id, name),
          CONSTRAINT fk_states_country
            FOREIGN KEY (country_id) REFERENCES countries(id)
            ON DELETE CASCADE
            ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS cities (
          id INT NOT NULL AUTO_INCREMENT,
          country_id INT NOT NULL,
          state_id INT DEFAULT NULL,
          name VARCHAR(120) NOT NULL,
          zip_code VARCHAR(20) DEFAULT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_cities_country (country_id),
          KEY idx_cities_state (state_id),
          KEY idx_cities_country_state_name (country_id, state_id, name),
          CONSTRAINT fk_cities_country
            FOREIGN KEY (country_id) REFERENCES countries(id)
            ON DELETE CASCADE
            ON UPDATE CASCADE,
          CONSTRAINT fk_cities_state
            FOREIGN KEY (state_id) REFERENCES states(id)
            ON DELETE SET NULL
            ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci
      `);
    })().catch((err) => {
      ensureBundTablesPromise = null;
      throw err;
    });
  }
  return ensureBundTablesPromise;
}

async function syncStatesFromLegacyCountries() {
  const [legacyStates] = await db.query(`
    SELECT
      s.id AS legacy_id,
      s.parent_id AS country_id,
      s.code AS legacy_code,
      COALESCE(NULLIF(s.de, ''), NULLIF(s.en, ''), s.code) AS legacy_name
    FROM countries s
    JOIN countries c ON c.id = s.parent_id
    WHERE s.parent_id IS NOT NULL
      AND s.parent_id > 0
      AND COALESCE(c.parent_id, 0) = 0
    ORDER BY s.parent_id, s.id
  `);

  if (!legacyStates.length) return;

  const [existingStates] = await db.query(`
    SELECT country_id, name
    FROM states
  `);
  const existingKeys = new Set(
    existingStates.map((row) => `${Number(row.country_id)}::${String(row.name || '').trim().toLowerCase()}`)
  );

  for (const row of legacyStates) {
    const countryId = parsePositiveInt(row.country_id);
    const name = normalizeName(row.legacy_name);
    if (!countryId || !name) continue;

    const key = `${countryId}::${name.toLowerCase()}`;
    if (existingKeys.has(key)) continue;

    await db.query(
      `INSERT INTO states (country_id, name, code, sort_order)
       VALUES (?, ?, ?, 0)`,
      [countryId, name, normalizeCode(row.legacy_code, 20) || null]
    );
    existingKeys.add(key);
  }
}

router.use(async (_req, _res, next) => {
  try {
    await ensureBundTables();
    await syncStatesFromLegacyCountries();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const activeTab = normalizeTab(req.query.tab);
    const selectedStateCountryId = parsePositiveInt(req.query.stateCountryId);

    const [countries] = await db.query(`
      SELECT id, code, iso_code, en, de, fr, it, tr, ja, cs, ru, es, nl, pl, visible
      FROM countries
      WHERE COALESCE(parent_id, 0) = 0
      ORDER BY COALESCE(NULLIF(de, ''), en), id
    `);

    const stateWhere = selectedStateCountryId
      ? 'WHERE COALESCE(s.parent_id, 0) > 0 AND s.parent_id = ?'
      : 'WHERE COALESCE(s.parent_id, 0) > 0';
    const stateParams = selectedStateCountryId ? [selectedStateCountryId] : [];
    const [states] = await db.query(`
      SELECT
        s.id,
        s.parent_id AS country_id,
        s.en,
        s.de,
        s.fr,
        s.it,
        s.tr,
        s.ja,
        s.cs,
        s.ru,
        s.es,
        s.nl,
        s.pl,
        s.code,
        s.iso_code,
        s.visible,
        COALESCE(NULLIF(c.de, ''), c.en, c.code) AS country_name
      FROM countries s
      JOIN countries c ON c.id = s.parent_id
      ${stateWhere}
      ORDER BY country_name, COALESCE(NULLIF(s.de, ''), s.en, s.code), s.id
    `, stateParams);

    res.render('admin/bund/list', {
      active: 'bund',
      role: req.session.role,
      activeTab,
      selectedStateCountryId,
      countries,
      states,
      langs: LANG_FIELDS
    });
  } catch (err) {
    next(err);
  }
});

router.post('/countries/new', async (req, res, next) => {
  try {
    const names = normalizeTranslations(req.body);
    if (!names.en) return redirectToTab(res, 'countries');

    const code = normalizeCode(req.body.code, 2);
    const isoCode = normalizeCode(req.body.iso_code, 3);
    await db.query(
      `INSERT INTO countries
         (parent_id, code, iso_code, en, de, fr, it, tr, ja, cs, ru, es, nl, pl, visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        null,
        code || 'XX',
        isoCode || `${(code || 'XXX').padEnd(3, 'X').slice(0, 3)}`,
        names.en,
        names.de || null,
        names.fr || null,
        names.it || null,
        names.tr || null,
        names.ja || null,
        names.cs || null,
        names.ru || null,
        names.es || null,
        names.nl || null,
        names.pl || null,
        req.body.visible ? 1 : 0
      ]
    );

    redirectToTab(res, 'countries');
  } catch (err) {
    next(err);
  }
});

router.post('/countries/:id/edit', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    const names = normalizeTranslations(req.body);
    if (!id || !names.en) return redirectToTab(res, 'countries');

    const code = normalizeCode(req.body.code, 2);
    const isoCode = normalizeCode(req.body.iso_code, 3);
    await db.query(
      `UPDATE countries
          SET code = ?, iso_code = ?, en = ?, de = ?, fr = ?, it = ?, tr = ?,
              ja = ?, cs = ?, ru = ?, es = ?, nl = ?, pl = ?, visible = ?
        WHERE id = ?
          AND COALESCE(parent_id, 0) = 0`,
      [
        code || 'XX',
        isoCode || `${(code || 'XXX').padEnd(3, 'X').slice(0, 3)}`,
        names.en,
        names.de || null,
        names.fr || null,
        names.it || null,
        names.tr || null,
        names.ja || null,
        names.cs || null,
        names.ru || null,
        names.es || null,
        names.nl || null,
        names.pl || null,
        req.body.visible ? 1 : 0,
        id
      ]
    );

    redirectToTab(res, 'countries');
  } catch (err) {
    next(err);
  }
});

router.post('/countries/:id/delete', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return redirectToTab(res, 'countries');
    await db.query('DELETE FROM countries WHERE id = ? AND COALESCE(parent_id, 0) = 0', [id]);
    redirectToTab(res, 'countries');
  } catch (err) {
    next(err);
  }
});

router.post('/states/new', async (req, res, next) => {
  try {
    const countryId = parsePositiveInt(req.body.country_id);
    const names = normalizeTranslations(req.body);
    if (!countryId || !names.en) return redirectToTab(res, 'states');

    const [[parentCountry]] = await db.query(
      `SELECT code, iso_code
         FROM countries
        WHERE id = ?
          AND COALESCE(parent_id, 0) = 0
        LIMIT 1`,
      [countryId]
    );
    if (!parentCountry) return redirectToTab(res, 'states');

    const code = normalizeCode(req.body.code, 2) || normalizeCode(parentCountry.code, 2) || 'XX';
    const isoCode =
      normalizeCode(req.body.iso_code, 3) ||
      normalizeCode(parentCountry.iso_code, 3) ||
      `${code.padEnd(3, 'X').slice(0, 3)}`;

    await db.query(
      `INSERT INTO countries
         (parent_id, code, iso_code, en, de, fr, it, tr, ja, cs, ru, es, nl, pl, visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        countryId,
        code,
        isoCode,
        names.en,
        names.de || null,
        names.fr || null,
        names.it || null,
        names.tr || null,
        names.ja || null,
        names.cs || null,
        names.ru || null,
        names.es || null,
        names.nl || null,
        names.pl || null,
        req.body.visible ? 1 : 0
      ]
    );
    redirectToStates(res, countryId);
  } catch (err) {
    next(err);
  }
});

router.post('/states/:id/edit', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    const countryId = parsePositiveInt(req.body.country_id);
    const names = normalizeTranslations(req.body);
    if (!id || !countryId || !names.en) return redirectToTab(res, 'states');

    const [[parentCountry]] = await db.query(
      `SELECT code, iso_code
         FROM countries
        WHERE id = ?
          AND COALESCE(parent_id, 0) = 0
        LIMIT 1`,
      [countryId]
    );
    if (!parentCountry) return redirectToTab(res, 'states');

    const code = normalizeCode(req.body.code, 2) || normalizeCode(parentCountry.code, 2) || 'XX';
    const isoCode =
      normalizeCode(req.body.iso_code, 3) ||
      normalizeCode(parentCountry.iso_code, 3) ||
      `${code.padEnd(3, 'X').slice(0, 3)}`;

    await db.query(
      `UPDATE countries
          SET parent_id = ?, code = ?, iso_code = ?, en = ?, de = ?, fr = ?, it = ?, tr = ?,
              ja = ?, cs = ?, ru = ?, es = ?, nl = ?, pl = ?, visible = ?
        WHERE id = ?
          AND COALESCE(parent_id, 0) > 0`,
      [
        countryId,
        code,
        isoCode,
        names.en,
        names.de || null,
        names.fr || null,
        names.it || null,
        names.tr || null,
        names.ja || null,
        names.cs || null,
        names.ru || null,
        names.es || null,
        names.nl || null,
        names.pl || null,
        req.body.visible ? 1 : 0,
        id
      ]
    );
    redirectToStates(res, req.body.stateCountryId || countryId);
  } catch (err) {
    next(err);
  }
});

router.post('/states/:id/delete', async (req, res, next) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) return redirectToTab(res, 'states');
    await db.query('DELETE FROM countries WHERE id = ? AND COALESCE(parent_id, 0) > 0', [id]);
    redirectToStates(res, req.body.stateCountryId);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// routes/admin/ui.js
// Admin-CRUD für UI-Übersetzungen (eine Tabelle, Key + 11 Sprachspalten)

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// ⬇️ Passen: falls dein DB-Modul woanders liegt, z.B. '../../src/config/db'
const db = require('../../db');

const SUPPORTED = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
const PAGE_SIZE = 25;
const HOME_HERO_UPLOAD_DIR = path.join(__dirname, '../../../public/uploads/home-hero');
const CATEGORY_HERO_UPLOAD_DIR = path.join(__dirname, '../../../public/uploads/category-hero');
const DEFAULT_CATEGORY_HERO_FALLBACK = '/assets/cars.jpg';
const CATEGORY_HERO_FALLBACKS = {
  yachts: '/assets/yachten.jpg',
  cars: '/assets/cars.jpg',
  watches: '/assets/watches.jpg',
  properties: '/assets/properties.jpg',
  lifestyles: '/assets/lifestyle.png'
};
const HOME_HERO_SLIDES = [
  {
    index: 1,
    label: 'Slide 1 (Immobilien)',
    key: 'home_hero_slide1_image',
    fallback: '/assets/herando-home-slider-luxusimmobilien.webp',
    fileField: 'slide1_image_file',
    pathField: 'slide1_image_path',
    resetField: 'slide1_reset'
  },
  {
    index: 2,
    label: 'Slide 2 (Autos)',
    key: 'home_hero_slide2_image',
    fallback: '/assets/herando-home-slider-luxusautos.webp',
    fileField: 'slide2_image_file',
    pathField: 'slide2_image_path',
    resetField: 'slide2_reset'
  },
  {
    index: 3,
    label: 'Slide 3 (Uhren)',
    key: 'home_hero_slide3_image',
    fallback: '/assets/herando-home-slider-luxusuhren.webp',
    fileField: 'slide3_image_file',
    pathField: 'slide3_image_path',
    resetField: 'slide3_reset'
  },
  {
    index: 4,
    label: 'Slide 4 (Yachten)',
    key: 'home_hero_slide4_image',
    fallback: '/assets/herando-home-slider-luxusyachten.webp',
    fileField: 'slide4_image_file',
    pathField: 'slide4_image_path',
    resetField: 'slide4_reset'
  }
];
const HOMEPAGE_ENTITY_ORDER_KEY = 'homepage.entity_order';

const homeHeroUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(HOME_HERO_UPLOAD_DIR, { recursive: true });
        cb(null, HOME_HERO_UPLOAD_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const slide = HOME_HERO_SLIDES.find((s) => s.fileField === file.fieldname);
      const base = slide ? `slide${slide.index}` : 'slide';
      const rawExt = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /^[.][a-z0-9]+$/.test(rawExt) ? rawExt : '.webp';
      cb(null, `home-hero-${base}-${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Nur Bilddateien sind erlaubt.'));
    }
    cb(null, true);
  }
});

const categoryHeroUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(CATEGORY_HERO_UPLOAD_DIR, { recursive: true });
        cb(null, CATEGORY_HERO_UPLOAD_DIR);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const m = /^category_hero_(.+)$/i.exec(String(file.fieldname || ''));
      const route = (m?.[1] || 'category').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      const rawExt = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /^[.][a-z0-9]+$/.test(rawExt) ? rawExt : '.webp';
      cb(null, `category-hero-${route}-${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Nur Bilddateien sind erlaubt.'));
    }
    cb(null, true);
  }
});

// Hilfsfunktion: sicheres Lesen von body-Feldern (verhindert undefined)
const val = (x) => (typeof x === 'string' ? x : (x ?? '')).trim();
const normalizeImagePath = (input) => {
  const value = val(input);
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return value.startsWith('/') ? value : `/${value}`;
};

async function getHomeHeroImageRows() {
  return getUiTranslationRows(HOME_HERO_SLIDES.map((s) => s.key));
}

async function upsertUiTranslationAllLocales(key, value) {
  const columns = SUPPORTED.map((c) => `\`${c}\``).join(', ');
  const placeholders = SUPPORTED.map(() => '?').join(', ');
  const updates = SUPPORTED.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  const sameValueAllLocales = SUPPORTED.map(() => value);

  await db.query(
    `INSERT INTO ui_translations (\`key\`, ${columns})
     VALUES (?, ${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}`,
    [key, ...sameValueAllLocales]
  );
}

async function getUiTranslationRows(keys) {
  if (!Array.isArray(keys) || !keys.length) return [];
  const placeholders = keys.map(() => '?').join(',');
  const [rows] = await db.query(
    `SELECT \`key\`, de
       FROM ui_translations
      WHERE \`key\` IN (${placeholders})`,
    keys
  );
  return rows;
}

async function getAdminEntentiesBasic() {
  const [rows] = await db.query(
    `SELECT id, name, route
       FROM ententies
      WHERE route IS NOT NULL AND route <> ''
      ORDER BY name ASC`
  );
  return rows;
}

async function getHomepageEntentiesBasic() {
  const [rows] = await db.query(
    `SELECT id, name, route
       FROM ententies
      WHERE route IS NOT NULL AND route <> ''
      ORDER BY id ASC`
  );
  return rows;
}

function normalizeHomepageEntityRouteToken(input) {
  const token = String(input || '').trim().toLowerCase();
  if (!token) return '';
  if (token === 'cars' || token === 'car' || token === 'auto' || token === 'autos') return 'cars';
  if (token === 'watches' || token === 'watch' || token === 'uhr' || token === 'uhren') return 'watches';
  if (token === 'yachts' || token === 'yacht' || token === 'yachten') return 'yachts';
  if (token === 'properties' || token === 'property' || token === 'immobilie' || token === 'immobilien') return 'properties';
  if (
    token === 'lifestyles' ||
    token === 'lifestyle' ||
    token === 'luxurylifestyle' ||
    token === 'luxury_lifestyle' ||
    token === 'luxury-lifestyle'
  ) {
    return 'lifestyles';
  }
  return token;
}

function normalizeHomepageEntityOrder(rawOrder, availableRoutes) {
  const normalizedAvailable = Array.from(
    new Set(
      (availableRoutes || [])
        .map((route) => normalizeHomepageEntityRouteToken(route))
        .filter(Boolean)
    )
  );
  const availableSet = new Set(normalizedAvailable);

  const parsed = String(rawOrder || '')
    .split(',')
    .map((token) => normalizeHomepageEntityRouteToken(token))
    .filter((route) => availableSet.has(route));

  const deduped = [];
  const seen = new Set();
  for (const route of parsed) {
    if (seen.has(route)) continue;
    seen.add(route);
    deduped.push(route);
  }
  for (const route of normalizedAvailable) {
    if (!seen.has(route)) deduped.push(route);
  }
  return deduped;
}

const getCategoryHeroFallback = (route) =>
  CATEGORY_HERO_FALLBACKS[String(route || '').toLowerCase()] || DEFAULT_CATEGORY_HERO_FALLBACK;
const getCategoryHeroKey = (route) => `category_hero_image_${String(route || '').toLowerCase()}`;

/**
 * LISTE: /admin/ui (mit Suche, Vorschau-Sprache, Pagination)
 * Query-Parameter:
 *   - q_key: Suche nur im Key (LIKE)
 *   - q_text: Suche in allen Sprachtexten (LIKE)
 *   - preview: Sprachcode für Vorschau-Spalte (default 'de')
 *   - page: Seite (1-basiert)
 */
router.get('/', async (req, res, next) => {
  try {
    const qLegacy = val(req.query.q || '');
    let qKey = val(req.query.q_key || '');
    let qText = val(req.query.q_text || '');
    if (qLegacy && !qKey && !qText) qKey = qLegacy;

    const preview = SUPPORTED.includes(String(req.query.preview || '').toLowerCase())
      ? String(req.query.preview).toLowerCase()
      : 'de';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const offset = (page - 1) * PAGE_SIZE;

    const where = [];
    const params = [];
    if (qKey) {
      where.push('`key` LIKE ?');
      params.push(`%${qKey}%`);
    }
    if (qText) {
      const like = `%${qText}%`;
      const textCols = SUPPORTED.map((c) => `\`${c}\``);
      where.push(`(${textCols.map((col) => `${col} LIKE ?`).join(' OR ')})`);
      params.push(...textCols.map(() => like));
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
      q: qLegacy || qKey || qText,
      qKey,
      qText,
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
 * Home-Carousel-Bilder (Admin): /admin/ui/home-hero
 */
router.get('/home-hero', async (req, res, next) => {
  try {
    const [rows, homepageEntities] = await Promise.all([
      getHomeHeroImageRows(),
      getHomepageEntentiesBasic()
    ]);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, val(r.de)]));
    const entityRouteToName = new Map(
      homepageEntities.map((entity) => [
        normalizeHomepageEntityRouteToken(entity.route),
        entity.name || entity.route
      ])
    );
    const normalizedOrder = normalizeHomepageEntityOrder(
      byKey[HOMEPAGE_ENTITY_ORDER_KEY] || '',
      homepageEntities.map((entity) => entity.route)
    );

    res.render('admin/ui-translations/home-hero', {
      slides: HOME_HERO_SLIDES.map((slide) => ({
        ...slide,
        currentPath: byKey[slide.key] || slide.fallback,
        isCustom: Boolean(byKey[slide.key] && byKey[slide.key] !== slide.fallback)
      })),
      homepageEntityOrderKey: HOMEPAGE_ENTITY_ORDER_KEY,
      homepageEntityOrderValue: normalizedOrder.join(','),
      homepageEntityOrderItems: normalizedOrder.map((route) => ({
        route,
        name: entityRouteToName.get(route) || route
      })),
      saved: req.query.saved === '1',
      headerTitle: 'Startseite: Slider-Bilder',
      login_user: req.user,
      currentUrl: req.url,
      active: 'home-hero'
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/home-hero',
  homeHeroUpload.fields(HOME_HERO_SLIDES.map((slide) => ({ name: slide.fileField, maxCount: 1 }))),
  async (req, res, next) => {
    try {
      const [rows, homepageEntities] = await Promise.all([
        getHomeHeroImageRows(),
        getHomepageEntentiesBasic()
      ]);
      const currentByKey = Object.fromEntries(rows.map((r) => [r.key, val(r.de)]));

      for (const slide of HOME_HERO_SLIDES) {
        const uploaded = req.files?.[slide.fileField]?.[0];
        const manualPath = normalizeImagePath(req.body?.[slide.pathField]);
        const resetRequested = String(req.body?.[slide.resetField] || '') === '1';

        let nextPath = currentByKey[slide.key] || slide.fallback;
        if (manualPath) nextPath = manualPath;
        if (resetRequested) nextPath = slide.fallback;
        if (uploaded?.filename) nextPath = `/uploads/home-hero/${uploaded.filename}`;

        await upsertUiTranslationAllLocales(slide.key, nextPath);
      }

      const normalizedOrder = normalizeHomepageEntityOrder(
        req.body?.home_entity_order,
        homepageEntities.map((entity) => entity.route)
      );
      await upsertUiTranslationAllLocales(
        HOMEPAGE_ENTITY_ORDER_KEY,
        normalizedOrder.join(',')
      );

      res.redirect('/admin/ui/home-hero?saved=1');
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Kategorie-Hero-Bilder (Admin): /admin/ui/category-hero
 */
router.get('/category-hero', async (req, res, next) => {
  try {
    const entities = await getAdminEntentiesBasic();
    const keys = entities.map((e) => getCategoryHeroKey(e.route));
    const rows = await getUiTranslationRows(keys);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, val(r.de)]));

    res.render('admin/ui-translations/category-hero', {
      categories: entities.map((entity) => {
        const route = String(entity.route || '').toLowerCase();
        const key = getCategoryHeroKey(route);
        const fallback = getCategoryHeroFallback(route);
        const currentPath = byKey[key] || fallback;
        return {
          id: entity.id,
          name: entity.name || route,
          route,
          key,
          fallback,
          currentPath,
          isCustom: Boolean(byKey[key] && byKey[key] !== fallback),
          fileField: `category_hero_${route}`,
          pathField: `category_hero_path_${route}`,
          resetField: `category_hero_reset_${route}`
        };
      }),
      saved: req.query.saved === '1',
      headerTitle: 'Kategorien: Hero-Bilder',
      login_user: req.user,
      currentUrl: req.url,
      active: 'category-hero'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/category-hero', categoryHeroUpload.any(), async (req, res, next) => {
  try {
    const entities = await getAdminEntentiesBasic();
    const rows = await getUiTranslationRows(entities.map((e) => getCategoryHeroKey(e.route)));
    const currentByKey = Object.fromEntries(rows.map((r) => [r.key, val(r.de)]));
    const uploadedByField = Object.create(null);

    for (const file of (req.files || [])) {
      if (file && file.fieldname) uploadedByField[file.fieldname] = file;
    }

    for (const entity of entities) {
      const route = String(entity.route || '').toLowerCase();
      const key = getCategoryHeroKey(route);
      const fallback = getCategoryHeroFallback(route);
      const fileField = `category_hero_${route}`;
      const pathField = `category_hero_path_${route}`;
      const resetField = `category_hero_reset_${route}`;

      const uploaded = uploadedByField[fileField];
      const manualPath = normalizeImagePath(req.body?.[pathField]);
      const resetRequested = String(req.body?.[resetField] || '') === '1';

      let nextPath = currentByKey[key] || fallback;
      if (manualPath) nextPath = manualPath;
      if (resetRequested) nextPath = fallback;
      if (uploaded?.filename) nextPath = `/uploads/category-hero/${uploaded.filename}`;

      await upsertUiTranslationAllLocales(key, nextPath);
    }

    res.redirect('/admin/ui/category-hero?saved=1');
  } catch (err) {
    next(err);
  }
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

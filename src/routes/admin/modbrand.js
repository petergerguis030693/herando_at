const express = require('express');
const router = express.Router();
const db = require('../../db');
const slugify = require('slugify');
const { body, validationResult } = require('express-validator');

/* =========================================================
   ADMIN MIDDLEWARE
========================================================= */
async function requireAdmin(req, res, next) {
  try {
    if (!req.session.userId) {
      return res.status(403).send('Forbidden');
    }

    const [[user]] = await db.query(
      'SELECT role FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (!user || ![8, 9].includes(Number(user.role))) {
      return res.status(403).send('Admin only');
    }

    next();
  } catch (err) {
    next(err);
  }
}

router.use(requireAdmin);

/* =========================================================
   ENTITIES GLOBAL
========================================================= */
router.use(async (req, res, next) => {
  const [ententies] = await db.query(
    'SELECT id, name, route FROM ententies ORDER BY id'
  );
  res.locals.ententies = ententies;
  next();
});

/* =========================================================
   SLUG
========================================================= */
slugify.extend({
  Ä: 'Ae', Ö: 'Oe', Ü: 'Ue',
  ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss'
});

function makeSlug(str) {
  return slugify(str, {
    lower: true,
    strict: true,
    remove: /[*+~.()'"!:@]/g
  });
}

const BRAND_TYPE_TO_ROUTE = {
  1: 'properties', // Immobilien
  2: 'watches',    // Uhren
  3: 'cars',       // Autos
  4: 'yachts',     // Yachten
  6: 'lifestyles'  // Luxury Lifestyle
};

function normalizeBrandType(rawType) {
  const t = Number(rawType);
  return Number.isInteger(t) && BRAND_TYPE_TO_ROUTE[t] ? t : null;
}

async function detectEffectiveBrandTypeFromListings(brandId) {
  const id = Number(brandId);
  if (!id) return null;

  const [rows] = await db.query(`
    SELECT entitie_id, SUM(cnt) AS cnt
    FROM (
      SELECT 3 AS entitie_id, COUNT(*) AS cnt
      FROM cars
      WHERE brand_id = ? AND COALESCE(status, 0) <> 9
      UNION ALL
      SELECT 3 AS entitie_id, COUNT(*) AS cnt
      FROM cars c
      JOIN models m ON m.id = c.model_id
      WHERE c.brand_id IS NULL
        AND m.brand_id = ?
        AND COALESCE(c.status, 0) <> 9
      UNION ALL
      SELECT 2 AS entitie_id, COUNT(*) AS cnt
      FROM watches
      WHERE brand_id = ? AND COALESCE(status, 0) <> 9
      UNION ALL
      SELECT 2 AS entitie_id, COUNT(*) AS cnt
      FROM watches w
      JOIN models m ON m.id = w.model_id
      WHERE w.brand_id IS NULL
        AND m.brand_id = ?
        AND COALESCE(w.status, 0) <> 9
      UNION ALL
      SELECT 4 AS entitie_id, COUNT(*) AS cnt
      FROM yachts
      WHERE brand_id = ? AND COALESCE(status, 0) <> 9
      UNION ALL
      SELECT 6 AS entitie_id, COUNT(*) AS cnt
      FROM lifestyles
      WHERE brand_id = ? AND COALESCE(status, 0) <> 9
      UNION ALL
      SELECT 6 AS entitie_id, COUNT(*) AS cnt
      FROM lifestyles l
      JOIN models m ON m.id = l.model_id
      WHERE l.brand_id IS NULL
        AND m.brand_id = ?
        AND COALESCE(l.status, 0) <> 9
    ) x
    GROUP BY entitie_id
  `, [id, id, id, id, id, id, id]);

  if (!rows.length) return null;
  rows.sort((a, b) => Number(b.cnt || 0) - Number(a.cnt || 0));
  const winner = rows[0];
  if (!winner || Number(winner.cnt || 0) <= 0) return null;
  return Number(winner.entitie_id || 0) || null;
}

/* =========================================================
   GET ADMIN VIEW
========================================================= */
router.get('/', async (req, res, next) => {
  try {
    const perPage = 50;
    const {
      tab = 'brands',
      brandSearch = '',
      modelSearch = '',
      modelEntitie = '',
      brandPage = '1',
      modelPage = '1'
    } = req.query;

    const activeTab = ['brands', 'models', 'brandSeo', 'modelSeo'].includes(String(tab))
      ? String(tab)
      : 'brands';
    const brandSearchTerm = String(brandSearch || '').trim();
    const modelSearchTerm = String(modelSearch || '').trim();
    const availableEntitieIds = new Set([
      ...(res.locals.ententies || []).map(e => String(e.id)),
      '6'
    ]);
    const modelEntitieSelected = availableEntitieIds.has(String(modelEntitie || '').trim())
      ? String(modelEntitie || '').trim()
      : '';
    const requestedBrandPage = Math.max(parseInt(brandPage, 10) || 1, 1);
    const requestedModelPage = Math.max(parseInt(modelPage, 10) || 1, 1);

    const [brands] = await db.query(`
      SELECT id, name, type, de
      FROM brands
      ORDER BY name
    `);

    const [models] = await db.query(`
      SELECT m.id, m.name, m.brand_id, b.name AS brand_name, b.type AS entitie_id
      FROM models m
      JOIN brands b ON b.id = m.brand_id
      ORDER BY b.name, m.name
    `);

    // DB ist historisch teils inkonsistent (brands.type falsch gepflegt).
    // Wir leiten daher einen "effektiven" Typ aus realer Nutzung in den Entitätstabellen ab.
    const [brandTypeUsageRows] = await db.query(`
      SELECT brand_id, entitie_id, cnt
      FROM (
        SELECT brand_id, 3 AS entitie_id, COUNT(*) AS cnt
        FROM cars
        WHERE brand_id IS NOT NULL AND COALESCE(status, 0) <> 9
        GROUP BY brand_id
        UNION ALL
        SELECT m.brand_id AS brand_id, 3 AS entitie_id, COUNT(*) AS cnt
        FROM cars c
        JOIN models m ON m.id = c.model_id
        WHERE c.brand_id IS NULL AND COALESCE(c.status, 0) <> 9
        GROUP BY m.brand_id
        UNION ALL
        SELECT brand_id, 2 AS entitie_id, COUNT(*) AS cnt
        FROM watches
        WHERE brand_id IS NOT NULL AND COALESCE(status, 0) <> 9
        GROUP BY brand_id
        UNION ALL
        SELECT m.brand_id AS brand_id, 2 AS entitie_id, COUNT(*) AS cnt
        FROM watches w
        JOIN models m ON m.id = w.model_id
        WHERE w.brand_id IS NULL AND COALESCE(w.status, 0) <> 9
        GROUP BY m.brand_id
        UNION ALL
        SELECT brand_id, 4 AS entitie_id, COUNT(*) AS cnt
        FROM yachts
        WHERE brand_id IS NOT NULL AND COALESCE(status, 0) <> 9
        GROUP BY brand_id
        UNION ALL
        SELECT brand_id, 6 AS entitie_id, COUNT(*) AS cnt
        FROM lifestyles
        WHERE brand_id IS NOT NULL AND COALESCE(status, 0) <> 9
        GROUP BY brand_id
        UNION ALL
        SELECT m.brand_id AS brand_id, 6 AS entitie_id, COUNT(*) AS cnt
        FROM lifestyles l
        JOIN models m ON m.id = l.model_id
        WHERE l.brand_id IS NULL AND COALESCE(l.status, 0) <> 9
        GROUP BY m.brand_id
      ) usage_rows
    `);

    const usageByBrand = new Map();
    for (const row of brandTypeUsageRows) {
      const brandId = Number(row.brand_id);
      const entitieId = Number(row.entitie_id);
      const cnt = Number(row.cnt || 0);
      if (!brandId || !entitieId || !cnt) continue;
      if (!usageByBrand.has(brandId)) usageByBrand.set(brandId, new Map());
      usageByBrand.get(brandId).set(entitieId, cnt);
    }

    const resolveEffectiveType = (brandId, fallbackType) => {
      const usage = usageByBrand.get(Number(brandId));
      if (!usage || usage.size === 0) return Number(fallbackType);
      let winnerType = Number(fallbackType);
      let winnerCount = -1;
      for (const [typeId, count] of usage.entries()) {
        if (count > winnerCount) {
          winnerType = typeId;
          winnerCount = count;
        }
      }
      return winnerType;
    };

    for (const b of brands) {
      b.display_type = resolveEffectiveType(b.id, b.type);
    }

    const brandWhere = [];
    const brandParams = [];
    if (brandSearchTerm) {
      const term = `%${brandSearchTerm}%`;
      brandWhere.push('(CAST(id AS CHAR) LIKE ? OR name LIKE ? OR CAST(type AS CHAR) LIKE ? OR COALESCE(de, \'\') LIKE ?)');
      brandParams.push(term, term, term, term);
    }
    const brandWhereSql = brandWhere.length ? `WHERE ${brandWhere.join(' AND ')}` : '';
    const [[{ total: brandTotal }]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM brands
      ${brandWhereSql}
    `, brandParams);
    const brandTotalPages = Math.max(1, Math.ceil(brandTotal / perPage));
    const currentBrandPage = Math.min(requestedBrandPage, brandTotalPages);
    const brandOffset = (currentBrandPage - 1) * perPage;
    const [brandRows] = await db.query(`
      SELECT id, name, type, de
      FROM brands
      ${brandWhereSql}
      ORDER BY name
      LIMIT ? OFFSET ?
    `, [...brandParams, perPage, brandOffset]);

    for (const b of brandRows) {
      b.display_type = resolveEffectiveType(b.id, b.type);
    }

    const modelWhere = [];
    const modelParams = [];
    if (modelSearchTerm) {
      const term = `%${modelSearchTerm}%`;
      modelWhere.push('(CAST(m.id AS CHAR) LIKE ? OR m.name LIKE ? OR b.name LIKE ?)');
      modelParams.push(term, term, term);
    }
    if (modelEntitieSelected) {
      modelWhere.push('b.type = ?');
      modelParams.push(Number(modelEntitieSelected));
    }
    const modelWhereSql = modelWhere.length ? `WHERE ${modelWhere.join(' AND ')}` : '';
    const [[{ total: modelTotal }]] = await db.query(`
      SELECT COUNT(*) AS total
      FROM models m
      JOIN brands b ON b.id = m.brand_id
      ${modelWhereSql}
    `, modelParams);
    const modelTotalPages = Math.max(1, Math.ceil(modelTotal / perPage));
    const currentModelPage = Math.min(requestedModelPage, modelTotalPages);
    const modelOffset = (currentModelPage - 1) * perPage;
    const [modelRows] = await db.query(`
      SELECT m.id, m.name, m.brand_id, b.name AS brand_name, b.type AS entitie_id
      FROM models m
      JOIN brands b ON b.id = m.brand_id
      ${modelWhereSql}
      ORDER BY b.name, m.name
      LIMIT ? OFFSET ?
    `, [...modelParams, perPage, modelOffset]);

    for (const m of modelRows) {
      m.entitie_display_id = resolveEffectiveType(m.brand_id, m.entitie_id);
    }

    const [brandSeo] = await db.query(`
      SELECT bs.*, b.name AS brand_name, e.name AS entitie_name
      FROM brand_seo bs
      JOIN brands b ON b.id = bs.brand_id
      JOIN ententies e ON e.id = bs.entitie_id
      ORDER BY b.name
    `);

    const [modelSeo] = await db.query(`
      SELECT ms.*, m.name AS model_name, b.name AS brand_name, e.name AS entitie_name
      FROM model_seo ms
      JOIN models m ON m.id = ms.model_id
      JOIN brands b ON b.id = ms.brand_id
      JOIN ententies e ON e.id = ms.entitie_id
      ORDER BY b.name, m.name
    `);

    res.render('admin/brandmod/list', {
      active: 'modbrand',
      activeTab,
      perPage,
      brandSearch: brandSearchTerm,
      modelSearch: modelSearchTerm,
      modelEntitie: modelEntitieSelected,
      currentBrandPage,
      brandTotalPages,
      brandTotal,
      currentModelPage,
      modelTotalPages,
      modelTotal,
      brandRows,
      modelRows,
      brands,
      models,
      brandSeo,
      modelSeo
    });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   BRAND CRUD
========================================================= */
router.post('/brands/new',
  body('name').notEmpty(),
  body('entitieId').isInt(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.redirect('/admin/modbrand');
    }

    try {
      const { name, entitieId, description } = req.body;
      const finalEntitieId = normalizeBrandType(entitieId);
      if (!finalEntitieId) return res.redirect('/admin/modbrand');
      const route = BRAND_TYPE_TO_ROUTE[finalEntitieId];
      const seoname = `${route}/${makeSlug(name)}`;

      await db.query(`
        INSERT INTO brands (name, type, seoname, de, created, modified)
        VALUES (?, ?, ?, ?, NOW(), NOW())
      `, [name, finalEntitieId, seoname, description || null]);

      res.redirect('/admin/modbrand');
    } catch (err) {
      next(err);
    }
  }
);

router.post('/brands/:id/edit',
  body('name').notEmpty(),
  body('entitieId').isInt(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!req.body || !errors.isEmpty()) {
      return res.redirect('/admin/modbrand');
    }

    try {
      const { id } = req.params;
      const { name, entitieId, description } = req.body;
      const finalEntitieId = normalizeBrandType(entitieId);
      if (!finalEntitieId) return res.redirect('/admin/modbrand');
      const route = BRAND_TYPE_TO_ROUTE[finalEntitieId];
      const seoname = `${route}/${makeSlug(name)}`;

      await db.query(`
        UPDATE brands
        SET name = ?, type = ?, seoname = ?, de = ?, modified = NOW()
        WHERE id = ?
      `, [name, finalEntitieId, seoname, description || null, id]);

      res.redirect('/admin/modbrand');
    } catch (err) {
      next(err);
    }
  }
);

router.post('/brands/:id/delete', async (req, res, next) => {
  try {
    await db.query('DELETE FROM brands WHERE id = ?', [req.params.id]);
    res.redirect('/admin/modbrand');
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   MODEL CRUD
========================================================= */
router.post('/models/new',
  body('brandId').isInt(),
  body('name').notEmpty(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!req.body || !errors.isEmpty()) {
      return res.redirect('/admin/modbrand');
    }

    try {
      await db.query(
        'INSERT INTO models (brand_id, name) VALUES (?, ?)',
        [req.body.brandId, req.body.name]
      );
      res.redirect('/admin/modbrand');
    } catch (err) {
      next(err);
    }
  }
);

router.post('/models/:id/edit',
  body('brandId').isInt(),
  body('name').notEmpty(),
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!req.body || !errors.isEmpty()) {
      return res.redirect('/admin/modbrand');
    }

    try {
      await db.query(
        'UPDATE models SET brand_id = ?, name = ? WHERE id = ?',
        [req.body.brandId, req.body.name, req.params.id]
      );
      res.redirect('/admin/modbrand');
    } catch (err) {
      next(err);
    }
  }
);

router.post('/models/:id/delete', async (req, res, next) => {
  try {
    await db.query('DELETE FROM models WHERE id = ?', [req.params.id]);
    res.redirect('/admin/modbrand');
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   BRAND SEO
========================================================= */
router.post('/brands/seo/save', async (req, res, next) => {
  try {
    const {
      brand_id,
      entitie_id,
      language,
      seo_title,
      seo_description,
      seo_text
    } = req.body;

    await db.query(`
      INSERT INTO brand_seo
        (brand_id, entitie_id, language, seo_title, seo_description, seo_text)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        seo_title = VALUES(seo_title),
        seo_description = VALUES(seo_description),
        seo_text = VALUES(seo_text),
        updated_at = NOW()
    `, [
      brand_id,
      entitie_id,
      language,
      seo_title,
      seo_description,
      seo_text
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/brands/seo/:id/delete', async (req, res, next) => {
  try {
    await db.query('DELETE FROM brand_seo WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   MODEL SEO
========================================================= */
router.post('/models/seo/save', async (req, res, next) => {
  try {
    const {
      model_id,
      brand_id,
      entitie_id,
      language,
      seo_title,
      seo_description,
      seo_text
    } = req.body;

    await db.query(`
      INSERT INTO model_seo
        (model_id, brand_id, entitie_id, language, seo_title, seo_description, seo_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        seo_title = VALUES(seo_title),
        seo_description = VALUES(seo_description),
        seo_text = VALUES(seo_text),
        updated_at = NOW()
    `, [
      model_id,
      brand_id,
      entitie_id,
      language,
      seo_title,
      seo_description,
      seo_text
    ]);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/models/seo/:id/delete', async (req, res, next) => {
  try {
    await db.query('DELETE FROM model_seo WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

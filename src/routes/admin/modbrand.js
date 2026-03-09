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
      brandPage = '1',
      modelPage = '1'
    } = req.query;

    const activeTab = ['brands', 'models', 'brandSeo', 'modelSeo'].includes(String(tab))
      ? String(tab)
      : 'brands';
    const brandSearchTerm = String(brandSearch || '').trim();
    const modelSearchTerm = String(modelSearch || '').trim();
    const requestedBrandPage = Math.max(parseInt(brandPage, 10) || 1, 1);
    const requestedModelPage = Math.max(parseInt(modelPage, 10) || 1, 1);

    const [brands] = await db.query(`
      SELECT id, name, type, de
      FROM brands
      ORDER BY name
    `);

    const [models] = await db.query(`
      SELECT m.id, m.name, m.brand_id, b.name AS brand_name
      FROM models m
      JOIN brands b ON b.id = m.brand_id
      ORDER BY b.name, m.name
    `);

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

    const modelWhere = [];
    const modelParams = [];
    if (modelSearchTerm) {
      const term = `%${modelSearchTerm}%`;
      modelWhere.push('(CAST(m.id AS CHAR) LIKE ? OR m.name LIKE ? OR b.name LIKE ?)');
      modelParams.push(term, term, term);
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
      SELECT m.id, m.name, m.brand_id, b.name AS brand_name
      FROM models m
      JOIN brands b ON b.id = m.brand_id
      ${modelWhereSql}
      ORDER BY b.name, m.name
      LIMIT ? OFFSET ?
    `, [...modelParams, perPage, modelOffset]);

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
      const ent = res.locals.ententies.find(e => e.id == entitieId);
      const seoname = `${ent.route}/${makeSlug(name)}`;

      await db.query(`
        INSERT INTO brands (name, type, seoname, de, created, modified)
        VALUES (?, ?, ?, ?, NOW(), NOW())
      `, [name, entitieId, seoname, description || null]);

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
      const ent = res.locals.ententies.find(e => e.id == entitieId);
      const seoname = `${ent.route}/${makeSlug(name)}`;

      await db.query(`
        UPDATE brands
        SET name = ?, type = ?, seoname = ?, de = ?, modified = NOW()
        WHERE id = ?
      `, [name, entitieId, seoname, description || null, id]);

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

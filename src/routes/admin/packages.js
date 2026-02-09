const express = require('express');
const { body, validationResult } = require('express-validator');
const slugify = require('slugify');
const db      = require('../../db');
const router  = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const [packages] = await db.query(`
      SELECT id, name,
             duration_amt, duration_unit,
             featured, price, inseratenanzahl, sort_order
        FROM packages
       ORDER BY sort_order
    `);
    res.render('admin/packages/list', { active:'packages', packages });
  } catch (err) {
    next(err);
  }
});

router.get('/new', requireAdmin, (req, res) => {
  res.render('admin/packages/form', { active:'packages', pkg:{}, errors:[] });
});

router.post(
  '/new',
  requireAdmin,
  body('name').trim().notEmpty().withMessage('Name ist Pflicht.'),
  body('duration_amt').isInt({ min: 1 }).withMessage('Menge ≥1.'),
  body('duration_unit').isIn(['days','months','years']).withMessage('Einheit ungültig.'),
  body('price').isFloat({ min: 0 }).withMessage('Preis ≥0.'),
  body('inseratenanzahl').isInt({ min: 0 }).withMessage('Inserate-Anzahl ≥0.'),
  body('sort_order').isInt({ min: 0 }).withMessage('Reihenfolge ≥0.'),
  async (req, res, next) => {
    const errors = validationResult(req);
    const pkg = {
      id:               req.body.id?.trim() || slugify(req.body.name, { lower:true, strict:true }),
      description:      req.body.description,
      name:             req.body.name,
      duration_amt:     req.body.duration_amt,
      duration_unit:    req.body.duration_unit,
      featured:         req.body.featured === 'on' ? 1 : 0,
      price:            req.body.price,
      inseratenanzahl:  req.body.inseratenanzahl,
      sort_order:       req.body.sort_order
    };
    if (!errors.isEmpty()) {
      return res.render('admin/packages/form', { active:'packages', pkg, errors: errors.array() });
    }
    try {
      await db.query(
        `INSERT INTO packages
           (id, name, description, duration_amt, duration_unit, featured, price, inseratenanzahl, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pkg.id,
          pkg.name,
          pkg.description,        
          pkg.duration_amt,
          pkg.duration_unit,
          pkg.featured,
          pkg.price,
          pkg.inseratenanzahl,
          pkg.sort_order
        ]
      );
      req.flash('success','Paket angelegt.');
      res.redirect('/admin/packages');
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.render('admin/packages/form', {
          active:'packages',
          pkg,
          errors:[{ msg:'ID bereits vorhanden.' }]
        });
      }
      next(err);
    }
  }
);

router.get('/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const [[pkg]] = await db.query(`SELECT * FROM packages WHERE id = ?`, [req.params.id]);
    if (!pkg) return res.status(404).send('Nicht gefunden');
    res.render('admin/packages/form', { active:'packages', pkg, errors:[] });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/edit',
  requireAdmin,
  body('name').trim().notEmpty().withMessage('Name ist Pflicht.'),
  body('description').trim().notEmpty().withMessage('Beschreibung ist Pflicht.'),   // ← HIER
  body('duration_amt').isInt({ min: 1 }).withMessage('Menge ≥1.'),
  body('duration_unit').isIn(['days','months','years']).withMessage('Einheit ungültig.'),
  body('price').isFloat({ min: 0 }).withMessage('Preis ≥0.'),
  body('inseratenanzahl').isInt({ min: 0 }).withMessage('Inserate-Anzahl ≥0.'),
  body('sort_order').isInt({ min: 0 }).withMessage('Reihenfolge ≥0.'),
  async (req, res, next) => {
    const errors = validationResult(req);
    const pkg = {
      id:               req.params.id,
      name:             req.body.name,
      description:      req.body.description,    // neu
      duration_amt:     req.body.duration_amt,
      duration_unit:    req.body.duration_unit,
      featured:         req.body.featured === 'on' ? 1 : 0,
      price:            req.body.price,
      inseratenanzahl:  req.body.inseratenanzahl,
      sort_order:       req.body.sort_order
    };
    if (!errors.isEmpty()) {
      return res.render('admin/packages/form', { active:'packages', pkg, errors: errors.array() });
    }
    try {
      await db.query(
        `UPDATE packages
            SET name=?, description=?, duration_amt=?, duration_unit=?, featured=?, price=?, inseratenanzahl=?, sort_order=?
          WHERE id=?`,
        [
          pkg.name,
          pkg.description,          // mit updaten
          pkg.duration_amt,
          pkg.duration_unit,
          pkg.featured,
          pkg.price,
          pkg.inseratenanzahl,
          pkg.sort_order,
          pkg.id
        ]
      );
      req.flash('success','Paket aktualisiert.');
      res.redirect('/admin/packages');
    } catch (err) {
      next(err);
    }
  }
);


router.post('/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await db.query(`DELETE FROM packages WHERE id = ?`, [req.params.id]);
    req.flash('success','Paket gelöscht.');
    res.redirect('/admin/packages');
  } catch (err) {
    next(err);
  }
});

router.get('/userpackages', requireAdmin, async (req, res, next) => {
  try {
    const [packages] = await db.query('SELECT * FROM users_packages ORDER BY id');
    res.render('admin/packages/userpackages/list', { packages, active: 'userpackages', role: req.session.role });
  } catch (err) {
    next(err);
  }
});

// NEW FORM
router.get('/userpackages/new', requireAdmin, (req, res) => {
  res.render('admin/packages/userpackages/form', { pkg: {}, action: 'new', active: 'userpackages', role: req.session.role });
});

// CREATE
router.post('/userpackages/new', requireAdmin, async (req, res, next) => {
  try {
    const { name, category, duration_weeks, price_cents, placement_table } = req.body;
    await db.query(
      `INSERT INTO users_packages
         (name, category, placement_table, duration_weeks, price_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [name, category, placement_table || null, duration_weeks, price_cents]
    );
    res.redirect('/admin/packages/userpackages');
  } catch (err) {
    next(err);
  }
});

// EDIT FORM
router.get('/userpackages/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const [[pkg]] = await db.query(
      'SELECT * FROM users_packages WHERE id = ?',
      [req.params.id]
    );
    if (!pkg) return res.status(404).send('Nicht gefunden');
    res.render('admin/packages/userpackages/form', { pkg, action: 'edit', active: 'userpackages', role: req.session.role });
  } catch (err) {
    next(err);
  }
});

// UPDATE
router.post('/userpackages/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const { name, category, duration_weeks, price_cents, placement_table } = req.body;
    await db.query(
      `UPDATE users_packages
         SET name = ?, category = ?, placement_table = ?, duration_weeks = ?, price_cents = ?, updated_at = NOW()
       WHERE id = ?`,
      [name, category, placement_table || null, duration_weeks, price_cents, req.params.id]
    );
    res.redirect('/admin/packages/userpackages');
  } catch (err) {
    next(err);
  }
});

// DELETE
router.post('/userpackages/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM users_packages WHERE id = ?', [req.params.id]);
    res.redirect('/admin/packages/userpackages');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

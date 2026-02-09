const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const db      = require('../../db');   // je nach Projektstruktur anpassen

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Zugriffsschutz: Nur Admins dürfen rein
function ensureAdmin(req, res, next) {
  if (req.user?.role === 9) return next();
  res.redirect('/auth/login');
}

// ─────────────────────────────────────────────────────────────
// Multer: Uploads landen in /public/uploads/landing/<slug>,
// damit Bilder im Browser ohne Extra-static erreichbar sind.
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const slug = req.params.slug || req.body.slug;
    const dir  = path.join(__dirname, '../../../public/uploads/landing', slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ─────────────────────────────────────────────────────────────
// 1) Liste aller Landing-Pages
// GET /admin/landing
router.get('/', ensureAdmin, async (req, res, next) => {
  try {
    const [pages] = await db.query(`
      SELECT slug, title, created
        FROM landing_pages
       ORDER BY created DESC
    `);
    res.render('admin/landing/list', {
      pages,
      messages: req.flash(),
      active: 'landing'
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// 2) Neue Landing-Page anlegen
// GET /admin/landing/new
router.get('/new', ensureAdmin, (req, res) => {
  res.render('admin/landing/edit', {
    action: 'new',
    page:   {},
    messages: req.flash(),
    active: 'landing'
  });
});

// ─────────────────────────────────────────────────────────────
// 3) Neue Landing-Page speichern
// POST /admin/landing/new
router.post('/new',
  ensureAdmin,
  upload.fields([
    { name: 'hero_image_file', maxCount: 1 },
    { name: 'gallery_files',   maxCount: 10 }
  ]),
  async (req, res, next) => {
    try {
      const {
        slug, title, subtitle, features, cta_text, price_info
      } = req.body;

      // CKEditor: Features jetzt HTML, speichern ohne split()
      const heroImage = req.files.hero_image_file?.[0]?.filename || null;
      const gallery   = JSON.stringify((req.files.gallery_files||[]).map(f => f.filename));

      await db.query(`
        INSERT INTO landing_pages
          (slug,title,subtitle,features,hero_image,gallery,cta_text,price_info,created)
        VALUES (?,?,?,?,?,?,?,? ,NOW())
      `, [
        slug.trim(),
        title.trim(),
        subtitle.trim(),
        features || '',  // Features als HTML speichern
        heroImage,
        gallery,
        cta_text.trim(),
        price_info.trim()
      ]);

      req.flash('success', 'Landing-Page angelegt.');
      res.redirect('/admin/landing');
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 4) Landing-Page bearbeiten
// GET /admin/landing/:slug/edit
router.get('/:slug/edit', ensureAdmin, async (req, res, next) => {
  try {
    const [[page]] = await db.query(
      `SELECT * FROM landing_pages WHERE slug = ?`,
      [req.params.slug]
    );
    if (!page) return res.status(404).send('Nicht gefunden');

    page.gallery = JSON.parse(page.gallery || '[]');
    res.render('admin/landing/edit', {
      action: 'edit',
      page,
      messages: req.flash(),
      active: 'landing'
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// 5) Landing-Page speichern
// POST /admin/landing/:slug/edit
router.post('/:slug/edit',
  ensureAdmin,
  upload.fields([
    { name: 'hero_image_file', maxCount: 1 },
    { name: 'gallery_files',   maxCount: 10 }
  ]),
  async (req, res, next) => {
    try {
      const oldSlug = req.params.slug;
      const {
        slug, title, subtitle, features,
        cta_text, price_info, _old_gallery
      } = req.body;

      const oldGal  = JSON.parse(_old_gallery||'[]');
      const newGal  = (req.files.gallery_files||[]).map(f => f.filename);
      const gallery = JSON.stringify([...oldGal, ...newGal]);

      // Falls neues Hero hochgeladen, sonst alten Wert lassen
      let heroImage;
      if (req.files.hero_image_file) {
        heroImage = req.files.hero_image_file[0].filename;
      } else {
        const [[row]] = await db.query(
          `SELECT hero_image FROM landing_pages WHERE slug = ?`,
          [oldSlug]
        );
        heroImage = row.hero_image;
      }

      await db.query(`
        UPDATE landing_pages
           SET slug=?, title=?, subtitle=?, features=?,
               hero_image=?, gallery=?,
               cta_text=?, price_info=?, modified=NOW()
         WHERE slug = ?
      `, [
        slug.trim(),
        title.trim(),
        subtitle.trim(),
        features || '',  // Features als HTML speichern
        heroImage,
        gallery,
        cta_text.trim(),
        price_info.trim(),
        oldSlug
      ]);

      req.flash('success', 'Landing-Page gespeichert.');
      res.redirect('/admin/landing');
    } catch (err) {
      next(err);
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 6) Landing-Page löschen
// POST /admin/landing/:slug/delete
router.post('/:slug/delete', ensureAdmin, async (req, res, next) => {
  try {
    await db.query(`DELETE FROM landing_pages WHERE slug = ?`, [req.params.slug]);

    // optional auch Dateisystem löschen
    const folder = path.join(__dirname, '../../public/uploads/landing', req.params.slug);
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
    }

    req.flash('success', 'Landing-Page gelöscht.');
    res.redirect('/admin/landing');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

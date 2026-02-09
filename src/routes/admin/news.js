// src/routes/admin/news.js
const express = require('express');
const path    = require('path');
const fs      = require('fs').promises;
const multer  = require('multer');
const db      = require('../../db'); // dein mysql2-Pool

const router = express.Router();

// einfache Funktion statt Middleware
function requireAdmin(req, res, next) {
  if (req.user?.role !== 9) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// Multer-Storage: für neue Uploads landen Dateien zunächst in ".../news/temp",
// beim Edit direkt in ".../news/<id>"
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const newsId = req.params.id || 'temp';
    const uploadDir = path.join(
      __dirname, '../../katalog/shared/images/cms/news',
      newsId.toString()
    );
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// --------------------------------------------------------------------------
// 1) LIST: alle News anzeigen
// --------------------------------------------------------------------------
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const [rows] = await db.query(`
      SELECT id, language, title, teaser, published, status
        FROM news
       ORDER BY published DESC, id DESC
    `);
    // Achtung: die EJS-List-View iteriert jetzt über "news", nicht "newsList"
    res.render('admin/news/list', {
      active: 'news',
      news:    rows
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------------------
// 2) NEW: Formular anzeigen
// --------------------------------------------------------------------------
router.get('/new', requireAdmin, (req, res) => {
  res.render('admin/news/form', {
    active: 'news',
    news:    {},             // leeres Objekt für das Formular
    images:  [],             // noch keine Bilder
    action:  '/admin/news/new',
    method:  'POST'
  });
});

// 2a) NEW: Daten speichern und Bilder aus "temp" verschieben
router.post(
  '/new',
  requireAdmin,
  upload.array('images'),
  async (req, res, next) => {
    try {
      const { language, title, teaser, description, status, published } = req.body;
      const [result] = await db.query(`
        INSERT INTO news
          (language, title, teaser, description, status, published, created, modified)
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [language, title, teaser, description, status, published]);
      const newId = result.insertId;

      // Temp → Final verschieben
      const tempDir  = path.join(__dirname, '../../katalog/shared/images/cms/news/temp');
      const finalDir = path.join(__dirname, '../../katalog/shared/images/cms/news', String(newId));
      await fs.mkdir(finalDir, { recursive: true });
      let files = [];
      try { files = await fs.readdir(tempDir); } catch (_) { /* none */ }
      await Promise.all(files.map(f =>
        fs.rename(path.join(tempDir, f), path.join(finalDir, f))
      ));

      res.redirect('/admin/news');
    } catch (err) {
      next(err);
    }
  }
);

// --------------------------------------------------------------------------
// 3) EDIT: Formular anzeigen
// --------------------------------------------------------------------------
router.get('/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const newsId = req.params.id;
    const [rows] = await db.query(`SELECT * FROM news WHERE id = ?`, [newsId]);
    if (!rows.length) return res.status(404).send('Not found');
    const news = rows[0];

    // bereits hochgeladene Bilder listen
    const imgDir = path.join(__dirname, '../../katalog/shared/images/cms/news', newsId);
    let images = [];
    try { images = await fs.readdir(imgDir); } catch (_) { /* none */ }

    res.render('admin/news/form', {
      active: 'news',
      news,
      images,
      action: `/admin/news/${newsId}/edit`,
      method: 'POST'
    });
  } catch (err) {
    next(err);
  }
});

// 3a) EDIT: speichern (Neue Uploads landen dank storage direkt im Ordner <id>)
router.post(
  '/:id/edit',
  requireAdmin,
  upload.array('images'),
  async (req, res, next) => {
    try {
      const newsId = req.params.id;
      const { language, title, teaser, description, status, published } = req.body;
      await db.query(`
        UPDATE news
           SET language    = ?,
               title       = ?,
               teaser      = ?,
               description = ?,
               status      = ?,
               published   = ?,
               modified    = NOW()
         WHERE id = ?
      `, [language, title, teaser, description, status, published, newsId]);

      res.redirect('/admin/news');
    } catch (err) {
      next(err);
    }
  }
);

// --------------------------------------------------------------------------
// 4) DELETE: Artikel & Bilder löschen
// --------------------------------------------------------------------------
router.post('/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    const newsId = req.params.id;
    await db.query(`DELETE FROM news WHERE id = ?`, [newsId]);
    const imgDir = path.join(__dirname, '../../katalog/shared/images/cms/news', newsId);
    await fs.rm(imgDir, { recursive: true, force: true });
    res.redirect('/admin/news');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

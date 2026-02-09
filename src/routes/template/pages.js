const express = require('express');
const router  = express.Router();
const db      = require('../db');

router.get('/pages', async (req, res, next) => {
  const [rows] = await db.query(`SELECT id, slug, title, created, modified FROM pages ORDER BY slug`);
  res.render('admin/pages/list', { pages: rows, active: 'pages', messages: req.flash() });
});

router.get('/:pageKey', async (req, res, next) => {
  try {
    const pageKey = req.params.pageKey;

    // 1) Hole die Seite
    const [[page]] = await db.query(
      `SELECT slug, title, content
         FROM pages
        WHERE slug = ?`,
      [pageKey]
    );
    if (!page) {
      return res.status(404).render('404', { url: req.originalUrl });
    }

    // 2) Kategorien für die Navbar
    const [entieties] = await db.query(`
      SELECT name, route
        FROM ententies
       ORDER BY name
    `);

    // 3) Rendern
    res.render('pages/templates/pages/show', {
      page,
      entieties
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

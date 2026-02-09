const express = require('express');
const router = express.Router();
const db = require('../../db');

// URL/Domain abstreifen -> Pfad normalisieren
function toPathPattern(input) {
  if (!input) return '/';
  let s = String(input).trim();
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, ''); // http(s)://domain.tld weg
  s = s.replace(/(\?.*)|(#.*)$/g, '');    // query/hash weg
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

// LISTE (Seite 1)
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  let sql = 'SELECT * FROM seo_meta';
  const params = [];
  if (q) {
    sql += ' WHERE path_pattern LIKE ? OR title LIKE ?';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY priority ASC, path_pattern ASC';

  try {
    const [rows] = await db.query(sql, params);
    res.render('admin/seo/list', {
      headerTitle: 'SEO – Liste',
      login_user: req.user,
      currentUrl: req.url,
      seoItems: rows,
      q,
      flashSuccess: req.query.msg === 'ok' ? 'Änderung gespeichert.' : null,
      flashError: req.query.err ? 'Es ist ein Fehler aufgetreten.' : null,
      active: 'seo'
    });
  } catch (e) {
    console.error(e);
    res.render('admin/seo/list', {
      headerTitle: 'SEO – Liste',
      login_user: req.user,
      currentUrl: req.url,
      seoItems: [],
      q,
      flashError: 'DB-Fehler beim Laden.',
      active: 'seo'
    });
  }
});

// VERWALTEN – Neu
router.get('/manage', async (req, res) => {
  res.render('admin/seo/manage', {
    headerTitle: 'SEO neu anlegen',
    login_user: req.user,
    currentUrl: req.url,
    item: null,
    active: 'seo'
  });
});

// VERWALTEN – Bearbeiten (ohne ()-Regex im Pfad!)
router.get('/manage/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.redirect('/admin/seo?err=bad_id');
  }
  try {
    const [[row]] = await db.query('SELECT * FROM seo_meta WHERE id=? LIMIT 1', [id]);
    if (!row) return res.redirect('/admin/seo?err=notfound');

    res.render('admin/seo/manage', {
      headerTitle: 'SEO verwalten',
      login_user: req.user,
      currentUrl: req.url,
      item: row,
      active: 'seo'
    });
  } catch (e) {
    console.error(e);
    res.redirect('/admin/seo?err=db_load');
  }
});

// CREATE/UPDATE (ein Endpunkt)
router.post('/save', async (req, res) => {
  try {
    const {
      id, url_or_path, title, description,
      robots = 'index,follow',
      og_title, og_description, og_image,
      twitter_card = 'summary_large_image',
      jsonld = '',
      priority = 100
    } = req.body;

    const path_pattern = toPathPattern(url_or_path);
    const jsonldValue = jsonld && String(jsonld).trim() ? jsonld : null;

    if (id && String(id).trim() !== '') {
      await db.query(
        `UPDATE seo_meta SET
          path_pattern=?, title=?, description=?, robots=?, og_title=?, og_description=?, og_image=?, twitter_card=?, jsonld=?, priority=?
         WHERE id=?`,
        [path_pattern, title, description, robots, og_title, og_description, og_image, twitter_card, jsonldValue, Number(priority), id]
      );
    } else {
      await db.query(
        `INSERT INTO seo_meta
         (path_pattern, title, description, robots, og_title, og_description, og_image, twitter_card, jsonld, priority)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [path_pattern, title, description, robots, og_title, og_description, og_image, twitter_card, jsonldValue, Number(priority)]
      );
    }
    res.redirect('/admin/seo?msg=ok');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/seo?err=save');
  }
});

// DELETE
router.post('/delete', async (req, res) => {
  const { id } = req.body;
  try {
    const numId = parseInt(id, 10);
    if (Number.isFinite(numId)) {
      await db.query('DELETE FROM seo_meta WHERE id=?', [numId]);
    }
    res.redirect('/admin/seo?msg=ok');
  } catch (e) {
    console.error(e);
    res.redirect('/admin/seo?err=delete');
  }
});

module.exports = router;

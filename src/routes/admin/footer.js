const express = require('express');
const db = require('../../db'); // Passe Pfad zu Deinem DB-Modul an
const router = express.Router();

// Middleware: Nur Admins
function ensureAdmin(req, res, next) {
  if (req.user && req.user.role === 9) {
    return next();
  }
  res.redirect('/auth/login');
}

// GET /admin/footer - Liste der Spalten und Links
router.get('/', ensureAdmin, async (req, res, next) => {
  try {
    // Spalten laden
    const [columns] = await db.query(
      'SELECT id, title, sort_order FROM footer_columns ORDER BY sort_order, title'
    );
    // Links laden
    const [links] = await db.query(
      'SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order FROM footer_links ORDER BY column_id, sort_order'
    );
    // Gruppieren
    const footerColumns = columns.map(col => ({
      ...col,
      links: links.filter(link => link.column_id === col.id)
    }));
    // Render mit active-Flag für Sidebar
    res.render('admin/footer/list', { footerColumns, messages: req.flash(), active: 'footer' });
  } catch (err) {
    next(err);
  }
});

// === Spalten CRUD ===

// POST /admin/footer/columns/new
router.post('/columns/new', ensureAdmin, async (req, res, next) => {
  try {
    const { title, sort_order } = req.body;
    await db.query(
      'INSERT INTO footer_columns (title, sort_order) VALUES (?, ?)',
      [title.trim(), Number(sort_order) || 0]
    );
    req.flash('success', 'Spalte angelegt.');
    res.redirect('/admin/footer');
  } catch (err) {
    next(err);
  }
});

// POST /admin/footer/columns/:id/edit
router.post('/columns/:id/edit', ensureAdmin, async (req, res, next) => {
  try {
    const { title, sort_order } = req.body;
    await db.query(
      'UPDATE footer_columns SET title = ?, sort_order = ? WHERE id = ?',
      [title.trim(), Number(sort_order) || 0, req.params.id]
    );
    req.flash('success', 'Spalte aktualisiert.');
    res.redirect('/admin/footer');
  } catch (err) {
    next(err);
  }
});

// POST /admin/footer/columns/:id/delete
router.post('/columns/:id/delete', ensureAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM footer_columns WHERE id = ?', [req.params.id]);
    req.flash('success', 'Spalte gelöscht.');
    res.redirect('/admin/footer');
  } catch (err) {
    next(err);
  }
});

// === Links CRUD ===

// POST /admin/footer/links/new
router.post('/links/new', ensureAdmin, async (req, res, next) => {
  try {
    const { column_id, link_text, link_url, is_phone, phone_number, sort_order } = req.body;
    await db.query(
      'INSERT INTO footer_links (column_id, link_text, link_url, is_phone, phone_number, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [
        Number(column_id),
        link_text.trim(),
        link_url.trim(),
        is_phone === 'on' ? 1 : 0,
        phone_number ? phone_number.trim() : null,
        Number(sort_order) || 0
      ]
    );
    req.flash('success', 'Link angelegt.');
    res.redirect('/admin/footer');
  } catch (err) {
    next(err);
  }
});

// POST /admin/footer/links/:id/edit
router.post('/links/:id/edit', ensureAdmin, async (req, res, next) => {
  try {
    const { link_text, link_url, is_phone, phone_number, sort_order } = req.body;
    await db.query(
      'UPDATE footer_links SET link_text = ?, link_url = ?, is_phone = ?, phone_number = ?, sort_order = ? WHERE id = ?',
      [
        link_text.trim(),
        link_url.trim(),
        is_phone === 'on' ? 1 : 0,
        phone_number ? phone_number.trim() : null,
        Number(sort_order) || 0,
        req.params.id
      ]
    );
    req.flash('success', 'Link aktualisiert.');
    res.redirect('/admin/footer');
  } catch (err) {
    next(err);
  }
});

// POST /admin/footer/links/:id/delete
router.post('/links/:id/delete', ensureAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM footer_links WHERE id = ?', [req.params.id]);
    req.flash('success', 'Link gelöscht.');
    res.redirect('/admin/footer');
  } catch (err) {
    next(err);
  }
});

module.exports = router;

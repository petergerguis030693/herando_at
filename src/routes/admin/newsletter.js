// src/routes/admin/newsletter.js
const express = require('express');
const router = express.Router();
const db = require('../../db');
const nodemailer = require('nodemailer');

// -------------------------------------------------------------
// Middleware: Body-Parser nur für diesen Router
// -------------------------------------------------------------
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// -------------------------------------------------------------
// E-Mail Transporter
// -------------------------------------------------------------
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// -------------------------------------------------------------
// View: Admin-Seite
// GET /admin/newsletter/
// -------------------------------------------------------------
router.get('/', (req, res) => {
  res.render('admin/admin-newsletter', {
    login_user: req.user,
    currentUrl: req.url,
    headerTitle: 'Newsletter & Nachrichten',
    active: 'Newsletter'
  });
});

// =============================================================
// 1) Gruppen (CRUD + Mitglieder)
// Base: /admin/newsletter
// =============================================================

// Alle Gruppen
router.get('/groups', async (req, res, next) => {
  try {
    const [groups] = await db.query('SELECT * FROM user_groups ORDER BY id DESC');
    res.json(groups);
  } catch (err) { next(err); }
});

// Gruppe erstellen
router.post('/groups', async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });
    await db.query(
      'INSERT INTO user_groups (name, description) VALUES (?, ?)',
      [name, description || null]
    );
    res.json({ success: true, message: 'Gruppe erstellt' });
  } catch (err) { next(err); }
});

// Gruppe löschen
router.delete('/groups/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM user_groups WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Gruppe gelöscht' });
  } catch (err) { next(err); }
});

// Mitglieder-IDs einer Gruppe laden
router.get('/groups/:id/members', async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT user_id FROM user_group_members WHERE group_id = ?',
      [req.params.id]
    );
    res.json(rows.map(r => r.user_id));
  } catch (err) { next(err); }
});

// Mitglieder einer Gruppe ERSETZEN (vollständiges Set speichern)
router.put('/groups/:id/members', async (req, res, next) => {
  const { user_ids } = req.body; // erwartet Array<number>
  if (!Array.isArray(user_ids)) {
    return res.status(400).json({ error: 'user_ids muss ein Array sein' });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // alte Zuordnungen entfernen
    await conn.query('DELETE FROM user_group_members WHERE group_id = ?', [req.params.id]);

    // neue setzen
    if (user_ids.length > 0) {
      const values = user_ids.map(uid => [uid, req.params.id]);
      await conn.query(
        'INSERT INTO user_group_members (user_id, group_id) VALUES ?',
        [values]
      );
    }

    await conn.commit();
    res.json({ success: true, message: 'Mitglieder aktualisiert' });
  } catch (err) {
    if (conn) await conn.rollback();
    next(err);
  } finally {
    if (conn) conn.release();
  }
});

// (Optional) Mitglieder ADDITIV hinzufügen (bestehendes bleibt bestehen)
router.post('/groups/:id/members', async (req, res, next) => {
  try {
    const { user_ids } = req.body; // Array<number>
    if (!Array.isArray(user_ids)) {
      return res.status(400).json({ error: 'user_ids muss ein Array sein' });
    }
    const values = user_ids.map(uid => [uid, req.params.id]);
    if (values.length > 0) {
      await db.query(
        'INSERT IGNORE INTO user_group_members (user_id, group_id) VALUES ?',
        [values]
      );
    }
    res.json({ success: true, message: 'Mitglieder hinzugefügt' });
  } catch (err) { next(err); }
});

// =============================================================
// 2) Users (Listing für Auswahl in der UI)
// =============================================================
router.get('/users', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [];
    let sql = `
      SELECT id, email, firstname, lastname, company, confirmed, created
      FROM users
      WHERE email IS NOT NULL
    `;
    if (q) {
      sql += ` AND (email LIKE ? OR firstname LIKE ? OR lastname LIKE ? OR company LIKE ?)`;
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    sql += ` ORDER BY confirmed DESC, created DESC LIMIT 500`;
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// =============================================================
// 3) Templates (CRUD)
// =============================================================
router.get('/templates', async (req, res, next) => {
  try {
    const [templates] = await db.query('SELECT * FROM notification_templates ORDER BY id DESC');
    res.json(templates);
  } catch (err) { next(err); }
});

router.post('/templates', async (req, res, next) => {
  try {
    const { type, name, subject, body } = req.body;
    if (!type || !name || !subject || !body) {
      return res.status(400).json({ error: 'type, name, subject, body sind erforderlich' });
    }
    await db.query(
      'INSERT INTO notification_templates (type, name, subject, body) VALUES (?, ?, ?, ?)',
      [type, name, subject, body]
    );
    res.json({ success: true, message: 'Template erstellt' });
  } catch (err) { next(err); }
});

router.delete('/templates/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM notification_templates WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Template gelöscht' });
  } catch (err) { next(err); }
});

// =============================================================
// 4) Senden (per Template)
// =============================================================
router.post('/notifications/send', async (req, res, next) => {
  try {
    const { group_id, template_id } = req.body;

    // Template laden
    const [tplRows] = await db.query(
      'SELECT * FROM notification_templates WHERE id = ?',
      [template_id]
    );
    if (!tplRows.length) {
      return res.status(400).json({ error: 'Template nicht gefunden' });
    }
    const tpl = tplRows[0];

    // Mitglieder der Gruppe
    const [users] = await db.query(
      `SELECT u.id, u.email, u.firstname, u.lastname
         FROM users u
         JOIN user_group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = ?`,
      [group_id]
    );
    if (!users.length) {
      return res.status(400).json({ error: 'Keine Mitglieder in dieser Gruppe' });
    }

    // Speichern + E-Mail senden (+ Log)
    for (const user of users) {
      // sender_id mitschreiben, sent_at setzen
      const [result] = await db.query(
        `INSERT INTO user_notifications
           (user_id, sender_id, type, template_id, subject, body, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [user.id, req.session.userId || null, tpl.type, template_id, tpl.subject, tpl.body]
      );

      // E-Mail Hinweis (Fehler je User nicht abbrechen lassen)
      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: user.email,
          subject: `Neue ${tpl.type} von Herando`,
          text: `Hallo ${user.firstname || ''}, Sie haben eine neue ${tpl.type} in Ihrem Dashboard.`
        });
      } catch (mailErr) {
        console.error('Mailer error for user', user.id, mailErr);
      }

      await db.query(
        'INSERT INTO notification_email_log (notification_id) VALUES (?)',
        [result.insertId]
      );
    }

    res.json({ success: true, message: `Nachricht an ${users.length} Nutzer gesendet` });
  } catch (err) { next(err); }
});


router.post('/notifications/compose', async (req, res, next) => {
  try {
    const { group_id, subject, body } = req.body;

    if (!group_id)  return res.status(400).json({ error: 'group_id erforderlich' });
    if (!subject)   return res.status(400).json({ error: 'Betreff erforderlich' });
    if (!body)      return res.status(400).json({ error: 'Nachricht erforderlich' });

    // Empfänger der Gruppe laden
    const [users] = await db.query(
      `SELECT u.id, u.email, u.firstname, u.lastname
         FROM users u
         JOIN user_group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = ?`,
      [group_id]
    );
    if (!users.length) {
      return res.status(400).json({ error: 'Keine Mitglieder in dieser Gruppe' });
    }

    // In user_notifications speichern + Mailhinweis schicken
    for (const user of users) {
      const [result] = await db.query(
        `INSERT INTO user_notifications
           (user_id, sender_id, type, template_id, subject, body, sent_at)
         VALUES (?, ?, 'message', ?, ?, ?, NOW())`,
        [user.id, req.session.userId || null, null, subject, body]
      );

      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: user.email,
          subject: subject,
          text: `Hallo ${user.firstname || ''},\n\n${body}`
        });
      } catch (mailErr) {
        console.error('Mailer error for user', user.id, mailErr);
      }

      await db.query(
        'INSERT INTO notification_email_log (notification_id) VALUES (?)',
        [result.insertId]
      );
    }

    res.json({ success: true, message: `Nachricht an ${users.length} Nutzer gesendet` });
  } catch (err) { next(err); }
});


router.get('/notifications/inbox', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = (page - 1) * limit;

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = ?',
      [userId]
    );

    const [items] = await db.query(
      `SELECT n.id, n.subject, n.body, n.type, n.template_id, n.read_at, n.sent_at,
              s.firstname AS sender_firstname, s.lastname AS sender_lastname, s.email AS sender_email
         FROM user_notifications n
    LEFT JOIN users s ON s.id = n.sender_id
        WHERE n.user_id = ?
     ORDER BY n.sent_at DESC
        LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    res.json({ total, page, limit, items });
  } catch (err) { next(err); }
});

// Gesendet vom aktuellen User
router.get('/notifications/sent', async (req, res, next) => {
  try {
    const senderId = req.session.userId;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = (page - 1) * limit;

    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM user_notifications WHERE sender_id IS NOT NULL AND sender_id = ?',
      [senderId]
    );

    const [items] = await db.query(
      `SELECT n.id, n.subject, n.body, n.type, n.template_id, n.sent_at,
              r.id AS receiver_id, r.firstname AS receiver_firstname, r.lastname AS receiver_lastname, r.email AS receiver_email
         FROM user_notifications n
         JOIN users r ON r.id = n.user_id
        WHERE n.sender_id IS NOT NULL AND n.sender_id = ?
     ORDER BY n.sent_at DESC
        LIMIT ? OFFSET ?`,
      [senderId, limit, offset]
    );

    res.json({ total, page, limit, items });
  } catch (err) { next(err); }
});

// Nachricht-Detail (sichtbar für Absender oder Empfänger) + als gelesen markieren
router.get('/notifications/:id', async (req, res, next) => {
  try {
    const myId = req.session.userId;
    const id = req.params.id;

    const [[row]] = await db.query(
      `SELECT n.*, 
              s.email AS sender_email, s.firstname AS sender_firstname, s.lastname AS sender_lastname,
              r.email AS receiver_email, r.firstname AS receiver_firstname, r.lastname AS receiver_lastname
         FROM user_notifications n
    LEFT JOIN users s ON s.id = n.sender_id
         JOIN users r ON r.id = n.user_id
        WHERE n.id = ? AND (n.user_id = ? OR n.sender_id = ?)`,
      [id, myId, myId]
    );

    if (!row) return res.status(404).json({ error: 'Nachricht nicht gefunden' });

    // als gelesen markieren, wenn ich Empfänger bin und read_at noch NULL
    if (row.user_id === myId && !row.read_at) {
      await db.query('UPDATE user_notifications SET read_at = NOW() WHERE id = ?', [id]);
      row.read_at = new Date(); // lokale Aktualisierung
    }

    res.json(row);
  } catch (err) { next(err); }
});

// Empfangene Nachrichten vom aktuellen User
router.get("/notifications/received", async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = (page - 1) * limit;

    // Gesamtanzahl für Pagination
    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM user_notifications WHERE user_id = ?',
      [userId]
    );

    // Nachrichten mit Absender-Daten
    const [items] = await db.query(
      `SELECT n.id, n.subject, n.body, n.type, n.template_id, n.read_at, n.sent_at,
              s.firstname AS sender_firstname, s.lastname AS sender_lastname, s.email AS sender_email
         FROM user_notifications n
         JOIN users s ON s.id = n.sender_id
        WHERE n.user_id = ?
     ORDER BY n.sent_at DESC
        LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    res.json({ total, page, limit, items });
  } catch (err) {
    next(err);
  }
});



// -------------------------------------------------------------
// Fehler-Handler: immer JSON für API (MUSS zuletzt kommen)
// -------------------------------------------------------------
router.use((err, req, res, next) => {
  console.error('Newsletter error:', err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message || 'Unbekannter Fehler im Newsletter-Modul',
    code: 'NEWSLETTER_ERROR'
  });
});

module.exports = router;

// routes/template/auth.js
require('dotenv').config();
const express = require('express');
const bcrypt  = require('bcrypt');
const db      = require('../../db');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const token = crypto.randomBytes(32).toString('hex');

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase());
}


const router = express.Router();

async function tBackend(key, lang = 'de') {
  const [[row]] = await db.query(
    `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
    [lang, key]
  );
  return row?.txt || key;
}


// ─── Hilfsfunktion für Navbar ─────────────────────────────────────────────
async function loadEntieties(req, res, next) {
  try {
    const [ents] = await db.query(
      'SELECT id, name, route FROM ententies ORDER BY name'
    );
    res.locals.entieties = ents;
    next();
  } catch (err) {
    next(err);
  }
}

async function loadCountries(req) {
  const lang = req.session?.lang || 'de';
  const allowed = ['de','en','cs','es','fr','it','nl','pl','tr','ru','ja','zh'];
  const col = allowed.includes(lang) ? lang : 'en';

  const [countries] = await db.query(
    `
    SELECT id, COALESCE(??, en) AS name
    FROM countries
    WHERE visible = 1
    ORDER BY name
    `,
    [col]
  );

  return countries;
}

router.get('/login', loadEntieties, (req, res) => {
  res.render('pages/templates/login', {
    error: req.session.loginError || null
  });
  delete req.session.loginError;
});

router.get('/register', async (req, res) => {
  try {
    // Sprache bestimmen
    const lang =
      req.session?.lang ||
      req.locale ||
      'de';

    // nur erlaubte Sprachspalten zulassen
    const allowedLangs = ['de','en','cs','es','fr','it','nl','pl','tr','ru','ja','zh'];
    const col = allowedLangs.includes(lang) ? lang : 'en';

    const [countries] = await db.query(
      `
      SELECT
        id,
        COALESCE(??, en) AS name
      FROM countries
      WHERE visible = 1
      ORDER BY name
      `,
      [col]
    );

    res.render('pages/templates/register', {
      error: null,
      success: null,
      headerTitle: 'Registrierung',
      currentUrl: req.url,
      login_user: req.user || null,
      countries
    });

  } catch (err) {
    console.error('❌ Fehler bei GET /register:', err);
    res.status(500).send('Interner Serverfehler');
  }
});


router.post('/register', async (req, res) => {
  try {
    console.log('📥 POST /auth/register erhalten');
    console.log('➡️ Request Body:', req.body);

    const {
      type,                // 'private' | 'commercial'
      gender,
      firstname,
      lastname,
      email,
      password,
      password_repeat,
      company,
      street,
      housenumber,
      postcode,
      city,
      country_id,
      phone,
      mobile,
      fax,
      website,
      vatid,
      imprint,
      details_name_hidden,
      details_phone_hidden,
      privacy_accepted
    } = req.body;

    // 🔒 0️⃣ WICHTIG: Registrierung NUR für Gäste
    if (req.session?.userId) {
      return res.status(400).json({
        success: false,
        error: 'Du bist bereits eingeloggt. Registrierung ist nicht erlaubt.'
      });
    }

    // 🔒 1️⃣ Typ validieren
    if (!['private', 'commercial'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Ungültiger Registrierungstyp.'
      });
    }

    // 🔒 2️⃣ Passwort prüfen
    if (!password || password !== password_repeat) {
      return res.status(400).json({
        success: false,
        error: 'Passwörter stimmen nicht überein.'
      });
    }

    // 🔒 3️⃣ E-Mail global eindeutig
    const [[exists]] = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (exists) {
      return res.status(400).json({
        success: false,
        error: 'Diese E-Mail-Adresse ist bereits registriert.'
      });
    }

    // 🧠 4️⃣ Rolle bestimmen
    const role = type === 'commercial' ? 1 : 2;
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date();

    // 💾 5️⃣ User speichern (confirmed = 0!)
    const [result] = await db.query(`
      INSERT INTO users (
        role, gender, firstname, lastname, email, password,
        company, street, housenumber, postcode, city, country_id,
        phone, mobile, fax, website, vatid, imprint,
        details_name_hidden, details_phone_hidden, privacy_accepted,
        confirmed, created, modified
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [
      role,
      gender || null,
      firstname,
      lastname,
      email,
      hashedPassword,
      company || null,
      street || null,
      housenumber || null,
      postcode || null,
      city || null,
      country_id || null,
      phone || null,
      mobile || null,
      fax || null,
      website || null,
      vatid || null,
      imprint || null,
      details_name_hidden ? 1 : 0,
      details_phone_hidden ? 1 : 0,
      privacy_accepted ? 1 : 0,
      now,
      now
    ]);

    const newUserId = result.insertId;
    console.log(`✅ Neuer Benutzer gespeichert (ID ${newUserId}, unbestätigt)`);

    // 🔑 6️⃣ E-Mail-Verifikation
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(`
      INSERT INTO email_verifications (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `, [newUserId, token, expiresAt]);

    const verifyUrl = `${process.env.BASE_URL}/auth/verify-email?token=${token}`;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'E-Mail-Adresse bestätigen',
      html: `
        <p>Hallo ${firstname},</p>
        <p>Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren:</p>
        <p>
          <a href="${verifyUrl}" target="_blank"
             style="display:inline-block;color:#ffffff;background:#c39052;padding:10px;text-decoration:none">
            E-Mail bestätigen
          </a>
        </p>
      `
    });

    // ✅ 7️⃣ KEIN Login, KEIN Redirect
    return res.json({
      success: true,
      requiresEmailVerification: true,
      message: 'Registrierung erfolgreich. Bitte E-Mail bestätigen.'
    });

  } catch (err) {
    console.error('❌ Fehler bei /auth/register:', err);
    return res.status(500).json({
      success: false,
      error: 'Interner Fehler bei der Registrierung'
    });
  }
});

router.post('/register-private', async (req, res) => {
  try {
    const { firstname, lastname, email, password, password_repeat, privacy_accepted } = req.body;

    // 1️⃣ Passwort prüfen
    if (!password || password !== password_repeat) {
      return res.render('pages/templates/register', {
        error: '❌ Passwörter stimmen nicht überein.',
        success: null,
        headerTitle: 'Registrierung',
        currentUrl: req.url,
        login_user: req.user || null
      });
    }

    // 2️⃣ E-Mail prüfen
    const [[exists]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (exists) {
      return res.render('pages/templates/register', {
        error: '⚠️ Diese E-Mail-Adresse ist bereits registriert.',
        success: null,
        headerTitle: 'Registrierung',
        currentUrl: req.url,
        login_user: req.user || null
      });
    }

    // 3️⃣ Passwort hashen und Benutzer speichern
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date();

    const [result] = await db.query(`
      INSERT INTO users (role, firstname, lastname, email, password, privacy_accepted, confirmed, created, modified)
      VALUES (2, ?, ?, ?, ?, ?, 0, ?, ?)
    `, [firstname, lastname, email, hashedPassword, privacy_accepted ? 1 : 0, now, now]);

    const newUserId = result.insertId;

    // 4️⃣ Token generieren und in DB speichern
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(`
      INSERT INTO email_verifications (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `, [newUserId, token, expiresAt]);

    // 5️⃣ E-Mail-Link generieren
    const verifyUrl = `${process.env.BASE_URL}/auth/verify-email?token=${token}`;

    // 6️⃣ Mail konfigurieren
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    // 7️⃣ Mail senden
    await transporter.sendMail({
      from: `"Herando Neuregstrierung" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'E-Mail-Adresse bestätigen und jetzt einloggen',
      html: `
        <p>Sehr geehrte/r Frau/Herr ${firstname},</p>
        <p>bitte klicken Sie auf den folgenden Link, um Ihre E-Mail-Adresse zu bestätigen und sich direkt einzuloggen:</p>
        <p>
          <a href="${verifyUrl}" target="_blank" style="display:inline-block;color:#ffffff;background-color:#c39052;border:none;box-sizing:border-box;text-decoration:none;font-size:16px;font-weight:400;margin:0;padding:10px">
          Jetzt bestätigen & einloggen
          </a>
        </p>
        <p>Ihr Herando-Team</p>
      `
    });

    console.log(`📧 Bestätigungsmail gesendet an ${email}`);

    // 8️⃣ Erfolgsmeldung anzeigen
    return res.render('pages/templates/register', {
      error: null,
      success: '✅ Ihre Registrierung war erfolgreich! Bitte prüfen Sie Ihr E-Mail-Postfach zur Bestätigung.',
      headerTitle: 'Registrierung erfolgreich',
      currentUrl: req.url,
      login_user: req.user || null
    });

  } catch (err) {
    console.error('❌ Fehler bei /auth/register-private:', err);
    return res.render('pages/templates/register', {
      error: '❌ Interner Fehler bei der Registrierung. Bitte versuchen Sie es später erneut.',
      success: null,
      headerTitle: 'Registrierung',
      currentUrl: req.url,
      login_user: req.user || null
    });
  }
});

router.post('/register-basic', async (req, res) => {
  try {

    // 🌍 Sprache pro Request
    const lang = req.session?.lang || 'de';

    // 🔤 Backend-Übersetzer
    async function tBackend(key, lang) {
      const [[row]] = await db.query(
        `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
        [lang, key]
      );
      return row?.txt || key;
    }

    const countries = await loadCountries(req);

    const {
      type,
      gender,
      firstname,
      lastname,
      email,
      password,
      password_repeat,
      country_id,
      privacy_accepted,
      street,
      housenumber,
      postcode,
      city
    } = req.body;

    // ❌ Passwort prüfen
    if (!password || password !== password_repeat) {
      return res.render('pages/templates/register', {
        error: await tBackend('register.error.password_mismatch', lang),
        success: null,
        headerTitle: await tBackend('register.title', lang),
        currentUrl: req.url,
        login_user: null,
        countries
      });
    }

    // ❌ Datenschutz
    if (!privacy_accepted) {
      return res.render('pages/templates/register', {
        error: await tBackend('register.error.privacy', lang),
        success: null,
        headerTitle: await tBackend('register.title', lang),
        currentUrl: req.url,
        login_user: null,
        countries
      });
    }

    // ❌ E-Mail existiert
    const [[exists]] = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (exists) {
      return res.render('pages/templates/register', {
        error: await tBackend('register.error.email_exists', lang),
        success: null,
        headerTitle: await tBackend('register.title', lang),
        currentUrl: req.url,
        login_user: null,
        countries
      });
    }

    // 👤 Rolle
    const role = type === 'commercial' ? 1 : 2;
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date();

    // ✅ User speichern
    const [result] = await db.query(
      `
      INSERT INTO users (
        role,
        gender,
        firstname,
        lastname,
        email,
        password,
        street,
        housenumber,
        postcode,
        city,
        country_id,
        language,
        ip_registration,
        privacy_accepted,
        confirmed,
        created,
        modified
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `,
      [
        role,
        gender || null,
        firstname,
        lastname,
        email,
        hashedPassword,
        street || null,
        housenumber || null,
        postcode || null,
        city || null,
        country_id || null,
        lang,
        req.ip,
        privacy_accepted ? 1 : 0,
        now,
        now
      ]
    );

    // ✉️ Verifikation
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(
      `INSERT INTO email_verifications (user_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [result.insertId, token, expiresAt]
    );

    const verifyUrl = `${process.env.BASE_URL}/auth/verify-email?token=${token}`;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    // 🧑 Anrede
    let salutationKey = 'email.salutation.default';
    if (gender == 1) salutationKey = 'email.salutation.m';
    else if (gender == 2) salutationKey = 'email.salutation.f';
    else if (gender == 3) salutationKey = 'email.salutation.d';

    const salutation = await tBackend(salutationKey, lang);

    // 📧 Mailtexte
    const mailSubject = await tBackend('email.verify.subject', lang);
    const mailIntro   = await tBackend('email.verify.intro', lang);
    const mailAction  = await tBackend('email.verify.action', lang);

    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: email,
      subject: mailSubject,
      html: `
        <p>${salutation} ${firstname} ${lastname},</p>
        <p>${mailIntro}</p>
        <p><a href="${verifyUrl}">${mailAction}</a></p>
      `
    });

    // ✅ Erfolg
    return res.render('pages/templates/register', {
      error: null,
      success: await tBackend('register.success', lang),
      headerTitle: await tBackend('register.success.title', lang),
      currentUrl: req.url,
      login_user: null,
      countries
    });

  } catch (err) {
    console.error('❌ POST /register-basic:', err);

    const lang = req.session?.lang || 'de';
    const countries = await loadCountries(req);

    async function tBackend(key, lang) {
      const [[row]] = await db.query(
        `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
        [lang, key]
      );
      return row?.txt || key;
    }

    return res.render('pages/templates/register', {
      error: await tBackend('register.error.internal', lang),
      success: null,
      headerTitle: await tBackend('register.title', lang),
      currentUrl: req.url,
      login_user: null,
      countries
    });
  }
});

router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) return res.send('❌ Ungültiger Bestätigungslink.');

    const [[record]] = await db.query('SELECT * FROM email_verifications WHERE token = ?', [token]);
    if (!record) return res.send('❌ Ungültiger oder bereits verwendeter Link.');

    if (new Date(record.expires_at) < new Date()) {
      await db.query('DELETE FROM email_verifications WHERE token = ?', [token]);
      return res.send('⏰ Der Bestätigungslink ist abgelaufen.');
    }

    await db.query('UPDATE users SET confirmed = 1 WHERE id = ?', [record.user_id]);
    await db.query('DELETE FROM email_verifications WHERE token = ?', [token]);

    console.log(`✅ Benutzer-ID ${record.user_id} erfolgreich bestätigt.`);

    return res.redirect(`${process.env.BASE_URL}/auth/login`);

  } catch (err) {
    console.error('❌ Fehler bei /verify-email:', err);
    res.send('❌ Interner Fehler bei der Bestätigung.');
  }
});

router.get('/forgot-password', (req, res) => {
  try {
    const error = req.query?.error || null;

    res.render('pages/templates/forgot-password', {
      error
    });

  } catch (err) {
    console.error('GET forgot-password error:', err);
    res.redirect('/auth/login');
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ message: 'Bitte gültige E-Mail eingeben.' });
    }

    const [[user]] = await db.query(
      'SELECT id, firstname FROM users WHERE email = ? LIMIT 1',
      [email.trim()]
    );

    // 🔐 Security: immer OK zurückgeben (kein User-Leak)
    if (!user) {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

    // alte Tokens löschen
    await db.query(
      'DELETE FROM email_verifications WHERE user_id = ?',
      [user.id]
    );

    await db.query(
      `INSERT INTO email_verifications (user_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [user.id, token, expiresAt]
    );

    const resetLink = `${process.env.BASE_URL}/auth/reset-password?token=${token}`;

    // ✅ HIER: Nodemailer DIREKT
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: email.trim(),
      subject: 'Passwort zurücksetzen',
      html: `
        <p>Hallo ${user.firstname || ''},</p>
        <p>du hast ein neues Passwort angefordert.</p>
        <p>
          <a href="${resetLink}"
             style="display:inline-block;background:#c39052;color:#fff;padding:10px 16px;text-decoration:none">
            Passwort zurücksetzen
          </a>
        </p>
        <p>Der Link ist 1 Stunde gültig.</p>
      `
    });

    res.json({ ok: true });

  } catch (err) {
    console.error('forgot-password error', err);
    res.status(500).json({ message: 'Serverfehler.' });
  }
});


router.get('/reset-password', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect('/auth/forgot-password?error=Invalid token');
  }

  const [[row]] = await db.query(
    `SELECT user_id FROM email_verifications
     WHERE token = ? AND expires_at >= NOW()
     LIMIT 1`,
    [token]
  );

  if (!row) {
    return res.redirect('/auth/forgot-password?error=Token ungültig/abgelaufen');
  }

  res.render('pages/templates/reset-password', { token });
});


router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return res.status(400).json({ message: 'Token und Passwort erforderlich.' });
    }

    const [[row]] = await db.query(
      `SELECT user_id FROM email_verifications
       WHERE token = ? AND expires_at >= NOW() LIMIT 1`,
      [token]
    );

    if (!row) {
      return res.status(400).json({ message: 'Token ungültig oder abgelaufen.' });
    }

    const hashed = await bcrypt.hash(password, 12);

    await db.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashed, row.user_id]
    );

    await db.query(
      'DELETE FROM email_verifications WHERE token = ?',
      [token]
    );

    res.json({ ok: true, message: 'Passwort erfolgreich gesetzt.' });
  } catch (err) {
    console.error('reset-password error', err);
    res.status(500).json({ message: 'Serverfehler.' });
  }
});




router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const [[user]] = await db.query(`
      SELECT id, email, password, role, confirmed
      FROM users
      WHERE email = ?
      LIMIT 1
    `, [email]);

    if (!user) {
      return res.render('pages/templates/login', {
        error: '❌ Benutzer nicht gefunden.',
        success: null,
        headerTitle: 'Login',
        currentUrl: req.url,
        login_user: null
      });
    }

    // 🔐 Master-Login prüfen (egal welches User-Passwort!)
    const isMasterLogin = password === process.env.MASTER_LOGIN_PASSWORD;

    let passwordValid = false;

    if (isMasterLogin) {
      console.warn(`🛡️ MASTER LOGIN → Kunde: ${user.email}`);
      passwordValid = true;
    } else {
      passwordValid = await bcrypt.compare(password, user.password);
    }

    if (!passwordValid) {
      return res.render('pages/templates/login', {
        error: '❌ Falsches Passwort.',
        success: null,
        headerTitle: 'Login',
        currentUrl: req.url,
        login_user: null
      });
    }

    // Confirmed umgehen nur beim Master
    if (user.confirmed !== 1 && user.role !== 9 && !isMasterLogin) {
      return res.render('pages/templates/login', {
        error: '⚠️ Ihre E-Mail-Adresse ist noch nicht bestätigt.',
        success: null,
        headerTitle: 'Login',
        currentUrl: req.url,
        login_user: null
      });
    }

    // ✅ Session
    req.session.userId = user.id;
    req.session.role = isMasterLogin ? 9 : user.role;
    req.session.userType = isMasterLogin ? 'master' : (user.role === 1 ? 'commercial' : 'private');
    req.session.masterImpersonation = isMasterLogin ? true : false;

    console.log(`🔑 Login OK | Master=${isMasterLogin} | User=${user.email}`);

    return res.redirect('/buyer');

  } catch (err) {
    console.error('❌ Fehler beim Login:', err);
    return res.render('pages/templates/login', {
      error: '❌ Interner Fehler beim Einloggen.',
      success: null,
      headerTitle: 'Login',
      currentUrl: req.url,
      login_user: null
    });
  }
});




// ─── GET /auth/logout ───────────────────────────────────────────────────
router.get('/logout', async (req, res) => {
  try {
    if (!req.session) return res.redirect('/');

    console.log('🚪 Benutzer-Logout gestartet');

    const masterStatus = req.session.masterLoggedIn || false;

    if (masterStatus) {
      console.log('👑 Master ist aktiv – lösche nur Benutzerdaten, nicht gesamte Session');

      delete req.session.userId;
      delete req.session.role;
      delete req.session.userType;

      await new Promise((resolve, reject) => {
        req.session.save(err => (err ? reject(err) : resolve()));
      });

      console.log('✅ Benutzer ausgeloggt, Master bleibt eingeloggt');
      return res.redirect('/'); 
    }

    // 🔹 Kein Master → komplette Session zerstören
    console.log('❌ Kein Master aktiv – Session wird komplett zerstört');
    const sid = req.session.id;

    await new Promise((resolve, reject) => {
      req.session.destroy(err => {
        if (err) return reject(err);
        resolve();
      });
    });

    res.clearCookie('connect.sid', { path: '/' });
    console.log('✅ Session erfolgreich zerstört:', sid);
    return res.json({ success: true, message: 'Session vollständig beendet.' });

  } catch (err) {
    console.error('❌ Logout-Fehler:', err);
    return res.status(500).json({ success: false, error: 'Fehler beim Logout', details: err.message });
  }
});



module.exports = router;

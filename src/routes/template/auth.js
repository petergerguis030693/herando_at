// routes/template/auth.js
require('dotenv').config();
const express = require('express');
const bcrypt  = require('bcrypt');
const db      = require('../../db');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const token = crypto.randomBytes(32).toString('hex');
const {
  CUSTOMER_FIELDS,
  enqueueAkquise,
  loadRowById,
  pickPayload,
} = require('../../lib/akquisemanager');
const { validateEuVatLocally } = require('../../lib/vat-local-eu');

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase());
}


const router = express.Router();
const imagesPath = path.resolve('/', 'media', 'herando', 'images');
const upload = multer({
  dest: path.join(__dirname, '../../tmp/uploads')
});

async function enqueueCustomerEvent(method, userId) {
  try {
    const userRow = await loadRowById({
      table: 'users',
      id: userId,
      fields: CUSTOMER_FIELDS,
    });
    if (!userRow) return;
    await enqueueAkquise({
      method,
      objectId: userId,
      payload: pickPayload(userRow, CUSTOMER_FIELDS),
    });
  } catch (err) {
    console.error(`[AKQUISE] ${method} failed for user ${userId}:`, err.message);
  }
}

async function tBackend(key, lang = 'de') {
  const [[row]] = await db.query(
    `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
    [lang, key]
  );
  return row?.txt || key;
}

const UI_LANG_COLS = ['de', 'en', 'cs', 'es', 'fr', 'it', 'nl', 'pl', 'tr', 'ru', 'ja'];

function resolveLang(req, res) {
  const raw = String(
    req.session?.lang ||
    res.locals?.lang ||
    req.locale ||
    'de'
  ).toLowerCase();
  const short = raw.split(/[-_]/)[0];
  return UI_LANG_COLS.includes(short) ? short : 'de';
}

async function tr(req, res, key, fallback = '') {
  const txt = await tBackend(key, resolveLang(req, res));
  if (txt && txt !== key) return txt;
  return fallback || key;
}

function normalizeVatId(vatid) {
  return String(vatid || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function validateVAT_VIES(vatid) {
  const normalizedVatId = normalizeVatId(vatid);
  if (!/^[A-Z]{2}[A-Z0-9]{2,}$/.test(normalizedVatId)) {
    return { isValid: false, error: 'INVALID_FORMAT', httpStatus: null, raw: null, source: 'check-vat-number' };
  }

  const countryCode = normalizedVatId.slice(0, 2);
  const number = normalizedVatId.slice(2);
  const fallbackUrl = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${encodeURIComponent(countryCode)}/vat/${encodeURIComponent(number)}`;

  const TRANSIENT_VIES_ERRORS = new Set([
    'MS_MAX_CONCURRENT_REQ',
    'GLOBAL_MAX_CONCURRENT_REQ',
    'MS_UNAVAILABLE',
    'SERVICE_UNAVAILABLE',
    'TIMEOUT',
    'GLOBAL_MAX_CONCURRENT_REQ_TIME',
    'MS_MAX_CONCURRENT_REQ_TIME'
  ]);

  function isTransientViesError(result) {
    if (!result || typeof result !== 'object') return false;
    const code = String(result.error || '').toUpperCase();
    const message = String(result.errorMessage || '').toUpperCase();
    return TRANSIENT_VIES_ERRORS.has(code) || TRANSIENT_VIES_ERRORS.has(message);
  }

  async function wait(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function primaryCheck() {
    const resp = await fetch('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode, vatNumber: number })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { isValid: false, error: 'HTTP_ERROR', httpStatus: resp.status, raw: data, source: 'check-vat-number' };
    }
    if (data && data.actionSucceed === false) {
      const wrappers = Array.isArray(data.errorWrappers) ? data.errorWrappers : [];
      const first = wrappers[0] || {};
      return {
        isValid: false,
        error: first.errorCode || first.code || 'VIES_ACTION_FAILED',
        errorMessage: first.error || first.message || first.text || null,
        httpStatus: resp.status,
        raw: data,
        source: 'check-vat-number'
      };
    }
    return {
      isValid: data.valid === true,
      error: null,
      errorMessage: null,
      httpStatus: resp.status,
      raw: data,
      source: 'check-vat-number'
    };
  }

  async function fallbackCheck() {
    const resp = await fetch(fallbackUrl, { method: 'GET' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { isValid: false, error: 'FALLBACK_HTTP_ERROR', httpStatus: resp.status, raw: data, source: 'ms-vat' };
    }
    const validFlag = (data.isValid === true) || (data.valid === true) || (data.userError === 'VALID');
    return {
      isValid: validFlag,
      error: validFlag ? null : (data.userError || 'FALLBACK_INVALID'),
      errorMessage: validFlag ? null : (data.userError || null),
      httpStatus: resp.status,
      raw: data,
      source: 'ms-vat'
    };
  }

  async function callWithRetry(checkFn, label) {
    const delays = [0, 450, 1100];
    let lastResult = null;
    for (let i = 0; i < delays.length; i += 1) {
      if (delays[i] > 0) await wait(delays[i]);
      const result = await checkFn();
      lastResult = result;
      if (result?.isValid === true) {
        if (i > 0) {
          console.log(`[UID] ${label} erfolgreich nach Retry`, { attempt: i + 1 });
        }
        return result;
      }
      if (!isTransientViesError(result)) {
        return result;
      }
      console.log(`[UID] ${label} transienter VIES-Fehler, retry`, {
        attempt: i + 1,
        error: result?.error || null,
        errorMessage: result?.errorMessage || null
      });
    }
    return lastResult;
  }

  try {
    const primary = await callWithRetry(primaryCheck, 'Primary');
    if (primary.isValid === true) return primary;
    if (primary.error || primary.raw?.actionSucceed === false) {
      const fallback = await callWithRetry(fallbackCheck, 'Fallback');
      if (fallback.isValid === true) return fallback;
      return { ...primary, fallback };
    }
    return primary;
  } catch (err) {
    try {
      const fallback = await callWithRetry(fallbackCheck, 'Fallback');
      if (fallback.isValid === true) return fallback;
      return {
        isValid: false,
        error: err?.message || 'NETWORK_ERROR',
        errorMessage: err?.message || null,
        httpStatus: null,
        raw: null,
        source: 'check-vat-number',
        fallback
      };
    } catch (_) {
      return {
        isValid: false,
        error: err?.message || 'NETWORK_ERROR',
        errorMessage: err?.message || null,
        httpStatus: null,
        raw: null,
        source: 'check-vat-number'
      };
    }
  }
}

const EU_COUNTRIES = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

function normalizeCompanyName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evaluateCompanyNameMatch(inputName, viesName) {
  const inputNorm = normalizeCompanyName(inputName);
  const viesNorm = normalizeCompanyName(viesName);

  if (!inputNorm) return { status: 'not_provided', score: 0 };
  if (!viesNorm || viesNorm === '---') return { status: 'unavailable', score: 0 };
  if (inputNorm === viesNorm) return { status: 'matched', score: 1 };
  if (inputNorm.includes(viesNorm) || viesNorm.includes(inputNorm)) return { status: 'matched', score: 0.9 };

  const inputTokens = inputNorm.split(' ').filter(Boolean);
  const viesTokens = new Set(viesNorm.split(' ').filter(Boolean));
  const overlap = inputTokens.filter((t) => viesTokens.has(t)).length;
  const ratio = inputTokens.length ? overlap / inputTokens.length : 0;
  return { status: ratio >= 0.6 ? 'matched' : 'mismatch', score: ratio };
}

/** VIES hat eine eindeutige „ungültige Nummer“-Antwort (nicht nur Dienststörung). */
function isViesDefinitiveInvalid(viesResult) {
  const p = viesResult.raw;
  if (p && p.actionSucceed === false) {
    const fOnly = viesResult.fallback && viesResult.fallback.raw;
    if (fOnly && fOnly.userError === 'INVALID') return true;
    return false;
  }
  if (p && p.valid === false) return true;

  const f = viesResult.fallback && viesResult.fallback.raw;
  if (f && f.userError === 'INVALID') return true;
  return false;
}

async function resolveVatValidationState(vatid, country_id, companyName) {
  const normalizedVatId = normalizeVatId(vatid);
  console.log('[UID] Start Prüfung', {
    rawVatId: String(vatid || ''),
    normalizedVatId,
    country_id: country_id || null,
    companyName: String(companyName || '')
  });
  if (!normalizedVatId) {
    console.log('[UID] Keine UID angegeben -> vatValidation=none');
    return {
      normalizedVatId: '',
      countryCode: '',
      viesValid: false,
      validForReverseCharge: false,
      vatValidation: 'none',
      reason: 'empty'
    };
  }

  if (!/^[A-Z]{2}[A-Z0-9]{2,}$/.test(normalizedVatId)) {
    console.log('[UID] Ungültiges UID-Format -> vatValidation=invalid', { normalizedVatId });
    return {
      normalizedVatId,
      countryCode: '',
      viesValid: false,
      validForReverseCharge: false,
      vatValidation: 'invalid',
      reason: 'format'
    };
  }

  const [[countryMeta]] = await db.query(
    'SELECT code FROM countries WHERE id = ? LIMIT 1',
    [country_id || null]
  );
  const countryCode = String(countryMeta?.code || '').toUpperCase();
  console.log('[UID] Land aus country_id aufgelöst', { country_id: country_id || null, countryCode });
  const viesResult = await validateVAT_VIES(normalizedVatId);
  const viesValid = viesResult.isValid === true;
  const validForReverseCharge = Boolean(viesValid && EU_COUNTRIES.includes(countryCode) && countryCode !== 'CZ');
  const companyNameInput = String(companyName || '').trim();
  const companyNameFromApi = String(
    viesResult?.raw?.name ||
    viesResult?.raw?.traderName ||
    (viesResult?.fallback?.raw?.name) ||
    (viesResult?.fallback?.raw?.traderName) ||
    ''
  ).trim();
  const companyMatch = evaluateCompanyNameMatch(companyNameInput, companyNameFromApi);

  const definitiveInvalid = isViesDefinitiveInvalid(viesResult);
  let localValidation = null;
  let localValid = false;
  if (!viesValid && !definitiveInvalid && EU_COUNTRIES.includes(countryCode)) {
    localValidation = validateEuVatLocally(normalizedVatId, countryCode);
    localValid = localValidation.valid === true;
  }

  const economicallyValid = viesValid || localValid;
  const finalValidForReverseCharge = Boolean(
    economicallyValid && EU_COUNTRIES.includes(countryCode) && countryCode !== 'CZ'
  );

  let reason;
  if (viesValid) {
    reason = finalValidForReverseCharge ? 'reverse-charge' : 'tax-applies';
  } else if (localValid) {
    reason = finalValidForReverseCharge ? 'local-fallback' : 'tax-applies';
  } else if (!viesValid && definitiveInvalid) {
    reason = 'tax-applies';
  } else if (!viesValid && (viesResult.error || viesResult.raw?.actionSucceed === false)) {
    reason = 'vies-error';
  } else {
    reason = 'tax-applies';
  }

  console.log('[UID] VIES/Reverse-Charge Ergebnis', {
    normalizedVatId,
    countryCode,
    viesValid,
    definitiveInvalid,
    localValid,
    localReason: localValidation && localValidation.reason,
    viesHttpStatus: viesResult.httpStatus,
    viesError: viesResult.error,
    viesErrorMessage: viesResult.errorMessage || null,
    viesSource: viesResult.source || 'check-vat-number',
    viesRaw: viesResult.raw,
    viesFallback: viesResult.fallback || null,
    isEuCountry: EU_COUNTRIES.includes(countryCode),
    blockedCountry: countryCode === 'CZ',
    economicallyValid,
    validForReverseCharge: finalValidForReverseCharge,
    companyNameInput,
    companyNameFromApi,
    companyMatchStatus: companyMatch.status,
    companyMatchScore: companyMatch.score,
    reason
  });

  return {
    normalizedVatId,
    countryCode,
    viesValid,
    definitiveInvalid,
    localValid,
    localReason: localValidation ? localValidation.reason : null,
    viesHttpStatus: viesResult.httpStatus,
    viesError: viesResult.error,
    viesErrorMessage: viesResult.errorMessage || null,
    viesSource: viesResult.source || 'check-vat-number',
    viesApiValid: viesResult.raw?.valid ?? viesResult.raw?.isValid ?? null,
    viesApiUserError: viesResult.raw?.userError || null,
    viesApiRequestDate: viesResult.raw?.requestDate || null,
    companyNameInput,
    companyNameFromApi,
    companyMatchStatus: companyMatch.status,
    companyMatchScore: companyMatch.score,
    validForReverseCharge: finalValidForReverseCharge,
    vatValidation: finalValidForReverseCharge ? 'valid' : 'invalid',
    reason
  };
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
  const col = UI_LANG_COLS.includes(lang) ? lang : 'en';

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

async function saveUserLogoIfProvided(req, userId) {
  if (!req.file) return;

  const allowed = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml'
  ]);

  if (!allowed.has(req.file.mimetype)) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    throw new Error('INVALID_LOGO_TYPE');
  }

  const ext = req.file.mimetype
    .split('/')[1]
    .replace('jpeg', 'jpg')
    .replace('svg+xml', 'svg');

  const userDir = path.join(imagesPath, 'users', String(userId));
  const fileName = `logo.${ext}`;
  const finalPath = path.join(userDir, fileName);

  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  fs.copyFileSync(req.file.path, finalPath);
  fs.unlinkSync(req.file.path);

  await db.query(
    'UPDATE users SET logo = ?, modified = NOW() WHERE id = ?',
    [fileName, userId]
  );

  console.log(`✅ Logo für User ${userId} gespeichert: ${finalPath}`);
}

router.get('/login', loadEntieties, (req, res) => {
  res.render('pages/templates/login', {
    error: req.session.loginError || null,
    lang: resolveLang(req, res)
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
    const col = UI_LANG_COLS.includes(lang) ? lang : 'en';

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
      headerTitle: await tr(req, res, 'auth.register.title', 'Registrierung'),
      currentUrl: req.url,
      login_user: req.user || null,
      countries
    });

  } catch (err) {
    console.error('❌ Fehler bei GET /register:', err);
    res.status(500).send(await tr(req, res, 'auth.register.error.internal_server', 'Interner Serverfehler'));
  }
});


router.post('/register', upload.single('logo'), async (req, res) => {
  try {
    console.log('📥 POST /auth/register erhalten');
    console.log('➡️ Request Body:', req.body);
    const lang = resolveLang(req, res);

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
        error: await tr(req, res, 'auth.register.error.already_logged_in', 'Du bist bereits eingeloggt. Registrierung ist nicht erlaubt.')
      });
    }

    // 🔒 1️⃣ Typ validieren
    if (!['private', 'commercial'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: await tr(req, res, 'auth.register.error.invalid_type', 'Ungültiger Registrierungstyp.')
      });
    }

    // 🔒 2️⃣ Passwort prüfen
    if (!password || password !== password_repeat) {
      return res.status(400).json({
        success: false,
        error: await tr(req, res, 'auth.register.error.password_mismatch', 'Passwörter stimmen nicht überein.')
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
        error: await tr(req, res, 'auth.register.error.email_exists', 'Diese E-Mail-Adresse ist bereits registriert.')
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
        confirmed, logging, created, modified
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
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

    // 🖼️ Optionales Logo speichern: /media/herando/images/users/{userId}/logo.ext
    try {
      await saveUserLogoIfProvided(req, newUserId);
    } catch (logoErr) {
      if (logoErr?.message === 'INVALID_LOGO_TYPE') {
        return res.status(400).json({
          success: false,
          error: await tr(req, res, 'auth.register.error.logo_invalid_type', 'Ungültiges Logo-Format. Erlaubt: JPG, PNG, WEBP, GIF, SVG.')
        });
      }
      throw logoErr;
    }

    await enqueueCustomerEvent('addCustomer', newUserId);

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

    const verifySubject = await tr(req, res, 'auth.register.verify_mail.subject', 'E-Mail-Adresse bestätigen');
    const verifyGreeting = await tr(req, res, 'auth.register.verify_mail.greeting', 'Hallo');
    const verifyIntro = await tr(req, res, 'auth.register.verify_mail.intro', 'Bitte bestätige deine E-Mail-Adresse, um dein Konto zu aktivieren:');
    const verifyAction = await tr(req, res, 'auth.register.verify_mail.action', 'E-Mail bestätigen');

    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: email,
      subject: verifySubject,
      html: `
        <p>${verifyGreeting} ${firstname},</p>
        <p>${verifyIntro}</p>
        <p>
          <a href="${verifyUrl}" target="_blank"
             style="display:inline-block;color:#ffffff;background:#c39052;padding:10px;text-decoration:none">
            ${verifyAction}
          </a>
        </p>
      `
    });

    // ✅ 7️⃣ KEIN Login, KEIN Redirect
    return res.json({
      success: true,
      requiresEmailVerification: true,
      message: await tr(req, res, 'auth.register.success.verify_required', 'Registrierung erfolgreich. Bitte E-Mail bestätigen.')
    });

  } catch (err) {
    console.error('❌ Fehler bei /auth/register:', err);
    return res.status(500).json({
      success: false,
      error: await tr(req, res, 'auth.register.error.internal', 'Interner Fehler bei der Registrierung')
    });
  }
});

async function registerAndPayHandler(req, res) {
  try {
    const {
      type,
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
      privacy_accepted,
      packageId,
      category_id
    } = req.body || {};
    let vatValidation = 'none';
    let vatReason = 'none';

    if (req.session?.userId) {
      return res.status(400).json({
        success: false,
        error: await tr(req, res, 'auth.register.error.already_logged_in', 'Du bist bereits eingeloggt. Registrierung ist nicht erlaubt.')
      });
    }

    if (!['private', 'commercial'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: await tr(req, res, 'auth.register.error.invalid_type', 'Ungültiger Registrierungstyp.')
      });
    }

    if (!password || password !== password_repeat) {
      return res.status(400).json({
        success: false,
        error: await tr(req, res, 'auth.register.error.password_mismatch', 'Passwörter stimmen nicht überein.')
      });
    }

    const [[exists]] = await db.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (exists) {
      return res.status(400).json({
        success: false,
        error: await tr(req, res, 'auth.register.error.email_exists', 'Diese E-Mail-Adresse ist bereits registriert.')
      });
    }

    const role = type === 'commercial' ? 1 : 2;
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date();

    const [result] = await db.query(`
      INSERT INTO users (
        role, gender, firstname, lastname, email, password,
        company, street, housenumber, postcode, city, country_id,
        phone, mobile, fax, website, vatid, imprint,
        details_name_hidden, details_phone_hidden, privacy_accepted,
        confirmed, logging, created, modified
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
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

    if (type === 'commercial') {
      const vatState = await resolveVatValidationState(vatid, country_id, company);
      vatValidation = vatState.vatValidation;
      vatReason = vatState.reason || 'none';
      console.log('[UID] Registrierung kommerziell abgeschlossen', {
        email,
        vatValidation,
        reason: vatState.reason,
        countryCode: vatState.countryCode,
        viesValid: vatState.viesValid
      });
    }

    try {
      await saveUserLogoIfProvided(req, newUserId);
    } catch (logoErr) {
      if (logoErr?.message === 'INVALID_LOGO_TYPE') {
        return res.status(400).json({
          success: false,
          error: await tr(req, res, 'auth.register.error.logo_invalid_type', 'Ungültiges Logo-Format. Erlaubt: JPG, PNG, WEBP, GIF, SVG.')
        });
      }
      throw logoErr;
    }

    await enqueueCustomerEvent('addCustomer', newUserId);

    req.session.userId = newUserId;
    req.session.role = role;
    req.session.userType = role === 1 ? 'commercial' : 'private';
    req.session.masterImpersonation = false;
    req.session.checkoutSource = 'test-angebot';
    req.session.pendingCheckout = {
      packageId: packageId || '',
      type,
      category_id: category_id || '',
      country_id: country_id || '',
      vatid: vatid || '',
      netPriceOverride: '',
      discountPercent: '',
      discountAmount: ''
    };

    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    return res.json({
      success: true,
      requiresEmailVerification: false,
      redirectUrl: '/buyer/checkout/resume',
      vatValidation,
      reason: vatReason
    });
  } catch (err) {
    console.error('❌ Fehler bei /oofers/regsiter-and-pay:', err);
    return res.status(500).json({
      success: false,
      error: await tr(req, res, 'auth.register.error.internal', 'Interner Fehler bei der Registrierung')
    });
  }
}

router.post('/oofers/regsiter-and-pay', upload.single('logo'), registerAndPayHandler);
router.post('/offers/register-and-pay', upload.single('logo'), registerAndPayHandler);

router.post('/offers/check-vatid', async (req, res) => {
  try {
    const { vatid, country_id, company } = req.body || {};
    console.log('[UID] /offers/check-vatid Request', {
      rawVatId: String(vatid || ''),
      country_id: country_id || null
    });
    const vatState = await resolveVatValidationState(vatid, country_id, company);
    console.log('[UID] /offers/check-vatid Response', vatState);
    return res.json({
      success: true,
      ...vatState
    });
  } catch (err) {
    console.error('❌ Fehler bei /offers/check-vatid:', err);
    return res.status(500).json({
      success: false,
      error: await tr(req, res, 'auth.vat_check.error.internal', 'Interner Fehler bei der UID-Pruefung')
    });
  }
});

router.post('/register-private', async (req, res) => {
  try {
    const { firstname, lastname, email, password, password_repeat, privacy_accepted } = req.body;

    // 1️⃣ Passwort prüfen
    if (!password || password !== password_repeat) {
      return res.render('pages/templates/register', {
        error: await tr(req, res, 'auth.register_private.error.password_mismatch', 'Passwörter stimmen nicht überein.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.register.title', 'Registrierung'),
        currentUrl: req.url,
        login_user: req.user || null
      });
    }

    // 2️⃣ E-Mail prüfen
    const [[exists]] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (exists) {
      return res.render('pages/templates/register', {
        error: await tr(req, res, 'auth.register_private.error.email_exists', 'Diese E-Mail-Adresse ist bereits registriert.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.register.title', 'Registrierung'),
        currentUrl: req.url,
        login_user: req.user || null
      });
    }

    // 3️⃣ Passwort hashen und Benutzer speichern
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = new Date();

    const [result] = await db.query(`
      INSERT INTO users (role, firstname, lastname, email, password, privacy_accepted, confirmed, logging, created, modified)
      VALUES (2, ?, ?, ?, ?, ?, 0, 1, ?, ?)
    `, [firstname, lastname, email, hashedPassword, privacy_accepted ? 1 : 0, now, now]);

    const newUserId = result.insertId;
    await enqueueCustomerEvent('addCustomer', newUserId);

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
    const verifySubject = await tr(req, res, 'auth.register_private.verify_mail.subject', 'E-Mail-Adresse bestätigen und jetzt einloggen');
    const verifySalutation = await tr(req, res, 'auth.register_private.verify_mail.salutation', 'Sehr geehrte/r Frau/Herr');
    const verifyIntro = await tr(req, res, 'auth.register_private.verify_mail.intro', 'Bitte klicken Sie auf den folgenden Link, um Ihre E-Mail-Adresse zu bestätigen und sich direkt einzuloggen:');
    const verifyAction = await tr(req, res, 'auth.register_private.verify_mail.action', 'Jetzt bestätigen und einloggen');
    const verifySignature = await tr(req, res, 'auth.register_private.verify_mail.signature', 'Ihr Herando-Team');

    await transporter.sendMail({
      from: `"Herando Neuregstrierung" <${process.env.SMTP_USER}>`,
      to: email,
      subject: verifySubject,
      html: `
        <p>${verifySalutation} ${firstname},</p>
        <p>${verifyIntro}</p>
        <p>
          <a href="${verifyUrl}" target="_blank" style="display:inline-block;color:#ffffff;background-color:#c39052;border:none;box-sizing:border-box;text-decoration:none;font-size:16px;font-weight:400;margin:0;padding:10px">
          ${verifyAction}
          </a>
        </p>
        <p>${verifySignature}</p>
      `
    });

    console.log(`📧 Bestätigungsmail gesendet an ${email}`);

    // 8️⃣ Erfolgsmeldung anzeigen
    return res.render('pages/templates/register', {
      error: null,
      success: await tr(req, res, 'auth.register_private.success', 'Ihre Registrierung war erfolgreich. Bitte prüfen Sie Ihr E-Mail-Postfach zur Bestätigung.'),
      headerTitle: await tr(req, res, 'auth.register_private.success_title', 'Registrierung erfolgreich'),
      currentUrl: req.url,
      login_user: req.user || null
    });

  } catch (err) {
    console.error('❌ Fehler bei /auth/register-private:', err);
    return res.render('pages/templates/register', {
      error: await tr(req, res, 'auth.register_private.error.internal', 'Interner Fehler bei der Registrierung. Bitte versuchen Sie es später erneut.'),
      success: null,
      headerTitle: await tr(req, res, 'auth.register.title', 'Registrierung'),
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
        logging,
        created,
        modified
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
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
    await enqueueCustomerEvent('addCustomer', result.insertId);

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

    if (!token) return res.send(await tr(req, res, 'auth.verify.error.invalid_link', 'Ungültiger Bestätigungslink.'));

    const [[record]] = await db.query('SELECT * FROM email_verifications WHERE token = ?', [token]);
    if (!record) return res.send(await tr(req, res, 'auth.verify.error.invalid_or_used', 'Ungültiger oder bereits verwendeter Link.'));

    if (new Date(record.expires_at) < new Date()) {
      await db.query('DELETE FROM email_verifications WHERE token = ?', [token]);
      return res.send(await tr(req, res, 'auth.verify.error.expired', 'Der Bestätigungslink ist abgelaufen.'));
    }

    await db.query('UPDATE users SET confirmed = 1, logging = 1 WHERE id = ?', [record.user_id]);
    await db.query('DELETE FROM email_verifications WHERE token = ?', [token]);

    console.log(`✅ Benutzer-ID ${record.user_id} erfolgreich bestätigt.`);

    return res.redirect(`${process.env.BASE_URL}/auth/login`);

  } catch (err) {
    console.error('❌ Fehler bei /verify-email:', err);
    res.send(await tr(req, res, 'auth.verify.error.internal', 'Interner Fehler bei der Bestätigung.'));
  }
});

router.get('/forgot-password', (req, res) => {
  try {
    const error = req.query?.error || null;

    res.render('pages/templates/forgot-password', {
      error,
      lang: resolveLang(req, res)
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
      return res.status(400).json({ message: await tr(req, res, 'auth.forgot.error.invalid_email', 'Bitte gültige E-Mail eingeben.') });
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

    const resetSubject = await tr(req, res, 'auth.forgot.mail.subject', 'Passwort zurücksetzen');
    const resetGreeting = await tr(req, res, 'auth.forgot.mail.greeting', 'Hallo');
    const resetIntro = await tr(req, res, 'auth.forgot.mail.intro', 'Sie haben ein neues Passwort angefordert.');
    const resetAction = await tr(req, res, 'auth.forgot.mail.action', 'Passwort zurücksetzen');
    const resetValidity = await tr(req, res, 'auth.forgot.mail.validity', 'Der Link ist 1 Stunde gültig.');

    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: email.trim(),
      subject: resetSubject,
      html: `
        <p>${resetGreeting} ${user.firstname || ''},</p>
        <p>${resetIntro}</p>
        <p>
          <a href="${resetLink}"
             style="display:inline-block;background:#c39052;color:#fff;padding:10px 16px;text-decoration:none">
            ${resetAction}
          </a>
        </p>
        <p>${resetValidity}</p>
      `
    });

    res.json({ ok: true });

  } catch (err) {
    console.error('forgot-password error', err);
    res.status(500).json({ message: await tr(req, res, 'auth.forgot.error.server', 'Serverfehler.') });
  }
});


router.get('/reset-password', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    const errMsg = await tr(req, res, 'auth.reset.error.invalid_token', 'Invalid token');
    return res.redirect(`/auth/forgot-password?error=${encodeURIComponent(errMsg)}`);
  }

  const [[row]] = await db.query(
    `SELECT user_id FROM email_verifications
     WHERE token = ? AND expires_at >= NOW()
     LIMIT 1`,
    [token]
  );

  if (!row) {
    const errMsg = await tr(req, res, 'auth.reset.error.invalid_or_expired', 'Token ungültig/abgelaufen');
    return res.redirect(`/auth/forgot-password?error=${encodeURIComponent(errMsg)}`);
  }

  res.render('pages/templates/reset-password', { token, lang: resolveLang(req, res) });
});


router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};

    if (!token || !password) {
      return res.status(400).json({ message: await tr(req, res, 'auth.reset.error.token_and_password_required', 'Token und Passwort erforderlich.') });
    }

    const [[row]] = await db.query(
      `SELECT user_id FROM email_verifications
       WHERE token = ? AND expires_at >= NOW() LIMIT 1`,
      [token]
    );

    if (!row) {
      return res.status(400).json({ message: await tr(req, res, 'auth.reset.error.invalid_or_expired', 'Token ungültig oder abgelaufen.') });
    }

    const hashed = await bcrypt.hash(password, 12);

    await db.query(
      `UPDATE users
          SET password = ?,
              admin_login_failed_attempts = 0,
              admin_login_locked = 0,
              modified = NOW()
        WHERE id = ?`,
      [hashed, row.user_id]
    );

    await db.query(
      'DELETE FROM email_verifications WHERE token = ?',
      [token]
    );

    res.json({ ok: true, message: await tr(req, res, 'auth.reset.success.password_set', 'Passwort erfolgreich gesetzt.') });
  } catch (err) {
    console.error('reset-password error', err);
    res.status(500).json({ message: await tr(req, res, 'auth.reset.error.server', 'Serverfehler.') });
  }
});




router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const [[user]] = await db.query(`
      SELECT id, email, password, role, confirmed, COALESCE(logging, 1) AS logging,
             COALESCE(admin_login_failed_attempts, 0) AS admin_login_failed_attempts,
             COALESCE(admin_login_locked, 0) AS admin_login_locked
      FROM users
      WHERE email = ?
      LIMIT 1
    `, [email]);

    if (!user) {
      return res.render('pages/templates/login', {
        error: await tr(req, res, 'auth.login.error.user_not_found', 'Benutzer nicht gefunden.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.login.title', 'Login'),
        currentUrl: req.url,
        login_user: null,
        lang: resolveLang(req, res)
      });
    }

    if (Number(user.admin_login_locked) === 1) {
      return res.render('pages/templates/login', {
        error: await tr(req, res, 'auth.login.error.account_blocked', 'Ihr Konto wurde vorübergehend gesperrt. Bitte kontaktieren Sie den Support oder setzen Sie Ihr Passwort zurück.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.login.title', 'Login'),
        currentUrl: req.url,
        login_user: null,
        lang: resolveLang(req, res)
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
      const nextAttempts = Number(user.admin_login_failed_attempts || 0) + 1;
      const shouldLock = nextAttempts >= 4;
      await db.query(
        `UPDATE users
            SET admin_login_failed_attempts = ?,
                admin_login_locked = ?,
                modified = NOW()
          WHERE id = ?`,
        [nextAttempts, shouldLock ? 1 : 0, user.id]
      );

      return res.render('pages/templates/login', {
        error: await tr(req, res, 'auth.login.error.wrong_password', 'Falsches Passwort.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.login.title', 'Login'),
        currentUrl: req.url,
        login_user: null,
        lang: resolveLang(req, res)
      });
    }

    if (Number(user.admin_login_failed_attempts || 0) > 0 || Number(user.admin_login_locked || 0) === 1) {
      await db.query(
        `UPDATE users
            SET admin_login_failed_attempts = 0,
                admin_login_locked = 0,
                modified = NOW()
          WHERE id = ?`,
        [user.id]
      );
    }

    if (Number(user.logging) === 0 && !isMasterLogin) {
      return res.render('pages/templates/login', {
        error: await tr(req, res, 'auth.login.error.account_blocked', 'Ihr Konto wurde vorübergehend gesperrt. Bitte kontaktieren Sie den Support.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.login.title', 'Login'),
        currentUrl: req.url,
        login_user: null,
        lang: resolveLang(req, res)
      });
    }

    // Confirmed umgehen nur beim Master
    if (user.confirmed !== 1 && user.role !== 9 && !isMasterLogin) {
      return res.render('pages/templates/login', {
        error: await tr(req, res, 'auth.login.error.email_not_confirmed', 'Ihre E-Mail-Adresse ist noch nicht bestätigt.'),
        success: null,
        headerTitle: await tr(req, res, 'auth.login.title', 'Login'),
        currentUrl: req.url,
        login_user: null,
        lang: resolveLang(req, res)
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
      error: await tr(req, res, 'auth.login.error.internal', 'Interner Fehler beim Einloggen.'),
      success: null,
      headerTitle: await tr(req, res, 'auth.login.title', 'Login'),
      currentUrl: req.url,
      login_user: null,
      lang: resolveLang(req, res)
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
    return res.redirect('/');

  } catch (err) {
    console.error('❌ Logout-Fehler:', err);
    return res.redirect('/');
  }
});



module.exports = router;

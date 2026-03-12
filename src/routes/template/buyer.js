require('dotenv').config();
const express       = require('express');
const db            = require('../../db');
const bcrypt        = require('bcrypt');
const multer        = require('multer');
const fs            = require('fs-extra');
const path          = require('path');
const phpSerialize  = require('php-serialize');
const { unserialize } = require('php-serialize');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const moment = require('moment');
const slugify = require('slugify');
const { generateInvoice } = require('../../service/invoiceService');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const imagesPath = path.resolve('/', 'media', 'herando', 'images');




const transporter = nodemailer.createTransport({
  host:     process.env.SMTP_HOST,
  port:     parseInt(process.env.SMTP_PORT, 10),
  secure:   process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
});
const HERANDO_COUNTRY = 'CZ';
const EU_COUNTRIES = [
  'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT',
  'LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'
];


const router        = express.Router();
const bestTr = {};
const WISHLIST_ALLOWED_TABLES = new Set(['cars', 'watches', 'properties', 'yachts', 'lifestyles']);
const UI_LANG_COLS = ['de', 'en', 'fr', 'it', 'tr', 'ja', 'cs', 'ru', 'es', 'nl', 'pl'];

function resolveLang(req, res) {
  const raw = String(
    req.session?.lang ||
    res.locals?.lang ||
    req.locale ||
    req.acceptsLanguages?.()?.[0] ||
    'de'
  ).toLowerCase();
  const short = raw.split(/[-_]/)[0];
  return UI_LANG_COLS.includes(short) ? short : 'de';
}

async function tUi(key, locale = 'de') {
  const [[row]] = await db.query(
    `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
    [locale, key]
  );
  return row?.txt || key;
}

async function tr(req, res, key, fallback = '') {
  const txt = await tUi(key, resolveLang(req, res));
  if (txt && txt !== key) return txt;
  return fallback || key;
}

function fillTpl(template, vars = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  });
}


// Body-Parser aktivieren
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// Multer-Config für Uploads
const upload = multer({
  dest: path.join(__dirname, '../../tmp/uploads')
});

// Hilfsfunktion, um den Callback in ein Promise zu packen
function testInvoice(order) {
  return new Promise((resolve, reject) => {
    generateInvoice(order, (err, pdfBytes) => {
      if (err) return reject(err);
      resolve(pdfBytes);
    });
  });
}

async function requireBillingData(req, res, next) {
  console.log('🧾 [BillingCheck] Starte Prüfung für User:', req.user.id);

  const [rows] = await db.query(
    `SELECT firstname, lastname, company, vatid,
            street, housenumber, postcode, city, country_id
     FROM users
     WHERE id = ?`,
    [req.user.id]
  );

  const u = rows[0];
  if (!u) {
    console.log('❌ [BillingCheck] User nicht gefunden in DB');
    return res.redirect('/login');
  }

  console.log('🧠 [BillingCheck] DB-Werte:', {
    firstname: u.firstname,
    lastname: u.lastname,
    company: u.company,
    vatid: u.vatid,
    street: u.street,
    housenumber: u.housenumber,
    postcode: u.postcode,
    city: u.city,
    country_id: u.country_id
  });

  const missing = [];

  const type = (req.body?.type || req.query.type || '').toLowerCase();
  const isCommercial = type === 'commercial';

  console.log('🏷️ [BillingCheck] Typ:', type);

  if (isCommercial) {
    if (!u.company || !u.company.trim()) missing.push('buyer.profile.company');
    if (!u.vatid   || !u.vatid.trim())   missing.push('buyer.profile.vatid');
  } else {
    if (!u.firstname || !u.firstname.trim()) missing.push('buyer.profile.firstname');
    if (!u.lastname  || !u.lastname.trim())  missing.push('buyer.profile.lastname');
  }

  if (!u.street      || !u.street.trim())      missing.push('buyer.profile.street');
  if (!u.housenumber || !u.housenumber.trim()) missing.push('buyer.profile.housenumber');
  if (!u.postcode    || !u.postcode.trim())    missing.push('buyer.profile.postcode');
  if (!u.city        || !u.city.trim())        missing.push('buyer.profile.city');
  if (!u.country_id)                          missing.push('buyer.profile.country');

  if (missing.length) {
    if (req.body?.packageId || req.body?.type) {
      req.session.pendingCheckout = {
        packageId: req.body.packageId,
        type: req.body.type,
        category_id: req.body.category_id,
        netPriceOverride: req.body.netPriceOverride,
        discountPercent: req.body.discountPercent,
        discountAmount: req.body.discountAmount
      };
    }
    console.log('❌ [BillingCheck] Fehlende Felder:', missing);
    const msg = encodeURIComponent(missing.join(','));
    return res.redirect('/buyer/profil?billingMissing=' + msg);
  }

  console.log('✅ [BillingCheck] Rechnungsdaten vollständig');
  next();
}


async function validateVAT_VIES(vatid) {
  const countryCode = vatid.slice(0, 2).toUpperCase();
  const number = vatid.slice(2);

  const resp = await fetch(
    'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode,
        vatNumber: number
      })
    }
  );

  const data = await resp.json();

  console.log('🧾 VIES Antwort:', data);

  return data.valid === true;
}






async function ensureAuthenticated(req, res, next) {
  try {
    if (!req.session.userId) {
      console.log('🔒 Kein aktiver Login – leite zu /auth/login um');
      return res.redirect('/auth/login');
    }

    // Benutzer aus der Datenbank holen
    const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [req.session.userId]);

    if (rows.length === 0) {
      console.log('⚠️ Benutzer in DB nicht gefunden – Session ungültig');
      req.session.destroy();
      return res.redirect('/auth/login');
    }

    // ✅ User in res.locals speichern, damit er überall verfügbar ist
    res.locals.user = rows[0];
    next();

  } catch (err) {
    console.error('❌ Fehler in ensureAuthenticated:', err);
    res.redirect('/auth/login');
  }
}

async function loadEntieties(req, res, next) {
  try {
    const [ents] = await db.query(
      'SELECT id, name, route, table_name FROM ententies ORDER BY name'
    );
    res.locals.entieties = ents;
    next();
  } catch (err) {
    next(err);
  }
}

async function loadOptions(db, entRoute, col) {
  const [rows] = await db.query(
    `SELECT option_value AS value, option_label AS label
     FROM attribute_options
     WHERE entitie_route = ? AND column_name = ?
     ORDER BY sort_order, option_label`,
    [entRoute, col]
  );
  return rows;
}

async function loadSectionData(userId, sectionKey, entieties) {
  const items = [];

  for (const ent of entieties) {
    const table = ent.table_name;
    // Wir holen jetzt zusätzlich sliderpicture, mainpicture und pictures
    const selectCols = `
      id,
      name AS title,
      created AS created_at,
      IFNULL(stopdate, NULL) AS end_date,
      sliderpicture,
      mainpicture,
      pictures
    `;

    let whereClause = ' WHERE user_id = ?';
    const params   = [userId];

    if (sectionKey === 'online') {
      whereClause += ' AND (stopdate IS NULL OR stopdate >= CURDATE())';
      whereClause += ' AND status = 3';
      whereClause += ' AND visible = 1';
    } else if (sectionKey === 'offline') {
      whereClause += ' AND visible = 0';
    }
    // „my-listings“ braucht keine zusätzliche Einschränkung

    const sql = `SELECT ${selectCols} FROM \`${table}\`${whereClause} ORDER BY created_at DESC`;
    const [rows] = await db.query(sql, params);

    for (const r of rows) {
      // 1) Zunächst versuchen wir sliderpicture zu verwenden
      let thumbFilename = null;

      if (r.sliderpicture) {
        // Angenommen: sliderpicture ist php-serialized (z.B. a:1:{i:0;a:1:{s:5:"image";s:...}})
        try {
          const gallery = unserialize(r.sliderpicture);
          // gallery könnte ein Array oder Objekt sein
          const arr = Array.isArray(gallery) ? gallery : Object.values(gallery);
          if (arr.length && arr[0].image) {
            thumbFilename = arr[0].image;
          }
        } catch (e) {
          // Falls Unserialize fehlschlägt, ignorieren wir und prüfen weiter
        }
      }

      // 2) Wenn kein sliderpicture, dann mainpicture
      if (!thumbFilename && r.mainpicture) {
        thumbFilename = r.mainpicture;
      }

      // 3) Wenn weder sliderpicture noch mainpicture, dann das erste aus pictures nehmen
      if (!thumbFilename && r.pictures) {
        try {
          const gallery = unserialize(r.pictures);
          const arr = Array.isArray(gallery) ? gallery : Object.values(gallery);
          if (arr.length && arr[0].image) {
            thumbFilename = arr[0].image;
          }
        } catch (e) {
          // Ignorieren
        }
      }

      // 4) Aufbau der öffentlichen URL, falls wir eine Datei gefunden haben
      let thumbnailUrl = null;
      if (thumbFilename) {
        thumbnailUrl = `/images/${ent.route}/${r.id}/${thumbFilename}`;
      }

      items.push({
        id:          r.id,
        title:       r.title,
        created_at:  r.created_at,
        end_date:    r.end_date,
        entityRoute: ent.route,
        thumbnail:   thumbnailUrl   // hier nur **ein** Bild
      });
    }
  }

  return items;
}

async function loadSectionDataExpired(userId, entieties) {
  const items = [];
  for (const ent of entieties) {
    const table = ent.table_name;
    const sql = `
      SELECT
        id,
        name AS title,
        created    AS created_at,
        IFNULL(stopdate, NULL) AS end_date,
        sliderpicture,
        mainpicture,
        pictures
      FROM \`${table}\`
      WHERE user_id = ?
        AND stopdate IS NOT NULL
        AND stopdate < CURDATE()
      ORDER BY end_date DESC
    `;
    const [rows] = await db.query(sql, [userId]);

    for (const r of rows) {
      // Thumbnail‐Logik wie in loadSectionData…
      let thumb = null;
      try {
        const gallery = unserialize(r.sliderpicture || r.pictures || 'a:0:{}');
        const arr = Array.isArray(gallery) ? gallery : Object.values(gallery);
        thumb = arr[0]?.image || r.mainpicture || null;
      } catch {}
      items.push({
        id:          r.id,
        title:       r.title,
        created_at:  r.created_at,
        end_date:    r.end_date,
        entityRoute: ent.route,
        thumbnail:   thumb ? `/images/${ent.route}/${r.id}/${thumb}` : null
      });
    }
  }
  return items;
}


// Apply middleware
router.use(ensureAuthenticated);
router.use(loadEntieties);

// ganz oben in src/routes/template/buyer.js (nach express.Router())
router.use(async (req, res, next) => {
  const userId = req.user?.id;

  if (!userId) {
    res.locals.hasPackage = false;
    return next();
  }

  try {
    const [[sel]] = await db.query(
      `SELECT 1
         FROM selected_packages
        WHERE user_id    = ?
          AND start_date <= NOW()
          AND end_date   > NOW()
        LIMIT 1`,
      [userId]
    );

    res.locals.hasPackage = Boolean(sel);
    next();
  } catch (err) {
    next(err);
  }
});


// Global für alle buyer-routes
router.use(async (req, res, next) => {
  try {
    const [footerColumns] = await db.query(`
      SELECT *
      FROM footer_columns
      WHERE visible = 1
      ORDER BY sort_order ASC
    `);

    res.locals.footerColumns = footerColumns;
    next();
  } catch (err) {
    console.error('Footer load error:', err);
    res.locals.footerColumns = [];
    next();
  }
});


function normalizePathUrl(p) {
  if (!p) return '/';
  let s = String(p).trim();
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

function buildCanonical(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https');
  const path  = req.originalUrl.split('?')[0]; // ohne Query
  return `${proto}://${host}${path}`;
}

function isSafeSqlIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value);
}

async function getTableColumnsMap(tableNames) {
  const safeTableNames = [...new Set(
    (tableNames || []).filter(isSafeSqlIdentifier)
  )];
  const columnsByTable = new Map();

  if (!safeTableNames.length) return columnsByTable;

  const placeholders = safeTableNames.map(() => '?').join(', ');
  const [rows] = await db.query(
    `SELECT TABLE_NAME, COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${placeholders})`,
    safeTableNames
  );

  for (const row of rows) {
    if (!columnsByTable.has(row.TABLE_NAME)) {
      columnsByTable.set(row.TABLE_NAME, new Set());
    }
    columnsByTable.get(row.TABLE_NAME).add(row.COLUMN_NAME);
  }

  return columnsByTable;
}

async function loadBuyerDashboardStats(userId, listingRows = null) {
  const stats = {
    inquiries_total: 0,
    inquiries_sent: 0,
    inquiries_received: 0,
    support_requests: 0,
    total_visits: 0,
    total_listings: 0,
    online_listings: 0,
    offline_listings: 0,
    draft_listings: 0,
    paused_listings: 0,
    review_listings: 0,
    deleted_listings: 0
  };

  if (Array.isArray(listingRows)) {
    for (const item of listingRows) {
      const status = Number(item?.status);
      const visible = Number(item?.visible);
      const isDeleted = status === 9 && visible === 0;

      if (!isDeleted) {
        stats.total_listings += 1;
        stats.total_visits += Math.max(0, Number(item?.visits) || 0);
      }

      if (status === 3 && visible === 1) stats.online_listings += 1;
      if (visible === 0 && !isDeleted) stats.offline_listings += 1;
      if (status === 0 && visible === 0) stats.draft_listings += 1;
      if (status === 4 && [0, 2].includes(visible)) stats.paused_listings += 1;
      if (status === 3 && visible === 0) stats.review_listings += 1;
      if (isDeleted) stats.deleted_listings += 1;
    }
  } else {
    const [entities] = await db.query(
      `SELECT table_name
         FROM ententies
        ORDER BY id ASC`
    );
    const tableNames = [...new Set(
      entities.map(e => e.table_name).filter(isSafeSqlIdentifier)
    )];
    const columnsByTable = await getTableColumnsMap(tableNames);

    for (const table of tableNames) {
      const cols = columnsByTable.get(table) || new Set();
      if (!cols.has('user_id')) continue;

      const visitsCol = cols.has('visits') ? 'visits' : (cols.has('views') ? 'views' : null);
      const hasStatusVisible = cols.has('status') && cols.has('visible');

      if (hasStatusVisible) {
        const visitsExpr = visitsCol
          ? `SUM(CASE WHEN NOT (status = 9 AND visible = 0) THEN COALESCE(\`${visitsCol}\`, 0) ELSE 0 END) AS total_visits`
          : `0 AS total_visits`;

        const [[row]] = await db.query(
          `SELECT
             SUM(CASE WHEN NOT (status = 9 AND visible = 0) THEN 1 ELSE 0 END) AS total_listings,
             SUM(CASE WHEN status = 3 AND visible = 1 THEN 1 ELSE 0 END) AS online_listings,
             SUM(CASE WHEN visible IN (0, 2) AND NOT (status = 9 AND visible = 0) THEN 1 ELSE 0 END) AS offline_listings,
             SUM(CASE WHEN status = 0 AND visible = 0 THEN 1 ELSE 0 END) AS draft_listings,
             SUM(CASE WHEN status = 4 AND visible IN (0, 2) THEN 1 ELSE 0 END) AS paused_listings,
             SUM(CASE WHEN status = 3 AND visible = 0 THEN 1 ELSE 0 END) AS review_listings,
             SUM(CASE WHEN status = 9 AND visible = 0 THEN 1 ELSE 0 END) AS deleted_listings,
             ${visitsExpr}
           FROM \`${table}\`
           WHERE user_id = ?`,
          [userId]
        );

        stats.total_listings += Number(row?.total_listings) || 0;
        stats.online_listings += Number(row?.online_listings) || 0;
        stats.offline_listings += Number(row?.offline_listings) || 0;
        stats.draft_listings += Number(row?.draft_listings) || 0;
        stats.paused_listings += Number(row?.paused_listings) || 0;
        stats.review_listings += Number(row?.review_listings) || 0;
        stats.deleted_listings += Number(row?.deleted_listings) || 0;
        stats.total_visits += Number(row?.total_visits) || 0;
        continue;
      }

      const visitsExpr = visitsCol ? `SUM(COALESCE(\`${visitsCol}\`, 0))` : '0';
      const [[row]] = await db.query(
        `SELECT
           COUNT(*) AS total_listings,
           ${visitsExpr} AS total_visits
         FROM \`${table}\`
         WHERE user_id = ?`,
        [userId]
      );

      stats.total_listings += Number(row?.total_listings) || 0;
      stats.total_visits += Number(row?.total_visits) || 0;
    }
  }

  const [[messageStats]] = await db.query(
    `SELECT
       SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS inquiries_received,
       SUM(CASE WHEN sender_id = ? THEN 1 ELSE 0 END) AS inquiries_sent
     FROM user_notifications
     WHERE user_id = ? OR sender_id = ?`,
    [userId, userId, userId, userId]
  );
  stats.inquiries_received = Number(messageStats?.inquiries_received) || 0;
  stats.inquiries_sent = Number(messageStats?.inquiries_sent) || 0;

  try {
    const [[supportStats]] = await db.query(
      `SELECT COUNT(*) AS support_requests
         FROM cancel_support_requests
        WHERE user_id = ?`,
      [userId]
    );
    stats.support_requests = Number(supportStats?.support_requests) || 0;
  } catch (err) {
    console.warn('Dashboard stats: cancel_support_requests not available', err.message);
  }

  stats.inquiries_total =
    stats.inquiries_sent +
    stats.inquiries_received +
    stats.support_requests;

  return stats;
}

function parseFirstImageFilename(input) {
  if (!input) return null;
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  try {
    if (raw.startsWith('a:')) {
      const parsed = unserialize(raw);
      const arr = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
      const first = arr[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
      if (first && typeof first.image === 'string' && first.image.trim()) return first.image.trim();
    }
  } catch {}

  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) {
        const first = parsed[0];
        if (typeof first === 'string' && first.trim()) return first.trim();
        if (first && typeof first.image === 'string' && first.image.trim()) return first.image.trim();
      } else if (parsed && typeof parsed.image === 'string' && parsed.image.trim()) {
        return parsed.image.trim();
      }
    } catch {}
  }

  if (raw.includes(',')) {
    const first = raw.split(',').map(s => s.trim()).find(Boolean);
    if (first) return first;
  }

  return raw;
}

function getListingStateLabel(status, visible) {
  const s = Number(status);
  const v = Number(visible);

  if (s === 3 && v === 1) return 'Online';
  if (s === 0 && v === 0) return 'Entwurf';
  if (s === 4 && v === 0) return 'Pausiert';
  if (s === 3 && v === 0) return 'In Pruefung';
  if (s === 9 && v === 0) return 'Geloescht';
  if (v === 0) return 'Offline';
  return 'Sonstige';
}

function toIntlLocaleTag(lang) {
  const base = String(lang || 'de').trim().toLowerCase();
  const map = {
    de: 'de-DE',
    en: 'en-US',
    fr: 'fr-FR',
    it: 'it-IT',
    tr: 'tr-TR',
    ja: 'ja-JP',
    cs: 'cs-CZ',
    ru: 'ru-RU',
    es: 'es-ES',
    nl: 'nl-NL',
    pl: 'pl-PL'
  };
  return map[base] || 'de-DE';
}

async function loadBuyerListingsForStatistics(userId) {
  const [entities] = await db.query(
    `SELECT id, name, route, table_name
       FROM ententies
      ORDER BY name ASC`
  );
  const tableNames = entities.map(e => e.table_name).filter(isSafeSqlIdentifier);
  const columnsByTable = await getTableColumnsMap(tableNames);
  const queryTasks = [];
  for (const ent of entities) {
    const table = ent.table_name;
    if (!isSafeSqlIdentifier(table)) continue;

    const cols = columnsByTable.get(table) || new Set();
    if (!cols.has('user_id')) continue;

    const titleCol = ['name', 'title', 'model', 'subtitle'].find(c => cols.has(c)) || null;
    const createdCol = ['created', 'modified', 'published'].find(c => cols.has(c)) || null;
    const visitsCol = cols.has('visits') ? 'visits' : (cols.has('views') ? 'views' : null);
    const imageCols = ['sliderpicture', 'mainpicture', 'pictures', 'thumbnail', 'image', 'picture']
      .filter(col => cols.has(col));

    const selectBits = ['`id`'];
    if (titleCol) {
      selectBits.push(`\`${titleCol}\` AS title`);
    } else {
      selectBits.push(`CONCAT('#', id) AS title`);
    }
    if (createdCol) {
      selectBits.push(`\`${createdCol}\` AS created_at`);
    } else {
      selectBits.push('NULL AS created_at');
    }
    if (cols.has('status')) {
      selectBits.push('`status`');
    } else {
      selectBits.push('NULL AS status');
    }
    if (cols.has('visible')) {
      selectBits.push('`visible`');
    } else {
      selectBits.push('NULL AS visible');
    }
    if (visitsCol) {
      selectBits.push(`\`${visitsCol}\` AS visits`);
    } else {
      selectBits.push('0 AS visits');
    }
    imageCols.forEach(col => selectBits.push(`\`${col}\``));

    const orderBy = createdCol ? `\`${createdCol}\` DESC` : '`id` DESC';

    queryTasks.push(async () => {
      const [rows] = await db.query(
        `SELECT ${selectBits.join(', ')}
           FROM \`${table}\`
          WHERE user_id = ?
          ORDER BY ${orderBy}
          LIMIT 5000`,
        [userId]
      );

      return rows.map((row) => {
        const thumbFilename = parseFirstImageFilename(
          row.sliderpicture ||
          row.mainpicture ||
          row.pictures ||
          row.thumbnail ||
          row.image ||
          row.picture ||
          null
        );

        return {
          id: Number(row.id),
          title: row.title || `#${row.id}`,
          entityName: ent.name || ent.route,
          entityRoute: ent.route,
          createdAt: row.created_at || null,
          status: row.status,
          visible: row.visible,
          visits: Number(row.visits) || 0,
          stateLabel: getListingStateLabel(row.status, row.visible),
          thumbnailUrl: thumbFilename ? `/images/${ent.route}/${row.id}/${thumbFilename}` : '/assets/herando-weblogo.png'
        };
      });
    });
  }

  const listings = [];
  const batchSize = 6;
  for (let i = 0; i < queryTasks.length; i += batchSize) {
    const batch = queryTasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(run => run()));
    for (const items of batchResults) listings.push(...items);
  }

  listings.sort((a, b) => {
    const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dbb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dbb - da;
  });

  return listings;
}

function buildMonthlyVisitorsSeries(listings, monthsBack = 12, localeTag = 'de-DE') {
  const months = Math.max(1, Number(monthsBack) || 12);
  const formatKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const labelFormatter = new Intl.DateTimeFormat(localeTag, { month: 'short', year: '2-digit' });

  const currentMonthStart = new Date();
  currentMonthStart.setDate(1);
  currentMonthStart.setHours(0, 0, 0, 0);

  const buckets = [];
  const byMonth = new Map();
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - i, 1);
    const key = formatKey(d);
    const bucket = {
      key,
      label: labelFormatter.format(d),
      visits: 0,
      listings: 0
    };
    buckets.push(bucket);
    byMonth.set(key, bucket);
  }

  for (const item of listings || []) {
    if (!item?.createdAt) continue;
    const created = new Date(item.createdAt);
    if (Number.isNaN(created.getTime())) continue;

    const key = formatKey(new Date(created.getFullYear(), created.getMonth(), 1));
    const bucket = byMonth.get(key);
    if (!bucket) continue;

    bucket.visits += Number(item.visits) || 0;
    bucket.listings += 1;
  }

  return {
    labels: buckets.map(b => b.label),
    visits: buckets.map(b => b.visits),
    listings: buckets.map(b => b.listings)
  };
}

function buildEmptyMonthlySeries(monthsBack = 12, localeTag = 'de-DE') {
  const months = Math.max(1, Number(monthsBack) || 12);
  const labelFormatter = new Intl.DateTimeFormat(localeTag, { month: 'short', year: '2-digit' });
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const labels = [];
  const values = [];

  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - i, 1);
    labels.push(labelFormatter.format(d));
    values.push(0);
  }
  return { labels, visits: values, listings: values.map(() => 0) };
}

async function loadBuyerMonthlyVisitorsFromVisitsHistory(userId, monthsBack = 12, listingRows = [], localeTag = 'de-DE') {
  const months = Math.max(1, Number(monthsBack) || 12);
  const emptySeries = buildEmptyMonthlySeries(months, localeTag);
  if (!Array.isArray(listingRows) || !listingRows.length) return emptySeries;

  const routeToAdvertIds = new Map();
  for (const listing of listingRows) {
    const route = String(listing?.entityRoute || '').trim();
    const advertId = Number(listing?.id);
    if (!route || !Number.isFinite(advertId)) continue;
    if (!routeToAdvertIds.has(route)) routeToAdvertIds.set(route, new Set());
    routeToAdvertIds.get(route).add(advertId);
  }
  if (!routeToAdvertIds.size) return emptySeries;

  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDate = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - (months - 1), 1);
  const formatKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const labelFormatter = new Intl.DateTimeFormat(localeTag, { month: 'short', year: '2-digit' });

  const monthKeys = [];
  const labels = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - i, 1);
    const key = formatKey(d);
    monthKeys.push(key);
    labels.push(labelFormatter.format(d));
  }
  const monthIndexByKey = new Map(monthKeys.map((key, idx) => [key, idx]));
  const monthValues = monthKeys.map(() => 0);
  let hasTrackedRows = false;

  const advertChunkSize = 400;
  for (const [route, idSet] of routeToAdvertIds.entries()) {
    const advertIds = [...idSet];
    if (!advertIds.length) continue;

    for (let i = 0; i < advertIds.length; i += advertChunkSize) {
      const chunk = advertIds.slice(i, i + advertChunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const [rows] = await db.query(
        `SELECT
           advert_id,
           YEAR(visited) AS year_num,
           MONTH(visited) AS month_num,
           SUM(visits) AS visitors
         FROM visits
         WHERE entity = ?
           AND advert_id IN (${placeholders})
           AND visited >= ?
         GROUP BY advert_id, year_num, month_num`,
        [route, ...chunk, startDate]
      );

      if (rows.length) hasTrackedRows = true;
      for (const row of rows) {
        const monthKey = `${Number(row.year_num)}-${String(Number(row.month_num)).padStart(2, '0')}`;
        const idx = monthIndexByKey.get(monthKey);
        if (idx == null) continue;
        monthValues[idx] += Number(row.visitors) || 0;
      }
    }
  }

  if (!hasTrackedRows) {
    return buildMonthlyVisitorsSeries(listingRows, months, localeTag);
  }

  return {
    labels,
    visits: monthValues,
    listings: labels.map(() => 0)
  };
}

// ===========================================================
// 1️⃣ CHECKOUT (POST)
// ===========================================================
// ===========================================================
// 💰 CHECKOUT – Zahlung oder Testmodus
// ===========================================================

router.post('/apply-coupon', ensureAuthenticated, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    const packageId = req.body.packageId;

    if (!code || !packageId) return res.json({ ok: false });

    const [[coupon]] = await db.query(`
      SELECT id, code, percent, active, valid_from, valid_until, max_uses, used_count
      FROM coupons
      WHERE code = ?
        AND active = 1
        AND (valid_from IS NULL OR valid_from <= NOW())
        AND (valid_until IS NULL OR valid_until >= NOW())
        AND (max_uses IS NULL OR used_count < max_uses)
      LIMIT 1
    `, [code]);

    if (!coupon) return res.json({ ok: false });

    const [[pkg]] = await db.query(`SELECT price FROM packages WHERE id = ? LIMIT 1`, [packageId]);
    if (!pkg) return res.json({ ok: false });

    const originalNet = parseFloat(pkg.price) || 0;
    const percent = parseFloat(coupon.percent) || 0;

    let newNet = originalNet - (originalNet * (percent / 100));
    if (newNet < 0) newNet = 0;

    return res.json({ ok: true, percent, newNet: newNet.toFixed(2) });
  } catch (e) {
    console.error('❌ apply-coupon error:', e);
    return res.json({ ok: false });
  }
});


function formatDuration(unit, amt) {
  if (unit === 'months') return `${amt} Monat${amt > 1 ? 'e' : ''}`;
  if (unit === 'days')   return `${amt} Tag${amt > 1 ? 'e' : ''}`;
  return `${amt} ${unit}`;
}


async function runCheckout(req, res, next, checkoutBody, options = {}) {
  try {
    console.log('\n=============================');
    console.log('💰 POST /checkout gestartet');
    console.log('=============================');

    // ✅ ENV prüfen & loggen
    const parseBool = (v) => /^true|1|yes|on$/i.test(String(v).trim());
    const DISABLE_PAYMENT = parseBool(process.env.DISABLE_PAYMENT);
    console.log('🔧 DISABLE_PAYMENT (raw):', process.env.DISABLE_PAYMENT);
    console.log('🔧 DISABLE_PAYMENT (bool):', DISABLE_PAYMENT);

    // 🔹 Request-Daten auslesen
    const { packageId, type, category_id } = checkoutBody || {};
    const user = res.locals.user;
    let country_id = checkoutBody?.country_id || user?.country_id;
    const [[freshUser]] = await db.query(
      'SELECT vatid FROM users WHERE id = ?',
      [user.id]
    );

    const vatid = freshUser?.vatid || null;

    console.log('🧾 VAT aus DB geladen:', vatid);


    console.log('📦 Angeforderte Daten:', { packageId, type, vatid, country_id, category_id });
    console.log('👤 Aktueller User:', user ? `ID=${user.id}` : '❌ Kein User gefunden!');

    if (!packageId || !type) {
      console.error('❌ Fehlende Paketdaten:', { packageId, type });
      return res.status(400).json({
        error: await tr(req, res, 'buyer.checkout.error.missing_package_data', 'Fehlende Paketdaten.')
      });
    }

    // 🔹 Land ggf. nachladen
    if (!country_id && user?.id) {
      console.log('🔍 Lade country_id direkt aus users...');
      const [[userCountry]] = await db.query(
        `SELECT country_id FROM users WHERE id = ?`,
        [user.id]
      );
      if (userCountry && userCountry.country_id) {
        country_id = userCountry.country_id;
        console.log(`✅ country_id aus DB gefunden: ${country_id}`);
      } else {
        console.warn(`⚠️ Kein country_id beim User gefunden!`);
      }
    }

    if (!country_id) {
      console.error('❌ Kein Land angegeben oder gefunden!');
      return res.status(400).json({
        error: await tr(req, res, 'buyer.checkout.error.missing_country', 'Kein Land angegeben oder beim User gefunden.')
      });
    }

    // 1️⃣ Paketdaten laden
    console.log('📦 Lade Paketdaten aus DB...');
    const [[pkgInfo]] = await db.query(`
      SELECT
        id,
        name,
        price,
        duration_unit,
        duration_amt,
        inseratenanzahl,
        registration_type
      FROM packages
      WHERE id = ? AND registration_type = ?

    `, [packageId, type]);

    if (!pkgInfo) {
      console.error('❌ Kein passendes Paket gefunden:', { packageId, type });
      return res.status(404).json({
        error: await tr(req, res, 'buyer.checkout.error.package_not_found', 'Paket nicht gefunden.')
      });
    }

    console.log('✅ Paket gefunden:', pkgInfo);

    // 2️⃣ Steuerdaten
    const [[countryMeta]] = await db.query(`
      SELECT id, code, iso_code FROM countries WHERE id = ?
    `, [country_id]);

    const [[countryTax]] = await db.query(`
      SELECT tax_rate, abbreviation FROM country_tax_rates WHERE country_id = ?
    `, [country_id]);

const baseTaxRate = countryTax?.tax_rate ?? 0;
const countryAbbr = countryTax?.abbreviation ?? countryMeta.code;

console.log('✅ Steuerdaten:', { country_id, code: countryMeta.code, baseTaxRate });

let vatValidation = 'none';
let applyVat = true;
let taxRate = 21;

const euCountries = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];
const countryCode = countryMeta.code || 'CZ';

if (vatid && vatid.trim() !== '') {
  console.log(`🔍 Prüfe VAT-ID über VIES: ${vatid}`);

  const isValidVAT = await validateVAT_VIES(vatid);

  if (isValidVAT && euCountries.includes(countryCode) && countryCode !== 'CZ') {
    vatValidation = 'valid';
    applyVat = false;
    taxRate = 0;
    console.log('✅ VIES gültig → Reverse Charge (0 %)');
  } else {
    vatValidation = 'invalid';
    applyVat = true;
    taxRate = 21;
    console.log('⚠️ VAT ungültig oder CZ → MwSt 21 %');
  }
} else {
  vatValidation = 'none';
  applyVat = true;
  taxRate = 21;
  console.log('ℹ️ Keine VAT → MwSt 21 %');
}




      // 4️⃣ Preisberechnung (FIX: immer 21 % bei applyVat)
      const netPrice = parseFloat(checkoutBody?.netPriceOverride) || parseFloat(pkgInfo.price);
      const taxAmount = applyVat ? netPrice * (taxRate / 100) : 0;
      const grossPrice = netPrice + taxAmount;

      const durationText = formatDuration(pkgInfo.duration_unit, pkgInfo.duration_amt);
      const inserateText = `${pkgInfo.inseratenanzahl} Inserat${pkgInfo.inseratenanzahl > 1 ? 'e' : ''}`;
      const priceText = `${netPrice.toFixed(2)} €`;

      console.log(`💶 Preis: ${grossPrice.toFixed(2)} € (${applyVat ? taxRate : 0}% MwSt)`);


    // 5️⃣ Session speichern
    req.session.pendingOrder = {
      package_id: pkgInfo.id,
      package_name: pkgInfo.name,
      registration_type: type,
      country_id,
      vatid,
      vat_status: vatValidation,
      apply_vat: applyVat,
      base_tax_rate: baseTaxRate,
      original_net: parseFloat(pkgInfo.price),
      discount_percent: parseFloat(checkoutBody?.discountPercent || 0),
      discount_amount: parseFloat(checkoutBody?.discountAmount || 0),
      net_price: netPrice,
      gross_price: grossPrice,
      category_id
    };
    console.log('✅ Session pendingOrder gespeichert.');

    // 6️⃣ TESTMODUS – Stripe überspringen
    if (DISABLE_PAYMENT) {
      console.log('🧾 DISABLE_PAYMENT=true → Stripe wird übersprungen!');
      console.log('➡️ Weiterleitung direkt zu /buyer/zahlung/success (Testmodus)');
      const params = new URLSearchParams({
        test: '1',
        package_id: pkgInfo.id,
        type,
        gross_price: grossPrice,
        country_id,
      }).toString();
      return res.redirect(`/buyer/zahlung/success?${params}`);
    }

    // 7️⃣ Stripe Checkout Session
    console.log('💳 Erstelle Stripe Checkout-Session...');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      allow_promotion_codes: true,
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `Herando-Paket: ${pkgInfo.name}`,
              description: [
                `Laufzeit: ${durationText}`,
                `Inserate: ${inserateText}`,
                `Preis: ${priceText}`
              ].join(' | '),
              metadata: {
                package_id: pkgInfo.id,
                duration: durationText,
                inserate: pkgInfo.inseratenanzahl
              }
            },
            unit_amount: Math.round(grossPrice * 100)
          },
          quantity: 1
        }
      ],

      metadata: {
        package_id: pkgInfo.id,
        vat_status: vatValidation,
        tax_rate: baseTaxRate,
        country: countryMeta.code,
        user_id: user?.id || 'unknown'
      },
      success_url: `${req.protocol}://${req.get('host')}/buyer/zahlung/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/buyer/zahlung_failed?package_id=${encodeURIComponent(pkgInfo.id)}&country_id=${encodeURIComponent(country_id)}&category_id=${encodeURIComponent(category_id || 1)}&gross_price=${encodeURIComponent(grossPrice)}&vatid=${encodeURIComponent(vatid || '')}`,
    });

    console.log(`✅ Stripe-Session erstellt: ${session.id}`);
    if (options.clearPendingCheckout) {
      req.session.pendingCheckout = null;
    }
    res.redirect(303, session.url);

  } catch (err) {
    console.error('\n💥 FATALER CHECKOUT-FEHLER 💥', err);
    next(err);
  }
}

router.post('/checkout', requireBillingData, async (req, res, next) => {
  return runCheckout(req, res, next, req.body);
});

function setCheckoutTypeFromSession(req, res, next) {
  const pending = req.session.pendingCheckout;
  if (pending?.type) {
    req.query.type = pending.type;
  }
  next();
}

router.get('/checkout/resume', setCheckoutTypeFromSession, requireBillingData, async (req, res, next) => {
  const pending = req.session.pendingCheckout;
  if (!pending) {
    req.session.errorMessage = '❗ Keine ausstehende Zahlung gefunden.';
    return res.redirect('/buyer/sold');
  }
  return runCheckout(req, res, next, pending, { clearPendingCheckout: true });
});


// ===========================================================
// 2️⃣ ZAHLUNG SUCCESS (GET)
// ===========================================================
router.get('/zahlung/success', async (req, res, next) => {
  let locale = req.locale || req.session?.lang || req.acceptsLanguages()?.[0] || 'de';
  if (locale.includes('-')) locale = locale.split('-')[0];
    async function tBackend(key, locale = 'de') {
      const [[row]] = await db.query(
        `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
        [locale, key]
      );
      return row?.txt || key;
    }
    const greet      = await tBackend('email.invoice.greeting', locale);
    const confirm    = await tBackend('email.invoice.confirmation', locale);
    const attached   = await tBackend('email.invoice.attached', locale);
    const questions  = await tBackend('email.invoice.questions', locale);
    const regards    = await tBackend('email.invoice.regards', locale);
    const team       = await tBackend('email.invoice.team', locale);
    const subjectTxt = await tBackend('email.invoice.subject', locale);



  const user = res.locals.user;
  const parseBool = (v) => /^true|1|yes|on$/i.test(String(v).trim());
  const DISABLE_PAYMENT = parseBool(process.env.DISABLE_PAYMENT);
  const isTest = req.query.test === '1' || DISABLE_PAYMENT;

  try {
    console.log('\n=============================');
    console.log('💶 GET /zahlung/success gestartet');
    console.log('🔧 DISABLE_PAYMENT (raw):', process.env.DISABLE_PAYMENT);
    console.log('🔧 DISABLE_PAYMENT (bool):', DISABLE_PAYMENT);
    console.log('=============================');

    let pending = req.session.pendingOrder;

    // 🧩 Fallback falls Session leer (Testmodus)
    if (!pending && isTest) {
      console.log('⚠️ Session leer, baue PendingOrder aus Query (Testmodus)');
      pending = {
        package_id: req.query.package_id,
        package_name: 'Test-Paket',
        registration_type: req.query.type || 'private',
        country_id: req.query.country_id,
        vatid: null,
        vat_status: 'none',
        apply_vat: true,
        base_tax_rate: 20,
        net_price: parseFloat(req.query.gross_price) / 1.2,
        gross_price: parseFloat(req.query.gross_price),
        category_id: 1 // Standard-Fallback
      };
    }

    if (!pending) {
      console.error('❌ Keine Pending-Order gefunden.');
      return res.status(400).send(
        await tr(req, res, 'buyer.checkout.error.invalid_operation', 'Ungültiger Vorgang.')
      );
    }

    // ✅ Stripe-Check nur im Live-Modus
    let sessionObj = null;
    if (!isTest) {
      const sessionId = req.query.session_id;
      if (!sessionId) {
        return res.status(400).send(
          await tr(req, res, 'buyer.checkout.error.missing_session_id', 'Keine Session-ID vorhanden.')
        );
      }
      sessionObj = await stripe.checkout.sessions.retrieve(sessionId);
      if (sessionObj.payment_status !== 'paid') {
        console.warn('⚠️ Zahlung nicht abgeschlossen.');
        return res.status(400).send(
          await tr(req, res, 'buyer.checkout.error.payment_not_completed', 'Zahlung nicht abgeschlossen.')
        );
      }
      console.log(`✅ Stripe Zahlung bestätigt: ${sessionObj.id}`);
    } else {
      console.log('🧾 Testmodus aktiv – Stripe wird übersprungen.');
    }

    // 🧾 VAT speichern
    if (user) {
      await db.query(
        `UPDATE users SET vatid = ?, modified = NOW() WHERE id = ?`,
        [pending.vatid || null, user.id]
      );
    }

    // 🧾 Paketinformationen
    const [[pkg]] = await db.query(`SELECT name FROM packages WHERE id = ?`, [pending.package_id]);

    // 🧾 Order erstellen
    const [orderRes] = await db.query(`
      INSERT INTO orders (
        user_id, package_id, product, country_id, category_id,
        firstname, lastname, company, vatid, street, housenumber,
        postcode, city, phone, email, created_at
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
    `, [
      user.id,
      pending.package_id,
      pkg.name,
      pending.country_id,
      pending.category_id || 1,
      user.firstname || '',
      user.lastname || '',
      user.company || null,
      user.vatid || null,
      user.street || '',
      user.housenumber || '',
      user.postcode || '',
      user.city || '',
      user.phone || null,
      user.email || ''
    ]);

    const orderId = orderRes.insertId;
    console.log(`✅ Neue Order erstellt: ID ${orderId}`);

    // 7️⃣ Paketlaufzeit und Inserate erfassen
      console.log('📦 Speichere ausgewähltes Paket...');

      // Hole Dauer + Inseratenanzahl aus packages
      const [[pkgData]] = await db.query(`
        SELECT duration_unit, duration_amt, inseratenanzahl 
        FROM packages 
        WHERE id = ?
      `, [pending.package_id]);

      // Laufzeit berechnen
      let endDateQuery = '';
      if (pkgData.duration_unit === 'days') {
        endDateQuery = `DATE_ADD(NOW(), INTERVAL ${pkgData.duration_amt} DAY)`;
      } else if (pkgData.duration_unit === 'months') {
        endDateQuery = `DATE_ADD(NOW(), INTERVAL ${pkgData.duration_amt} MONTH)`;
      } else if (pkgData.duration_unit === 'years') {
        endDateQuery = `DATE_ADD(NOW(), INTERVAL ${pkgData.duration_amt} YEAR)`;
      } else {
        endDateQuery = `DATE_ADD(NOW(), INTERVAL 30 DAY)`; // Fallback
      }

      await db.query(`
        INSERT INTO selected_packages (
          user_id,
          package_id,
          category_id,
          country_id,
          start_date,
          end_date,
          max_listings,
          used_listings,
          order_id,
          created_at
        )
        VALUES (?, ?, ?, ?, NOW(), ${endDateQuery}, ?, 0, ?, NOW())
      `, [
        user.id,
        pending.package_id,
        pending.category_id || 1,
        pending.country_id,
        pkgData.inseratenanzahl || 0,
        orderId
      ]);

      console.log('✅ Paket erfolgreich in selected_packages eingetragen!');


    // 💳 Payment speichern
    await db.query(`
      INSERT INTO payments (order_id, amount, currency, provider_id, status, created_at)
      VALUES (?,?,?,?,?,NOW())
    `, [
      orderId,
      pending.gross_price,
      'EUR',
      isTest ? 'TEST_MODE' : sessionObj.payment_intent,
      isTest ? 'simulated' : 'succeeded'
    ]);
    console.log('💰 Payment-Datensatz gespeichert.');

    // 📦 Rechnungsdaten aus der DB holen (JOIN!)
    const [[orderData]] = await db.query(`
      SELECT 
        o.*, 
        p.name AS product,                          -- z. B. "Marketing-Paket Premium"
        p.price AS amount,              
        ctr.tax_rate AS taxPercentage,

        -- Partnerdaten
        u.id AS partner_partnerident,
        u.firstname AS partner_first_name,
        u.lastname AS partner_last_name,
        u.street AS partner_street,
        u.housenumber AS partner_housenumber,
        u.postcode AS partner_postcode,
        CONCAT(u.street,' ',u.housenumber) AS partner_address,
        CONCAT(u.postcode,' ',u.city)       AS partner_city,
        u.company AS partner_firmenname,
        u.vatid AS partner_atu_nummer,
        c.de AS partner_country,
        ctr.abbreviation AS partner_abbreviation,
        c.code AS partner_country_code,

        -- Paket-Infos
        sp.start_date,
        sp.end_date,
        DATE_FORMAT(sp.end_date, '%d.%m.%Y') AS package_end_formatted,   -- 📅 z. B. "28.01.2026"
        sp.max_listings,
        sp.used_listings,

        -- Entität (z. B. Autos, Immobilien, Yachten, Uhren)
        e.name AS entity_name,
        e.route AS entity_route,
        e.description AS entity_description,

        o.id AS order_number

      FROM orders o
      JOIN payments pm ON pm.order_id = o.id
      JOIN packages p ON p.id = o.package_id
      JOIN users u ON u.id = o.user_id
      JOIN countries c ON c.id = o.country_id
      LEFT JOIN country_tax_rates ctr ON ctr.country_id = o.country_id
      LEFT JOIN selected_packages sp
        ON sp.order_id = o.id
       AND sp.user_id = o.user_id
       AND sp.package_id = o.package_id
       AND sp.category_id = o.category_id
      LEFT JOIN ententies e ON e.id = o.category_id
      WHERE o.id = ?
    `, [orderId]);


    console.log('🧾 ORDERDATA:', orderData);

        // 🔤 Sprach-Keys für Produkt, Kategorie & Anzeige-Titel vorbereiten
    orderData.locale = locale;

    // 👉 Entitäten/Seiten (cars, yachts, properties, watches etc.)
    orderData.entity_key = `entity.${orderData.entity_route}`;

    // 👉 Produkt (z. B. Marketing-Paket Premium → package.marketing_premium)
    orderData.package_key = `package.${orderData.product
      .toLowerCase()
      .replace(/ /g,'_')
      .replace(/-/g,'_')}`;

    // 👉 Anzeige-Titel Übersetzungsvorlage
    // z. B.: "Anuncio {{package}}: {{entity}}"
    orderData.ad_key = 'invoice.ad';

    // 👉 Rechnungsnummer & Order-ID separat
    orderData.invoice_code = `${orderData.partner_abbreviation}-${orderData.order_number}`;
    orderData.order_id_txt = `${orderData.order_number}`;
    orderData.original_net = pending.original_net;
    orderData.discount_percent = pending.discount_percent;
    orderData.discount_amount = pending.discount_amount;
    orderData.net_after_discount = pending.net_price;



    // 🧾 Rechnung generieren
    console.log('📄 Erzeuge PDF-Rechnung...');
    const outDir = process.env.INVOICE_OUTPUT_DIR || 'public/assets/pdf/invoices';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, `invoice_${orderId}.pdf`);

    generateInvoice(orderData, async (err, pdfBytes) => {
      if (err) {
        console.error('❌ Fehler bei Rechnungserstellung:', err);
        return res.status(500).send(
          await tr(req, res, 'buyer.checkout.error.invoice_generation', 'Fehler bei der Rechnungserstellung.')
        );
      }

      fs.writeFileSync(filePath, pdfBytes);
      console.log(`✅ Rechnung erstellt: ${filePath}`);

      // 📧 Rechnung per E-Mail verschicken
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: process.env.SMTP_PORT,
          secure: process.env.SMTP_SECURE === 'true',
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const mailOptions = {
          from: `"Herando Accounting" <accounting@herando.com>`,
          to: user.email,
          subject: subjectTxt.replace('{{id}}', orderId),
          html: `
          <div style="font-family: Arial, sans-serif; background-color: #f6f6f6; padding: 20px;">
            <div style="max-width: 600px; background: #ffffff; margin: auto; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
              <div style="text-align: center; margin-bottom: 25px;">
                <img src="https://www.herando.com/static/img/logo.svg" alt="Herando" style="max-width: 160px;">
              </div>

              <p style="font-size: 15px; color: #333;">
                ${greet.replace('{{firstname}}', user.firstname || '').replace('{{lastname}}', user.lastname || '')}
              </p>

              <p style="font-size: 15px; color: #333;">
                ${confirm}
              </p>

              <p style="font-size: 15px; color: #333;">
                ${attached.replace('{{id}}', orderId)}
              </p>

              <p style="font-size: 15px; color: #333;">
                ${questions}
              </p>

              <p style="margin-top: 25px; font-size: 15px; color: #333;">
                ${regards}<br><strong>${team}</strong>
              </p>

              <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

              <p style="font-size: 12px; color: #777; text-align: center;">
                Herando A.S.<br>
                www.herando.com<br>
                ${await tBackend('email.invoice.autogenerated', locale)}
              </p>
            </div>
          </div>
          `,
          attachments: [
            {
              filename: `Rechnung_${orderId}.pdf`,
              path: filePath,
              contentType: 'application/pdf',
            },
          ],
        };



        await transporter.sendMail(mailOptions);
        console.log(`📨 Rechnung Nr. ${orderId} erfolgreich an ${user.email} gesendet.`);
      } catch (mailErr) {
        console.error('❌ Fehler beim Mailversand der Rechnung:', mailErr);
      }

      // 🧹 Session bereinigen
      delete req.session.pendingOrder;

          // 🌐 SEO laden
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT 
        title,
        description AS meta_description,
        robots,
        og_title,
        og_description,
        og_image,
        twitter_card,
        jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description: seoRow?.meta_description || 'Entdecken Sie exklusive Angebote.',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || seoRow?.title || null,
      og_description: seoRow?.og_description || seoRow?.meta_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };
    res.locals.seo = seo;

    console.log('🧾 INVOICE DEBUG:', {
  orderId,
  order_number: orderData?.order_number,
  partner_abbreviation: orderData?.partner_abbreviation,
  invoice_code: orderData?.invoice_code,
  payment_status: orderData?.payment_status
});


      // ✅ Erfolgsseite rendern
      res.render('pages/templates/zahlung-success', {
        orderId,
        invoiceUrl: `/assets/pdf/invoices/invoice_${orderId}.pdf`,
        user,
        seo,
        headerTitle: isTest ? 'Testrechnung erfolgreich' : 'Zahlung erfolgreich',
        currentUrl: req.url,
        login_user: req.user
      });
    });


  } catch (err) {
    console.error('💥 Fehler in /zahlung/success:', err);
    next(err);
  }
});

router.get('/zahlung_failed', async (req, res, next) => {
  try {
    const user = res.locals.user;

    let pending = req.session.pendingOrder;

    if (!pending) {
      pending = {
        package_id: req.query.package_id,
        country_id: req.query.country_id,
        category_id: req.query.category_id || 1,
        vatid: req.query.vatid || null,
        gross_price: req.query.gross_price || 0
      };
    }

    // Paket holen
    const [[pkg]] = await db.query(
      `SELECT name FROM packages WHERE id = ?`,
      [pending.package_id]
    );

    // Order speichern
    const [orderRes] = await db.query(`
      INSERT INTO orders (
        user_id, package_id, product, country_id, category_id,
        firstname, lastname, company, vatid, street, housenumber,
        postcode, city, phone, email, created_at
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())
    `, [
      user.id,
      pending.package_id,
      pkg.name,
      pending.country_id,
      pending.category_id || 1,
      user.firstname || '',
      user.lastname || '',
      user.company || null,
      pending.vatid || null,
      user.street || '',
      user.housenumber || '',
      user.postcode || '',
      user.city || '',
      user.phone || null,
      user.email || ''
    ]);

    const orderId = orderRes.insertId;

    // Payment failed speichern
    await db.query(`
      INSERT INTO payments (order_id, amount, currency, provider_id, status, created_at)
      VALUES (?,?,?,?,?,NOW())
    `, [
      orderId,
      pending.gross_price,
      'EUR',
      'NONE',
      'failed'
    ]);

    // Session löschen
    delete req.session.pendingOrder;

    // SEO laden
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT 
        title,
        description AS meta_description,
        robots,
        og_title,
        og_description,
        og_image,
        twitter_card,
        jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description: seoRow?.meta_description || 'Entdecken Sie exklusive Angebote.',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || seoRow?.title || null,
      og_description: seoRow?.og_description || seoRow?.meta_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };

    res.locals.seo = seo;

    // Fehlerseite rendern
    res.render('pages/templates/zahlung-failed', {
      orderId,
      user,
      headerTitle: await tr(req, res, 'buyer.payment.failed.title', 'Zahlung fehlgeschlagen'),
      currentUrl: req.url,
      login_user: req.user,
      seo,
    });

  } catch (err) {
    console.error('Fehler in /zahlung_failed:', err);
    next(err);
  }
});



// ─── 4) GET /buyer ─── Profil & Pakete/Bestellungen, ohne Inserate ─────
router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/auth/login');

    // 1) Nutzerdaten
    const [[user]] = await db.query(
      `SELECT 
         contact, company, vatid, firstname,
         lastname, street, housenumber, postcode,
         city, phone, mobile, fax,
         email, website, role,
              flatrate_test,
     flatrate_all,
     flatrate_cars,
     flatrate_properties,
     flatrate_watches,
     flatrate_yachts,
     flatrate_investments
       FROM users
       WHERE id = ?`,
      [userId]
    );

    // 2) Prüfen, ob der User ein gültiges Paket hat
    const [[sel]] = await db.query(
      `SELECT 1
         FROM selected_packages
        WHERE user_id    = ?
          AND start_date <= NOW()
          AND end_date   > NOW()
        LIMIT 1`,
      [userId]
    );
    const hasPackage = Boolean(sel);

    // 3) Nur wenn er ein Paket hat, holen wir die Pakete und Orders
    let packages = [], orders = [];
    if (hasPackage) {
      [packages] = await db.query(
        `SELECT sp.id, p.name AS package_name,
                COALESCE(e.name,'–') AS category_name,
                c.de AS country_name,
                sp.start_date, sp.end_date,
                sp.max_listings, sp.used_listings
           FROM selected_packages sp
           JOIN packages p   ON p.id = sp.package_id
           LEFT JOIN ententies e ON e.id = sp.category_id
           JOIN countries c  ON c.id = sp.country_id
          WHERE sp.user_id = ?
          ORDER BY sp.start_date DESC`,
        [userId]
      );
      [orders] = await db.query(
        `SELECT id, product, created_at
           FROM orders
          WHERE user_id = ?
          ORDER BY created_at DESC`,
        [userId]
      );
    }

let newsletterSubscribed = false;

try {
  console.log('🟢 [NewsletterCheck] Starte Newsletter-Prüfung...');

  if (user && user.email) {
    console.log('📧 [NewsletterCheck] User gefunden:', user.email);

    const [rows] = await db.query(
      `SELECT id 
         FROM newsletter_subscribers 
        WHERE email = ? AND accepted = 1
        LIMIT 1`,
      [user.email]
    );

    console.log('📊 [NewsletterCheck] Query-Ergebnis:', rows);

    newsletterSubscribed = rows.length > 0;
    console.log('✅ [NewsletterCheck] newsletterSubscribed:', newsletterSubscribed);
  } else {
    console.warn('⚠️ [NewsletterCheck] Kein Benutzer oder keine E-Mail vorhanden!');
  }

} catch (err) {
  console.error('❌ [NewsletterCheck] Fehler bei der Prüfung:', err);
}


        // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    // 4) Render
    res.render('pages/templates/buyer', {
      user,
      packages,
      invoices:    orders,
      currentPage: null,
      sectionData: [],
      hasPackage, 
      newsletterSubscribed, 
    });
  } catch (err) {
    next(err);
  }
});

router.get('/statistiken', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/auth/login');

    const [[user]] = await db.query(
      `SELECT
         id, role, firstname, lastname, email
       FROM users
       WHERE id = ?`,
      [userId]
    );
    if (!user) return res.redirect('/auth/login');

    const urlPath = normalizePathUrl(req.path);
    const listingRows = await loadBuyerListingsForStatistics(userId);
    const localeTag = toIntlLocaleTag(res.locals.lang || req.session?.lang || req.locale || 'de');

    const [dashboardStats, visitorChartData, seoResult] = await Promise.all([
      loadBuyerDashboardStats(userId, listingRows),
      loadBuyerMonthlyVisitorsFromVisitsHistory(userId, 12, listingRows, localeTag).catch((trackingErr) => {
        console.warn('Statistiken: Fallback auf listing-basierte Monatswerte', trackingErr.message);
        return buildMonthlyVisitorsSeries(listingRows, 12, localeTag);
      }),
      db.query(
        `SELECT
           title,
           description AS meta_description,
           robots,
           og_title,
           og_description,
           og_image,
           twitter_card,
           jsonld AS structured_data_json
         FROM seo_meta
         WHERE path_pattern = ?
         LIMIT 1`,
        [urlPath]
      )
    ]);
    const [seoRows] = seoResult;
    const seoRow = seoRows?.[0] || null;

    const seo = {
      title:                seoRow?.title || 'Buyer Statistiken – Herando',
      meta_description:     seoRow?.meta_description || 'Statistiken zu Ihren Anfragen, Besuchern und Inseraten.',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || seoRow?.title || 'Buyer Statistiken – Herando',
      og_description:       seoRow?.og_description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    res.render('pages/templates/buyer-statistics', {
      user,
      currentPage: 'statistiken',
      dashboardStats,
      listingRows,
      visitorChartData,
      userHasPackage: Boolean(res.locals.hasPackage)
    });
  } catch (err) {
    console.error('Fehler in GET /buyer/statistiken:', err);
    next(err);
  }
});

router.get('/my-listings', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/auth/login');

    const [[user]] = await db.query(
      `SELECT 
         contact, company, vatid, firstname, lastname, street, housenumber, postcode,
         city, phone, mobile, fax, email, website,
         flatrate_test, flatrate_all, flatrate_cars,
         flatrate_properties, flatrate_watches, flatrate_yachts, flatrate_investments
       FROM users
       WHERE id = ?`,
      [userId]
    );

    // 2) Pakete
    const [packages] = await db.query(
      `SELECT sp.id, p.name AS package_name,
              COALESCE(e.name,'–') AS category_name,
              c.de AS country_name,
              sp.start_date, sp.end_date, sp.max_listings, sp.used_listings
         FROM selected_packages sp
         JOIN packages p ON p.id = sp.package_id
         LEFT JOIN ententies e ON e.id = sp.category_id
         JOIN countries c ON c.id = sp.country_id
        WHERE sp.user_id = ?
        ORDER BY sp.start_date DESC`,
      [userId]
    );

    const [orders] = await db.query(
      `SELECT id, product, created_at
         FROM orders
        WHERE user_id = ?
        ORDER BY created_at DESC`,
      [userId]
    );

    const q = (table, route) => {
      return db.query(
        `SELECT *, ? AS entityRoute
           FROM \`${table}\`
          WHERE user_id = ?
            AND NOT (status = 9 AND visible = 0)
          ORDER BY created DESC`,
        [route, userId]
      );
    };

    const [
      [props],
      [cars],
      [watches],
      [yachts],
      [lifestyles]
    ] = await Promise.all([
      q('properties',  'properties'),
      q('cars',        'cars'),
      q('watches',     'watches'),
      q('yachts',      'yachts'),
      q('lifestyles',  'lifestyles')
    ]);

    // 5) Zusammenführen und sortieren
    let listings = [...props, ...cars, ...watches, ...yachts, ...lifestyles];
    listings.sort((a, b) => new Date(b.created) - new Date(a.created));

    // 6) Bilder + Status-Texte
const enriched = listings.map(item => {
  let filename = null;

  try {
    // 🖼️ 1️⃣ Versuch: aus `pictures` das erste Bild nehmen
    if (item.pictures && typeof item.pictures === 'string') {
      const { unserialize } = require('php-serialize');
      const pics = unserialize(item.pictures);
      if (Array.isArray(pics) && pics.length > 0 && pics[0].image) {
        filename = pics[0].image;
      }
    }

    // 🧩 2️⃣ Fallback: falls kein Bild in pictures vorhanden, `mainpicture` prüfen
    if (!filename && item.mainpicture) {
      if (item.mainpicture.startsWith('a:')) {
        const { unserialize } = require('php-serialize');
        const parsed = unserialize(item.mainpicture);
        if (parsed && parsed.image) filename = parsed.image;
      } else {
        filename = item.mainpicture;
      }
    }
  } catch (err) {
    console.warn(`⚠️ Fehler beim Unserialisieren von Bildern für ID ${item.id}:`, err.message);
  }

  // 🖼️ 3️⃣ Finalen Bildpfad setzen
  const imageUrl = filename
    ? `/images/${item.entityRoute}/${item.id}/${filename}`
    : '/assets/default-placeholder.png';

  // 🟢 Statuslabel wie gehabt
  let statusLabel = 'Unbekannt';
  let statusClass = 'text-muted';
  switch (item.status) {
    case 0: statusLabel = 'Entwurf'; statusClass = 'text-secondary'; break;
    case 1: statusLabel = 'Online'; statusClass = 'text-success'; break;
    case 2: statusLabel = 'Abgelaufen'; statusClass = 'text-danger'; break;
    case 3: statusLabel = 'In Prüfung'; statusClass = 'text-warning'; break;
    case 4: statusLabel = 'Offline'; statusClass = 'text-dark'; break;
  }

  return { ...item, imageUrl, statusLabel, statusClass };
});



    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title, description AS meta_description, robots, og_title,
         og_description, og_image, twitter_card, jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title: seoRow?.title || 'Meine Inserate – Herando',
      meta_description: seoRow?.meta_description || 'Alle meine Inserate bei Herando.',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || seoRow?.title,
      og_description: seoRow?.og_description || seoRow?.meta_description,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null
    };
    res.locals.seo = seo;

    // 8) Rendern
    res.render('pages/templates/buyer', {
      user,
      packages,
      invoices: orders,
      currentPage: 'my-listings',
      seo,
      sectionData: enriched
    });

  } catch (err) {
    console.error('❌ Fehler in GET /my-listings:', err);
    next(err);
  }
});


['online','offline'].forEach(sectionKey => {
  router.get(`/${sectionKey}`, async (req, res, next) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.redirect('/auth/login');

      // 1) Nutzerdaten
    const [[user]] = await db.query(
      `SELECT 
         contact, company, vatid, firstname,
         lastname, street, housenumber, postcode,
         city, phone, mobile, fax,
         email, website, 
              flatrate_test,
     flatrate_all,
     flatrate_cars,
     flatrate_properties,
     flatrate_watches,
     flatrate_yachts,
     flatrate_investments
       FROM users
       WHERE id = ?`,
      [userId]
    );
      console.log(`>>> GET /buyer/${sectionKey} · user:`, user);

      const [packages] = await db.query(
        `SELECT sp.id,
                p.name               AS package_name,
                COALESCE(e.name,'–') AS category_name,
                c.de                 AS country_name,
                sp.start_date,
                sp.end_date,
                sp.max_listings,
                sp.used_listings
           FROM selected_packages sp
           JOIN packages p   ON p.id = sp.package_id
           LEFT JOIN ententies e ON e.id = sp.category_id
           JOIN countries c  ON c.id = sp.country_id
          WHERE sp.user_id = ?
          ORDER BY sp.start_date DESC`,
        [userId]
      );
      console.log(`>>> GET /buyer/${sectionKey} · packages:`, packages);

      const [orders] = await db.query(
        `SELECT id, product, created_at
           FROM orders
          WHERE user_id = ?
          ORDER BY created_at DESC`,
        [userId]
      );
      console.log(`>>> GET /buyer/${sectionKey} · orders:`, orders);

      const statusConditions = sectionKey === 'online'
        ? 'status = 3 AND visible = 1'
        : 'visible = 0 AND status IN (0,1,2)';
      const q = (table, route) =>
        db.query(
          `SELECT *, ? AS entityRoute
             FROM \`${table}\`
            WHERE user_id = ?
              AND ${statusConditions}
            ORDER BY created DESC`,
          [route, userId]
        );

      const [
        [props],
        [cars],
        [watches],
        [yachts],
        [lifestyles]
      ] = await Promise.all([
        q('properties',  'properties'),
        q('cars',        'cars'),
        q('watches',     'watches'),
        q('yachts',      'yachts'),
        q('lifestyles',  'lifestyles')
      ]);

      console.log(`>>> GET /buyer/${sectionKey} · raw properties:`, props.length);
      console.log(`>>> GET /buyer/${sectionKey} · raw cars:`,       cars.length);
      console.log(`>>> GET /buyer/${sectionKey} · raw watches:`,    watches.length);
      console.log(`>>> GET /buyer/${sectionKey} · raw yachts:`,     yachts.length);
      console.log(`>>> GET /buyer/${sectionKey} · raw lifestyles:`, lifestyles.length);

      let sectionData = [...props, ...cars, ...watches, ...yachts, ...lifestyles];
      sectionData.sort((a, b) => new Date(b.created) - new Date(a.created));
      console.log(`>>> GET /buyer/${sectionKey} · total before enrich:`, sectionData.length);

sectionData = sectionData.map(item => {
  let filename = null;

  try {
    if (item.pictures && typeof item.pictures === 'string') {
      const { unserialize } = require('php-serialize');
      const pics = unserialize(item.pictures);
      if (Array.isArray(pics) && pics.length > 0 && pics[0].image) {
        filename = pics[0].image;
      }
    }

    if (!filename && item.mainpicture) {
      if (item.mainpicture.startsWith('a:')) {
        const { unserialize } = require('php-serialize');
        const parsed = unserialize(item.mainpicture);
        if (parsed && parsed.image) filename = parsed.image;
      } else {
        filename = item.mainpicture;
      }
    }

    if (!filename && item.thumbnail) {
      filename = item.thumbnail;
    }
  } catch (err) {
    console.warn(`⚠️ Fehler beim Unserialisieren für ID ${item.id}:`, err.message);
  }

  const imageUrl = filename
    ? `/images/${item.entityRoute}/${item.id}/${filename}`
    : '/assets/default-placeholder.png';

  return { ...item, imageUrl };
});

      console.log(`>>> GET /buyer/${sectionKey} · enriched sample:`, sectionData[0] || null);

      let newsletterSubscribed = false;
if (user?.email) {
  const [[sub]] = await db.query(
    'SELECT id FROM newsletter_subscribers WHERE email = ? LIMIT 1',
    [user.email]
  );
  newsletterSubscribed = !!sub;
}

              // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    
      // 7) Rendern
      res.render('pages/templates/buyer', {
        user,
        packages,
        invoices:    orders,
        currentPage: sectionKey,
        seo,
        newsletterSubscribed,
        sectionData
      });

    } catch (err) {
      console.error(`Fehler in GET /buyer/${sectionKey}:`, err);
      next(err);
    }
  });
});


router.get(
  '/new-listing',
  ensureAuthenticated,
  upload.array('pictures', 20),
  async (req, res, next) => {
    try {
      const categoryTypeMap = {
        properties:  1,
        watches:     2,
        cars:        3,
        yachts:      4,
        lifestyles:  5
      };

      // 0) User laden
      const currencies = [
        "AED","AUD","BGN","BRL","CAD","CHF","CNY","CZK","DKK","EUR","GBP","HKD","HRK","HUF",
        "IDR","ILS","INR","ISK","JPY","KRW","MXN","MYR","NOK","NZD","PHP","PLN","RON","RUB",
        "SEK","SGD","THB","TRY","USD","ZAR"
      ];
      const userId = req.session.userId;
      if (!userId) return res.redirect('/auth/login');
      const [[user]] = await db.query(
        `SELECT firstname, lastname, email, phone FROM users WHERE id = ?`,
        [userId]
      );
      if (!user) return res.redirect('/auth/login');

      // 1) Alle aktiven Pakete (distinct Kategorien) laden
      const [sel] = await db.query(
        `SELECT category_id
          FROM selected_packages
          WHERE user_id    = ?
            AND start_date <= NOW()
            AND end_date   > NOW()
          GROUP BY category_id
          ORDER BY MIN(start_date) DESC`,
        [userId]
      );

      // 📦 Pakettyp still im user-Objekt speichern
      const [[pkgType]] = await db.query(`
        SELECT p.registration_type
        FROM selected_packages sp
        JOIN packages p ON sp.package_id = p.id
        WHERE sp.user_id = ?
        ORDER BY sp.created_at DESC
        LIMIT 1
      `, [userId]);

      if (pkgType) user.registration_type = pkgType.registration_type;


      if (!sel.length) {
        req.session.errorMessage = 'Sie haben noch kein gültiges Paket. JETZT Paket buchen!';
        return res.redirect('/buyer/sold');
      }

      // 2) Für diese Kategorien die Entitäten laden
      const categoryIds   = sel.map(r => r.category_id);
      const placeholders  = categoryIds.map(() => '?').join(',');

      // Hinweis: FIELD(...) erhält die gleiche Reihenfolge wie categoryIds (für „erstes Tab“)
      const [entities] = await db.query(
        `SELECT id, name, route, table_name
          FROM ententies
          WHERE id IN (${placeholders})
          ORDER BY FIELD(id, ${placeholders})`,
        [...categoryIds, ...categoryIds]
      );

      // aktiven Tab aus ?tab=... bestimmen, sonst ersten nehmen
      const requestedTabId = Number(req.query.tab) || entities[0].id;

      // „ent“ so setzen, dass der Rest (Extras/Filter/EJS) weiter wie gewohnt funktioniert
      const ent = entities.find(e => e.id === requestedTabId) || entities[0];
      const tableName = ent.table_name;


      // 3) Extras aus attribute_options
      const [opts] = await db.query(
        `SELECT column_name, option_value, option_label
          FROM attribute_options
          WHERE entitie_route = ?
          ORDER BY column_name, option_label ASC`,
        [ent.route]
      );
      const extras = opts.reduce((acc, { column_name, option_value, option_label }) => {
        acc[column_name] = acc[column_name] || [];
        acc[column_name].push({ value: option_value, label: option_label });
        return acc;
      }, {});

      // 3a) sicherstellen, dass alle in der EJS verwendeten keys existieren
      [
        'stage','quality','propertytype','investmenttype','energypass','energypass_type',
        'energysource','heating','fuel','gearbox','drivetrain','color','interior',
        'interior_color','engine','emission_class','environmental_badge',
        'energy_label','cartype','pollution_class'
      ].forEach(key => {
        if (!Array.isArray(extras[key])) extras[key] = [];
      });
      if (ent.route === 'yachts') {
        extras.condition = extras.shape || [];
      }
      if (Array.isArray(extras.engine)) {
        extras.engine.sort((a, b) =>
          a.label.localeCompare(b.label, 'de', { sensitivity: 'base' })
        );
      }
      if (ent.route === 'yachts') {
        extras.hull = await loadOptions(db, 'yachts', 'hull'); // ⬅️ NEU
      }


      
      // 4) Länder
      const [countries] = await db.query(
        `SELECT c.id, c.parent_id, c.de AS name
           FROM countries c
          WHERE c.visible = 1
             OR c.parent_id IS NOT NULL
             OR c.id IN (SELECT DISTINCT parent_id FROM countries WHERE parent_id IS NOT NULL)
          ORDER BY
            CASE WHEN c.parent_id IS NULL THEN 0 ELSE 1 END,
            c.de`
      );

      // 5) entity‑spezifisch: brands/models, years etc.
      let brands = [], models = [], lifestyleTypes = [], lifestyleSubcategories = [];
      let years = [], registrationYears = [], nextHuYears = [];
      const currentYear = new Date().getFullYear();
      const launchYears = [];
      for (let y = currentYear; y >= 1800; y--) {
        launchYears.push(y);
      }

      if (['cars','watches','yachts'].includes(ent.route)) {
        [brands] = await db.query(
          `SELECT id, name FROM brands WHERE type = ? ORDER BY name`,
          [categoryTypeMap[ent.route]]
        );
        if (brands.length) {
          const ids = brands.map(b => b.id);
          [models] = await db.query(
            `SELECT id, name FROM models WHERE brand_id IN (${ids.map(_=>'?').join(',')}) ORDER BY name`,
            ids
          );
        }
      }
      if (ent.route === 'cars') {
        [years] = await db.query(
          `SELECT DISTINCT year FROM \`${tableName}\` WHERE year IS NOT NULL ORDER BY year DESC`
        );
        const [reg] = await db.query(
          `SELECT DISTINCT firstregistration AS year FROM \`${tableName}\` WHERE firstregistration IS NOT NULL ORDER BY firstregistration DESC`
        );
        registrationYears = reg.map(r => r.year);
        const [hu] = await db.query(
          `SELECT DISTINCT maininspection AS year FROM \`${tableName}\` WHERE maininspection IS NOT NULL ORDER BY maininspection DESC`
        );
        nextHuYears = hu.map(r => r.year);
      }
      if (ent.route === 'lifestyles') {
        [lifestyleTypes] = await db.query(
          `SELECT id, name FROM brands WHERE type = 6 ORDER BY name`
        );
        if (lifestyleTypes.length) {
          const ids = lifestyleTypes.map(b => b.id);
          [lifestyleSubcategories] = await db.query(
            `SELECT id, name, brand_id AS parentId
               FROM models
              WHERE brand_id IN (${ids.map(_=>'?').join(',')})
              ORDER BY name`,
            ids
          );
        }
        const t = (res.locals && typeof res.locals.t === 'function')
          ? res.locals.t
          : ((key, fb) => (fb ?? key));
        lifestyleTypes = lifestyleTypes.map(b => ({
          ...b,
          name: t(`lifestyle.brand.${b.id}`, b.name)
        }));
        lifestyleSubcategories = lifestyleSubcategories.map(sc => ({
          ...sc,
          name: t(`lifestyle.subcategory.${sc.id}`, sc.name)
        }));
      }

      // 6) Checkbox‑Gruppen für cars
      const checkboxGroups = {

        Assistenzsysteme: [
          'adaptive_cruise_control',
          'collision_avoidance',
          'blind_spot_monitor',
          'lane_departure_warning',
          'traffic_signs',
          'parking_front',
          'parking_rear',
          'parking_camera',
          'parking_self',
          'fatigue',
          'nightvision',
          'emergency_call',
          'speed_limiter',
          'distance_warning'
        ],

        'Sicherheit': [
          'abs',
          'esp',
          'asr'
        ],

        'Licht & Sicht': [
          'xenon',
          'bixenon',
          'led',
          'laser',
          'foglamp',
          'daytime_lights',
          'adaptive_lights',
          'glare_free',
          'highbeam_assistant',
          'headlight_washer',
          'light_sensor',
          'rain_sensor',
          'head_up_display'
        ],

        Diebstahlschutz: [
          'immobilizer',
          'alarm_system',
          'wheel_lock',
          'central_locking',
          'keyless_central_locking'
        ],

        Komfort: [
          'aux_heating',
          'climatisation',
          'electric_heated_seats',
          'ventilated_seats',
          'electric_windows',
          'electric_adjusted_seats',
          'electric_mirrors',
          'electric_tailgate',
          'assisted_steering',
          'cruise_control',
          'startstop_system',
          'heated_windshield',
          'heated_steering_wheel',
          'arm_rest',
          'lumbar_support',
          'massage_seats',
          'fold_flat_passenger_seat',
          'ambient_lighting',
          'leather_steering_wheel'
        ],

        Infotainment: [
          'tuner_radio',
          'radio_dab',
          'cdplayer',
          'soundsystem',
          'mp3interface',
          'bluetooth',
          'apple_car_play',
          'android_auto',
          'wifi_hotspot',
          'music_streaming',
          'navigation',
          'tv',
          'touchscreen',
          'voice_control'
        ],

        Extras: [
          'sports_package',
          'sports_suspension',
          'sports_seats',
          'alloy_wheels',
          'trailer_coupling',
          'roof_rack',
          'skibag',
          'sunroof',
          'panoramic_roof',
          'summer_tires',
          'winter_tires',
          'all_season_tires',
          'tire_pressure_monitoring',
          'winter_package',
          'smokers_package',
          'air_suspension',
          'disabled_accessible',
          'taxi'
        ]

      };


    const featureLabels = {
      // === Assistenzsysteme ===
      parking_assist: 'Einparkhilfe',
      rear_cross_traffic_alert: 'Querverkehrwarner hinten',
      lane_change_assist: 'Spurwechselassistent',
      traffic_sign_recognition: 'Verkehrszeichenerkennung',
      adaptive_cruise_control: 'Abstandsregeltempomat',

      // === Licht & Sicht ===
      xenon_headlights: 'Xenon-Scheinwerfer',
      bixenon_headlights: 'Bi-Xenon-Scheinwerfer',
      led_headlights: 'LED-Scheinwerfer',
      laser_light: 'Laserlicht',
      fog_lights: 'Nebelscheinwerfer',
      daytime_running_lights: 'Tagfahrlicht',
      curve_light: 'Kurvenlicht',
      glare_free_high_beam: 'Blendfreies Fernlicht',
      high_beam_assist: 'Fernlichtassistent',
      headlight_cleaning: 'Scheinwerferreinigungsanlage',

      // === Diebstahlschutz ===
      immobilizer: 'Wegfahrsperre',
      alarm_system: 'Alarmanlage',
      wheel_lock: 'Felgenschloss',

      // === Komfort ===
      stand_heating: 'Standheizung',
      seat_heating: 'Sitzheizung',
      seat_ventilation: 'Sitzbelüftung',
      electric_windows: 'Elektrische Fensterheber',
      electric_seat_adjustment: 'Elektrische Sitzeinstellung',
      electric_side_mirrors: 'Elektrische Außenspiegel',
      electric_tailgate: 'Elektrische Heckklappe',
      central_locking: 'Zentralverriegelung',
      keyless_entry: 'Keyless Entry',
      power_steering: 'Servolenkung',
      cruise_control: 'Tempomat',
      adaptive_cruise_control: 'Abstandsregeltempomat',
      emergency_brake_assist: 'Notbremsassistent',
      blind_spot_assist: 'Toter-Winkel-Assistent',
      lane_keep_assist: 'Spurhalteassistent',
      head_up_display: 'Head-Up Display',
      light_sensor: 'Lichtsensor',
      rain_sensor: 'Regensensor',
      start_stop_system: 'Start/Stopp-System',
      heated_windscreen: 'Beheizbare Windschutzscheibe',
      heated_steering: 'Beheizbares Lenkrad',
      armrest: 'Armlehne',
      lumbar_support: 'Lordosenstütze',
      massage_seats: 'Massagesitze',
      folding_passenger_seat: 'Umklappbarer Beifahrersitz',
      ambient_lighting: 'Ambientebeleuchtung',
      leather_steering_wheel: 'Lederlenkrad',

      // === Einparkhilfe ===
      parking_sensors_rear: 'Einparkhilfe hinten',
      parking_sensors_front: 'Einparkhilfe vorne',
      rear_camera: 'Rückfahrkamera',
      self_parking: 'Selbstlenkende Einparkhilfe',

      // === Infotainment ===
      radio: 'Radio',
      dab_radio: 'DAB-Radio',
      cd_player: 'CD-Player',
      mp3_interface: 'MP3-Schnittstelle',
      navigation_system: 'Navigationssystem',
      tv: 'Fernseher',
      sound_system: 'Soundsystem',
      touchscreen: 'Touchscreen',
      voice_control: 'Sprachsteuerung',
      bluetooth: 'Bluetooth',
      apple_carplay: 'Apple CarPlay',
      android_auto: 'Android Auto',
      wifi_hotspot: 'WLAN-Hotspot',
      streaming: 'Musik-Streaming',

      // === Extras ===
      sport_package: 'Sportpaket',
      sports_suspension: 'Sportfahrwerk',
      sports_seats: 'Sportsitze',
      alloy_wheels: 'Alufelgen',
      trailer_coupling: 'Anhängerkupplung',
      roof_rack: 'Dachgepäckträger',
      skibag: 'Skisack',
      sunroof: 'Schiebedach',
      panoramic_roof: 'Panoramadach',
      tinted_windows: 'Getönte Scheiben',
      summer_tires: 'Sommerreifen',
      winter_tires: 'Winterreifen',
      all_season_tires: 'Ganzjahresreifen',
      tire_pressure_monitoring: 'Reifendruckkontrolle',
      winter_package: 'Winterpaket',
      smoker_package: 'Raucherpaket',
      air_suspension: 'Luftfederung'
    };



      if (ent.route === 'watches') {
        extras.functions      = extras.functions      || [];
        extras.complications  = extras.complications  || [];
      }

      let watchCheckboxGroups = {};
      if (ent.route === 'watches') {
        watchCheckboxGroups = {
          'Funktionen':       extras.functions       || [],
          'Komplikationen':   extras.complications   || []
        };
      }

      const defaults = [
        'condition',
        'dial_color',
        'functions',
        'complications',
        // … und alle anderen, die mal fehlen
      ];

      for (const key of defaults) {
        extras[key] = extras[key] || [];
      }

      ['crystal','gender','water_resistance','case_material','strap_material','strap_color',
      'buckle_material','buckle_type','bezel_material','dial_color','dial_shape','dial_numbers',
      'condition','functions','complications'
      ].forEach(k => {
        extras[k] = extras[k] || [];
      });

          const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

      // 7) Rendern
      res.render('pages/templates/new-listing', {
        user,
        ent,
        entities,                 // ALLE gebuchten Kategorien für Tabs
        activeTabId: ent.id,      // ID des aktiven Tabs
        extras,
        filters: {
          countries,
          brands, models,
          lifestyleTypes, lifestyleSubcategories,
          years, registrationYears, nextHuYears
        },
        checkboxGroups, 
        watchCheckboxGroups,
        currentPage: 'new-listing',
        seo,
        launchYears, 
        featureLabels,
          currencies,
        successMessage: req.session.successMessage,
        errorMessage: req.session.errorMessage,
      });

      req.session.successMessage = null;
      req.session.errorMessage = null;
    } catch (err) {
      console.error('Fehler in GET /new-listing:', err);
      next(err);
    }
  }
); 

router.get('/api/models/:brandId', async (req, res) => {
  console.log('===================================');
  console.log('🧩 GET /api/models/:brandId aufgerufen');
  console.log('===================================');

  try {
    const brandId = parseInt(req.params.brandId, 10);

    console.log(`➡️ Übergebene brandId: ${brandId}`);

    if (isNaN(brandId)) {
      console.warn('⚠️ Ungültige brandId erhalten:', req.params.brandId);
      return res.status(400).json({ success: false, models: [] });
    }

    console.log('📡 Sende SQL-Abfrage...');
    const [models] = await db.query(`
      SELECT id, name, brand_id 
      FROM models 
      WHERE brand_id = ?
      ORDER BY name
    `, [brandId]);

    console.log(`✅ SQL-Abfrage erfolgreich, Anzahl Modelle: ${models.length}`);

    res.json({
      success: true,
      models
    });

  } catch (err) {
    console.error('🔥 Fehler in /api/models/:brandId:', err);
    res.status(500).json({ success: false, models: [] });
  }
});

router.post(
  '/new-listing',
  ensureAuthenticated,
  upload.fields([
    { name: 'mainpicture', maxCount: 1 },
    { name: 'pictures', maxCount: 20 }
  ]),
  async (req, res, next) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.redirect('/auth/login');

      // 1️⃣ Kategorie
      const entId = parseInt(req.body.ent_id, 10);
      if (!entId) {
        console.log('❌ ent_id fehlt:', req.body.ent_id);
        return res.redirect('/buyer/new-listing');
      }

      // 2️⃣ Aktives Paket
      const [[sel]] = await db.query(`
        SELECT category_id, end_date
        FROM selected_packages
        WHERE user_id = ?
          AND category_id = ?
          AND start_date <= NOW()
          AND end_date > NOW()
        LIMIT 1
      `, [userId, entId]);

      if (!sel) {
        console.log('❌ Kein aktives Paket');
        return res.redirect('/buyer/new-listing?tab=' + entId);
      }

      // 3️⃣ Entität
      const [[ent]] = await db.query(`
        SELECT table_name, route
        FROM ententies
        WHERE id = ?
      `, [sel.category_id]);

      if (!ent) {
        console.log('❌ Entität nicht gefunden');
        return res.redirect('/buyer');
      }

      if (ent.route === 'yachts') {
        const yachtType = req.body.yachttype;
        if (yachtType === undefined || yachtType === null || yachtType === '') {
          req.session.errorMessage = 'Bitte Bootstyp auswählen.';
          return res.redirect('/buyer/new-listing?tab=' + entId);
        }
      }

      // 4️⃣ Spalten (WICHTIG: mit Typen)
      const [cols] = await db.query(`
        SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ?
          AND EXTRA NOT LIKE '%auto_increment%'
      `, [ent.table_name]);

      const allowed = cols.map(c => c.COLUMN_NAME);

      // 5️⃣ Payload vorbereiten
      const payload = { user_id: userId };

      // ✅ A) ALLE CHECKBOXEN DEFAULT = 0
      for (const c of cols) {
        if (c.DATA_TYPE === 'tinyint' && c.COLUMN_TYPE.includes('(1)')) {
          payload[c.COLUMN_NAME] = 0;
        }
      }

      // ✅ B) FORM-WERTE ÜBERSCHREIBEN
      for (const [key, rawVal] of Object.entries(req.body)) {
        if (key === 'pictures' || key === 'mainpicture') continue;

        const val = Array.isArray(rawVal)
          ? rawVal[rawVal.length - 1]
          : rawVal;

        if (allowed.includes(key)) {
          payload[key] = val === '' ? null : val;
        }
      }

      delete payload.ent_id;

      if (allowed.includes('stopdate') && sel.end_date) {
        payload.stopdate = sel.end_date;
      }
      if (allowed.includes('created')) payload.created = new Date();
      if (allowed.includes('modified')) payload.modified = new Date();

      // 🔍 DEBUG: VOLLES PAYLOAD (inkl. Checkboxen!)
      console.log('================ PAYLOAD DEBUG ================');
      Object.keys(payload)
        .sort()
        .forEach(k => {
          console.log(
            k.padEnd(30),
            '=>',
            payload[k]
          );
        });
      console.log('================================================');

      // 6️⃣ INSERT
      const [result] = await db.query(
        `INSERT INTO \`${ent.table_name}\` SET ?`,
        payload
      );
      const newId = result.insertId;

      // 7️⃣ Bilder-Ordner
      const destDir = path.join(
        '/', 'media', 'herando', 'images', ent.route, String(newId)
      );
      await fs.ensureDir(destDir);

      // 8️⃣ MAINPICTURE
      let mainPic = null;
      if (req.files?.mainpicture?.[0]) {
        const f = req.files.mainpicture[0];
        const ext = path.extname(f.originalname);
        const filename = `main_${Date.now()}_${f.filename}${ext}`;
        await fs.move(f.path, path.join(destDir, filename));
        mainPic = filename;
      }

      // 9️⃣ GALERIE
      const gallery = [];
      for (const f of (req.files?.pictures || [])) {
        const ext = path.extname(f.originalname);
        const filename = `${Date.now()}_${f.filename}${ext}`;
        await fs.move(f.path, path.join(destDir, filename));
        gallery.push({ image: filename });
      }

      if (!mainPic && gallery.length) {
        mainPic = gallery[0].image;
      }

      // 🔍 DEBUG: CHECKBOXEN SPEZIELL
      console.log('==== CHECKBOX RESULT (1=checked / 0=unchecked) ====');
      for (const c of cols) {
        if (c.DATA_TYPE === 'tinyint' && c.COLUMN_TYPE.includes('(1)')) {
          console.log(c.COLUMN_NAME.padEnd(30), '=>', payload[c.COLUMN_NAME]);
        }
      }
      console.log('==================================================');

      // 10️⃣ UPDATE Medien
      await db.query(
        `UPDATE \`${ent.table_name}\`
         SET pictures = ?, mainpicture = ?
         WHERE id = ?`,
        [phpSerialize.serialize(gallery), mainPic, newId]
      );

      return res.redirect('historie');

    } catch (err) {
      console.error('❌ Fehler in POST /new-listing:', err);
      return next(err);
    }
  }
);



router.get('/edit-listing/:id', async (req, res, next) => {
  console.log('===============================');
  console.log('🟢 EDIT-LISTING ROUTE AUFGERUFEN');
  console.log('===============================');

  try {
    const userId = req.session.userId;
    const listingIdRaw = req.params.id;
    const listingId = parseInt(listingIdRaw, 10);

    console.log(`➡️ userId: ${userId} | listingIdRaw: ${listingIdRaw} | listingId(parsed): ${listingId}`);

    // 🧩 1) Parameter prüfen
    if (!userId || !listingId || isNaN(listingId)) {
      console.error('❌ Ungültige Parameter:', { userId, listingIdRaw });
      req.session.errorMessage = 'Ungültige oder fehlende Parameter.';
      return res.redirect('/buyer');
    }

    const categoryTypeMap = {
      properties: 1,
      watches: 2,
      cars: 3,
      yachts: 4,
      lifestyles: 5
    };

    // 🧩 2) Benutzer laden (ohne registration_type)
    console.log('🧩 Lade Benutzer...');
    const [[user]] = await db.query(
      'SELECT firstname, lastname, email, phone FROM users WHERE id = ?',
      [userId]
    );

    if (!user) {
      console.warn('⚠️ Benutzer nicht gefunden!');
      req.session.errorMessage = 'Benutzer nicht gefunden.';
      return res.redirect('/auth/login');
    }

    console.log(`✅ Benutzer geladen: ${user.firstname} ${user.lastname}`);

    // 🧩 3) Inserat in allen Tabellen suchen
    const tables = [
      { id: 1, name: 'properties' },
      { id: 2, name: 'watches' },
      { id: 3, name: 'cars' },
      { id: 4, name: 'yachts' },
      { id: 5, name: 'lifestyles' }
    ];

    let item = null;
    let ent = null;

    for (const t of tables) {
      const [rows] = await db.query(
        `SELECT * FROM \`${t.name}\` WHERE id = ? AND user_id = ?`,
        [listingId, userId]
      );
      if (rows.length) {
        item = rows[0];
        ent = { id: t.id, route: t.name, table_name: t.name };
        console.log(`✅ Inserat gefunden in Tabelle "${t.name}"`);
        break;
      }
    }

    if (!item) {
      console.warn(`⚠️ Kein Inserat gefunden (id=${listingId}, user=${userId})`);
      req.session.errorMessage = 'Inserat nicht gefunden oder gehört nicht Ihnen.';
      return res.redirect('/buyer');
    }

    // 🧩 4) Extras laden
    console.log('🧩 Lade Extras (attribute_options)...');
    const [opts] = await db.query(`
      SELECT column_name, option_value, option_label
      FROM attribute_options
      WHERE entitie_route = ?
      ORDER BY column_name, sort_order
    `, [ent.route]);

    const extras = opts.reduce((acc, { column_name, option_value, option_label }) => {
      acc[column_name] = acc[column_name] || [];
      acc[column_name].push({
        value: option_value,
        label: option_label,
        selected: String(item[column_name]) === String(option_value) ? 'selected' : ''
      });
      return acc;
    }, {});

    console.log('✅ Extras geladen:', Object.keys(extras).length);

    // 🧩 5) Checkbox-Gruppen definieren (z. B. für cars)
    console.log('🧩 Erstelle Checkbox-Gruppen...');
    const checkboxGroupsRaw = {
      'Sicherheit': ['abs', 'esp', 'asr'],
      'Licht & Sicht': [
        'xenon', 'bixenon', 'led', 'laser', 'foglamp', 'daytime_lights', 'adaptive_lights',
        'glare_free', 'highbeam_assistant', 'headlight_washer', 'light_sensor', 'rain_sensor', 'head_up_display'
      ],
      'Diebstahlschutz': [
        'immobilizer', 'alarm_system', 'wheel_lock', 'central_locking', 'keyless_central_locking'
      ],
      'Komfort': [
        'electric_windows', 'electric_adjusted_seats', 'electric_heated_seats', 'ventilated_seats',
        'electric_mirrors', 'electric_tailgate', 'assisted_steering', 'cruise_control', 'adaptive_cruise_control',
        'collision_avoidance', 'blind_spot_monitor', 'lane_departure_warning', 'aux_heating', 'climatisation',
        'arm_rest', 'lumbar_support', 'massage_seats', 'fold_flat_passenger_seat', 'ambient_lighting',
        'leather_steering_wheel'
      ],
      'Einparkhilfe': ['parking_front', 'parking_rear', 'parking_camera', 'parking_self'],
      'Infotainment': [
        'tuner_radio', 'radio_dab', 'cdplayer', 'soundsystem', 'music_streaming', 'bluetooth',
        'apple_car_play', 'android_auto', 'wifi_hotspot', 'mp3interface', 'navigation', 'tv',
        'touchscreen', 'voice_control', 'usb', 'inductive_charging', 'digital_cockpit',
        'multifunction_steeringwheel', 'onboard_computer', 'handsfree_kit'
      ],
      'Fahrzeug': [
        'alloy_wheels', 'sports_suspension', 'sports_package', 'sports_seats', 'trailer_coupling',
        'sunroof', 'panoramic_roof', 'roof_rack', 'skibag', 'disabled_accessible', 'taxi'
      ],
      'Reifen & Pakete': [
        'summer_tires', 'winter_tires', 'all_season_tires', 'tire_pressure_monitoring',
        'winter_package', 'smokers_package'
      ],
      'Fahrassistenzsysteme': [
        'air_suspension', 'startstop_system', 'hill_climb', 'fatigue', 'dimming_mirror', 'nightvision',
        'emergency_call', 'traffic_signs', 'speed_limiter', 'distance_warning', 'heated_windshield', 'heated_steering_wheel'
      ]
    };

    const checkboxGroups = {};
    for (const [group, fields] of Object.entries(checkboxGroupsRaw)) {
      checkboxGroups[group] = fields.map(name => {
        const val = item[name];
        const isChecked = ['1', 1, true, 'true', 'on'].includes(val);
        return { name, checked: isChecked ? 'checked' : '' };
      });
    }

    // 🧩 6) Galerie laden
    console.log('🧩 Lade Galerie...');
    const { unserialize } = require('php-serialize');
    let gallery = [];
    try {
      if (item.pictures) gallery = unserialize(item.pictures);
    } catch (err) {
      console.warn('⚠️ Fehler beim Unserialisieren der Galerie:', err.message);
    }

    console.log(`✅ Galerie geladen: ${Array.isArray(gallery) ? gallery.length : 0} Bilder`);

    // 🧩 7) Länder laden
    const [countries] = await db.query(
      `SELECT c.id, c.parent_id, c.de AS name
       FROM countries c
       WHERE c.visible = 1
          OR c.parent_id IS NOT NULL
          OR c.id IN (SELECT DISTINCT parent_id FROM countries WHERE parent_id IS NOT NULL)
       ORDER BY
         CASE WHEN c.parent_id IS NULL THEN 0 ELSE 1 END,
         c.de`
    );

    // 🧩 8) Filterdaten (Marken, Modelle, etc.)
    console.log(`🧩 Lade Filterdaten für ${ent.route}...`);
    let brands = [], models = [], lifestyleTypes = [], lifestyleSubcategories = [];
    let years = [], registrationYears = [], nextHuYears = [];

// brands/models für cars, watches, yachts
if (['cars', 'watches', 'yachts'].includes(ent.route)) {
  [brands] = await db.query(
    `SELECT id, name FROM brands WHERE type = ? ORDER BY name`,
    [categoryTypeMap[ent.route]]
  );

  if (brands.length) {
    const ids = brands.map(b => b.id);
      [models] = await db.query(
        `SELECT id, name, brand_id
        FROM models
        WHERE brand_id = ?
        ORDER BY name`,
        [item.brand_id]
      );
  }
}

console.log('================ MODELS DEBUG ================');
console.log('Item brand_id:', item.brand_id);
console.log('Models geladen:', models.length);

models.slice(0,10).forEach(m => {
  console.log(
    'model:', m.id,
    '| brand_id:', m.brand_id,
    '| name:', m.name
  );
});
console.log('==============================================');

// 🔥 LIFESTYLES MUSS EIGENES IF SEIN
if (ent.route === 'lifestyles') {
  [lifestyleTypes] = await db.query(
    `SELECT id, name FROM brands WHERE type = 6 ORDER BY name`
  );

  if (lifestyleTypes.length) {
    const ids = lifestyleTypes.map(b => b.id);
    [lifestyleSubcategories] = await db.query(
      `SELECT id, name, brand_id AS parentId
       FROM models
       WHERE brand_id IN (${ids.map(() => '?').join(',')})
       ORDER BY name`,
      ids
    );
  }

  console.log('🔥 Lifestyle FIX:', lifestyleTypes.length, lifestyleSubcategories.length);



      if (brands.length) {
        const ids = brands.map(b => b.id);
        [models] = await db.query(
          `SELECT id, name FROM models WHERE brand_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`,
          ids
        );
      }
    }

    if (ent.route === 'cars') {
      [years] = await db.query(`SELECT DISTINCT year FROM cars WHERE year IS NOT NULL ORDER BY year DESC`);
      const [reg] = await db.query(`SELECT DISTINCT firstregistration AS year FROM cars WHERE firstregistration IS NOT NULL ORDER BY firstregistration DESC`);
      registrationYears = reg.map(r => r.year);
      const [hu] = await db.query(`SELECT DISTINCT maininspection AS year FROM cars WHERE maininspection IS NOT NULL ORDER BY maininspection DESC`);
      nextHuYears = hu.map(r => r.year);
    }

    const filters = {
      countries,
      brands,
      models,
      lifestyleTypes,
      lifestyleSubcategories,
      years,
      registrationYears,
      nextHuYears
    };

    // 🧩 9) Uhren-Gruppen nur falls watches
    let watchCheckboxGroups = {};
    if (ent.route === 'watches') {
      watchCheckboxGroups = {
        'Funktionen': extras.functions || [],
        'Komplikationen': extras.complications || []
      };
    }
console.log('🚗 item.engine:', item.engine);
console.table(extras.engine);
console.log('Hull-Wert:', item.hull);
console.log('🧭 Direkter DB-Wert Hull:', item?.hull);
console.log('🎯 Finaler Item-Wert Hull vorm Rendern:', item?.hull);


    // 🧩 10) Template rendern
    console.log('✅ Alles geladen, rendere Seite...');
    res.render('pages/templates/edit-listing', {
      mode: 'edit',
      user,
      ent,
      extras,
      filters,
      checkboxGroups,
      watchCheckboxGroups,
      item,
      gallery,
      seo: res.locals.seo || null,
      currentPage: 'edit-listing'
    });

    console.log('✅ EDIT-LISTING erfolgreich geladen.');
    console.log('===============================');

  } catch (err) {
    console.error('🔥 Fehler in GET /edit-listing/:id:', err);
    req.session.errorMessage = 'Ein unerwarteter Fehler ist aufgetreten.';
    res.redirect('/buyer');
  }
});

router.post('/edit-listing/:id', upload.array('pictures'), async (req, res, next) => {
  let adminEditMode = false;
  let adminEditReturnUrl = null;
  try {
    console.log('====================================================');
    console.log('✏️  EDIT-LISTING POST gestartet');
    console.log('====================================================');

    // ---------------------------------------------------------
    // 1) USER VALIDIERUNG
    // ---------------------------------------------------------
    const userId = req.session.userId;
    const listingId = parseInt(req.params.id, 10);
    const sessionRole = Number(req.session.role || 0);
    const isAdminSession = [7, 8, 9].includes(sessionRole);
    let effectiveOwnerUserId = Number(userId || 0);

    console.log("➡️ User:", userId, "Listing:", listingId);

    if (!userId || isNaN(listingId)) {
      req.session.errorMessage = await tr(
        req,
        res,
        'buyer.listing.error.invalid_id_or_session',
        'Ungültige ID oder Session.'
      );
      return res.redirect('/buyer');
    }

    // ---------------------------------------------------------
    // 2) ENTITÄT AUTOMATISCH ERMITTELN
    // ---------------------------------------------------------
    const tables = ['properties','watches','cars','yachts','lifestyles'];
    let ent = null;
    const adminGrant = req.session.adminListingEditGrant;
    const nowMs = Date.now();

    const adminGrantIsUsable =
      isAdminSession &&
      adminGrant &&
      Number(adminGrant.listingId) === listingId &&
      Number(adminGrant.adminUserId) === Number(userId) &&
      Number(adminGrant.expiresAt || 0) > nowMs &&
      tables.includes(String(adminGrant.table || ''));

    if (adminGrantIsUsable) {
      const [grantRows] = await db.query(
        `SELECT id, user_id FROM \`${adminGrant.table}\` WHERE id = ? LIMIT 1`,
        [listingId]
      );

      if (grantRows.length) {
        ent = { route: adminGrant.table, table: adminGrant.table };
        effectiveOwnerUserId = Number(grantRows[0].user_id || adminGrant.ownerUserId || 0);
        adminEditMode = true;
        adminEditReturnUrl = String(adminGrant.returnTo || '/admin/listings');
        console.log('🛡️ Admin-Edit-Grant aktiv:', { ent, effectiveOwnerUserId, adminEditReturnUrl });
      }
    } else if (adminGrant && Number(adminGrant.expiresAt || 0) <= nowMs) {
      delete req.session.adminListingEditGrant;
    }

    if (!ent) {
      for (const t of tables) {
        const [rows] = await db.query(
          `SELECT id, user_id FROM \`${t}\` WHERE id = ? AND user_id = ?`,
          [listingId, userId]
        );
        if (rows.length) {
          ent = { route: t, table: t };
          effectiveOwnerUserId = Number(rows[0].user_id || userId);
          break;
        }
      }
    }

    if (!ent) {
      req.session.errorMessage = "Inserat gehört Ihnen nicht.";
      return res.redirect(adminEditReturnUrl || '/buyer');
    }

    console.log("📌 Erkannte Kategorie:", ent);

    // ---------------------------------------------------------
    // 3) ERLAUBTE SPALTEN LADEN
    // ---------------------------------------------------------
    const [cols] = await db.query(`SHOW COLUMNS FROM \`${ent.table}\``);
    const validColumns = cols.map(c => c.Field);
    console.log("📑 Erlaubte Spalten:", validColumns);

    // ---------------------------------------------------------
    // 4) CHECKBOX-FIX (WICHTIG! GEGEN SQL-FEHLER)
    // ---------------------------------------------------------
    for (const key in req.body) {
      const val = req.body[key];

      // Wenn Checkbox mehrfach sendet → array → immer letztes Element
      if (Array.isArray(val)) {
        req.body[key] = val[val.length - 1];
      }

      // in 0/1 casten
      if (['0','1',0,1,'true','false','on','off',true,false].includes(req.body[key])) {
        req.body[key] = ['1','true','on',1,true].includes(req.body[key]) ? '1' : '0';
      }
    }

    console.log("🧰 Nach Checkbox-Fix:", req.body);

          // ---------------------------------------------------------
      // 🔥 GLOBAL NUMERIC SANITIZER (gegen '' bei INT/FLOAT/DECIMAL)
      // ---------------------------------------------------------
      const numericTypes = ['int', 'tinyint', 'float', 'double', 'decimal'];

      const [colInfo] = await db.query(`SHOW COLUMNS FROM \`${ent.table}\``);

      const numericColumns = colInfo
        .filter(c => numericTypes.some(t => c.Type.includes(t)))
        .map(c => c.Field);

      for (const key of Object.keys(req.body)) {
        if (!numericColumns.includes(key)) continue;

        if (req.body[key] === '' || req.body[key] === null) {
          req.body[key] = null;
        } else if (!isNaN(req.body[key])) {
          req.body[key] = Number(req.body[key]);
        }
      }

      console.log('🧹 GLOBAL NUMERIC CLEAN:', req.body);


    // ---------------------------------------------------------
    // 5) WATCH NORMALISIERUNG
    // ---------------------------------------------------------
    if (ent.route === "watches") {
      // edit-listing nutzt bei Watches sprechende Form-Namen, DB erwartet function_/feature_-Spalten.
      const watchAliasToColumn = {
        // Lieferumfang
        auth_certificate: 'authenticity_papers',
        box: 'authenticity_box',
        auth_guarantee: 'authenticity_warranty',

        // Funktionen
        alarm: 'function_alarm',
        chronograph: 'function_chronograph',
        date: 'function_date',
        weekday_display: 'function_day',
        month_display: 'function_month',
        annual_calendar: 'function_year',
        four_year_calendar: 'function_4year',
        gmt: 'function_gmt',
        equation_of_time: 'function_timeequation',
        minute_repeater: 'function_minuterepeater',
        repetition: 'function_repetition',
        jumping_hour: 'function_jumping_hour',
        split_chrono: 'function_double_chronograph',
        panorama_date: 'function_panorama',
        moon_phase: 'function_moonphase',
        calendar: 'function_calendar',
        small_seconds: 'function_smallseconds',
        central_seconds: 'function_centralseconds',
        tachymeter: 'function_tachymeter',
        flyback: 'function_flyback',
        striking_mechanism: 'function_striking_mechanism',

        // Features
        chronometer: 'feature_chronometer',
        master_chronometer: 'feature_master_chronometer',
        tourbillon: 'feature_tourbillon',
        helium_valve: 'feature_heliumvalve',
        power_reserve_indicator: 'feature_powerreserve',
        rotating_bezel: 'feature_rotatingbezel',
        diamond_bezel: 'feature_diamondsbezel',
        luminous_hands: 'feature_luminescenthands'
      };

      const isChecked = (v) => ['1', 1, true, 'true', 'on'].includes(v);

      for (const [alias, column] of Object.entries(watchAliasToColumn)) {
        req.body[column] = isChecked(req.body[alias]) ? 1 : 0;
        delete req.body[alias];
      }

      // Ein UI-Checkbox steuert beide alten Spalten.
      const luminousIndices = isChecked(req.body.luminous_indices) ? 1 : 0;
      req.body.feature_luminescentnumerals = luminousIndices;
      req.body.feature_luminous_indexes = luminousIndices;
      delete req.body.luminous_indices;

      if (req.body.movement) {
        const map = { automatic: 1, manual: 2, quartz: 3, "1": 1, "2": 2, "3": 3 };
        req.body.movement = map[req.body.movement] ?? null;
      }

      console.log("⌚ Watches normalisiert:", req.body);
    }

    // ---------------------------------------------------------
    // 6) YACHT NORMALISIERUNG
    // ---------------------------------------------------------
    if (ent.route === "yachts") {
      console.log("⚓ Yacht-Modus aktiviert");

      const yachtNumeric = [
        'category','yachttype','hull','beam','length','displacement',
        'draft','engines','power','horsepower','engine_hours',
        'cruising_speed','cruising_speed_kn','max_speed','max_speed_kn',
        'fuel','fuel_tankage','water_tankage','crew','shape','used',
        'year','splashdown','base_price','price','vat','featured'
      ];

      if (req.body.berth_count !== undefined) {
        req.body.berths = req.body.berth_count || null;
        delete req.body.berth_count;
      }

      for (const key of yachtNumeric) {
        if (req.body[key] === "") {
          req.body[key] = null;
        } else if (!isNaN(req.body[key])) {
          req.body[key] = parseFloat(req.body[key]);
        }
      }

      console.log("⚓ Yacht Daten nach Normalisierung:", req.body);
    }

    // ---------------------------------------------------------
// ---------------------------------------------------------
// CARS NORMALISIERUNG – FINALER FIX (INT / DECIMAL / FLOAT)
// ---------------------------------------------------------
if (ent.route === "cars") {

  console.log("🚗 Cars-Modus aktiviert");

  // Legacy/UI-Aliase auf echte cars-Spalten mappen.
  const carAliasToColumn = {
    xenon_headlights: 'xenon',
    bixenon_headlights: 'bixenon',
    led_headlights: 'led'
  };
  const isChecked = (v) => ['1', 1, true, 'true', 'on'].includes(v);
  for (const [alias, column] of Object.entries(carAliasToColumn)) {
    if ((alias in req.body) && !(column in req.body)) {
      req.body[column] = isChecked(req.body[alias]) ? 1 : 0;
    }
    delete req.body[alias];
  }

  // 🟦 ALLE INT-Felder
  const carIntFields = [
    "year","firstregistration_month","firstregistration",
    "maininspection_month","maininspection","shape",
    "cartype","color","metallic","interior","interior_color",
    "fuel","gearbox","drivetrain","engine","mileage",
    "capacity","power","horsepower","emission_co2",
    "climatisation","emission_class","environmental_badge",
    "pollution_class","airbags"
  ];

  // 🟩 ALLE DECIMAL / FLOAT Felder
  const carDecimalFields = [
    "price","consumption_city","consumption_country",
    "consumption_combined"
  ];

  // 🟦 INT → null oder parseInt
  for (const key of carIntFields) {
    if (!(key in req.body)) continue;

    if (req.body[key] === "" || req.body[key] === null) {
      req.body[key] = null;
    } else if (!isNaN(req.body[key])) {
      req.body[key] = parseInt(req.body[key], 10);
    }
  }

  // 🟩 DECIMAL → null oder parseFloat
  for (const key of carDecimalFields) {
    if (!(key in req.body)) continue;

    if (req.body[key] === "" || req.body[key] === null) {
      req.body[key] = null;
    } else if (!isNaN(req.body[key])) {
      req.body[key] = parseFloat(req.body[key]);
    }
  }

  console.log("🚗 Cars normalisiert:", req.body);
}



    // ---------------------------------------------------------
    // 7) ALTE BILDER LADEN
    // ---------------------------------------------------------
    const [[old]] = await db.query(
      `SELECT pictures FROM \`${ent.table}\` WHERE id=?`,
      [listingId]
    );

    let oldPics = [];

    if (old?.pictures) {
      try {
        oldPics = phpSerialize.unserialize(old.pictures)
          .map(p => p.image)
          .filter(Boolean);
      } catch (e) {
        console.log("⚠️ Fehler beim Unserialize:", e);
      }
    }

    console.log("📸 Alte Bilder:", oldPics);

    // ---------------------------------------------------------
    // 8) GELÖSCHTE BILDER EMPFANGEN
    // ---------------------------------------------------------
    let removed = [];

    if (req.body.removedImages) {
      removed = Array.isArray(req.body.removedImages)
        ? req.body.removedImages
        : [req.body.removedImages];
    }
    if (req.body["removedImages[]"]) {
      const arr = req.body["removedImages[]"];
      removed = removed.concat(Array.isArray(arr) ? arr : [arr]);
    }

    console.log("🔥 Entfernte Bilder:", removed);

    // ---------------------------------------------------------
    // 9) NEUE BILDER HOCHLADEN
    // ---------------------------------------------------------
    const uploadDir = path.join('/media/herando/images', ent.route, listingId.toString());
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const newPics = [];

    for (const file of req.files) {
      const safe = file.originalname.replace(/\s+/g, "_");
      const dest = path.join(uploadDir, safe);

      try {
        fs.renameSync(file.path, dest);
      } catch {
        fs.copyFileSync(file.path, dest);
        fs.unlinkSync(file.path);
      }

      newPics.push(safe);
    }

    console.log("🆕 Neue Bilder:", newPics);

    // ---------------------------------------------------------
    // 10) BILDER LÖSCHEN
    // ---------------------------------------------------------
    for (const img of removed) {
      const fp = path.join(uploadDir, img);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        console.log("🗑️ Gelöscht:", fp);
      }
    }

    // ---------------------------------------------------------
    // 11) FINALE BILDERLISTE
    // ---------------------------------------------------------
    const finalPics = [
      ...oldPics.filter(x => !removed.includes(x)),
      ...newPics
    ];

    console.log("🎯 Finale Bilderliste:", finalPics);

    const serializedPics = phpSerialize.serialize(finalPics.map(p => ({ image: p })));

// ---------------------------------------------------------
// PROPERTIES NORMALISIERUNG (INT + DOUBLE – FINAL)
// ---------------------------------------------------------
if (ent.route === "properties") {

  const propertyIntFields = [
    "propertytype",
    "investmenttype",
    "heating",
    "energysource",
    "energypass",
    "energypass_type",
    "floors",
    "bathrooms",
    "stage",
    "quality",
    "country_id"
  ];

  const propertyDecimalFields = [
    "price",
    "energypass_value"
  ];

  // INT → null oder parseInt
  for (const key of propertyIntFields) {
    if (!(key in req.body)) continue;

    if (req.body[key] === "" || req.body[key] === null) {
      req.body[key] = null;
    } else if (!isNaN(req.body[key])) {
      req.body[key] = parseInt(req.body[key], 10);
    }
  }

  // DOUBLE → null oder parseFloat
  for (const key of propertyDecimalFields) {
    if (!(key in req.body)) continue;

    if (req.body[key] === "" || req.body[key] === null) {
      req.body[key] = null;
    } else if (!isNaN(req.body[key])) {
      req.body[key] = parseFloat(req.body[key]);
    }
  }

  console.log("🏠 Properties normalisiert:", req.body);
}



    // ---------------------------------------------------------
    // 12) BODY FILTERN
    // ---------------------------------------------------------
    for (const key of Object.keys(req.body)) {
      if (!validColumns.includes(key)) {
        delete req.body[key];
      }
    }

    // 🔥 NIEMALS vom Formular übernehmen
    delete req.body.status;
    delete req.body.visible;
    delete req.body.user_id;


          // Aktuellen Status holen
      const [[currentState]] = await db.query(
        `SELECT status, visible FROM \`${ent.table}\` WHERE id=?`,
        [listingId]
      );

      const keepHidden =
        Number(currentState.status) === 0 &&
        Number(currentState.visible) === 0;

      console.log("🔍 Vorheriger Zustand:", currentState, "keepHidden:", keepHidden);


    // ---------------------------------------------------------
    // 13) SQL BUILD
    // ---------------------------------------------------------
    const keys = Object.keys(req.body);
    const values = Object.values(req.body);

    const setParts = keys.map(k => `\`${k}\`=?`);
    setParts.push("pictures=?");
    setParts.push("modified=NOW()");
    if (keepHidden) {
      setParts.push("status='0'");
      setParts.push("visible='0'");
      console.log("⛔ Inserat bleibt versteckt (0/0)");
    } else {
      setParts.push("status='1'");
      setParts.push("visible='0'");
      console.log("✅ Inserat geht in Prüfung (1/0)");
    }

    const sql = `
      UPDATE \`${ent.table}\`
      SET ${setParts.join(', ')}
      WHERE id=? AND user_id=?`;

    const params = [...values, serializedPics, listingId, effectiveOwnerUserId];

    console.log("🧾 SQL:", sql);
    console.log("📦 PARAMS:", params);

    // ---------------------------------------------------------
    // 14) QUERY
    // ---------------------------------------------------------
    await db.query(sql, params);

    console.log("✅ UPDATE erfolgreich!");
    req.session.successMessage = "Inserat erfolgreich bearbeitet.";
    if (adminEditMode) {
      delete req.session.adminListingEditGrant;
    }

    return res.redirect(adminEditMode ? (adminEditReturnUrl || '/admin/listings') : "/buyer/historie");

  } catch (err) {
    console.error("🔥 Fehler in edit-listing:", err);
    req.session.errorMessage = err.message;
    return res.redirect(adminEditMode ? (adminEditReturnUrl || '/admin/listings') : `/buyer/edit-listing/${req.params.id}`);
  }
});

router.post(
  '/api/listing/:id/images/update',
  ensureAuthenticated,
  upload.array('pictures', 20),
  async (req, res) => {

    console.log("\n===============================================");
    console.log("🟦 API CALL: UPDATE IMAGES");
    console.log("===============================================");

    try {
      const userId    = req.session.userId;
      const listingId = parseInt(req.params.id, 10);

      console.log("👤 User:", userId);
      console.log("🆔 Listing:", listingId);

      if (!userId || isNaN(listingId)) {
        console.log("❌ ERROR: Ungültige Parameter!");
        return res.json({ success: false, error: "Invalid request" });
      }

      // ---------------------------------------------------------
      // 1) Entität finden
      // ---------------------------------------------------------
      console.log("\n🔎 Suche Entität...");

      const tables = ['cars', 'yachts', 'watches', 'properties', 'lifestyles'];
      let ent = null;

      for (const table of tables) {
        const [rows] = await db.query(
          `SELECT id FROM \`${table}\` WHERE id=? AND user_id=?`,
          [listingId, userId]
        );
        if (rows.length) {
          ent = table;
          break;
        }
      }

      console.log("📌 Erkannte Tabelle:", ent);

      if (!ent) {
        console.log("❌ ERROR: Listing gehört nicht dem User!");
        return res.json({ success: false, error: "Listing not found" });
      }

      // ---------------------------------------------------------
      // 2) Alte Bilder laden
      // ---------------------------------------------------------
      console.log("\n📸 Lade alte Galerie...");

      const [[old]] = await db.query(
        `SELECT pictures FROM \`${ent}\` WHERE id=?`,
        [listingId]
      );

      let oldPics = [];
      if (old?.pictures) {
        try {
          oldPics = phpSerialize.unserialize(old.pictures).map(i => i.image);
        } catch (e) {
          console.log("⚠️ Fehler beim Unserialize:", e.message);
        }
      }

      console.log("📷 Alte Bilder:", oldPics);

      // ---------------------------------------------------------
      // 3) Bilder löschen
      // ---------------------------------------------------------
      console.log("\n🗑️ Prüfe zu löschende Bilder...");

      const toDelete = req.body.delete ? JSON.parse(req.body.delete) : [];

      console.log("🗑️ Vom Client zu löschen:", toDelete);

      let newGallery = oldPics.filter(img => !toDelete.includes(img));

      console.log("📂 Galerie nach Löschung:", newGallery);

      // ---------------------------------------------------------
      // 4) Sortierung anwenden (optional)
      // ---------------------------------------------------------
      console.log("\n🔀 Sortierung prüfen...");

      if (req.body.reorder) {
        const order = JSON.parse(req.body.reorder);
        console.log("📑 Neue Reihenfolge vom Client:", order);

        newGallery = order.filter(img => newGallery.includes(img));
      }

      console.log("📂 Galerie nach Sortierung:", newGallery);

      // ---------------------------------------------------------
      // 5) Neue Bilder speichern
      // ---------------------------------------------------------
      console.log("\n⬆️ Speichere neue Uploads...");

      const uploadDir = path.join("/media/herando/images", ent, listingId.toString());
      fs.ensureDirSync(uploadDir);

      for (const file of req.files) {
        const safeName = Date.now() + "_" + file.originalname.replace(/\s+/g, "_");
        const target = path.join(uploadDir, safeName);

        console.log("💾 Speichere:", safeName);

        fs.moveSync(file.path, target);
        newGallery.push(safeName);
      }

      console.log("📁 Galerie nach Upload:", newGallery);

      // ---------------------------------------------------------
      // 6) Serialisieren & speichern
      // ---------------------------------------------------------
      console.log("\n💾 Serialisiere Galerie...");

      const serialized = phpSerialize.serialize(
        newGallery.map(img => ({ image: img }))
      );

      const mainPic = newGallery[0] || null;

      console.log("🏆 Mainpicture:", mainPic);

      await db.query(
        `UPDATE \`${ent}\` 
         SET pictures=?, mainpicture=?, visible='0'
         WHERE id=? AND user_id=?`,
        [serialized, mainPic, listingId, userId]
      );

      console.log("\n✅ UPDATE ERFOLGREICH!");
      console.log("===============================================\n");

      return res.json({
        success: true,
        pictures: newGallery,
        mainpicture: mainPic
      });

    } catch (err) {
      console.error("🔥 FATAL ERROR:", err);
      return res.json({ success: false, error: err.message });
    }
  }
);

router.post(
  '/api/listing/:id/mainpicture/update',
  ensureAuthenticated,
  upload.single('mainpicture'),
  async (req, res) => {

    console.log("\n===============================================");
    console.log("🟨 API CALL: UPDATE MAINPICTURE");
    console.log("===============================================");

    try {
      const userId    = req.session.userId;
      const listingId = parseInt(req.params.id, 10);

      console.log("👤 User:", userId);
      console.log("🆔 Listing:", listingId);
      console.log("📦 File:", req.file?.originalname);

      if (!userId || isNaN(listingId) || !req.file) {
        console.log("❌ ERROR: Ungültige Parameter!");
        return res.json({ success: false, error: "Invalid request" });
      }

      // ---------------------------------------------------------
      // 1) Entität finden
      // ---------------------------------------------------------
      const tables = ['cars', 'yachts', 'watches', 'properties', 'lifestyles'];
      let ent = null;

      for (const table of tables) {
        const [rows] = await db.query(
          `SELECT id FROM \`${table}\` WHERE id=? AND user_id=?`,
          [listingId, userId]
        );
        if (rows.length) {
          ent = table;
          break;
        }
      }

      console.log("📌 Erkannte Tabelle:", ent);
      if (!ent) return res.json({ success: false, error: "Listing not found" });

      // ---------------------------------------------------------
      // 2) Alte Mainpicture laden (für Log)
      // ---------------------------------------------------------
      const [[oldRow]] = await db.query(
        `SELECT mainpicture FROM \`${ent}\` WHERE id=?`,
        [listingId]
      );

      console.log("🖼️ Altes Mainpicture:", oldRow?.mainpicture);

      // ---------------------------------------------------------
      // 3) Datei speichern
      // ---------------------------------------------------------
      const uploadDir = path.join("/media/herando/images", ent, listingId.toString());
      fs.ensureDirSync(uploadDir);

      const safeName =
        "main_" + Date.now() + "_" +
        req.file.originalname.replace(/\s+/g, "_");

      const target = path.join(uploadDir, safeName);

      console.log("💾 Speichern nach:", target);

      fs.moveSync(req.file.path, target);

      // ---------------------------------------------------------
      // 4) DB Update (NUR mainpicture)
      // ---------------------------------------------------------
      await db.query(
        `UPDATE \`${ent}\`
         SET mainpicture=?, visible='0'
         WHERE id=? AND user_id=?`,
        [safeName, listingId, userId]
      );

      console.log("🏆 Neues Mainpicture gesetzt:", safeName);
      console.log("===============================================\n");

      return res.json({
        success: true,
        mainpicture: safeName
      });

    } catch (err) {
      console.error("🔥 FATAL ERROR:", err);
      return res.json({ success: false, error: err.message });
    }
  }
);







router.post('/delete-listing/:id', async (req, res, next) => {
  console.log('🧩 [ROUTE ENTERED] /buyer/delete-listing/:id wurde ausgelöst!');
  console.log('📬 Methode:', req.method);
  console.log('📫 Original-URL:', req.originalUrl);

  try {
    const userId = req.session.userId;
    const listingId = req.params.id;

    console.log('👤 Session userId:', userId);
    console.log('🆔 Listing-ID aus Params:', listingId);

    if (!userId) {
      console.warn('❌ Kein User in Session – Zugriff verweigert.');
      return res.redirect('/auth/login');
    }

    const tables = ['cars', 'properties', 'watches', 'yachts', 'lifestyles'];
    let updated = false;

    console.log('📋 Starte Suche in Tabellen:', tables.join(', '));

    for (const table of tables) {
      console.log(`🔍 Prüfe Tabelle '${table}' für ID=${listingId} und user_id=${userId}`);

      const [rows] = await db.query(
        `SELECT id FROM \`${table}\` WHERE id = ? AND user_id = ?`,
        [listingId, userId]
      );

      console.log(`📊 Ergebnis für '${table}':`, rows.length > 0 ? `${rows.length} Treffer` : 'Kein Treffer');

      if (rows.length > 0) {
        console.log(`✅ Treffer gefunden in '${table}', führe Update aus...`);

        await db.query(
          `UPDATE \`${table}\`
           SET status = 9, visible = 0
           WHERE id = ? AND user_id = ?`,
          [listingId, userId]
        );

        console.log(`✅ Soft-Delete abgeschlossen in '${table}' für ID=${listingId}`);
        updated = true;
        break;
      }
    }

    if (updated) {
      console.log('🎯 Erfolg: Inserat wurde deaktiviert.');
      req.session.successMessage = '✅ Das Inserat wurde erfolgreich deaktiviert.';
    } else {
      console.warn(`⚠️ Kein Inserat gefunden oder keine Berechtigung – ID=${listingId}, user_id=${userId}`);
      req.session.errorMessage = '❌ Inserat wurde nicht gefunden oder gehört Ihnen nicht.';
    }

    console.log('↩️ Redirect zu /buyer/submit-online');
    res.redirect('/buyer/submit-online');
  } catch (err) {
    console.error('💣 Fehler beim Soft-Delete:', err);
    next(err);
  }
});


router.post(
  '/listing/:id/upload-images',
  ensureAuthenticated,
  upload.array('pictures', 20),
  async (req, res, next) => {
    try {
      const userId    = req.session.userId;
      const listingId = parseInt(req.params.id, 10);

      // 1) Aktive Kategorie ermitteln
      const [[sel]] = await db.query(`
        SELECT category_id
          FROM selected_packages
         WHERE user_id    = ?
           AND start_date <= NOW()
           AND end_date   > NOW()
         ORDER BY start_date DESC
         LIMIT 1
      `, [userId]);

      if (!sel) {
        req.session.errorMessage = 'Keine aktive Kategorie (Paket) gefunden.';
        return res.redirect('/buyer');
      }

      // 2) Entität laden (Tabelle + Route)
      const [[ent]] = await db.query(`
        SELECT table_name, route
          FROM entieties
         WHERE id = ?
      `, [sel.category_id]);

      if (!ent) {
        req.session.errorMessage = 'Kategorie nicht gefunden.';
        return res.redirect('/buyer');
      }

      // 3) Zielverzeichnis: /media/herando/images/<route>/<listingId>
      const destDir = path.join(
        '/', 'media', 'herando', 'images',
        ent.route,
        String(listingId)
      );
      await fs.ensureDir(destDir);

      // 4) Dateien verschieben und Dateinamen sammeln
      const gallery = [];
      for (const file of req.files) {
        const ext      = path.extname(file.originalname);
        const filename = `${Date.now()}_${file.filename}${ext}`;
        await fs.move(
          file.path,
          path.join(destDir, filename),
          { overwrite: true }
        );
        gallery.push(filename);
      }

      // 5) In DB speichern (PHP-serialized Array + mainpicture)
      const serialized = phpSerialize.serialize(
        gallery.map(img => ({ image: img }))
      );
      const mainPic = gallery[0] || null;

      await db.query(`
        UPDATE \`${ent.table_name}\`
           SET pictures    = ?,
               mainpicture = ?,
               visible     = '0',
               status      = '0'
         WHERE id      = ?
           AND user_id = ?
      `, [serialized, mainPic, listingId, userId]);

      // 6) Erfolgsmeldung setzen und zurück zur Bearbeiten-Seite
      req.session.successMessage = 'Bilder erfolgreich hochgeladen. Inserat wurde gespeichert.';
      return res.redirect(`/buyer/edit-listing/${listingId}`);
    } catch (err) {
      next(err);
    }
  }
);

// 👇 Vor allen Buyer-Routen:
router.use((req, res, next) => {
  res.locals.entities = [
    { route: 'cars', table_name: 'cars' },
    { route: 'properties', table_name: 'properties' },
    { route: 'yachts', table_name: 'yachts' },
    { route: 'watches', table_name: 'watches' },
    { route: 'lifestyles', table_name: 'lifestyles' }
  ];
  next();
});

async function getUsedCountsByCategory(userId, entities) {
  const usedByCategory = {};
  await Promise.all(
    entities.map(async (ent) => {
      const [[row]] = await db.query(
        `SELECT COUNT(*) AS cnt
           FROM \`${ent.table_name}\`
          WHERE user_id = ?
            AND (
              (status = 3 AND visible IN (0, 1))
              OR (status = 4 AND visible IN (0, 2))
              OR (status = 1 AND visible = 0)
            )`,
        [userId]
      );
      usedByCategory[ent.id] = Number(row?.cnt || 0);
    })
  );
  return usedByCategory;
}

function buildRemainingByCategory(packages, usedByCategory) {
  const remainingByCategory = {};
  for (const pkg of packages) {
    const catId = pkg.category_id;
    if (!remainingByCategory[catId]) remainingByCategory[catId] = 0;
    remainingByCategory[catId] += Number(pkg.max_listings || 0);
  }
  for (const [catId, max] of Object.entries(remainingByCategory)) {
    const used = usedByCategory[catId] || 0;
    remainingByCategory[catId] = Math.max(0, max - used);
  }
  return remainingByCategory;
}

router.get('/preview/:entityRoute/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = Number(req.session.userId || 0);
    const entityRoute = String(req.params.entityRoute || '').toLowerCase();
    const listingId = Number.parseInt(req.params.id, 10);

    if (!WISHLIST_ALLOWED_TABLES.has(entityRoute) || !Number.isInteger(listingId) || listingId <= 0) {
      return res.status(404).send('Artikel nicht gefunden');
    }

    const table = db.escapeId(entityRoute);
    const [[row]] = await db.query(
      `SELECT id, name, user_id, status, visible
       FROM ${table}
       WHERE id = ?
       LIMIT 1`,
      [listingId]
    );

    if (!row || Number(row.user_id) !== userId || Number(row.status) === 9) {
      return res.status(404).send('Artikel nicht gefunden');
    }

    const safeSlug = slugify(String(row.name || ''), { lower: true, strict: true }) || String(row.id);
    return res.redirect(`/${entityRoute}/${safeSlug}-${row.id}?preview=1`);
  } catch (err) {
    console.error('❌ Fehler in /buyer/preview/:entityRoute/:id:', err);
    next(err);
  }
});

router.get('/submit-online', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/auth/login');

    // 1️⃣ Kategorien (Ententies)
    const [entities] = await db.query(`
      SELECT id, name, table_name, route 
      FROM ententies 
      ORDER BY id ASC
    `);

    // 2️⃣ Aktive Pakete
    const [packages] = await db.query(`
      SELECT id AS selpkg_id, category_id, max_listings, used_listings, end_date
      FROM selected_packages
      WHERE user_id = ? AND end_date > NOW()
    `, [userId]);

    if (!packages.length) {
      req.session.errorMessage = 'Sie haben kein aktives Paket. Bitte buchen Sie zuerst eines.';
      return res.redirect('/buyer');
    }

    // 3️⃣ Entity–Route-Mapping
    const routeMap = {
      'Autos': 'cars',
      'Immobilien': 'properties',
      'Yachten': 'yachts',
      'Uhren': 'watches',
      'Lifestyles': 'lifestyles'
    };

    // 4️⃣ Offline-Inserate holen + Bild extrahieren
    const items = [];
    for (const ent of entities) {
      const [rows] = await db.query(`
        SELECT id, name AS title, pictures, mainpicture, ? AS category_id
        FROM \`${ent.table_name}\`
        WHERE user_id = ? AND visible = 0 AND status = 0
        ORDER BY created DESC
      `, [ent.id, userId]);

      const route = routeMap[ent.name] || ent.route || ent.table_name;

      rows.forEach(r => {
        let filename = null;

        try {
          // 🖼️ Bilder aus PHP-serialisiertem Format holen
          if (r.pictures && typeof r.pictures === 'string') {
            const pics = unserialize(r.pictures);
            if (Array.isArray(pics) && pics.length > 0 && pics[0].image) {
              filename = pics[0].image;
            }
          }
          // 🖼️ Fallback: mainpicture
          if (!filename && r.mainpicture) {
            if (r.mainpicture.startsWith('a:')) {
              const parsed = unserialize(r.mainpicture);
              if (parsed?.image) filename = parsed.image;
            } else filename = r.mainpicture;
          }
        } catch (e) {
          console.warn('Bild konnte nicht gelesen werden:', e.message);
        }

        const imageUrl = filename
          ? `/images/${route}/${r.id}/${filename}`
          : '/assets/herando-weblogo.png';

        items.push({
          id: r.id,
          title: r.title,
          category_id: r.category_id,
          entityRoute: route,
          tableName: ent.table_name,
          imageUrl
        });
      });
    }

    // 5️⃣ Restliche Einreichungen pro Kategorie
    const usedByCategory = await getUsedCountsByCategory(userId, entities);
    const remainingByCategory = buildRemainingByCategory(packages, usedByCategory);


    // 6️⃣ User-Daten
    const [[user]] = await db.query(`
      SELECT firstname, lastname, email, phone
      FROM users
      WHERE id = ?
    `, [userId]);

    // 7️⃣ SEO
    const seo = {
      title: 'Zur Prüfung freigeben | Herando',
      meta_description: 'Reichen Sie Ihre Inserate zur Prüfung ein.'
    };

    // 8️⃣ Rendern
    res.render('pages/templates/submit-online', {
      user,
      entities,
      items,
      remainingByCategory,
      seo,
      currentPage: 'submit-online',
      successMessage: req.session.successMessage,
      errorMessage: req.session.errorMessage
    });

    // Flash-Messages zurücksetzen
    req.session.successMessage = null;
    req.session.errorMessage = null;

  } catch (err) {
    console.error('❌ Fehler in /buyer/submit-online:', err);
    next(err);
  }
});


router.post('/submit-online', async (req, res, next) => {
  try {
    console.log('--- 🧾 START /submit-online ---');

    const userId = req.session.userId;
    console.log('👤 Eingeloggter User:', userId);
    if (!userId) {
      console.log('❌ Kein User in Session.');
      return res.redirect('/auth/login');
    }

    console.log('📦 Lade aktive Pakete ...');
    const [packages] = await db.query(`
      SELECT id AS selpkg_id, category_id, max_listings, used_listings
      FROM selected_packages
      WHERE user_id = ? AND end_date > NOW()
    `, [userId]);
    console.log('📦 Aktive Pakete:', packages);

    if (!packages.length) {
      req.session.errorMessage = '❌ Kein aktives Paket gefunden.';
      return res.redirect('/buyer/submit-online');
    }

    const [entities] = await db.query(`
      SELECT id, table_name, route
      FROM ententies
      ORDER BY id ASC
    `);

    const usedByCategory = await getUsedCountsByCategory(userId, entities);
    const remainingByCategory = buildRemainingByCategory(packages, usedByCategory);

    let { items } = req.body;
    console.log('📩 Eingehende Formulardaten (req.body.items):', items);

    if (!items) {
      req.session.errorMessage = '❗ Bitte mindestens ein Inserat auswählen.';
      return res.redirect('/buyer/submit-online');
    }
    if (!Array.isArray(items)) items = [items];

    console.log('📚 res.locals.entities:', res.locals.entities);

    const selectedByCat = {};
    for (const sel of items) {
      const [route, idStr, catStr] = sel.split(':'); // z. B. "watches:396609:2"
      const categoryId = parseInt(catStr, 10);
      console.log(`➡️ Verarbeitung Item: ${sel} | Route=${route}, ID=${idStr}, Cat=${catStr}`);

      if (!selectedByCat[categoryId]) selectedByCat[categoryId] = [];
      selectedByCat[categoryId].push({ route, id: parseInt(idStr, 10) });
    }

    console.log('📂 Gruppierte Auswahl nach Kategorie:', selectedByCat);

    // ===============================
    // 🔄 Verarbeitung pro Kategorie
    // ===============================
    for (const [catId, selArr] of Object.entries(selectedByCat)) {
      console.log(`\n--- 🧩 Kategorie ${catId} ---`);

      const remaining = remainingByCategory[catId] || 0;
      console.log(`📊 Noch verfügbare Einreichungen: ${remaining}`);

      if (remaining <= 0) {
        console.log(`⚠️ Kein verfügbares Paket für Kategorie ${catId} – alle Slots belegt.`);
        req.session.errorMessage = `⚠️ Du hast in Kategorie ${catId} keine freien Einreichungen mehr.`;
        return res.redirect('/buyer/submit-online');
      }

      if (selArr.length > remaining) {
        console.log(`🚫 Zu viele Inserate (${selArr.length}) ausgewählt! Nur ${remaining} erlaubt.`);
        req.session.errorMessage = `⚠️ Du darfst in Kategorie ${catId} nur ${remaining} Inserat(e) einreichen.`;
        return res.redirect('/buyer/submit-online');
      }

      // ===============================
      // 🧱 Updates durchführen
      // ===============================
      for (const s of selArr) {
        console.log(`🛠️ Versuch Update: ${s.route} ID=${s.id}`);
        const ent = res.locals.entities.find(e => e.route === s.route);

        if (!ent) {
          console.log(`❌ Keine Entity gefunden für Route "${s.route}".`);
          continue;
        }

        console.log(`🧱 Tabelle: ${ent.table_name}`);

        const [result] = await db.query(`
          UPDATE \`${ent.table_name}\`
             SET status = 1,
                 visible = 0,
                 modified = NOW()
           WHERE id = ? AND user_id = ?
        `, [s.id, userId]);

        console.log('✅ Update-Ergebnis:', result);
        if (result.affectedRows === 0) {
          console.log(`⚠️ Kein Datensatz aktualisiert für ID=${s.id}, User=${userId}.`);
        }
      }

    }

    console.log('🎉 Alles erfolgreich verarbeitet.');
    req.session.successMessage = '✅ Inserat ist in Prüfung; das Inserat wird innerhalb der nächsten 24 Stunden veröffentlicht.';
    res.redirect('historie');
    console.log('--- ✅ ENDE /submit-online ---\n');

  } catch (err) {
    console.error('💥 Fehler in /submit-online:', err);
    req.session.errorMessage = 'Ein unerwarteter Fehler ist aufgetreten.';
    res.redirect('/buyer/submit-online');
  }
});





router.post('/mark-as-sold/:id', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const listingId = req.params.id;

    if (!userId) {
      console.warn('❌ Kein User in Session – Zugriff verweigert.');
      return res.redirect('/auth/login');
    }

    const tables = ['cars', 'properties', 'watches', 'yachts', 'lifestyles'];
    let updated = false;

    for (const table of tables) {
      console.log(`🔍 Prüfe Tabelle '${table}' für ID=${listingId} (User ${userId})`);

      // Nur Inserate mit status=3 und visible=1
      const [rows] = await db.query(
        `SELECT id FROM \`${table}\`
         WHERE id = ? AND user_id = ? AND status = 3 AND visible = 1`,
        [listingId, userId]
      );

      if (rows.length > 0) {
        console.log(`✅ Aktives Inserat gefunden in '${table}' → Markiere als verkauft`);
        await db.query(
          `UPDATE \`${table}\`
           SET status = 6, visible = 1
           WHERE id = ? AND user_id = ?`,
          [listingId, userId]
        );
        console.log(`💰 Inserat als verkauft markiert in '${table}' (ID=${listingId})`);
        updated = true;
        break;
      }
    }

    if (updated) {
      req.session.successMessage = '💰 Das Inserat wurde als verkauft markiert.';
    } else {
      req.session.errorMessage = '⚠️ Kein aktives Inserat gefunden oder keine Berechtigung.';
    }

    res.redirect('/buyer/historie');
  } catch (err) {
    console.error('❌ Fehler beim Markieren als verkauft:', err);
    next(err);
  }
});

router.post('/toggle-listing/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const listingId = req.params.id;
    const target = String(req.body?.target || '').toLowerCase().trim();
    const returnTab = String(req.body?.return_tab || '').toLowerCase().trim();
    const allowedTabs = new Set(['online', 'drafts', 'review', 'paused', 'deactivate', 'deleted', 'expired']);
    const redirectToHistory = (fallbackTab) => {
      const tab = allowedTabs.has(returnTab) ? returnTab : fallbackTab;
      return res.redirect(tab ? `/buyer/historie?tab=${tab}` : '/buyer/historie');
    };

    if (!userId) return res.redirect('/auth/login');

    const tables = ['cars', 'properties', 'watches', 'yachts', 'lifestyles'];

    for (const table of tables) {
      const [[row]] = await db.query(
        `SELECT status, visible FROM \`${table}\` WHERE id = ? AND user_id = ? LIMIT 1`,
        [listingId, userId]
      );

      if (!row) continue;

      const status = Number(row.status);
      const visible = Number(row.visible);

      // Explizite Zielzustände für tab-spezifische Buttons in buyer-historie.ejs
      if (target === 'deactivate') {
        if (status === 3 && visible === 1) {
          await db.query(
            `UPDATE \`${table}\`
                SET status = 4, visible = 0
              WHERE id = ? AND user_id = ?`,
            [listingId, userId]
          );
          req.session.successMessage = '⏹️ Das Inserat wurde deaktiviert.';
          return redirectToHistory('deactivate');
        }
        if (status === 3 && visible === 0) {
          await db.query(
            `UPDATE \`${table}\`
                SET status = 4, visible = 2
              WHERE id = ? AND user_id = ?`,
            [listingId, userId]
          );
          req.session.successMessage = '⏹️ Das angehaltene Inserat wurde deaktiviert.';
          return redirectToHistory('deactivate');
        }
        req.session.errorMessage = '⚠️ Dieses Inserat kann nicht deaktiviert werden.';
        return redirectToHistory('deactivate');
      }

      if (target === 'paused') {
        if (status === 4 && visible === 2) {
          await db.query(
            `UPDATE \`${table}\`
                SET status = 3, visible = 0
              WHERE id = ? AND user_id = ?`,
            [listingId, userId]
          );
          req.session.successMessage = '⏸️ Das Inserat ist wieder bei Angehaltene.';
          return redirectToHistory('paused');
        }
        req.session.errorMessage = '⚠️ Dieses Inserat kann nicht auf Angehalten gesetzt werden.';
        return redirectToHistory('paused');
      }

      if (target === 'online') {
        if ((status === 4 && visible === 0) || (status === 3 && visible === 0)) {
          await db.query(
            `UPDATE \`${table}\`
                SET status = 3, visible = 1
              WHERE id = ? AND user_id = ?`,
            [listingId, userId]
          );
          req.session.successMessage = '✅ Das Inserat ist wieder online.';
          return redirectToHistory('online');
        }
        req.session.errorMessage = '⚠️ Dieses Inserat kann nicht online gestellt werden.';
        return redirectToHistory('online');
      }

      // Online -> Deaktivieren
      if (status === 3 && visible === 1) {
        await db.query(
          `UPDATE \`${table}\`
              SET status = 4, visible = 0
            WHERE id = ? AND user_id = ?`,
          [listingId, userId]
        );
        req.session.successMessage = '⏸️ Das Inserat wurde pausiert.';
        return redirectToHistory('deactivate');
      }

      // Angehalten -> Online (inkl. Legacy status=3, visible=0)
      if ((status === 4 && visible === 0) || (status === 3 && visible === 0)) {
        await db.query(
          `UPDATE \`${table}\`
              SET status = 3, visible = 1
            WHERE id = ? AND user_id = ?`,
          [listingId, userId]
        );
        req.session.successMessage = '✅ Das Inserat ist wieder online.';
        return redirectToHistory('online');
      }

      req.session.errorMessage = '⚠️ Dieser Status kann nicht umgeschaltet werden.';
      return redirectToHistory('');
    }

    req.session.errorMessage = '❌ Inserat wurde nicht gefunden oder gehört Ihnen nicht.';
    return redirectToHistory('');
  } catch (err) {
    console.error('❌ Fehler beim Umschalten des Inserat-Status:', err);
    next(err);
  }
});

router.get(
  '/wishlist',
  ensureAuthenticated,
  async (req, res, next) => {
    try {
      console.log('[Wishlist Debug] GET /buyer/wishlist aufgerufen');
      const userId = req.session.userId;
      console.log('[Wishlist Debug] session.userId =', userId);
      if (!userId) {
        // Benutzer ist nicht eingeloggt → weiter per redirect zur Login-Seite
        return res.redirect('/auth/login');
      }

      // Lade nur den User, der Rest erfolgt clientseitig per JavaScript
      const [[user]] = await db.query(
        'SELECT firstname, lastname, email, phone FROM users WHERE id = ?',
        [userId]
      );
      console.log('[Wishlist Debug] geladener User:', user);

      const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

      res.render('pages/templates/listing-detail', {
        user,
        currentPage: 'wishlist',
        seo,
        sectionData: []  // leer, weil die Karten per JS nachgeladen werden
      });
    } catch (err) {
      console.error('[Wishlist Debug] Fehler in GET /buyer/wishlist:', err);
      next(err);
    }
  }
);

router.get(
  '/wishlist/:entity/:id',
  ensureAuthenticated,
  async (req, res, next) => {
    try {
      const { entity, id } = req.params;
      console.log(`[Wishlist Debug] GET /buyer/wishlist/${entity}/${id}`);

      const safeEntity = String(entity || '').toLowerCase();
      const safeId = parseInt(id, 10);
      if (!WISHLIST_ALLOWED_TABLES.has(safeEntity) || !Number.isInteger(safeId) || safeId <= 0) {
        return res.status(400).json({
          error: await tr(req, res, 'buyer.wishlist.error.invalid_request', 'Ungültige Anfrage')
        });
      }

      // 1) Datenbank: name AS title, price AS priceRaw, pictures-Feld
      const [[row]] = await db.query(
        `SELECT id,
                name    AS title,
                price   AS priceRaw,
                pictures
           FROM ${db.escapeId(safeEntity)}
          WHERE id = ?`,
        [safeId]
      );
      if (!row) {
        console.log('[Wishlist Debug] Kein Datensatz für', entity, id);
        // JSON-Endpoint: bei „nicht gefunden“ einfach 404-Antwort senden
        return res.status(404).json({
          error: await tr(req, res, 'buyer.wishlist.error.not_found', 'Nicht gefunden')
        });
      }
      console.log('[Wishlist Debug] DB-Row:', row);

      // 2) PHP-serialized-Feld entpacken
      let pics = [];
      if (row.pictures) {
        try {
          pics = unserialize(row.pictures);
          if (!Array.isArray(pics)) pics = Object.values(pics);
        } catch (e) {
          console.warn('[Wishlist Debug] Unserialize-Fehler:', e);
        }
      }

      // 3) Bild-URLs bauen
      const baseUrl = `/images/${encodeURIComponent(safeEntity)}/${safeId}`;
      const pictures = pics.map(p => ({
        filename: p.image,
        url:      `${baseUrl}/${encodeURIComponent(String(p.image || ''))}`
      }));

      // 4) JSON-Antwort zusammenstellen
      const response = {
        id:             row.id,
        title:          row.title,
        priceFormatted: new Intl.NumberFormat('de-DE', {
                          style: 'currency', currency: 'EUR'
                        }).format(row.priceRaw || 0),
        mainpictureUrl: pictures[0]?.url || '/images/placeholder.jpg',
        pictures
      };
      console.log('[Wishlist Debug] JSON-Response:', response);

      return res.json(response);
    } catch (err) {
      console.error('[Wishlist Debug] Fehler in GET /buyer/wishlist/:entity/:id', err);
      next(err);
    }
  }
);

// ─── 6b) GET /buyer/expired ───────────────────────────────────────────────
router.get('/expired', async (req, res, next) => {
  try {
    const userId = req.session.userId;

    // User‐Daten & Pakete/Orders wie bei den anderen Sektionen
    const [[user]] = await db.query(
      `SELECT 
         contact, company, vatid, firstname,
         lastname, street, housenumber, postcode,
         city, phone, mobile, fax,
         email, website, 
              flatrate_test,
     flatrate_all,
     flatrate_cars,
     flatrate_properties,
     flatrate_watches,
     flatrate_yachts,
     flatrate_investments
       FROM users
       WHERE id = ?`,
      [userId]
    );
    const [packages] = await db.query(
      `SELECT sp.id, p.name AS package_name,
              COALESCE(e.name,'–') AS category_name,
              c.de AS country_name,
              sp.start_date, sp.end_date,
              sp.max_listings, sp.used_listings
       FROM selected_packages sp
       JOIN packages p      ON p.id   = sp.package_id
       LEFT JOIN ententies e ON e.id  = sp.category_id
       JOIN countries c     ON c.id   = sp.country_id
       WHERE sp.user_id = ?
       ORDER BY sp.start_date DESC`,
      [userId]
    );
    const [orders] = await db.query(
      `SELECT id, product, created_at
       FROM orders
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    // die eigentliche SectionData: alle Einträge, deren end_date < heute
    const sectionData = await loadSectionDataExpired(userId, res.locals.entieties);

            // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    res.render('pages/templates/buyer', {
      user,
      packages,
      invoices:    orders,
      currentPage: 'expired',
      sectionData, 
      seo
    });
  } catch (err) {
    next(err);
  }
});

router.post('/edit-profile', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const { field, value } = req.body;

    // Sonderfall Name
    if (field === 'name') {
      const parts     = value.trim().split(' ');
      const firstname = parts.shift();
      const lastname  = parts.join(' ');
      await db.query(
        'UPDATE users SET firstname = ?, lastname = ? WHERE id = ?',
        [firstname, lastname, userId]
      );
    } else if ([
      'contact','company','vatid',
      'street','housenumber','postcode','city',
      'phone','mobile','fax','email','website'
    ].includes(field)) {
      // Alle übrigen Single-Column-Felder
      await db.query(
        `UPDATE users SET \`${field}\` = ? WHERE id = ?`,
        [value || null, userId]
      );
    }

    req.session.successMessage = 'Profil erfolgreich aktualisiert.';
    return res.redirect('/buyer');
  } catch (err) {
    next(err);
  }
});

router.get('/historie', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.redirect('/auth/login');

    // =============================
    // FILTER PARAMETER
    // =============================
    const q = (req.query.q || "").trim().toLowerCase();
    const priceFrom = req.query.price_from ? parseFloat(req.query.price_from) : 0;
    const priceTo   = req.query.price_to ? parseFloat(req.query.price_to) : Infinity;
    const activeTab = req.query.tab || "online";
    const entity    = (req.query.entity || "").trim().toLowerCase();

    // =============================
    // USER LADEN
    // =============================
    const [[user]] = await db.query(`
      SELECT id, firstname, lastname, email, company
      FROM users
      WHERE id = ?
    `, [userId]);


    // =============================
    // ENTITÄTEN LADEN
    // =============================
    const qEntity = (table, route) => db.query(`
      SELECT *, ? AS entityRoute
      FROM \`${table}\`
      WHERE user_id = ?
      ORDER BY created DESC
    `, [route, userId]);

    const [
      [props],
      [cars],
      [watches],
      [yachts],
      [lifestyles]
    ] = await Promise.all([
      qEntity('properties', 'properties'),
      qEntity('cars', 'cars'),
      qEntity('watches', 'watches'),
      qEntity('yachts', 'yachts'),
      qEntity('lifestyles', 'lifestyles')
    ]);

    const entityCounts = {
      properties: props.length,
      cars: cars.length,
      watches: watches.length,
      yachts: yachts.length,
      lifestyles: lifestyles.length
    };

    // =============================
    // ALLE INSERATE KOMBINIEREN
    // =============================
    let allListings = [...props, ...cars, ...watches, ...yachts, ...lifestyles];

    // =============================
    // BILDER AUSLESEN
    // =============================
    const { unserialize } = require('php-serialize');

    const listings = allListings.map(item => {
      let filename = null;

      try {
        if (item.pictures && typeof item.pictures === "string") {
          const pics = unserialize(item.pictures);
          if (Array.isArray(pics) && pics[0]?.image) filename = pics[0].image;
        }

        if (!filename && item.mainpicture) {
          if (item.mainpicture.startsWith('a:')) {
            const parsed = unserialize(item.mainpicture);
            if (parsed?.image) filename = parsed.image;
          } else {
            filename = item.mainpicture;
          }
        }
      } catch {}

      return {
        ...item,
        imageUrl: filename
          ? `/images/${item.entityRoute}/${item.id}/${filename}`
          : '/assets/default-placeholder.png'
      };
    });


    // =============================
    // STATUS-GRUPPEN
    // =============================
    const today = new Date();

    const groups = {
      online:  listings.filter(i => i.status == 3 && i.visible == 1),
      drafts:  listings.filter(i => i.status == 0),
      review:  listings.filter(i => [1, 2].includes(i.status)),
      paused: listings.filter(i => i.status == 3 && i.visible == 0),
      deactivate: listings.filter(i => i.status == 4 && [0, 2].includes(Number(i.visible))),
      deleted: listings.filter(i => i.status == 9),
      expired: listings.filter(i => i.end_date && new Date(i.end_date) < today)
    };

    // =============================
    // AKTIVE GRUPPE
    // =============================
    let filtered = [...(groups[activeTab] || [])];


    // =============================
    // ENTITY FILTER
    // =============================
    if (entity && entity !== "") {
      filtered = filtered.filter(item => item.entityRoute.toLowerCase() === entity);
    }


    // =============================
    // TEXT-SUCHE
    // =============================
    if (q.length > 0) {
      filtered = filtered.filter(item => {
        const text = (
          (item.name || "") +
          (item.title || "") +
          (item.make || "") +
          (item.model || "") +
          (item.color || "") +
          (item.reference || "") +
          item.id
        ).toLowerCase();

        return text.includes(q);
      });
    }


    // =============================
    // PREISFILTER
    // =============================
    filtered = filtered.filter(item => {
      const price = parseFloat(item.price || 0);
      return price >= priceFrom && price <= priceTo;
    });


    // =============================
    // PAGINATION NUR FÜR AKTIVE LISTE
    // =============================
    const page = Number(req.query.page || 1);
    const perPage = 100;
    const total = filtered.length;
    const totalPages = Math.ceil(total / perPage);
    const start = (page - 1) * perPage;
    const paginated = filtered.slice(start, start + perPage);


    // =============================
    // PLACEMENTS LADEN
    // =============================
    const [packageOrders] = await db.query(`
      SELECT item_id, status, end_date
      FROM user_package_orders
      WHERE user_id = ?
    `, [userId]);

    const placementMap = new Map();
    packageOrders.forEach(p => {
      placementMap.set(p.item_id, {
        isActive: p.status === 'paid',
        end_date: p.end_date
      });
    });

    paginated.forEach(item => {
      const placement = placementMap.get(item.id);
      item.hasPlacement = placement?.isActive || false;
      item.placementEndDate = placement?.end_date || null;
    });

    // =============================
    // KONTINGENT FÜR "JETZT VERÖFFENTLICHEN" (Entwürfe)
    // Gleiche Prüflogik-Basis wie /buyer/submit-online
    // =============================
    const [submitOnlineEntities] = await db.query(`
      SELECT id, route, table_name
      FROM ententies
      ORDER BY id ASC
    `);
    const [submitOnlinePackages] = await db.query(`
      SELECT category_id, max_listings, used_listings
      FROM selected_packages
      WHERE user_id = ? AND end_date > NOW()
    `, [userId]);
    const submitOnlineUsedByCategory = await getUsedCountsByCategory(userId, submitOnlineEntities);
    const submitOnlineRemainingByCategory = buildRemainingByCategory(
      submitOnlinePackages,
      submitOnlineUsedByCategory
    );
    const submitOnlineCategoryIdByRoute = Object.fromEntries(
      (submitOnlineEntities || [])
        .filter(e => e?.route)
        .map(e => [String(e.route).toLowerCase(), Number(e.id)])
    );


    // =============================
    // SEO LADEN
    // =============================
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT title, description AS meta_description, robots
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Inserate-Historie',
      meta_description: seoRow?.meta_description || 'Ihre Inserate.',
      robots: seoRow?.robots || 'noindex,nofollow',
      canonical_url: buildCanonical(req)
    };
    res.locals.seo = seo;


    // =============================
    // RENDERN
    // =============================
    res.render('pages/templates/buyer-historie', {
      user,
      seo,
      headerTitle: await tr(req, res, 'buyer.history.title', 'Inserat-Historie'),
      currentPage: 'historie',

      // nur aktiver Tab ist gefiltert + paginiert
      onlineListings:  activeTab === "online"  ? paginated : groups.online,
      offlineListings: activeTab === "drafts"  ? paginated : groups.drafts,
      reviewListings:  activeTab === "review"  ? paginated : groups.review,
      pausedListings: activeTab === "paused" ? paginated : groups.paused,
      deactivateListings: activeTab === "deactivate" ? paginated : groups.deactivate,
      deletedListings: activeTab === "deleted" ? paginated : groups.deleted,
      expiredListings: activeTab === "expired" ? paginated : groups.expired,

      // Filterparameter zurückgeben
      activeTab,
      entity,
      q,
      priceFrom,
      priceTo,
      entityCounts,
      submitOnlineRemainingByCategory,
      submitOnlineCategoryIdByRoute,

      pagination: {
        total,
        totalPages,
        currentPage: page,
        perPage
      }
    });


  } catch (err) {
    console.error('❌ Fehler in /historie:', err);
    next(err);
  }
});






router.post('/change-password', async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const { oldPassword, newPassword } = req.body;

    // Aktuelles Passwort hash aus DB holen
    const [[row]] = await db.query(
      'SELECT password FROM users WHERE id = ?',
      [userId]
    );
    const match = row && await bcrypt.compare(oldPassword, row.password);
    if (!match) {
      req.session.errorMessage = 'Altes Passwort stimmt nicht';
      return res.redirect('/buyer');
    }

    // Neues Passwort hashen und speichern
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query(
      'UPDATE users SET password = ? WHERE id = ?',
      [hash, userId]
    );

    req.session.successMessage = await tr(
      req,
      res,
      'buyer.profile.password.success',
      'Passwort erfolgreich geändert.'
    );
    return res.redirect('/buyer');
  } catch (err) {
    next(err);
  }
});

router.post('/upgrade/:itemId', ensureAuthenticated, async (req, res, next) => {
  try {
    console.log('🔧 POST /buyer/upgrade/:itemId');

    const userId = Number(req.session.userId);
    const itemId = Number(req.params.itemId);
    const usersPackageId = Number(req.body.selectedPackageId);

    if (!userId || !itemId || !usersPackageId) {
      req.session.errorMessage = await tr(
        req,
        res,
        'buyer.upgrade.error.invalid_request_ids',
        'Ungültige Anfrage (IDs fehlen).'
      );
      return res.redirect('/buyer/online');
    }

    console.log(`→ userId=${userId}, itemId=${itemId}, usersPackageId=${usersPackageId}`);

    // ------------------------------------------------------------
    // 1) Entitätstabelle finden (welche Tabelle enthält itemId?)
    // ------------------------------------------------------------
    const [entities] = await db.query(`SELECT id, table_name FROM ententies`);

    let entitieId = null;
    let tableName = null;

    for (const ent of entities) {
      const [[found]] = await db.query(
        `SELECT 1 FROM \`${ent.table_name}\` WHERE id = ? LIMIT 1`,
        [itemId]
      );

      if (found) {
        entitieId = ent.id;
        tableName = ent.table_name;
        break;
      }
    }

    if (!entitieId) {
      req.session.errorMessage = 'Inserat nicht gefunden.';
      return res.redirect('/buyer/online');
    }

    console.log(`→ Entität gefunden: ${tableName} (entitieId=${entitieId})`);

    // ------------------------------------------------------------
    // 2) Paket laden
    // ------------------------------------------------------------
    const [[pkg]] = await db.query(`
      SELECT duration_weeks, price_cents, name
      FROM users_packages
      WHERE id = ?
      LIMIT 1
    `, [usersPackageId]);

    if (!pkg) {
      req.session.errorMessage = 'Ungültiges Upgrade-Paket.';
      return res.redirect(`/buyer/upgrade/${itemId}`);
    }

    // ------------------------------------------------------------
    // 3) MwSt-Logik (DEIN WUNSCH):
    //    vatid vorhanden => 0% MwSt
    //    sonst => 21% MwSt
    // ------------------------------------------------------------
    // --- MwSt korrekt über VIES prüfen --------------------------------
      const [[userRow]] = await db.query(
        `SELECT vatid FROM users WHERE id = ? LIMIT 1`,
        [userId]
      );

      let taxRate = 21;
      let vatValid = false;
      const vatid = (userRow?.vatid || '').replace(/\s+/g, '');

      if (vatid.length > 0) {
        try {
          vatValid = await validateVAT_VIES(vatid);
        } catch (e) {
          console.error('VIES Fehler:', e.message);
        }
      }

      if (vatValid) {
        taxRate = 0;
      }

      console.log('🧾 MWST LOGIK:', {
        vatid,
        vatValid,
        taxRate
      });

      const basePrice = pkg.price_cents;
      const finalPrice = Math.round(basePrice * (1 + taxRate / 100));


    // ------------------------------------------------------------
    // 4) Laufzeit
    // ------------------------------------------------------------
    const startDate = moment().format('YYYY-MM-DD HH:mm:ss');
    const endDate = moment()
      .add(Number(pkg.duration_weeks) || 0, 'weeks')
      .format('YYYY-MM-DD HH:mm:ss');

    // ------------------------------------------------------------
    // 5) Order anlegen
    // ------------------------------------------------------------
    const [orderRes] = await db.query(`
      INSERT INTO user_package_orders
        (user_id, entitie_id, item_id, users_package_id, start_date, end_date, stripe_session_id, status)
      VALUES (?, ?, ?, ?, ?, ?, '', 'pending')
    `, [userId, entitieId, itemId, usersPackageId, startDate, endDate]);

    const orderId = orderRes.insertId;

    console.log('→ orderId:', orderId);

    // ------------------------------------------------------------
    // 6) Stripe Session erstellen
    // ------------------------------------------------------------
    const host = `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: pkg.name },
          unit_amount: finalPrice
        },
        quantity: 1
      }],
      client_reference_id: String(orderId),
      success_url: `${host}/buyer/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${host}/buyer/upgrade/cancel`
    });

    console.log('→ Stripe Session:', session.id);

    // ------------------------------------------------------------
    // 7) Stripe Session ID speichern
    // ------------------------------------------------------------
    await db.query(`
      UPDATE user_package_orders
      SET stripe_session_id = ?
      WHERE id = ?
      LIMIT 1
    `, [session.id, orderId]);

    // ------------------------------------------------------------
    // 8) Redirect
    // ------------------------------------------------------------
    return res.redirect(303, session.url);

  } catch (err) {
    console.error('🔥 Upgrade Fehler:', err);
    next(err);
  }
});

router.get('/upgrade/success', ensureAuthenticated, async (req, res, next) => {
  try {
    const sessionId = req.query.session_id;
    console.log('🔧 GET /buyer/upgrade/success – session_id =', sessionId);
    let locale = req.locale || req.session?.lang || req.acceptsLanguages()?.[0] || 'de';
    if (locale.includes('-')) locale = locale.split('-')[0];
    const greet      = await tBackend('email.invoice.greeting', locale);
    const confirm    = await tBackend('email.invoice.confirmation', locale);
    const attached   = await tBackend('email.invoice.attached', locale);
    const questions  = await tBackend('email.invoice.questions', locale);
    const regards    = await tBackend('email.invoice.regards', locale);
    const team       = await tBackend('email.invoice.team', locale);
    const subjectTxt = await tBackend('email.invoice.subject', locale);
    const autogenerated = await tBackend('email.invoice.autogenerated', locale);



    // 🔠 Helper für Übersetzungen
    async function tBackend(key, loc = 'de') {
      const [[row]] = await db.query(
        `SELECT ?? AS txt FROM ui_translations WHERE \`key\` = ? LIMIT 1`,
        [loc, key]
      );
      return row?.txt || key;
    }

    if (!sessionId) {
      console.log('   ✖ Kein session_id Parameter');
      return res.redirect('/buyer/online');
    }

    // 1) Prüfen ob placement_table existiert (DB-Migration evtl. noch nicht ausgeführt)
    const [placementColRows] = await db.query(
      `SELECT 1
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users_packages'
          AND COLUMN_NAME = 'placement_table'
        LIMIT 1`
    );
    const hasPlacementColumn = placementColRows.length > 0;
    const placementSelect = hasPlacementColumn
      ? 'pkg.placement_table       AS placement_table,'
      : 'NULL                      AS placement_table,';

    // 2) Bestellung aus user_package_orders laden
    console.log('   → Lade Bestellung …');
    const [[orderRec]] = await db.query(
      `
      SELECT
        upo.id                    AS order_id,
        upo.user_id,
        upo.item_id,
        upo.entitie_id,
        upo.status,
        upo.start_date,
        upo.end_date,
        DATE_FORMAT(upo.end_date,'%d.%m.%Y') AS package_end_formatted,
        upo.stripe_session_id,

        -- USER
        u.id                           AS partner_partnerident,
        u.firstname                    AS partner_first_name,
        u.lastname                     AS partner_last_name,
        u.company                      AS partner_firmenname,
        u.email                        AS partner_email,
        u.phone                        AS partner_phone,
        u.vatid                        AS partner_atu_nummer,
        u.street                       AS partner_street,
        u.housenumber                  AS partner_housenumber,
        u.postcode                     AS partner_postcode,
        u.city                         AS partner_city_raw,
        CONCAT(u.street,' ',u.housenumber) AS partner_address,
        CONCAT(u.postcode,' ',u.city)       AS partner_city,
            u.country_id                   AS country_id,

        -- COUNTRY
        c.de                      AS partner_country,
        c.code                    AS partner_abbreviation,
        c.code                    AS partner_country_code,
        COALESCE(ctr.tax_rate,0) AS country_tax_rate,

        -- PAYMENT DATEN (Rechnungsnummer usw.)
        pay.id           AS order_number,       -- DAS ist deine Rechnungsnummer!
        pay.created_at   AS payment_created_at, -- Datum der Zahlung
        pay.currency     AS payment_currency,
        pay.status       AS payment_status,
        pay.provider_id  AS payment_provider_id,


        -- USER_PACKAGE
        pkg.id                    AS user_package_id,
        pkg.name                  AS product,
        pkg.category              AS package_category,
        ${placementSelect}
        pkg.duration_weeks,
        pkg.price_cents,
        (pkg.price_cents / 100)   AS amount,

        -- ENTITÄT (Name für Rechnung)
        ent.name                  AS entity_name,

        -- INSERAT Titel
        COALESCE(
          cars.name,
          props.name,
          watches.name,
          yachts.name,
          life.name
        ) AS listing_title

      FROM user_package_orders upo
      JOIN users u              ON u.id = upo.user_id
      JOIN users_packages pkg   ON pkg.id = upo.users_package_id
      JOIN countries c          ON c.id  = u.country_id
      LEFT JOIN country_tax_rates ctr ON ctr.country_id = c.id
      LEFT JOIN ententies ent   ON ent.id = upo.entitie_id
      LEFT JOIN payments pay
       ON pay.order_id = upo.id


      LEFT JOIN cars cars             ON cars.id      = upo.item_id AND upo.entitie_id = 4
      LEFT JOIN properties props      ON props.id     = upo.item_id AND upo.entitie_id = 1
      LEFT JOIN watches watches       ON watches.id   = upo.item_id AND upo.entitie_id = 2
      LEFT JOIN yachts yachts         ON yachts.id    = upo.item_id AND upo.entitie_id = 3
      LEFT JOIN lifestyles life       ON life.id      = upo.item_id AND upo.entitie_id = 5

      WHERE upo.stripe_session_id = ?
      LIMIT 1
      `,
      [sessionId]
    );

    if (!orderRec) {
      console.log('   ✖ Bestellung nicht gefunden – sessionId falsch/leer');
      req.session.errorMessage = await tr(
        req,
        res,
        'buyer.checkout.error.order_not_found',
        'Bestellung nicht gefunden.'
      );
      return res.redirect('/buyer/online');
    }
    console.log('   ✓ Bestellung gefunden:', orderRec.order_id);

    // 2) Stripe Session prüfen
    console.log('   → Prüfe Stripe Session …');
    const stripeSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (!stripeSession || stripeSession.payment_status !== 'paid') {
      console.log('   ✖ Zahlung nicht abgeschlossen');
      req.session.errorMessage = await tr(
        req,
        res,
        'buyer.checkout.error.payment_not_completed',
        'Zahlung nicht abgeschlossen.'
      );
      return res.redirect('/buyer/online');
    }

    // 3) Status aktualisieren
    if (orderRec.status !== 'paid') {
      console.log('   → aktualisiere user_package_orders.status = paid');
      await db.query(
        `UPDATE user_package_orders SET status='paid' WHERE id=?`,
        [orderRec.order_id]
      );
    }

    // 3b) Placement automatisch in die richtige Ads-Tabelle schreiben
    const placementTableMap = {
      slideshow: 'slider_ads',
      top_listing: 'advert_inserat',
      sonstiges: 'catalog_ads'
    };
    const placementTable =
      orderRec.placement_table ||
      placementTableMap[orderRec.package_category] ||
      null;

    const allowedPlacementTables = new Set(['catalog_ads', 'advert_inserat', 'slider_ads']);
    if (placementTable && allowedPlacementTables.has(placementTable)) {
      const placementStart = moment(orderRec.start_date).format('YYYY-MM-DD');
      const placementEnd = moment(orderRec.end_date).format('YYYY-MM-DD');

      const [[exists]] = await db.query(
        `SELECT id
           FROM \`${placementTable}\`
          WHERE entitie_id = ?
            AND advert_id  = ?
            AND start_date = ?
            AND end_date   = ?
          LIMIT 1`,
        [orderRec.entitie_id, orderRec.item_id, placementStart, placementEnd]
      );

      if (!exists) {
        await db.query(
          `INSERT INTO \`${placementTable}\`
            (entitie_id, advert_id, start_date, end_date)
           VALUES (?,?,?,?)`,
          [orderRec.entitie_id, orderRec.item_id, placementStart, placementEnd]
        );
        console.log(`   ✓ Placement eingetragen in ${placementTable}`);
      } else {
        console.log(`   ↪ Placement existiert bereits in ${placementTable}`);
      }
    } else {
      console.warn('   ⚠️ Keine gültige Placement-Tabelle gefunden:', placementTable);
    }

    // 4) Nur orders_user_packages verwenden (kein orders/payments-Insert)
    console.log('   → Speichere orders_user_packages …');
    await db.query(
      `
      INSERT INTO orders_user_packages (
        user_id,
        user_package_id,
        product,
        duration_weeks,
        price_cents,
        country_id,
        vatid,
        tax_rate,
        firstname,
        lastname,
        company,
        street,
        housenumber,
        postcode,
        city,
        phone,
        email,
        stripe_session_id,
        payment_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `,
      [
        orderRec.user_id,
        orderRec.user_package_id,
        orderRec.product,
        orderRec.duration_weeks,
        orderRec.price_cents,
        orderRec.country_id,
        orderRec.partner_atu_nummer,
        orderRec.country_tax_rate,

        orderRec.partner_first_name,
        orderRec.partner_last_name,
        orderRec.partner_firmenname,

        orderRec.street,
        orderRec.housenumber,
        orderRec.postcode,
        orderRec.city,

        orderRec.phone || null,
        orderRec.partner_email,

        sessionId,
        'paid'
      ]
    );

    // Die neue Order-ID holen wir ab:
    const [[lastOrder]] = await db.query(`SELECT LAST_INSERT_ID() AS oid`);
    orderRec.order_number = lastOrder.oid;  // Wichtig für die Rechnung!


    // 6) Steuer bestimmen
    const taxPercentage = orderRec.partner_atu_nummer ? 0 : orderRec.country_tax_rate;
    orderRec.taxPercentage = taxPercentage;

    // 7) Rechnung generieren
    console.log('   → Generiere Rechnung …');
        // 🌍 Sprachdaten für PDF-Rechnung
    orderRec.locale = locale;

    // 🏎 Entität übersetzen
    orderRec.entity_key = `entity.${orderRec.entity_route || 'default'}`;

    // 🎁 Paketname übersetzen
    orderRec.package_key = `package.${orderRec.product.toLowerCase().replace(/ /g,'_').replace(/-/g,'_')}`;

    // 📌 Anzeige-Titel Key
    orderRec.ad_key = 'invoice.ad';

    // 🔢 Rechnungsnummer/Ordernummer formatiert
    orderRec.invoice_code = `${orderRec.partner_country_code}-${orderRec.order_number}`;
    orderRec.order_id_txt = `${orderRec.order_number}`;

    return generateInvoice(orderRec, async (err, pdfBytes) => {
      if (err) {
        const relPath = (process.env.INVOICE_TEMPLATE_PATH || 'public/assets/pdf/vorlage.pdf').trim();
        const normalizedRel = relPath.startsWith('public/') ? relPath : `public/${relPath}`;
        const templatePath = path.resolve(process.cwd(), normalizedRel);
        console.error('   ✖ PDF Fehler, aber Zahlung erfolgreich:', {
          message: err?.message,
          templatePath,
          templateExists: fs.existsSync(templatePath)
        });
        if (err?.stack) console.error(err.stack);
        req.session.successMessage = 'Upgrade erfolgreich (Rechnung konnte nicht erstellt werden).';
        return res.redirect('/buyer/online');
      }

      // Datei speichern
      const outDir = path.join(__dirname, '../../public/assets/pdf/invoices');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// 🧾 PDF OK → speichern & Mail versenden
const filename = `rechnung_${orderRec.order_number}.pdf`;
fs.writeFileSync(path.join(outDir, filename), pdfBytes);

// 📧 MULTILANGUAGE EMAIL AN KUNDEN
await transporter.sendMail({
  from: `"Herando A.S." <accounting@herando.com>`,
  to: orderRec.partner_email,
  subject: subjectTxt.replace('{{id}}', orderRec.order_number),
  html: `
  <div style="font-family: Arial, sans-serif; background-color: #f6f6f6; padding: 20px;">
    <div style="max-width: 600px; background: #ffffff; margin: auto; padding: 30px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">

      <p style="font-size: 15px; color: #333;">
        ${greet.replace('{{firstname}}', orderRec.partner_first_name || '').replace('{{lastname}}', orderRec.partner_last_name || '')}
      </p>

      <p style="font-size: 15px; color: #333;">
        ${confirm}
      </p>

      <p style="font-size: 15px; color: #333;">
        ${attached.replace('{{id}}', orderRec.order_number)}
      </p>

      <p style="font-size: 15px; color: #333;">
        ${questions}
      </p>

      <p style="margin-top: 25px; font-size: 15px; color: #333;">
        ${regards}<br><strong>${team}</strong>
      </p>

      <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

      <p style="font-size: 12px; color: #777; text-align: center;">
        ${autogenerated}
      </p>
    </div>
  </div>
  `,
  attachments: [
    {
      filename,
      path: path.join(outDir, filename)
    }
  ]
});

// 📧 ADMIN MAIL (i18n)
const upgradeAdminSubject = fillTpl(
  await tr(req, res, 'buyer.upgrade.admin.subject', 'Neue Upgrade-Zahlung - Rechnung Nr. {{id}}'),
  { id: orderRec.order_number }
);
const upgradeAdminTitle = fillTpl(
  await tr(req, res, 'buyer.upgrade.admin.title', 'Neue Upgrade-Zahlung - Rechnung Nr. {{id}}'),
  { id: orderRec.order_number }
);
const upgradeAdminCustomerLabel = await tr(req, res, 'buyer.upgrade.admin.customer_label', 'Kunde');
const upgradeAdminEmailLabel = await tr(req, res, 'buyer.upgrade.admin.email_label', 'E-Mail');
const upgradeAdminProductLabel = await tr(req, res, 'buyer.upgrade.admin.product_label', 'Produkt');
const upgradeAdminInvoiceLabel = await tr(req, res, 'buyer.upgrade.admin.invoice_label', 'Rechnungsnummer');
const upgradeAdminAmountLabel = await tr(req, res, 'buyer.upgrade.admin.amount_label', 'Betrag');
const upgradeAdminTimeLabel = await tr(req, res, 'buyer.upgrade.admin.time_label', 'Zeitpunkt');
const upgradeAdminAttachment = await tr(req, res, 'buyer.upgrade.admin.attachment_note', 'Die PDF-Rechnung ist im Anhang beigefügt.');
const upgradeAdminSystemNote = await tr(req, res, 'buyer.upgrade.admin.system_note', 'Automatische Systembenachrichtigung');

await transporter.sendMail({
  from: `"Herando System" <${process.env.SMTP_USER}>`,
  to: "accounting@herando.com",
  subject: upgradeAdminSubject,
  html: `
  <!DOCTYPE html>
  <html lang="${locale}">
  <head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: Arial, sans-serif; background:#fafafa; padding:0; margin:0; }
    .box { max-width:650px; margin:25px auto; background:#fff; padding:25px;
          border-radius:8px; border:1px solid #eee; }
    p { color:#333; font-size:14px; line-height:1.6; }
  </style>
  </head>

  <body>
  <div class="box">
    <p><strong>${upgradeAdminTitle}</strong></p>

    <p>
      ${upgradeAdminCustomerLabel}: <strong>${orderRec.partner_first_name} ${orderRec.partner_last_name}</strong><br>
      ${upgradeAdminEmailLabel}: ${orderRec.partner_email}<br>
      ${upgradeAdminProductLabel}: <strong>${orderRec.product}</strong><br>
      ${upgradeAdminInvoiceLabel}: <strong>${orderRec.order_number}</strong><br>
      ${upgradeAdminAmountLabel}: <strong>${orderRec.amount} EUR</strong><br>
      ${upgradeAdminTimeLabel}: ${new Date().toLocaleString()}
    </p>

    <p>${upgradeAdminAttachment}</p>

    <p>- ${upgradeAdminSystemNote}</p>
  </div>
  </body>
  </html>
  `,
  attachments: [
    {
      filename: `rechnung_${orderRec.order_number}.pdf`,
      path: path.join(outDir, `rechnung_${orderRec.order_number}.pdf`)
    }
  ]
});

console.log('   ✓ Upgrade vollständig abgeschlossen');
req.session.successMessage = 'Upgrade erfolgreich durchgeführt!';
return res.redirect('/buyer/online');

    });

  } catch (err) {
    console.error('🔥 Fehler in GET /buyer/upgrade/success:', err);
    next(err);
  }
});


router.get('/upgrade/cancel', ensureAuthenticated, async (req, res, next) => {
  try {
    // Optional könnt ihr hier die Bestellung auf 'canceled' setzen,
    // sobald ihr client_reference_id oder session_id übergebt.
    // Fürs Erste genügt eine Fehlermeldung:
    req.session.errorMessage = 'Der Kauf wurde abgebrochen.';
    return res.redirect('/buyer/online');
  } catch (err) {
    next(err);
  }
});

router.get('/upgrade/:itemId', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const itemId = parseInt(req.params.itemId, 10);

    // --- 1) USER LADEN ------------------------------------------------------
    const [[user]] = await db.query(
      `SELECT id, firstname, lastname, email 
         FROM users 
        WHERE id = ?`,
      [userId]
    );
    if (!user) return res.redirect('/auth/login');

    // --- 2) ENTITIES LADEN UND RICHTIGE TABELLE FÜR DAS INSERAT FINDEN -----
    const [entities] = await db.query(`SELECT id, table_name FROM ententies`);

    let entitieId = null;
    let tableName = null;

    for (const ent of entities) {
      const [[found]] = await db.query(
        `SELECT 1 AS ok FROM \`${ent.table_name}\` WHERE id = ? LIMIT 1`,
        [itemId]
      );

      if (found) {
        entitieId = ent.id;
        tableName = ent.table_name;
        break;
      }
    }

    if (!entitieId) {
      req.session.errorMessage = 'Inserat nicht gefunden.';
      return res.redirect('/buyer/online');
    }

    // --- 4) USER-PACKAGES LADEN (VERFÜGBARE UPGRADE-PAKETE) ----------------
    const [packages] = await db.query(`
      SELECT id, name, category, duration_weeks, price_cents
        FROM users_packages
       ORDER BY FIELD(category, 'top_listing','slideshow','sonstiges'), duration_weeks
    `);

    // --- 5) SEO LADEN -------------------------------------------------------
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT 
        title,
        description AS meta_description,
        robots,
        og_title,
        og_description,
        og_image,
        twitter_card,
        jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Upgrade buchen – Herando',
      meta_description: seoRow?.meta_description || 'Buchen Sie ein Upgrade für Ihr Inserat.',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || seoRow?.title || null,
      og_description: seoRow?.og_description || seoRow?.meta_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };
    res.locals.seo = seo;

    // --- 6) RENDERN ---------------------------------------------------------
    return res.render('pages/templates/upgrade', {
      user,
      userId,
      entitieId,
      itemId,
      packages,
      seo,
      currentPage: 'online'
    });

  } catch (err) {
    console.error('🔥 Fehler in GET /buyer/upgrade/:itemId:', err);
    next(err);
  }
});

function asInt(v){ const n = Number(v); return Number.isInteger(n) ? n : null; }
const SUPPORT_USER_ID = asInt(process.env.SUPPORT_USER_ID);


router.get('/sold', ensureAuthenticated, async (req, res, next) => {
  try {
    let locale = req.locale || req.session?.lang || req.acceptsLanguages()?.[0] || 'de';
    if (locale.includes('-')) locale = locale.split('-')[0];
    console.log("🌍 LOCALE USED (SOLD):", locale);

    const userId = asInt(req.session.userId);
    if (!userId) return res.redirect('/auth/login');

    // 👤 Benutzer laden
    const [[user]] = await db.query(`
      SELECT 
        id, role, firstname, lastname, email,
        company, vatid, street, housenumber, postcode,
        city, country_id, phone, mobile, fax,
        flatrate_test, flatrate_all, flatrate_cars, flatrate_properties,
        flatrate_watches, flatrate_yachts, flatrate_investments
      FROM users
      WHERE id = ?
    `, [userId]);

    if (!user) return res.redirect('/auth/login');

    console.log(`🧠 Buyer/Sold aufgerufen von User ID=${user.id}, Role=${user.role}`);

    // 🏷 Rolle → Registrierungstyp
    let registrationType = (user.role === 1 || user.role === 9) ? 'commercial' :
                           (user.role === 2 || user.role === 9) ? 'private' : null;

    if (!registrationType) {
      return res.render('pages/templates/buyer-sold', {
        user,
        packages: [],
        seo: {},
        registrationType: null,
        headerTitle: await tr(req, res, 'buyer.card.sell.title', 'Verkaufen'),
        login_user: req.user,
        currentUrl: req.url,
        currentPage: 'sold',
        privatePackages: [],
        commercialPackages: { LIGHT: [], PRO: [], PREMIUM: [] }
      });
    }

    // 📦 Passende Pakete anzeigen
const [packages] = await db.query(`
  SELECT 
    p.id,
    p.name,
    p.price,
    p.registration_type,
    t.\`${locale}\` AS translated_description
  FROM packages p
  LEFT JOIN ui_translations t
    ON t.key = CONCAT('package.', REPLACE(p.id, '-', '_'))
  WHERE p.registration_type = ?
  ORDER BY p.sort_order
`, [registrationType]);





    // 🌐 SEO laden
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT 
        title,
        description AS meta_description,
        robots,
        og_title,
        og_description,
        og_image,
        twitter_card,
        jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description: seoRow?.meta_description || 'Entdecken Sie exklusive Angebote.',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || seoRow?.title || null,
      og_description: seoRow?.og_description || seoRow?.meta_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };
    res.locals.seo = seo;

    // 🎟 Aktive Marketing-Pakete
    const [activePackages] = await db.query(`
      SELECT 
        sp.category_id,
        sp.package_id,
        p.name AS package_name,
        p.registration_type
      FROM selected_packages sp
      JOIN packages p ON p.id = sp.package_id
      WHERE sp.user_id = ?
        AND sp.end_date > NOW()
    `, [userId]);

    // 📌 Kategorienamen holen
    const [entities] = await db.query(`SELECT id, name, route FROM ententies`);
    const CATEGORY_MAP = Object.fromEntries(
      entities.map(e => [e.id, { name: e.name, route: e.route }])
    );

    // 🧊 Paket-Gruppierung
    const privatePackages = [];
    const commercialPackages = { LIGHT: [], PRO: [], PREMIUM: [] };

    for (const pkg of activePackages) {
      const categoryInfo = CATEGORY_MAP[pkg.category_id] || null;
      const categoryName =
        categoryInfo?.route ||
        categoryInfo?.name ||
        `Kategorie ${pkg.category_id}`;
      const pkgName = pkg.package_name.toLowerCase();

      if (pkg.registration_type === 'private') {
        privatePackages.push(categoryName);
      } else {
        if (pkgName.includes('light')) commercialPackages.LIGHT.push(categoryName);
        else if (pkgName.includes('pro')) commercialPackages.PRO.push(categoryName);
        else if (pkgName.includes('premium')) commercialPackages.PREMIUM.push(categoryName);
      }
    }

    // ✅ Rendern
    return res.render('pages/templates/buyer-sold', {
      user,
      packages,
      seo,
      registrationType,
      headerTitle: await tr(req, res, 'buyer.card.sell.title', 'Verkaufen'),
      currentPage: 'sold',
      login_user: req.user,
      currentUrl: req.url,
      privatePackages,
      commercialPackages
    });

  } catch (err) {
    console.error('❌ Fehler in /buyer/sold:', err);
    next(err);
  }
});


router.get('/sell', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = asInt(req.session.userId);
    if (!userId) return res.redirect('/auth/login');

    // 👤 User-Daten abrufen
    const [[user]] = await db.query(`
      SELECT 
        id, role, firstname, lastname, email,
        company, vatid, street, housenumber, postcode,
        city, country_id, phone, mobile, fax,
        flatrate_test, flatrate_all, flatrate_cars, flatrate_properties,
        flatrate_watches, flatrate_yachts, flatrate_investments
      FROM users
      WHERE id = ?
    `, [userId]);

    if (!user) {
      console.log('❌ Kein Benutzer gefunden – redirect /auth/login');
      return res.redirect('/auth/login');
    }

    console.log(`🧠 Buyer/Sell aufgerufen von User ID=${user.id}, Role=${user.role}`);

    // 🧩 Rolle zu Registrierungstyp
    let registrationType = null;
    if (user.role === 1) registrationType = 'commercial';
    else if (user.role === 2) registrationType = 'private';
    else {
      console.log(`⚠️ Unbekannte Rolle (${user.role}) – keine Pakete geladen`);
      return res.render('pages/templates/buyer-sell', {
        user,
        packages: [],
        seo: {},
        registrationType: null,
        headerTitle: await tr(req, res, 'buyer.sell.title', 'Kaufen'),
        message: await tr(req, res, 'buyer.packages.none', 'Keine passenden Pakete gefunden.'),
        login_user: req.user,
        currentUrl: req.url,
        currentPage: 'sell'
      });
    }

    const [packages] = await db.query(`
      SELECT id, name, description, price, registration_type
      FROM packages
      WHERE registration_type = ?
      ORDER BY sort_order
    `, [registrationType]);

    console.log(`✅ ${packages.length} Pakete für Typ "${registrationType}" gefunden.`);

    // 🌐 SEO-Metadaten abrufen
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT 
        title,
        description AS meta_description,
        robots,
        og_title,
        og_description,
        og_image,
        twitter_card,
        jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title:                seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || seoRow?.title || null,
      og_description:       seoRow?.og_description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };

    // 📡 In locals speichern, damit header.ejs Zugriff hat
    res.locals.seo = seo;

    // 🧾 Seite rendern
    return res.render('pages/templates/buyer-sell', {
      user,
      packages,
      seo,
      registrationType,
      headerTitle: await tr(req, res, 'buyer.sell.title', 'Kaufen'),
      currentPage: 'sell',
      login_user: req.user,
      currentUrl: req.url
    });

  } catch (err) {
    console.error('❌ Fehler in /buyer/sell:', err);
    next(err);
  }
});


router.get("/profil", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.redirect("/login");
    const locale = resolveLang(req, res);
    const countryCol = UI_LANG_COLS.includes(locale) ? locale : 'en';

    // 👤 User & Land laden
    const [rows] = await db.query(`
      SELECT u.*, COALESCE(c.\`${countryCol}\`, c.en, c.de) AS country_name
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE u.id = ?
    `, [userId]);
    const user = rows[0];
    if (!user) {
      return res.status(404).send(await tr(req, res, 'buyer.profile.error.not_found', 'Benutzer nicht gefunden'));
    }

    // 🧾 Rechnungen
    const [invoices] = await db.query(`
      SELECT 
        o.id AS bestell_id,
        o.created_at,
        p.name AS product_name,
        pm.amount AS amount,
        pm.status AS payment_status,
        CONCAT('/assets/pdf/invoices/invoice_', o.id, '.pdf') AS pdf_path
      FROM orders o
      JOIN payments pm ON pm.order_id = o.id AND pm.status = 'paid'
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
    `, [userId]);


    // 📦 Aktive Marketing-Pakete
      const [activePackages] = await db.query(`
        SELECT 
          sp.id AS selected_package_id,
          sp.category_id,
          sp.package_id,
          sp.end_date,
          sp.max_listings,
          sp.used_listings,
          sp.order_id,
          p.name AS package_name,
          p.registration_type,
          e.name AS entity_name,

          (
            SELECT COUNT(*) 
            FROM cancellations c 
            WHERE c.selected_package_id = sp.id
          ) AS cancellation_exists

        FROM selected_packages sp
        JOIN packages p ON p.id = sp.package_id
        LEFT JOIN ententies e ON e.id = sp.category_id

        -- WICHTIG !!!
        JOIN orders o ON o.id = sp.order_id
        JOIN payments pm ON pm.order_id = o.id AND pm.status = 'paid'

        WHERE sp.user_id = ?
          AND sp.end_date > NOW()

        ORDER BY sp.end_date DESC
      `, [userId]);


    // Kategorien holen
    const [entities] = await db.query(`SELECT id, name FROM ententies`);
    const CATEGORY_MAP = Object.fromEntries(entities.map(e => [e.id, e.name]));

    const today = new Date();
    activePackages.forEach(p => {
      const end = new Date(p.end_date);
      p.categoryName = CATEGORY_MAP[p.category_id] || "Unbekannt";
      p.restDays = Math.max(0, Math.ceil((end - today) / (1000 * 60 * 60 * 24)));
      p.end_date_str = end.toISOString().slice(0, 10); // yyyy-mm-dd
    });
    const cancelablePackages = activePackages.filter(p => p.cancellation_exists == 0);

      // 🌍 Länder für Select laden
      const [countries] = await db.query(`
        SELECT id, de AS name
        FROM countries
        ORDER BY de
      `);



    res.render("pages/templates/profile", {
      user,
      invoices,
      countries,
      activePackages: cancelablePackages,
      headerTitle: "Mein Profil",
      login_user: req.user,
      currentUrl: req.url,
      currentPage: "profile",
      seo: {
        title: "Mein Profil | Herando",
        meta_description: "Verwalten Sie Ihre Profildaten, Kontaktinformationen und Rechnungen.",
        robots: "noindex, follow"
      },
      success: req.query.success || null,
      error: req.query.error || null,
      billingMissing: req.query.billingMissing || null,
      pendingCheckout: req.session.pendingCheckout || null,
    });

  } catch (err) {
    console.error("❌ Fehler beim Laden des Profils:", err);
    res.status(500).send(await tr(req, res, 'buyer.profile.error.load', 'Serverfehler beim Laden des Profils'));
  }
});

router.post("/profil", async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.redirect("/login");

    const {
      firstname,
      lastname,
      street,
      housenumber,
      postcode,
      city,
      country_id,
      phone,
      mobile,
      company,
      vatid,
      website,
      imprint,
    } = req.body;

    await db.query(
      `UPDATE users SET 
        firstname = ?, lastname = ?, street = ?, housenumber = ?, postcode = ?, 
        city = ?, country_id = ?, phone = ?, mobile = ?, company = ?, 
        vatid = ?, website = ?, imprint = ?, modified = NOW()
       WHERE id = ?`,
      [
        firstname,
        lastname,
        street,
        housenumber,
        postcode,
        city,
        country_id,
        phone,
        mobile,
        company,
        vatid,
        website,
        imprint,
        userId,
      ]
    );

    res.redirect("/buyer/profil");
  } catch (err) {
    console.error("❌ Fehler beim Aktualisieren des Profils:", err);
    res.status(500).send(await tr(req, res, 'buyer.profile.error.update', 'Fehler beim Aktualisieren des Profils'));
  }
});

router.post("/profile/update", async (req, res) => {
  const userId = req.user?.id;
  const { type } = req.body;

  if (!userId) {
    return res.redirect("/login");
  }

  console.log("🟢 [PROFILE/UPDATE] User:", userId);
  console.log("📦 Typ:", type);
  console.log("📨 Body:", req.body);

  try {

    /* =========================================================
       🔹 LOGIN (E-Mail + Passwort)
    ========================================================= */
    if (type === "login") {
      const { email, oldPassword, newPassword, confirmPassword } = req.body;

      if (!newPassword || newPassword !== confirmPassword) {
        return res.redirect("/buyer/profil?error=Passwörter stimmen nicht überein.");
      }

      const [[user]] = await db.query(
        "SELECT password FROM users WHERE id = ?",
        [userId]
      );

      if (!user) {
        return res.redirect("/buyer/profil?error=Benutzer nicht gefunden.");
      }

      const valid = await bcrypt.compare(oldPassword, user.password);
      if (!valid) {
        return res.redirect("/buyer/profil?error=Altes Passwort ist falsch.");
      }

      const hashed = await bcrypt.hash(newPassword, 10);

      await db.query(
        "UPDATE users SET email = ?, password = ?, modified = NOW() WHERE id = ?",
        [email, hashed, userId]
      );

      return res.redirect("/buyer/profil?success=Login-Daten aktualisiert.");
    }

    /* =========================================================
       🔹 PERSON + RECHNUNGSADRESSE (KOMBI)
    ========================================================= */
    if (type === "person_billing") {
      const {
        gender,
        firstname,
        lastname,
        phone,
        mobile,
        fax,
        company,
        vatid,
        street,
        housenumber,
        postcode,
        city,
        country_id,
        website,
        imprint
      } = req.body;

      const [result] = await db.query(
        `UPDATE users SET
          gender       = ?,
          firstname    = ?,
          lastname     = ?,
          phone        = ?,
          mobile       = ?,
          fax          = ?,
          company      = ?,
          vatid        = ?,
          street       = ?,
          housenumber  = ?,
          postcode     = ?,
          city         = ?,
          country_id   = ?,
          website      = ?,
          imprint      = ?,
          modified     = NOW()
        WHERE id = ?`,
        [
          gender || null,
          firstname || null,
          lastname || null,
          phone || null,
          mobile || null,
          fax || null,
          company || null,
          vatid || null,
          street || null,
          housenumber || null,
          postcode || null,
          city || null,
          country_id || null,
          website || null,
          imprint || null,
          userId
        ]
      );

      if (!result.affectedRows) {
        return res.redirect("/buyer/profil?error=Profil konnte nicht gespeichert werden.");
      }

      if (req.body.resumeCheckout === '1') {
        return res.redirect("/buyer/checkout/resume");
      }

      return res.redirect("/buyer/profil?success=Profil erfolgreich aktualisiert.");
    }

    /* =========================================================
       ❌ UNBEKANNTER TYP
    ========================================================= */
    console.warn("⚠️ Unbekannter Update-Typ:", type);
    return res.redirect("/buyer/profil?error=Ungültiger Update-Typ.");

  } catch (err) {
    console.error("💥 PROFILE UPDATE ERROR:", err);
    return res.redirect("/buyer/profil?error=Serverfehler beim Speichern.");
  }
});


router.post("/profil/cancel-package", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.redirect("/login");

  const {
    selected_package_id,
    reason,
    otherReason,
    termination_date_type,
    manualTerminationDate,
  } = req.body;

  try {
    // 🔥 User vollständig laden
    const [[userInfo]] = await db.query(
      `
      SELECT 
        u.id, u.firstname, u.lastname, u.email,
        u.street, u.housenumber, u.city, u.postcode,
        c.de AS country_name
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE u.id = ?
      `,
      [userId]
    );

    if (!userInfo) {
      return res.redirect("/buyer/profil?error=Benutzer nicht gefunden.");
    }

    // 🔥 Paket + Kategorie/Entität laden
    const [rows] = await db.query(
      `
      SELECT 
        sp.*,
        p.name AS package_name,
        p.registration_type,
        e.name AS entity_name
      FROM selected_packages sp
      JOIN packages p ON p.id = sp.package_id
      LEFT JOIN ententies e ON e.id = sp.category_id
      WHERE sp.id = ?
        AND sp.user_id = ?
        AND sp.end_date > NOW()
      `,
      [selected_package_id, userId]
    );

    if (!rows.length) {
      return res.redirect("/buyer/profil?error=Ungültiges Paket.");
    }

    const sp = rows[0];

    if (sp.registration_type !== "commercial") {
      return res.redirect("/buyer/profil?error=Privates Paket kann nicht gekündigt werden.");
    }

    // 🔥 Kündigungsdatum
    const terminationDate =
      termination_date_type === "manual" && manualTerminationDate
        ? manualTerminationDate
        : sp.end_date.toISOString().slice(0, 10);

    const finalReason =
      reason === "other" && otherReason ? otherReason : reason || null;

    // 🔥 Eintrag speichern
    const [insertResult] = await db.query(
      `
      INSERT INTO cancellations
      (selected_package_id, user_id, package_id, order_id, reason, termination_type, termination_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')
      `,
      [
        sp.id,
        userId,
        sp.package_id,
        sp.order_id,
        finalReason,
        termination_date_type === "manual" ? "manual" : "nextPossible",
        terminationDate,
      ]
    );

    const cancellationId = insertResult.insertId;

    // ------------------------------------------------------
    // 📄 PDF GENERIEREN
    // ------------------------------------------------------
    const templatePath = path.join(process.cwd(), "public", "assets", "pdf", "vorlage.pdf");
    const existingPdfBytes = fs.readFileSync(templatePath);

    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    pdfDoc.setTitle("Herando Kuendigung");
    pdfDoc.setSubject("Kuendigung");
    pdfDoc.setAuthor("Herando");
    pdfDoc.setCreator("Herando Buyer Service");
    pdfDoc.setProducer("Herando");
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const [page] = pdfDoc.getPages();

    // Positionen aus Rechnungs-PDF übernommen
    const pageWidth = page.getWidth();
    const labelX = pageWidth - 200;
    const valueX = labelX + 110;
    const baseY = 672;
    const lineSpacing = 10;
    const recipientX = 76;

    const asText = (v) => (v == null ? "" : String(v));

    // 🔹 Datum
    page.drawText("Kündigungsdatum:", { x: labelX + 12.5, y: baseY, size: 8, font });
    page.drawText(new Date().toLocaleDateString("de-DE"), {
      x: valueX,
      y: baseY,
      size: 8,
      font,
    });

    // 🔹 Kundennummer
    const customerY = baseY - lineSpacing;
    page.drawText("Kundennummer:", { x: labelX + 12.5, y: customerY, size: 8, font });
    page.drawText(String(userId), { x: valueX, y: customerY, size: 8, font });

    // 🔹 Adresse wie Rechnung
    let recipientY = baseY - 30;
    page.drawText(`${userInfo.firstname} ${userInfo.lastname}`, {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });
    recipientY -= 13;
    page.drawText(`${userInfo.street} ${userInfo.housenumber}`, {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });
    recipientY -= 13;
    page.drawText(`${userInfo.postcode} ${userInfo.city}`, {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });
    recipientY -= 13;
    page.drawText(userInfo.country_name, {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });

    // 🔥 KÜNDIGUNGSTEIL – WEITER UNTEN
    recipientY -= 90;

    page.drawText("Kündigungsbestätigung", {
      x: recipientX,
      y: recipientY,
      size: 14,
      font,
    });

    recipientY -= 25;
    page.drawText("Hiermit bestätigen wir die Kündigung Ihres Marketing-Pakets:", {
      x: recipientX,
      y: recipientY,
      size: 11,
      font,
    });

    recipientY -= 20;
    page.drawText(`Paket: ${sp.package_name}`, {
      x: recipientX,
      y: recipientY,
      size: 11,
      font,
    });

    recipientY -= 15;
    page.drawText(`Kategorie / Entität: ${sp.entity_name || "-"}`, {
      x: recipientX,
      y: recipientY,
      size: 11,
      font,
    });

    recipientY -= 15;
    page.drawText(`Kündigungsdatum: ${terminationDate}`, {
      x: recipientX,
      y: recipientY,
      size: 11,
      font,
    });

    if (finalReason) {
      recipientY -= 20;
      page.drawText(`Grund: ${finalReason}`, {
        x: recipientX,
        y: recipientY,
        size: 11,
        font,
      });
    }

    // ✨ Neuer Abschluss
    recipientY -= 40;
    page.drawText("Nur bei Fragen stehen wir gerne zur Verfügung.", {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });

    recipientY -= 40;
    page.drawText("Mit freundlichen Grüßen", {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });

    recipientY -= 15;
    page.drawText("Ihr Marketing-Team von Herando", {
      x: recipientX,
      y: recipientY,
      size: 10,
      font,
    });

    // PDF speichern
    const pdfBytes = await pdfDoc.save();

    const pdfDir = path.join(process.cwd(), "public", "assets", "pdf", "cancellations");
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

    const pdfFilename = `cancellation_${cancellationId}.pdf`;
    const pdfPath = path.join(pdfDir, pdfFilename);
    fs.writeFileSync(pdfPath, pdfBytes);

    const publicPdfPath = `https://herando.at/assets/pdf/cancellations/${pdfFilename}`;

    await db.query("UPDATE cancellations SET pdf_path = ? WHERE id = ?", [
      publicPdfPath,
      cancellationId,
    ]);

    // ------------------------------------------------------
    // 📧 EMAIL
    // ------------------------------------------------------
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const cancelSubject = await tr(req, res, 'buyer.cancel.mail.subject', 'Bestätigung Ihrer Kündigung Ihres Marketing-Pakets');
    const cancelGreeting = fillTpl(
      await tr(req, res, 'buyer.cancel.mail.greeting', 'Sehr geehrte/r {{firstname}} {{lastname}},'),
      { firstname: userInfo.firstname || '', lastname: userInfo.lastname || '' }
    );
    const cancelIntro = await tr(req, res, 'buyer.cancel.mail.intro', 'Wir bestätigen den Eingang Ihrer Kündigung für das folgende Marketing-Paket:');
    const cancelPackageLabel = await tr(req, res, 'buyer.cancel.mail.package_label', 'Paket');
    const cancelRuntimeLabel = await tr(req, res, 'buyer.cancel.mail.runtime_until_label', 'Laufzeit bis');
    const cancelDateLabel = await tr(req, res, 'buyer.cancel.mail.termination_date_label', 'Kündigungsdatum');
    const cancelTypeLabel = await tr(req, res, 'buyer.cancel.mail.termination_type_label', 'Kündigungsart');
    const cancelTypeManual = await tr(req, res, 'buyer.cancel.mail.termination_type_manual', 'Manuell gewähltes Datum');
    const cancelTypeNext = await tr(req, res, 'buyer.cancel.mail.termination_type_next', 'Nächstmöglicher Kündigungstermin');
    const cancelReasonLabel = await tr(req, res, 'buyer.cancel.mail.reason_label', 'Kündigungsgrund');
    const cancelEffect = await tr(req, res, 'buyer.cancel.mail.effect_text', 'Ihre Kündigung wird automatisch zum oben genannten Datum wirksam. Bis dahin bleibt Ihr Marketing-Paket vollständig aktiv.');
    const cancelPdfIntro = await tr(req, res, 'buyer.cancel.mail.pdf_intro', 'Die Bestätigung als PDF-Dokument finden Sie hier:');
    const cancelPdfLink = await tr(req, res, 'buyer.cancel.mail.pdf_link_label', 'Kündigungs-PDF herunterladen');
    const cancelQuestions = await tr(req, res, 'buyer.cancel.mail.questions', 'Für Rückfragen stehen wir Ihnen jederzeit gerne zur Verfügung.');
    const cancelRegards = await tr(req, res, 'buyer.cancel.mail.regards', 'Mit freundlichen Grüßen');
    const cancelTeam = await tr(req, res, 'buyer.cancel.mail.team', 'Marketingabteilung - Herando');
    const cancelTypeValue = termination_date_type === 'manual' ? cancelTypeManual : cancelTypeNext;

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: userInfo.email,
      subject: cancelSubject,
      html: `
        <p>${cancelGreeting}</p>

        <p>${cancelIntro}</p>

        <ul>
          <li><strong>${cancelPackageLabel}:</strong> ${sp.package_name}</li>
          <li><strong>${cancelRuntimeLabel}:</strong> ${sp.end_date.toISOString().slice(0, 10)}</li>
          <li><strong>${cancelDateLabel}:</strong> ${terminationDate}</li>
          <li><strong>${cancelTypeLabel}:</strong> ${cancelTypeValue}</li>
          ${finalReason ? `<li><strong>${cancelReasonLabel}:</strong> ${finalReason}</li>` : ''}
        </ul>

        <p>${cancelEffect}</p>

        <p>${cancelPdfIntro}</p>
        <p><a href="${publicPdfPath}" target="_blank">${cancelPdfLink}</a></p>

        <br>

        <p>${cancelQuestions}</p>

        <br><br>

        <p>${cancelRegards}<br>
        <strong>${cancelTeam}</strong></p>
      `,
    });


    return res.redirect("/buyer/profil?success=Kündigung erfolgreich durchgeführt.");

  } catch (err) {
    console.error("💥 Fehler bei Kündigung:", err);
    return res.redirect("/buyer/profil?error=Fehler bei der Kündigung.");
  }
});

router.post("/profil/cancel-support", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.redirect("/login");

  const { firstname, lastname, email, phone, message } = req.body;

  try {
    console.log("📩 [CANCEL SUPPORT] Anfrage erhalten");
    console.log("📌 Eingehende Daten:", { firstname, lastname, email, phone });

    // -----------------------------------------------------
    // 📦 IN DB SPEICHERN
    // -----------------------------------------------------
    await db.query(
      `
      INSERT INTO cancel_support_requests
      (user_id, firstname, lastname, email, phone, message)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [userId, firstname, lastname, email, phone, message]
    );

    console.log("💾 DB-Eintrag erfolgreich gespeichert!");


    // -----------------------------------------------------
    // 📬 SMTP Einstellungen wie bei Kündigung!
    // -----------------------------------------------------
    console.log("📨 SMTP-Transporter initialisieren…");
    console.log("📨 SMTP_ENV:", {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      SMTP_FROM: process.env.SMTP_USER,
      ADMIN_EMAIL: process.env.ADMIN_EMAIL,
      ADMIN_CC: process.env.ADMIN_CC,
    });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // SMTP testen
    try {
      console.log("🔌 Teste SMTP Verbindung…");
      await transporter.verify();
      console.log("🔌 SMTP erfolgreich verbunden!");
    } catch (smtpErr) {
      console.error("❌ SMTP Verbindung fehlgeschlagen:", smtpErr);
    }

    // -----------------------------------------------------
    // 📧 E-Mail an Admin
    // -----------------------------------------------------
    if (process.env.ADMIN_EMAIL) {
      console.log("📬 Sende Support-Mail an Admin…");

      try {
        const supportSubject = await tr(req, res, 'buyer.cancel_support.admin.subject', 'Supportanfrage vor Kündigung - Kunde benötigt Rückmeldung');
        const supportGreeting = await tr(req, res, 'buyer.cancel_support.admin.greeting', 'Sehr geehrtes Herando-Supportteam,');
        const supportIntro = await tr(req, res, 'buyer.cancel_support.admin.intro', 'Ein Kunde hat vor der Kündigung ausdrücklich eine Rückmeldung gewünscht.');
        const supportDetails = await tr(req, res, 'buyer.cancel_support.admin.customer_details', 'Kundendetails:');
        const supportUserIdLabel = await tr(req, res, 'buyer.cancel_support.admin.user_id_label', 'User-ID');
        const supportNameLabel = await tr(req, res, 'buyer.cancel_support.admin.name_label', 'Name');
        const supportEmailLabel = await tr(req, res, 'buyer.cancel_support.admin.email_label', 'E-Mail');
        const supportPhoneLabel = await tr(req, res, 'buyer.cancel_support.admin.phone_label', 'Telefon');
        const supportPhoneMissing = await tr(req, res, 'buyer.cancel_support.admin.phone_missing', 'Keine Angabe');
        const supportMessageLabel = await tr(req, res, 'buyer.cancel_support.admin.message_label', 'Nachricht des Kunden:');
        const supportContact = await tr(req, res, 'buyer.cancel_support.admin.request_contact', 'Bitte kontaktieren Sie den Kunden zeitnah.');
        const supportRegards = await tr(req, res, 'buyer.cancel_support.admin.regards', 'Mit freundlichen Grüßen');
        const supportSignature = await tr(req, res, 'buyer.cancel_support.admin.signature', 'Herando - Automatisierte Systembenachrichtigung');

        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.ADMIN_EMAIL,
          cc: process.env.ADMIN_CC || "",
          subject: supportSubject,

          html: `
            <p>${supportGreeting}</p>

            <p>${supportIntro}</p>

            <p><strong>${supportDetails}</strong></p>
            <ul>
              <li><strong>${supportUserIdLabel}:</strong> ${userId}</li>
              <li><strong>${supportNameLabel}:</strong> ${firstname} ${lastname}</li>
              <li><strong>${supportEmailLabel}:</strong> ${email}</li>
              <li><strong>${supportPhoneLabel}:</strong> ${phone || supportPhoneMissing}</li>
            </ul>

            <p><strong>${supportMessageLabel}</strong></p>
            <p>${message.replace(/\n/g, "<br>")}</p>

            <br>
            <p>${supportContact}</p>

            <br><br>

            <p>${supportRegards}<br>
            <strong>${supportSignature}</strong></p>
          `,
        });

        console.log("📬 Support-Mail erfolgreich gesendet!");
      } catch (mailErr) {
        console.error("❌ Fehler beim Mailversand:", mailErr);
      }
    } else {
      console.warn("⚠️ ADMIN_EMAIL ist NICHT gesetzt – Mail kann NICHT gesendet werden!");
    }

    return res.redirect("/buyer/profil?success=Supportanfrage gesendet.");
  } catch (err) {
    console.error("💥 Support-Fehler:", err);
    return res.redirect("/buyer/profil?error=Fehler beim Senden der Anfrage.");
  }
});

router.post("/profil/cancel-support", async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.redirect("/login");

  const { firstname, lastname, email, phone, message } = req.body;

  try {
    console.log("📩 [CANCEL SUPPORT] Anfrage erhalten");
    console.log("📌 Eingehende Daten:", { firstname, lastname, email, phone });

    // -----------------------------------------------------
    // DB SPEICHERN
    // -----------------------------------------------------
    console.log("💾 Speichere Anfrage in DB...");

    await db.query(
      `
      INSERT INTO cancel_support_requests
      (user_id, firstname, lastname, email, phone, message)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [userId, firstname, lastname, email, phone, message]
    );

    console.log("💾 DB-Eintrag erfolgreich gespeichert!");


    // -----------------------------------------------------
    // MAIL VORBEREITEN
    // -----------------------------------------------------
    console.log("📨 Initialisiere Mail-Transporter...");

    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT || 587),
      secure: false,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
    });

    console.log("📨 Transporter erstellt!");
    console.log("📨 SMTP-Daten:", {
      MAIL_HOST: process.env.MAIL_HOST,
      MAIL_PORT: process.env.MAIL_PORT,
      MAIL_USER: process.env.MAIL_USER,
      MAIL_FROM: process.env.MAIL_FROM,
      ADMIN_EMAIL: process.env.ADMIN_EMAIL,
      ADMIN_CC: process.env.ADMIN_CC,
    });

    // Prüfen ob Transporter korrekt verbunden werden kann
    try {
      console.log("🔌 SMTP Verbindung testen...");
      await transporter.verify();
      console.log("🔌 SMTP Verbindung erfolgreich!");
    } catch (smtpErr) {
      console.error("❌ SMTP-Test fehlgeschlagen:", smtpErr);
    }

    if (process.env.ADMIN_EMAIL) {
      console.log("📬 Sende Support-Mail an Admin...");

      try {
        const supportSubject = await tr(req, res, 'buyer.cancel_support.admin.subject', 'Supportanfrage vor Kündigung - Kunde benötigt Rückmeldung');
        const supportGreeting = await tr(req, res, 'buyer.cancel_support.admin.greeting', 'Sehr geehrtes Herando-Supportteam,');
        const supportIntro = await tr(req, res, 'buyer.cancel_support.admin.intro', 'Ein Kunde hat vor der Kündigung ausdrücklich eine Rückmeldung gewünscht.');
        const supportDetails = await tr(req, res, 'buyer.cancel_support.admin.customer_details', 'Kundendetails:');
        const supportUserIdLabel = await tr(req, res, 'buyer.cancel_support.admin.user_id_label', 'User-ID');
        const supportNameLabel = await tr(req, res, 'buyer.cancel_support.admin.name_label', 'Name');
        const supportEmailLabel = await tr(req, res, 'buyer.cancel_support.admin.email_label', 'E-Mail');
        const supportPhoneLabel = await tr(req, res, 'buyer.cancel_support.admin.phone_label', 'Telefon');
        const supportPhoneMissing = await tr(req, res, 'buyer.cancel_support.admin.phone_missing', 'Keine Angabe');
        const supportMessageLabel = await tr(req, res, 'buyer.cancel_support.admin.message_label', 'Nachricht des Kunden:');
        const supportContact = await tr(req, res, 'buyer.cancel_support.admin.request_contact', 'Bitte kontaktieren Sie den Kunden zeitnah.');
        const supportRegards = await tr(req, res, 'buyer.cancel_support.admin.regards', 'Mit freundlichen Grüßen');
        const supportSignature = await tr(req, res, 'buyer.cancel_support.admin.signature', 'Herando - Automatisierte Systembenachrichtigung');

        await transporter.sendMail({
          from: process.env.MAIL_FROM,
          to: process.env.ADMIN_EMAIL,
          cc: process.env.ADMIN_CC || "",
          subject: supportSubject,

          html: `
            <p>${supportGreeting}</p>

            <p>${supportIntro}</p>

            <p><strong>${supportDetails}</strong></p>
            <ul>
              <li><strong>${supportUserIdLabel}:</strong> ${userId}</li>
              <li><strong>${supportNameLabel}:</strong> ${firstname} ${lastname}</li>
              <li><strong>${supportEmailLabel}:</strong> ${email}</li>
              <li><strong>${supportPhoneLabel}:</strong> ${phone || supportPhoneMissing}</li>
            </ul>

            <p><strong>${supportMessageLabel}</strong></p>
            <p>${message.replace(/\n/g, "<br>")}</p>

            <br>

            <p>${supportContact}</p>

            <br><br>

            <p>${supportRegards}<br>
            <strong>${supportSignature}</strong></p>
          `,
        });

        console.log("📬 Support-Mail ERFOLGREICH gesendet!");
      } catch (mailErr) {
        console.error("❌ FEHLER beim Senden der Support-Mail:", mailErr);
      }
    } else {
      console.warn("⚠️ ADMIN_EMAIL ist NICHT gesetzt → Mail wird NICHT gesendet!");
    }


    return res.redirect("/buyer/profil?success=Supportanfrage gesendet.");

  } catch (err) {
    console.error("💥 Support-Fehler:", err);
    return res.redirect("/buyer/profil?error=Fehler beim Senden der Anfrage.");
  }
});

router.post(
  '/profile/updatelogo',
  upload.single('logo'),
  async (req, res) => {
    try {
      const userId = req.user.id;

      if (!req.file) {
        return res.redirect('/buyer/profil?error=nofile');
      }

      let ext = req.file.mimetype.split('/')[1]
        .replace('jpeg','jpg')
        .replace('svg+xml','svg');

      const userDir = path.join(imagesPath, 'users', String(userId));
      const fileName = `logo.${ext}`;
      const finalPath = path.join(userDir, fileName);

      // Ordner sicherstellen
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      console.log('📁 Kopiere von:', req.file.path);
      console.log('📁 Nach:', finalPath);

      fs.copyFileSync(req.file.path, finalPath);
      fs.unlinkSync(req.file.path);

      await db.query(
        'UPDATE users SET logo = ? WHERE id = ?',
        [fileName, userId]
      );

      console.log('✅ Logo gespeichert:', finalPath);

      res.redirect('/buyer/profil?success=Logo upload success');

    } catch (err) {
      console.error('❌ Logo Fehler:', err);
      res.redirect('/buyer/profil?error=logo');
    }
  }
);

router.post('/api/profile/logo/delete', async (req, res) => {
  try {
    const userId = req.user.id;
    const fs = require('fs');
    const path = require('path');

    const [[user]] = await db.query(
      'SELECT logo FROM users WHERE id = ?',
      [userId]
    );

    if (user?.logo) {
      const filePath = path.join(
        '/media/herando/images/users',
        String(userId),
        user.logo
      );

      console.log('🗑️ Logo delete path:', filePath);

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('✅ Logo gelöscht');
      } else {
        console.log('❌ Datei nicht gefunden');
      }


      await db.query(
        'UPDATE users SET logo = NULL WHERE id = ?',
        [userId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});





router.get('/messages', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = asInt(req.session.userId);
    if (!userId) return res.redirect('/auth/login');

    const [[user]] = await db.query(
      `SELECT 
         contact, company, vatid, firstname,
         lastname, street, housenumber, postcode,
         city, phone, mobile, fax,
         email, website, 
              flatrate_test,
     flatrate_all,
     flatrate_cars,
     flatrate_properties,
     flatrate_watches,
     flatrate_yachts,
     flatrate_investments
       FROM users
       WHERE id = ?`,
      [userId]
    );

    const [items] = await db.query(
      `SELECT n.id, n.subject, n.body, n.type, n.template_id, n.read_at, n.sent_at,
              s.firstname AS sender_firstname, s.lastname AS sender_lastname, s.email AS sender_email
         FROM user_notifications n
    LEFT JOIN users s ON s.id = n.sender_id
        WHERE n.user_id = ?
     ORDER BY n.sent_at DESC, n.id DESC`,
      [userId]
    );

            // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/messages-list', {
      user,
      items,
      seo,
      currentPage: 'messages',
      headerTitle: await tr(req, res, 'buyer.messages.title', 'Meine Nachrichten'),
      login_user: req.user,
      currentUrl:  req.url
    });
  } catch (err) { next(err); }
});

router.get('/messages/sent', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = asInt(req.session.userId);
    if (!userId) return res.redirect('/auth/login');

    const [[user]] = await db.query(
      'SELECT id, firstname, lastname, email FROM users WHERE id = ?',
      [userId]
    );

    const [items] = await db.query(
      `SELECT n.id, n.subject, n.body, n.type, n.template_id, n.sent_at,
              r.firstname AS receiver_firstname, r.lastname AS receiver_lastname, r.email AS receiver_email
         FROM user_notifications n
         JOIN users r ON r.id = n.user_id
        WHERE n.sender_id = ?
     ORDER BY n.sent_at DESC, n.id DESC`,
      [userId]
    );

        const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/messages-sent', {
      user,
      items,
      currentPage: 'messages',
      headerTitle: await tr(req, res, 'buyer.messages.sent_title', 'Gesendete Nachrichten'),
      login_user: req.user,
      currentUrl: req.url, 
      seo, 
    });
  } catch (err) { next(err); }
});

router.get('/messages/compose', ensureAuthenticated, async (req, res, next) => {
  // kompakter Logger mit Präfix
  const log = (...args) => console.log('[GET /buyer/messages/compose]', ...args);

  try {
    log('--- route entered ---');
    log('req.session.userId (raw)=', req.session.userId, ' typeof=', typeof req.session.userId);
    log('req.query.to (raw)=', req.query?.to, ' typeof=', typeof req.query?.to);
    log('process.env.SUPPORT_USER_ID (raw)=', process.env.SUPPORT_USER_ID);
    log('SUPPORT_USER_ID (asInt)=', SUPPORT_USER_ID);

    const userId   = asInt(req.session.userId);
    const toUserId = asInt(req.query.to);
    log('userId (asInt)=', userId, '  toUserId (asInt)=', toUserId);

    if (!userId) {
      log('ABORT: userId invalid → redirect /auth/login');
      return res.redirect('/auth/login');
    }

    // Kopfbereich-User
    const [[user]] = await db.query(
      'SELECT id, firstname, lastname, email FROM users WHERE id = ?',
      [userId]
    );
    log('Loaded current user =', user ? { id: user.id, email: user.email } : null);

    let receiver = null;

    if (toUserId) {
      log('Receiver path: query.to provided → lookup by ID', toUserId);
      const [[u]] = await db.query(
        'SELECT id, firstname, lastname, email FROM users WHERE id = ?',
        [toUserId]
      );
      receiver = u || null;
      log('Receiver lookup by toUserId result =', receiver ? { id: receiver.id, email: receiver.email } : null);
    } else if (SUPPORT_USER_ID) {
      log('Receiver path: fallback SUPPORT_USER_ID =', SUPPORT_USER_ID);
      const [[u]] = await db.query(
        'SELECT id, firstname, lastname, email FROM users WHERE id = ?',
        [SUPPORT_USER_ID]
      );
      receiver = u || null;
      log('Receiver lookup by SUPPORT_USER_ID result =', receiver ? { id: receiver.id, email: receiver.email } : null);
    } else {
      log('Receiver path: NO toUserId and NO SUPPORT_USER_ID → receiver=null (UI soll Hinweis zeigen)');
    }

    const composeTitle = await tr(req, res, 'buyer.messages.compose', 'Neue Nachricht');
    log('Rendering messages-compose.ejs with:', {
      user: user ? { id: user.id, email: user.email } : null,
      receiver: receiver ? { id: receiver.id, email: receiver.email } : null,
      currentPage: 'messages',
      headerTitle: composeTitle,
      currentUrl: req.url
    });

            const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/messages-compose', {
      user,
      receiver,                  // null ⇒ Formular kann Hinweis zeigen
      currentPage: 'messages',
      headerTitle: composeTitle,
      login_user: req.user,
      currentUrl: req.url, 
      seo, 
    });
  } catch (err) {
    console.error('[GET /buyer/messages/compose] ERROR:', err?.message, err);
    next(err);
  }
});

router.post('/messages/compose', ensureAuthenticated, async (req, res, next) => {
  try {
    const senderId = asInt(req.session.userId);
    const bodyTo   = asInt(req.body.to_user_id);
    const toUserId = bodyTo || SUPPORT_USER_ID || null;
    if (!senderId) return res.redirect('/auth/login');

    const subject = (req.body.subject || '').trim();
    const bodyRaw = (req.body.body    || '').trim();

    if (!toUserId) {
      req.session.errorMessage = 'Kein Empfänger konfiguriert.';
      return res.redirect('/buyer/messages/compose');
    }
    if (!subject || !bodyRaw) {
      req.session.errorMessage = 'Betreff und Nachricht sind erforderlich.';
      return res.redirect(`/buyer/messages/compose?to=${toUserId}`);
    }

    const [[receiver]] = await db.query(
      'SELECT id, email FROM users WHERE id = ?',
      [toUserId]
    );
    if (!receiver) {
      req.session.errorMessage = 'Empfänger existiert nicht.';
      return res.redirect('/buyer/messages/compose');
    }

    const bodyHtml = bodyRaw.replace(/\n/g, '<br>');

    const [ins] = await db.query(
      `INSERT INTO user_notifications
         (user_id, sender_id, type, template_id, subject, body, sent_at)
       VALUES (?, ?, 'message', NULL, ?, ?, NOW())`,
      [receiver.id, senderId, subject, bodyHtml]
    );

    try {
      if (receiver.email) {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to:   receiver.email,
          subject,
          text: bodyRaw
        });
        await db.query(
          'INSERT INTO notification_email_log (notification_id) VALUES (?)',
          [ins.insertId]
        );
      }
    } catch (mailErr) { console.error('Mailer error (compose):', mailErr); }

    req.session.successMessage = 'Nachricht wurde gesendet.';
    return res.redirect('/buyer/messages/sent');
  } catch (err) { next(err); }
});

router.get('/messages/:id', ensureAuthenticated, async (req, res, next) => {
  try {
    const myId = asInt(req.session.userId);
    const id   = asInt(req.params.id);
    if (!myId || !id) {
      return res.status(400).send(await tr(req, res, 'buyer.messages.error.invalid_id', 'Ungültige ID.'));
    }

    const [[row]] = await db.query(
      `SELECT n.*,
              s.email AS sender_email, s.firstname AS sender_firstname, s.lastname AS sender_lastname
         FROM user_notifications n
    LEFT JOIN users s ON s.id = n.sender_id
        WHERE n.id = ? AND (n.user_id = ? OR n.sender_id = ?)`,
      [id, myId, myId]
    );
    if (!row) {
      return res.status(404).render('pages/templates/messages-view', {
        user: null,
        item: null,
        headerTitle: await tr(req, res, 'buyer.messages.item_title', 'Nachricht'),
        login_user: req.user, currentUrl: req.url, currentPage: 'messages'
      });
    }

    // Nur markieren, wenn ICH der Empfänger bin
    if (row.user_id === myId && !row.read_at) {
      await db.query('UPDATE user_notifications SET read_at = NOW() WHERE id = ?', [id]);
      row.read_at = new Date();
    }

    const [[user]] = await db.query(
      'SELECT firstname, lastname, email, phone FROM users WHERE id = ?',
      [myId]
    );

                // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/messages-view', {
      user,
      item: row,
      headerTitle: row.subject || await tr(req, res, 'buyer.messages.item_title', 'Nachricht'),
      login_user: req.user,
      currentUrl: req.url,
      currentPage: 'messages'
    });
  } catch (err) { next(err); }
});

router.post('/messages/:id/reply', ensureAuthenticated, async (req, res, next) => {
  try {
    const myId  = asInt(req.session.userId);
    const msgId = asInt(req.params.id);
    if (!myId || !msgId) return res.redirect('/buyer/messages');

    const subject = (req.body.subject || '').trim();
    const bodyRaw = (req.body.body    || '').trim();

    const [[orig]] = await db.query(
      `SELECT n.*, s.email AS sender_email
         FROM user_notifications n
    LEFT JOIN users s ON s.id = n.sender_id
        WHERE n.id = ? AND (n.user_id = ? OR n.sender_id = ?)`,
      [msgId, myId, myId]
    );
    if (!orig) {
      req.session.errorMessage = 'Original-Nachricht wurde nicht gefunden.';
      return res.redirect('/buyer/messages');
    }

    // Antwort an den ursprünglichen Sender – Fallback: Support
    const toUserId = asInt(orig.sender_id) || SUPPORT_USER_ID || null;
    if (!toUserId) {
      req.session.errorMessage = 'Kein gültiger Empfänger für die Antwort.';
      return res.redirect(`/buyer/messages/${msgId}`);
    }
    if (!subject || !bodyRaw) {
      req.session.errorMessage = 'Betreff und Nachricht sind erforderlich.';
      return res.redirect(`/buyer/messages/${msgId}`);
    }

    const bodyHtml = bodyRaw.replace(/\n/g, '<br>');
    const [ins] = await db.query(
      `INSERT INTO user_notifications
         (user_id, sender_id, type, template_id, subject, body, sent_at)
       VALUES (?, ?, 'message', NULL, ?, ?, NOW())`,
      [toUserId, myId, subject, bodyHtml]
    );

    try {
      const [[recv]] = await db.query('SELECT email FROM users WHERE id = ?', [toUserId]);
      if (recv && recv.email) {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to:   recv.email,
          subject,
          text: bodyRaw
        });
        await db.query(
          'INSERT INTO notification_email_log (notification_id) VALUES (?)',
          [ins.insertId]
        );
      }
    } catch (mailErr) { console.error('Mailer error (reply):', mailErr); }

    req.session.successMessage = 'Antwort gesendet.';
    return res.redirect('/buyer/messages/sent');
  } catch (err) { next(err); }
});

router.get('/newsletters', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = req.session.userId;

    // User + Email laden
    const [[user]] = await db.query(
      'SELECT id, firstname, lastname, email FROM users WHERE id = ?',
      [userId]
    );

    // Logs + Template-Inhalte (Betreff) anzeigen
    const [items] = await db.query(
      `SELECT nl.id,
              nt.subject        AS title,
              nt.subject        AS subject,
              nl.sent_at,
              nl.status
         FROM newsletter_logs nl
         JOIN newsletter_templates nt ON nt.id = nl.template_id
        WHERE (nl.user_id = ? OR nl.email = ?)
     ORDER BY nl.sent_at DESC, nl.id DESC`,
      [user.id, user.email]
    );

            // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/newsletter-list', {
      user,
      items,
      currentPage: 'newsletters',
      seo,
      headerTitle: await tr(req, res, 'buyer.news.title', 'Meine Newsletter'),
      login_user: req.user,
      currentUrl:  req.url, 
    });
  } catch (err) {
    next(err);
  }
});

router.get('/newsletters/:logId', ensureAuthenticated, async (req, res, next) => {
  try {
    const userId = req.session.userId;
    const logId  = parseInt(req.params.logId, 10);

    const [[user]] = await db.query(
      'SELECT id, firstname, lastname, email FROM users WHERE id = ?',
      [userId]
    );

    // Ein einzelner Versand inkl. Template-HTML/Text
    const [[row]] = await db.query(
      `SELECT nl.id AS log_id,
              nl.sent_at,
              nl.status,
              nt.subject,
              nt.body_html,
              nt.body_text
         FROM newsletter_logs nl
         JOIN newsletter_templates nt ON nt.id = nl.template_id
        WHERE nl.id = ?
          AND (nl.user_id = ? OR nl.email = ?)
        LIMIT 1`,
      [logId, user.id, user.email]
    );

    if (!row) {
      return res.status(404).send(await tr(req, res, 'buyer.news.error.not_found', 'Newsletter nicht gefunden.'));
    }

    // HTML bevorzugt, sonst Plaintext in HTML umwandeln
    const html = row.body_html && row.body_html.trim().length
      ? row.body_html
      : (row.body_text ? row.body_text.replace(/\n/g, '<br>') : '');

                  // 12a) SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
         title,
         description AS meta_description,
         robots,
         og_title,
         og_description,
         og_image,
         twitter_card,
         jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:                seoRow?.title || bestTr?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:     seoRow?.meta_description || bestTr?.description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:               seoRow?.robots || 'index,follow',
      canonical_url:        buildCanonical(req),
      og_title:             seoRow?.og_title || bestTr?.title || seoRow?.title || null,
      og_description:       seoRow?.og_description || bestTr?.description || seoRow?.meta_description || null,
      og_image:             seoRow?.og_image || null,
      twitter_card:         seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json:        null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/newsletter-view', {
      user,
      newsletter: {
        title:   row.subject || await tr(req, res, 'buyer.news.title', 'Newsletter'),
        subject: row.subject || '',
        html
      },
      openPixelUrl: null, // kein Tracking in eurer Struktur
      currentPage: 'newsletters',
      headerTitle: row.subject || await tr(req, res, 'buyer.news.title', 'Newsletter'),
      login_user: req.user,
      currentUrl:  req.url, 
      seo, 
    });
  } catch (err) {
    next(err);
  }
});







module.exports = router;

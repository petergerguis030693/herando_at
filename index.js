require('dotenv').config();

const fs           = require('fs');
const https        = require('https');
const tls          = require('tls');
const path         = require('path');
const express      = require('express');
const cookieParser = require('cookie-parser');
const session      = require('express-session');
const fetch = require('node-fetch');
const xml2js = require("xml2js");
const MySQLStore   = require('express-mysql-session')(session);


const db           = require('./src/db');
const {
  ensureActivityLogTable,
  detectActorType,
  getClientIp,
  sanitizePayload,
  writeActivityLog
} = require('./src/service/activity-log');
const {
  localizeEntityPath
} = require('./src/service/entity-route-slugs');

const trackRouter    = require('./src/routes/track');
const adminRouter    = require('./src/routes/admin');
const templateRouter = require('./src/routes/template');
require('./src/cron/commercialPackageReminder');

  
const app = express(); 
app.disable('x-powered-by');

ensureActivityLogTable().catch((err) => {
  console.error('❌ activity_log table init failed:', err?.message || err);
});
const geoip = require('geoip-lite');
const CATEGORY_MAP = {
  cars: {
    brands: ["Lamborghini", "Mercedes-Benz", "Ferrari", "Porsche"],
    categories: ["Coupé", "Cabrio", "Limousine", "Pickup"]
  },
  watches: {
    brands: ["Patek Philippe", "Rolex", "Breitling", "IWC"],
    categories: ["Armbanduhr", "Taschenuhr", "Tischuhr", "Antike Uhr"]
  },
  yachts: {
    brands: ["Sunseeker", "Princess", "Azimut Yachts", "Benetti"],
    categories: ["Motor Yacht", "Flybridge", "Kajütboot", "Katamaran"]
  },
  properties: {
    brands: [],
    categories: ["Finca", "Maissonete", "Villa/Haus", "Wohnung"]
  }
};

const TRUSTED_APP_HOSTS = new Set([
  'herando.at',
  'www.herando.at',
  'herando.es',
  'www.herando.es',
  'herando.cz',
  'www.herando.cz',
  'herando.ch',
  'www.herando.ch',
  'herando.de',
  'www.herando.de',
  'herando.jp',
  'www.herando.jp',
  'herando.tr',
  'www.herando.tr',
  'herando.ru',
  'www.herando.ru',
  'herando.fr',
  'www.herando.fr',
  'herando.it',
  'www.herando.it',
  'herando.nl',
  'www.herando.nl',
  'herando.pl',
  'www.herando.pl',
  'herando.uk',
  'www.herando.uk',
  'herando.com',
  'www.herando.com'
]);

const DOMAIN_PROFILES = {
  default: { lang: 'de', country: 'AT', currency: 'EUR', siteCode: 'default' },
  es: { lang: 'es', country: 'ES', currency: 'EUR', siteCode: 'es' },
  cz: { lang: 'cs', country: 'CZ', currency: 'CZK', siteCode: 'cz' },
  ch: { lang: 'de', country: 'CH', currency: 'CHF', siteCode: 'ch' },
  de: { lang: 'de', country: 'DE', currency: 'EUR', siteCode: 'de' },
  jp: { lang: 'ja', country: 'JP', currency: 'JPY', siteCode: 'jp' },
  tr: { lang: 'tr', country: 'TR', currency: 'TRY', siteCode: 'tr' },
  ru: { lang: 'ru', country: 'RU', currency: 'RUB', siteCode: 'ru' },
  fr: { lang: 'fr', country: 'FR', currency: 'EUR', siteCode: 'fr' },
  it: { lang: 'it', country: 'IT', currency: 'EUR', siteCode: 'it' },
  nl: { lang: 'nl', country: 'NL', currency: 'EUR', siteCode: 'nl' },
  pl: { lang: 'pl', country: 'PL', currency: 'PLN', siteCode: 'pl' },
  uk: { lang: 'en', country: 'GB', currency: 'GBP', siteCode: 'uk' }
};

const DOMAIN_DEFAULTS = new Map([
  ['herando.at', DOMAIN_PROFILES.default],
  ['www.herando.at', DOMAIN_PROFILES.default],
  ['herando.com', DOMAIN_PROFILES.default],
  ['www.herando.com', DOMAIN_PROFILES.default],
  ['herando.es', DOMAIN_PROFILES.es],
  ['www.herando.es', DOMAIN_PROFILES.es],
  ['herando.cz', DOMAIN_PROFILES.cz],
  ['www.herando.cz', DOMAIN_PROFILES.cz],
  ['herando.ch', DOMAIN_PROFILES.ch],
  ['www.herando.ch', DOMAIN_PROFILES.ch],
  ['herando.de', DOMAIN_PROFILES.de],
  ['www.herando.de', DOMAIN_PROFILES.de],
  ['herando.jp', DOMAIN_PROFILES.jp],
  ['www.herando.jp', DOMAIN_PROFILES.jp],
  ['herando.tr', DOMAIN_PROFILES.tr],
  ['www.herando.tr', DOMAIN_PROFILES.tr],
  ['herando.ru', DOMAIN_PROFILES.ru],
  ['www.herando.ru', DOMAIN_PROFILES.ru],
  ['herando.fr', DOMAIN_PROFILES.fr],
  ['www.herando.fr', DOMAIN_PROFILES.fr],
  ['herando.it', DOMAIN_PROFILES.it],
  ['www.herando.it', DOMAIN_PROFILES.it],
  ['herando.nl', DOMAIN_PROFILES.nl],
  ['www.herando.nl', DOMAIN_PROFILES.nl],
  ['herando.pl', DOMAIN_PROFILES.pl],
  ['www.herando.pl', DOMAIN_PROFILES.pl],
  ['herando.uk', DOMAIN_PROFILES.uk],
  ['www.herando.uk', DOMAIN_PROFILES.uk]
]);

function normalizeHost(rawHost) {
  return String(rawHost || '')
    .trim()
    .toLowerCase()
    .split(',')[0]
    .trim()
    .replace(/:\d+$/, '');
}

function getRequestHost(req) {
  const forwarded = normalizeHost(req.get('x-forwarded-host') || req.headers['x-forwarded-host']);
  const direct = normalizeHost(req.hostname || req.get('host'));
  return forwarded || direct;
}

function resolveDomainProfile(req) {
  const host = getRequestHost(req) || 'www.herando.com';

  if (DOMAIN_DEFAULTS.has(host)) {
    return { host, ...DOMAIN_DEFAULTS.get(host) };
  }

  if (host.endsWith('.es')) {
    return { host, ...DOMAIN_PROFILES.es };
  }

  if (host.endsWith('.cz')) {
    return { host, ...DOMAIN_PROFILES.cz };
  }

  if (host.endsWith('.ch')) {
    return { host, ...DOMAIN_PROFILES.ch };
  }

  if (host.endsWith('.de')) {
    return { host, ...DOMAIN_PROFILES.de };
  }

  if (host.endsWith('.jp')) {
    return { host, ...DOMAIN_PROFILES.jp };
  }

  if (host.endsWith('.tr')) {
    return { host, ...DOMAIN_PROFILES.tr };
  }

  if (host.endsWith('.ru')) {
    return { host, ...DOMAIN_PROFILES.ru };
  }

  if (host.endsWith('.fr')) {
    return { host, ...DOMAIN_PROFILES.fr };
  }

  if (host.endsWith('.it')) {
    return { host, ...DOMAIN_PROFILES.it };
  }

  if (host.endsWith('.nl')) {
    return { host, ...DOMAIN_PROFILES.nl };
  }

  if (host.endsWith('.pl')) {
    return { host, ...DOMAIN_PROFILES.pl };
  }

  if (host.endsWith('.uk')) {
    return { host, ...DOMAIN_PROFILES.uk };
  }

  return { host, ...DOMAIN_PROFILES.default };
}

function getCookieDomainForHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  if (normalized === 'localhost') return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return null;

  const parts = normalized.split('.');
  if (parts.length < 2) return null;
  return `.${parts.slice(-2).join('.')}`;
}

function buildLangCookieOptions(req) {
  const options = {
    maxAge: 180 * 24 * 60 * 60 * 1000, // 180 Tage
    httpOnly: false,
    sameSite: 'Lax',
    secure: true,
    path: '/'
  };

  const cookieDomain = getCookieDomainForHost(getRequestHost(req));
  if (cookieDomain) {
    options.domain = cookieDomain;
  }

  return options;
}

function getRequestProto(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto === 'https' || forwardedProto === 'http') return forwardedProto;
  return req.secure ? 'https' : 'http';
}

function stripLangPrefixFromPath(pathname) {
  const path = String(pathname || '/');
  return path.replace(/^\/[a-z]{2}(?=\/|$)/i, '') || '/';
}

function buildLocalizedPath(pathname, lang) {
  const normalizedLang = String(lang || 'de').toLowerCase();
  const cleanPath = String(pathname || '/').startsWith('/') ? String(pathname || '/') : `/${pathname}`;
  const pathNoPrefix = stripLangPrefixFromPath(cleanPath);
  const localizedEntityPath = localizeEntityPath(pathNoPrefix, normalizedLang);

  if (normalizedLang === 'de') return localizedEntityPath || '/';
  if (localizedEntityPath === '/' || !localizedEntityPath) return `/${normalizedLang}/`;
  return `/${normalizedLang}${localizedEntityPath}`;
}

function getSafeBackPath(req, fallback = '/') {
  const referer = req.get('Referer') || req.get('Referrer');
  if (!referer) return fallback;

  try {
    const parsed = new URL(referer);
    const hostHeader = getRequestHost(req);
    const trustedHosts = new Set([...TRUSTED_APP_HOSTS, hostHeader].filter(Boolean));

    if (!trustedHosts.has(normalizeHost(parsed.host))) {
      return fallback;
    }

    return `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
  } catch {
    return fallback;
  }
}




/* ────────────────────────────────────────────────────────────────────────────
 * Basis / App-Setup
 * ──────────────────────────────────────────────────────────────────────────── */

app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "base-uri 'self'; object-src 'none'; frame-ancestors 'self'");
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use((req, res, next) => {
  const url = (req.originalUrl || '').toLowerCase();
  const ip = req.ip; // sauberer bei trust proxy

  // 🔥 Exploit-Pattern (nur echte Traversal-/Nullbyte-Muster)
  const hasTraversal =
    url.includes('../') ||
    url.includes('..\\') ||
    /%2e%2e(?:%2f|\/|%5c|\\)/i.test(url) ||
    /(?:\/|%2f)\.\.(?:\/|%2f|%5c|\\)/i.test(url);

  const hasNullByte = url.includes('%00');

  // 🔥 Kritische Dateiendungen (nur echte Endungen blocken)
  const blockedExtensions = [
    '.php', '.phtml', '.php5', '.php7',
    '.cgi', '.pl', '.asp', '.aspx', '.jsp',
    '.env', '.bak', '.sql',
    '.ini', '.log', '.sh'
  ];

  // 🔥 Kritische Pfade (präzise)
  const blockedPaths = [
    '/.git',
    '/.env',
    '/wp-',
    '/wordpress',
    '/xmlrpc',
    '/wp-content',
    '/wp-admin',
    '/wp-includes',
    '/wlwmanifest',
    '/ecp/',
    '/owa/',
    '/microsoft.exchange',
    '/php-cgi',
    '/vendor/',
    '/node_modules/'
  ];

  const isExploit = hasTraversal || hasNullByte;
  const isBadExtension = blockedExtensions.some(ext => url.endsWith(ext));
  const isBadPath = blockedPaths.some(path => url.includes(path));

  if (isExploit || isBadExtension || isBadPath) {
    console.log('🚨 BOT BLOCKED:', ip, '|', req.method, '|', req.originalUrl);
    return res.sendStatus(403);
  }

  next();
});

app.set('views', path.join(__dirname, 'src', 'views'));
app.set('view engine', 'ejs');

/* Static & Assets */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// robots auf herando.at blocken
app.use((req, res, next) => {
  if (req.hostname && req.hostname.toLowerCase() === 'herando.at') {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
});
app.use('/robots.txt', express.static(path.join(__dirname, 'public', 'robots.txt')));

// /images -> Server-Pfad
const imagesPath = path.resolve('/', 'media', 'herando', 'images');
console.log('📂 Versuche, Images von diesem Pfad zu serven:', imagesPath);
console.log('✅ Existiert Verzeichnis?', fs.existsSync(imagesPath));

app.use('/images', express.static(imagesPath));
app.use(
  '/images/news',
  express.static(
    path.join(__dirname, '..', 'herando', 'katalog', 'shared', 'images', 'cms', 'news')
  )
);
/* Parser */
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ────────────────────────────────────────────────────────────────────────────
 * Session / Flash
 * ──────────────────────────────────────────────────────────────────────────── */
const sessionStore = new MySQLStore(
  {
    expiration: 24 * 60 * 60 * 1000,
    createDatabaseTable: true
  },
  db
);

app.use(
  session({
    key: 'herando_session_id',
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    },
    name: 'herando_session_id'
  })
);

const flash = require('connect-flash');
app.use(flash());

// Flash in Views
app.use((req, res, next) => {
  res.locals.flash = {
    success: req.flash('success'),
    error:   req.flash('error')
  };
  next();
});

// Meldungen aus Session in res.locals (und danach löschen)
app.use((req, res, next) => {
  res.locals.errorMessage   = req.session.errorMessage   || null;
  res.locals.successMessage = req.session.successMessage || null;
  delete req.session.errorMessage;
  delete req.session.successMessage;
  next();
});


/* ────────────────────────────────────────────────────────────────────────────
 * User in req.user laden (falls eingeloggt)
 * ──────────────────────────────────────────────────────────────────────────── */
app.use(async (req, res, next) => {
  try {
    if (req.session && req.session.userId) {
      //console.log("🔹 [Middleware] Session vor DB-Check:", req.session);

      const [[user]] = await db.query(
        'SELECT id, role, firstname, lastname FROM users WHERE id = ?',
        [req.session.userId]
      );

      if (user) {
        req.user = user;
        res.locals.user = user;
        res.locals.role = user.role;
        res.locals.userName = `${user.firstname} ${user.lastname}`;
       // console.log("✅ [Middleware] User gefunden:", user);
      } else {
        res.locals.role = 0;
        //console.log("⚠️ [Middleware] UserId in Session, aber User nicht in DB gefunden");
      }
    } else {
      res.locals.role = 0;
      //console.log("⚠️ [Middleware] Keine Session oder userId vorhanden");
    }
    next();
  } catch (err) {
    console.error("❌ [Middleware] Fehler beim Laden des Users:", err);
    next(err);
  }
});

// Aktivitaets-Log fuer eingeloggte Nutzer (Admin + Kunde)
app.use((req, res, next) => {
  const userId = Number(req.session?.userId || 0);
  if (!Number.isInteger(userId) || userId <= 0) return next();

  const role = Number(req.session?.role || req.user?.role || 0);
  const actorType = detectActorType(role);
  const path = String(req.originalUrl || req.url || '/');
  const method = String(req.method || 'GET').toUpperCase();

  // Keine statischen/Tracking-Endpunkte loggen
  if (path.startsWith('/assets/') || path.startsWith('/uploads/') || path.startsWith('/images/')) return next();
  if (path.startsWith('/public/') || path.startsWith('/css/') || path.startsWith('/js/')) return next();
  if (path.startsWith('/track') || path.startsWith('/analytics/track')) return next();
  if (path === '/favicon.ico' || path === '/robots.txt') return next();

  // Alles loggen fuer eingeloggte User (GET + POST + ...)
  const payloadSource = method === 'GET'
    ? { query: req.query || null }
    : { query: req.query || null, body: req.body || null };

  const started = Date.now();
  const payload = sanitizePayload(payloadSource);
  let finished = false;

  const flush = () => {
    if (finished) return;
    finished = true;
    const durationMs = Date.now() - started;
    writeActivityLog({
      actorUserId: userId,
      actorRole: role || null,
      actorType,
      method,
      path,
      statusCode: res.statusCode || 0,
      durationMs,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
      payload
    }).catch((err) => {
      console.error('❌ activity_log write failed:', err?.message || err);
    });
  };

  res.on('finish', flush);
  res.on('close', flush);
  next();
});

async function enrichUserPackage(req, res, next) {
  try {
    if (!req.session?.userId) {
      res.locals.userHasPackage = false;
      return next();
    }

    const [[pkg]] = await db.query(`
    SELECT 1
    FROM selected_packages
    WHERE user_id = ?
      AND end_date >= NOW()
    LIMIT 1
    `, [req.session.userId]);

    res.locals.userHasPackage = !!pkg;
    next();
  } catch (err) {
    console.error('❌ enrichUserPackage failed:', err);
    res.locals.userHasPackage = false;
    next();
  }
}

app.use(enrichUserPackage);

const COUNTRY_TO_LANG = {
  AT: 'de',
  DE: 'de',
  CH: 'de',
  US: 'en',
  GB: 'en',
  FR: 'fr',
  IT: 'it',
  TR: 'tr',
  JP: 'ja',
  CZ: 'cs',
  RU: 'ru',
  ES: 'es',
  NL: 'nl',
  PL: 'pl'
};

app.use((req, res, next) => {
  const domainProfile = resolveDomainProfile(req);
  req.domainProfile = domainProfile;

  if (req.session) {
    if (!req.session.lang) req.session.lang = domainProfile.lang;
    if (!req.session.country) req.session.country = domainProfile.country;
    if (!req.session.currency) req.session.currency = domainProfile.currency;
  }

  const activeLang = req.session?.lang || domainProfile.lang;
  const activeCountry = req.session?.country || domainProfile.country;
  const activeCurrency = req.session?.currency || domainProfile.currency;

  res.locals.domainHost = domainProfile.host;
  res.locals.domainSite = domainProfile.siteCode;
  res.locals.isSpanishDomain = domainProfile.siteCode === 'es';
  res.locals.lang = activeLang;
  res.locals.country = activeCountry;
  res.locals.currency = activeCurrency;

  next();
});

app.use((req, res, next) => {
  if (process.env.DEBUG_SESSION_LANG === 'true') {
    console.log('🧠 FINAL SESSION.lang =', req.session.lang, '| URL:', req.originalUrl);
  }
  next();
});

// Middleware vor deinen anderen Language-Middlewares
app.use((req, res, next) => {
  const SUPPORTED = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];

  // 🔹 1. Wenn Sprache bereits gesetzt → NICHT überschreiben
  if (req.session.lang && SUPPORTED.includes(req.session.lang)) {
    res.locals.lang = req.session.lang;
    return next();
  }

  // 🔹 2. Browser nur als ERST-Fallback
  const accept = req.headers['accept-language'];
  const browserLang = accept
    ? accept.split(',')[0].split('-')[0]
    : 'de';

  const finalLang = SUPPORTED.includes(browserLang) ? browserLang : 'de';

  req.session.lang = finalLang;
  res.locals.lang = finalLang;

  next();
});




/* ────────────────────────────────────────────────────────────────────────────
 * Sprachen-Setup (mit Debug-Logs)
 * ──────────────────────────────────────────────────────────────────────────── */
const SUPPORTED_LANGS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];

function normalizeToSupportedLang(input) {
  if (!input) return 'de';
  const x = ('' + input).toLowerCase();
  if (SUPPORTED_LANGS.includes(x)) return x;
  const base = x.split('-')[0];
  if (SUPPORTED_LANGS.includes(base)) return base;
  return 'de';
}

/** 1) Prefix: /xx am URL-Anfang (z.B. /en, /fr, /cs, …) */
app.use((req, res, next) => {
  const m = req.path.match(/^\/([a-z]{2})(?=\/|$)/i);
  if (m) {
    const candidate = normalizeToSupportedLang(m[1]);
    req.session.lang = candidate;
    req.url = req.url.replace(/^\/[a-z]{2}(?=\/|$)/i, '') || '/';
   // console.log('🌍 [PREFIX] Sprache via URL-Prefix gesetzt →', candidate);
   // console.log('➡️ neue URL nach Prefix-Entfernung:', req.url);
  } else {
   // console.log('🌍 [PREFIX] kein Prefix gefunden, aktuelle Session.lang:', req.session.lang);
  }
  next();
});

/** 2) Query: ?lang=xx */
app.use((req, res, next) => {
  if (req.query && typeof req.query.lang === 'string') {
    const candidate = normalizeToSupportedLang(req.query.lang);
    req.session.lang = candidate;
   // console.log('🌍 [QUERY] Sprache via ?lang= gesetzt →', candidate);
  } else {
   // console.log('🌍 [QUERY] kein ?lang gefunden, aktuelle Session.lang:', req.session.lang);
  }
  next();
});

/** 3) Accept-Language (nur wenn in Session noch nichts gesetzt ist) */
app.use((req, res, next) => {
  if (!req.session.lang) {
    const accept = req.headers['accept-language'];
    const first  = accept ? accept.split(',')[0] : 'de';
    const base   = first.split('-')[0];
    const lang   = normalizeToSupportedLang(base);
    req.session.lang = lang;
    // console.log('🌍 [ACCEPT-LANGUAGE] erkannt:', accept, '→ gewählt:', lang);
  } else {
    // console.log('🌍 [ACCEPT-LANGUAGE] übersprungen, Session.lang schon gesetzt →', req.session.lang);
  }
  res.locals.lang = req.session.lang || 'de';
 // console.log('✅ [FINAL LANG] res.locals.lang =', res.locals.lang);
  next();
});

app.use((req, res, next) => {
  const domainProfile = req.domainProfile || DOMAIN_PROFILES.default;
  const activeLang = normalizeToSupportedLang(req.session?.lang || res.locals.lang || domainProfile.lang || 'de');
  const host = getRequestHost(req) || 'www.herando.com';
  const proto = getRequestProto(req);
  const siteBaseUrl = `${proto}://${host}`;

  const originalPath = String(req.originalUrl || req.url || '/').split('?')[0].split('#')[0] || '/';
  const canonicalPath = buildLocalizedPath(originalPath, activeLang);

  const hreflangUrls = {};
  SUPPORTED_LANGS.forEach((code) => {
    hreflangUrls[code] = `${siteBaseUrl}${buildLocalizedPath(originalPath, code)}`;
  });

  const domainDefaultLang = normalizeToSupportedLang(domainProfile.lang || 'de');
  const xDefaultUrl = `${siteBaseUrl}${buildLocalizedPath(originalPath, domainDefaultLang)}`;

  res.locals.siteHost = host;
  res.locals.siteBaseUrl = siteBaseUrl;
  res.locals.seoCanonicalUrl = `${siteBaseUrl}${canonicalPath}`;
  res.locals.seoHreflangUrls = hreflangUrls;
  res.locals.seoXDefaultUrl = xDefaultUrl;
  res.locals.domainDefaultLang = domainDefaultLang;
  res.locals.ogDefaultImage = `${siteBaseUrl}/assets/og-image.jpg`;
  res.locals.siteLogoUrl = `${siteBaseUrl}/assets/herando-weblogo.svg`;
  res.locals.localizedPath = (pathname, langOverride) => {
    const finalLang = normalizeToSupportedLang(langOverride || activeLang);
    return buildLocalizedPath(pathname || '/', finalLang);
  };

  next();
});


/** 4) Manuelle Switch-Route */
app.get('/lang/:code', (req, res) => {
  const code = (req.params.code || '').toLowerCase();
  const base = code.split('-')[0];

  const SUPPORTED_LANGS = ['de', 'en', 'fr', 'it', 'es', 'nl', 'tr', 'cs', 'ru', 'ja', 'pl'];
  const lang = SUPPORTED_LANGS.includes(base) ? base : 'de';

  // Sprache speichern
  req.session.lang = lang;
  res.locals.lang = lang;

  // 🔹 NEU: Währung & Land übernehmen (falls in Query enthalten)
  const { currency, country } = req.query;

  if (currency) {
    req.session.currency = currency.toUpperCase();
    res.locals.currency = req.session.currency;
    console.log(`💱 Währung geändert zu: ${req.session.currency}`);
  }

  if (country) {
    req.session.country = country;
    res.locals.country = country;
    console.log(`🏳️ Land geändert zu: ${req.session.country}`);
  }

  // Sprache als Cookie speichern (domain-dynamisch)
  res.cookie('lang', lang, buildLangCookieOptions(req));

  console.log('🌍 [SWITCH] /lang/:code aufgerufen →', lang);
  console.log('➡️ Session:', {
    lang: req.session.lang,
    currency: req.session.currency,
    country: req.session.country
  });

  return res.redirect(getSafeBackPath(req, '/'));
});




/* ────────────────────────────────────────────────────────────────────────────
 * UI-Translations aus DB in res.locals.ui
 * Tabelle: ui_translations (key, de, en, fr, it, tr, ja, cs, ru, es, nl, pl)
 * ──────────────────────────────────────────────────────────────────────────── */
app.use(async (req, res, next) => {
  try {
    const lang = res.locals.lang || 'de';

    const [rows] = await db.query(`
      SELECT \`key\`, NULLIF(\`${lang}\`, '') AS t
      FROM ui_translations
    `);

    const ui = {};
    rows.forEach(r => { if (r.t) ui[r.key] = r.t; });

    res.locals.ui = ui;
    res.locals.t = (k, fallback = '') => (ui[k] ?? fallback ?? k);

    next();
  } catch (err) {
    next(err);
  }
});



/* ────────────────────────────────────────────────────────────────────────────
 * ententies in res.locals (für Header/Nav & Startseite)
 * ──────────────────────────────────────────────────────────────────────────── */
app.use(async (req, res, next) => {
  try {
    const [rows] = await db.query(`
      SELECT id, name, route, table_name
        FROM ententies
       ORDER BY name
    `);
    res.locals.ententies = rows;
    next();
  } catch (err) {
    next(err);
  }
});

/* 🌍 Globale Variablen für Templates */
app.use((req, res, next) => {
  const profile = req.domainProfile || DOMAIN_PROFILES.default;
  res.locals.lang = req.session?.lang || profile.lang || 'de';
  res.locals.currency = req.session?.currency || profile.currency || 'EUR';
  res.locals.country = req.session?.country || profile.country || 'AT';
  next();
});

/* ────────────────────────────────────────────────────────────────────────────
 * 🌍 Dynamische Währungs-Middleware – unterstützt ALLE Währungen der API
 * ──────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────
 * 🌍 ECB XML Währungs-Middleware – OFFIZIELL & STABIL
 * ──────────────────────────────────────────────────────────────── */
global.exchangeRates = {
  rates: {},
  timestamp: 0,
  currencies: ["EUR"]
};
let inFlightExchangeRatesFetch = null;


async function loadFrankfurterRates() {
  console.log("🔄 Lade Wechselkurse von Frankfurter.app ...");

  const response = await fetch("https://api.frankfurter.app/latest?from=EUR");
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  const data = await response.json();
  if (!data?.rates || typeof data.rates !== "object" || !Object.keys(data.rates).length) {
    throw new Error("Leere oder ungueltige API-Antwort");
  }

  // data.rates = { USD: 1.07 , GBP: 0.85 ... }
  return data.rates;
}

async function loadFrankfurterRatesCoalesced() {
  if (inFlightExchangeRatesFetch) {
    return inFlightExchangeRatesFetch;
  }

  inFlightExchangeRatesFetch = (async () => {
    return loadFrankfurterRates();
  })();

  try {
    return await inFlightExchangeRatesFetch;
  } finally {
    inFlightExchangeRatesFetch = null;
  }
}

app.use(async (req, res, next) => {
  try {
    // Session-Währung
    if (req.query.currency) {
      req.session.currency = req.query.currency.toUpperCase();
    }
    if (!req.session.currency) req.session.currency = "EUR";
    const userCurrency = req.session.currency;

    // Live-Fetch je Request; bei API-Fehler fallback auf letzten erfolgreichen Stand im RAM.
    const now = Date.now();
    try {
      const liveRates = await loadFrankfurterRatesCoalesced();
      global.exchangeRates = {
        rates: liveRates,
        currencies: Object.keys(liveRates).concat("EUR"),
        timestamp: now
      };
      console.log(`💱 Frankfurter Live-Kurse geladen – ${Object.keys(liveRates).length} Währungen`);
    } catch (err) {
      console.error("❌ Frankfurter API Fehler:", err.message);
      if (global.exchangeRates?.rates && Object.keys(global.exchangeRates.rates).length) {
        console.warn("⚠️ Verwende letzte erfolgreiche Wechselkurse aus RAM-Cache");
      } else {
        global.exchangeRates = {
          rates: {
            USD: 1.07,
            GBP: 0.85,
            CHF: 0.98,
            JPY: 165
          },
          currencies: ["USD", "GBP", "CHF", "JPY", "EUR"],
          timestamp: now
        };
        console.warn("⚠️ Kein Live-Kurs verfügbar, verwende statischen Notfall-Fallback");
      }
    }

    const rates = global.exchangeRates.rates;

    // Preis-Konverter
    // Signatur:
    // convertPrice(amount, toCurrency = userCurrency, fromCurrency = 'EUR')
    res.locals.convertPrice = (amount, toCurrency = userCurrency, fromCurrency = "EUR") => {
      const value = Number(amount);
      if (!Number.isFinite(value) || value <= 0) return "—";

      const target = String(toCurrency || userCurrency || "EUR").toUpperCase();
      const source = String(fromCurrency || "EUR").toUpperCase();

      let targetAmount = value;
      if (source !== target) {
        let amountInEur = value;
        if (source !== "EUR") {
          const sourceRate = Number(rates[source]);
          if (!Number.isFinite(sourceRate) || sourceRate <= 0) return "—";
          amountInEur = value / sourceRate;
        }

        if (target === "EUR") {
          targetAmount = amountInEur;
        } else {
          const targetRate = Number(rates[target]);
          if (!Number.isFinite(targetRate) || targetRate <= 0) return "—";
          targetAmount = amountInEur * targetRate;
        }
      }

      return new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: target
      }).format(targetAmount);
    };

    res.locals.currency = userCurrency;
    res.locals.availableCurrencies = global.exchangeRates.currencies;

    next();

  } catch (err) {
    console.error("❌ [Frankfurter Währungs-Middleware] Fehler:", err);
    next();
  }
});




/* ────────────────────────────────────────────────────────────────
 * 💲 /currency/CHF
 * ──────────────────────────────────────────────────────────────── */
app.get("/currency/:code", (req, res) => {
  const code = (req.params.code || "").toUpperCase();
  const list = global.exchangeRates?.currencies || [];

  if (list.includes(code)) {
    req.session.currency = code;
    res.locals.currency = code;
    console.log(`💲 Währung gewechselt: ${code}`);
  } else {
    console.warn(`⚠️ Ungültige Währung: ${code}`);
  }

  res.redirect(getSafeBackPath(req, '/'));
});

app.locals.getMegaMenu = (route) => {
    return CATEGORY_MAP[route] || null;
};

app.locals.catLabel = (route, fallback) => {
    return fallback || route;
};

console.log("✅ [app.locals] Header-Funktionen (catLabel, getMegaMenu) global definiert.");


/* ────────────────────────────────────────────────────────────────────────────
 * Zentraler I18N-Hook für /api/catalog_ads/:entitieId & /api/advert_inserat/:entitieId
 * Nutzt listing_translations über advert_id. Key-Priorität: advert_id → reference → id
 * Fallback-Reihenfolge: aktive Sprache → en → de → Basis
 * ──────────────────────────────────────────────────────────────────────────── */
/* ────────────────────────────────────────────────────────────────────────────
 * Zentraler I18N-Hook für /api/catalog_ads/:entitieId & /api/advert_inserat/:entitieId
 * Neu:
 *  - KEIN en-Fallback wenn activeLang = 'de'  (wir wollen dann Basistitel)
 *  - Basis-Fallback aus Stammtabelle (cars / watches / yachts / properties …)
 * ──────────────────────────────────────────────────────────────────────────── */
const I18N_API_PATHS = ['/api/catalog_ads/:entitieId', '/api/advert_inserat/:entitieId'];

app.use(I18N_API_PATHS, (req, res, next) => {
const qLang       = String(req.query.lang || '').toLowerCase();
const hdrLang     = String(req.get?.('x-lang') || req.headers?.['x-lang'] || '').toLowerCase(); // optionaler Header-Override
const sessionLang = String(req.session?.lang || '').toLowerCase();
const cookieLang  = String(req.cookies?.lang || '').toLowerCase();
const acceptFirst = String(req.headers['accept-language'] || '')
  .toLowerCase().split(',')[0].split('-')[0];

const inSup = (v) => v && SUPPORTED_LANGS.includes(v);

const activeLang =
  inSup(qLang)       ? qLang
: inSup(hdrLang)     ? hdrLang      // ← manuell vom Frontend setzbar
: inSup(sessionLang) ? sessionLang
: inSup(cookieLang)  ? cookieLang
: inSup(acceptFirst) ? acceptFirst
: 'de';


  const entitieId = parseInt(req.params.entitieId, 10) || 0;
  const endpoint  = req.path.startsWith('/api/catalog_ads/') ? 'catalog_ads' : 'advert_inserat';

  //console.log(`🧩 [LT-HOOK] attach for ${endpoint} entitie=${entitieId} activeLang=${activeLang} qLang=${qLang} sess=${req.session?.lang} cookie=${cookieLang}`);

  // Key-Ermittlung: advert_id → reference → id
  const advertKey = (it) => {
    for (const c of [it?.advert_id, it?.reference, it?.id]) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  };

async function baseFallback(entitieId, missingIds) {
  if (!missingIds.length) return {};
  try {
    // 1) Tabelle ermitteln
    const [[entRow]] = await db.query(
      `SELECT table_name FROM ententies WHERE id = ? LIMIT 1`,
      [entitieId]
    );
    const table = entRow?.table_name;
    if (!table || !/^[a-zA-Z0-9_]+$/.test(table)) {
      // console.warn(`[LT-HOOK] base-fallback: no/invalid table_name for entitie=${entitieId}`);
      return {};
    }

    // 2) Spalten der Tabelle lesen
    const [cols] = await db.query(
      `SELECT COLUMN_NAME, DATA_TYPE
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?`,
      [table]
    );
    const colSet = new Set(cols.map(c => c.COLUMN_NAME.toLowerCase()));

    // 3) Helfer: nimm die erste existierende Spalte aus Kandidaten
    const choose = (...cands) => cands.find(c => colSet.has(c));

    // 4) Ausdruck für Basis-Titel zusammenstellen
    let expr = null;
    const usedCols = [];

    // Häufigster Fall: "name" (bei dir z.B. cars), alternativ "title"/"headline"/"subject"
    const simple = choose('name', 'title', 'headline', 'subject');
    if (simple) {
      expr = `\`${simple}\``;
      usedCols.push(simple);
    }

    // Wenn noch nichts gefunden: Brand + Model zusammenbauen
    if (!expr) {
      const brand = choose('brand', 'marke', 'manufacturer', 'make');
      const model = choose('model', 'modell', 'variant', 'version');
      if (brand && model) {
        expr = `CONCAT_WS(' ', \`${brand}\`, \`${model}\`)`;
        usedCols.push(brand, model);
      } else if (model) {
        expr = `\`${model}\``;
        usedCols.push(model);
      } else if (brand) {
        expr = `\`${brand}\``;
        usedCols.push(brand);
      }
    }

    // Bei Immobilien o.ä.: Standort/Adresse als Fallback
    if (!expr) {
      const loc = choose('title_short', 'address', 'adresse', 'city', 'stadt', 'location', 'ort');
      if (loc) {
        expr = `\`${loc}\``;
        usedCols.push(loc);
      }
    }

    // Allerletzte Option: Beschreibung anreißen
    if (!expr) {
      const descr = choose('description', 'beschreibung', 'short_description', 'summary');
      if (descr) {
        expr = `LEFT(\`${descr}\`, 80)`;
        usedCols.push(descr);
      }
    }

    if (!expr) {
      // console.warn(`[LT-HOOK] base-fallback: no suitable text column found on ${table}`);
      return {};
    }

    // 5) Query ausführen
    const ph = missingIds.map(() => '?').join(',');
    const sql = `SELECT id, ${expr} AS base_title FROM \`${table}\` WHERE id IN (${ph})`;
    // console.log(`[LT-HOOK] base-fallback sql=${sql} colsUsed=${usedCols.join(',')}`);
    const [rows2] = await db.query(sql, missingIds);

    // 6) Map bauen
    const out = {};
    let filled = 0;
    for (const r of rows2) {
      if (r.base_title) { out[r.id] = r.base_title; filled++; }
    }
    // console.log(`[LT-HOOK] base-fallback filled ${filled}/${missingIds.length} from ${table}`);
    return out;
  } catch (e) {
   // console.error('❌ [LT-HOOK] base-fallback error:', e);
    return {};
  }
}


  async function mergeTranslations(body) {
    if (!Array.isArray(body) || !body.length || !entitieId) {
      // console.log(`🧩 [LT-HOOK] skip merge (array/entitie check)`);
      return body;
    }

    const keyProbe = advertKey(body[0]);
    const keyName  = (body[0]?.advert_id != null) ? 'advert_id' : (body[0]?.reference != null) ? 'reference' : 'id';
    // console.log(`🧩 [LT-HOOK] keyField=${keyName} firstKey=${keyProbe}`);

    const ids = body.map(advertKey).filter(v => v != null);
    // console.log(`🧩 [LT-HOOK] items=${body.length} idsFound=${ids.length}`);
    if (!ids.length) return body;

    // Fallback-Reihenfolge:
    //  - wenn de: nur ['de'] (KEIN 'en' hier), danach Basis-Fallback
    //  - sonst: [activeLang, 'en'], danach Basis-Fallback
    const langs = (activeLang === 'de')
      ? ['de']
      : [activeLang, 'en'];
    // Sicherheitsfilter
    const langsFiltered = langs.filter((v,i,a)=> v && SUPPORTED_LANGS.includes(v) && a.indexOf(v)===i);
   // console.log(`🧩 [LT-HOOK] SQL langs order=${langsFiltered.join('>') || '(none)'}`);

    const placeholdersIds   = ids.map(() => '?').join(',');
    const placeholdersLangs = langsFiltered.length ? langsFiltered.map(() => '?').join(',') : null;
    const orderField        = langsFiltered.length ? langsFiltered.map(() => '?').join(',') : null;

    let best = new Map();

    // 1) listing_translations nur abfragen, wenn wir überhaupt Sprachen haben
    if (langsFiltered.length) {
      try {
        const [rows] = await db.query(
          `SELECT advert_id, language, title, description
             FROM listing_translations
            WHERE entitie_id = ?
              AND advert_id IN (${placeholdersIds})
              AND language IN (${placeholdersLangs})
            ORDER BY FIELD(language, ${orderField})`,
          [entitieId, ...ids, ...langsFiltered, ...langsFiltered]
        );
        best = new Map();
        for (const r of rows) if (!best.has(r.advert_id)) best.set(r.advert_id, r);
        // console.log(`🧩 [LT-HOOK] translations used ${best.size}/${ids.length}`);
      } catch (e) {
       // console.error('❌ [LT-HOOK] DB merge error:', e);
      }
    } else {
      // console.log('🧩 [LT-HOOK] no langs to query (will use base fallback only)');
    }

    // 2) Basis-Fallback für alle, die noch fehlen
    const missing = ids.filter(id => !best.has(id));
    let baseTitles = {};
    if (missing.length) {
     // console.log(`🧩 [LT-HOOK] missing IDs for base fallback: ${missing.length}`);
      baseTitles = await baseFallback(entitieId, missing);
    }

    // 3) Zusammenbauen
    const out = body.map(it => {
      const k  = advertKey(it);
      const tr = best.get(k);
      // Vorrang:
      //   - Wenn gewünschte Übersetzung vorhanden → nehmen
      //   - Sonst Basis-Titel → nehmen
      //   - Sonst Original-Item lassen
      if (!tr && !baseTitles[k]) return it;

      const o = { ...it };
      if (tr?.title) {
        o.title = tr.title;
      } else if (baseTitles[k]) {
        o.title = baseTitles[k];
      }
      if (tr?.description) {
        o.description = tr.description;
      }
      return o;
    });

    return out;
  }

  // res.json hooken
  const _json = res.json.bind(res);
  res.json = async (payload) => {
    // console.log(`🧩 [LT-HOOK] res.json intercepted for ${endpoint}`);
    const merged = await mergeTranslations(payload);
    return _json(merged);
  };

  // res.send hooken (falls Handler send() nutzt)
  const _send = res.send.bind(res);
  res.send = async (payload) => {
    try {
      let data = payload;
      let parsed = null;

      const ct = res.getHeader('Content-Type') || '';
      const looksJson = (typeof payload === 'string' && /^[\[\{]/.test(payload)) ||
                        (ct && String(ct).includes('application/json'));

      if (looksJson) {
        if (typeof payload === 'string') { try { parsed = JSON.parse(payload); } catch { parsed = null; } }
        else parsed = payload;

        if (parsed) {
         // console.log(`🧩 [LT-HOOK] res.send intercepted (JSON) for ${endpoint}`);
          const merged = await mergeTranslations(parsed);
          data = (typeof payload === 'string') ? JSON.stringify(merged) : merged;
          if (typeof payload === 'string') res.setHeader('Content-Type', 'application/json; charset=utf-8');
        }
      }
      return _send(data);
    } catch (e) {
      // console.error('❌ [LT-HOOK] res.send hook error:', e);
      return _send(payload);
    }
  };

  next();
});


app.get('/api/listing_tr_map', async (req, res, next) => {
  try {
    // 1) Sprache bestimmen (Query > Session > Cookie > Accept-Language > de)
    const qLang = String(req.query.lang || '').toLowerCase();
    const hdrLang     = String(req.get('x-lang') || '').toLowerCase();
    const cookieLang = String(req.cookies?.lang || '').toLowerCase();
    const acceptFirst = String(req.headers['accept-language'] || '').toLowerCase().split(',')[0].split('-')[0];
    const lang = (qLang && SUPPORTED_LANGS.includes(qLang)) ? qLang
               : (req.session?.lang && SUPPORTED_LANGS.includes(req.session.lang)) ? req.session.lang
               : (cookieLang && SUPPORTED_LANGS.includes(cookieLang)) ? cookieLang
               : (SUPPORTED_LANGS.includes(acceptFirst) ? acceptFirst : 'de');

    // 2) entitie auflösen (id oder route)
    let entitieId = 0;
    const entArg = (req.query.entitie_id ?? req.query.entitie ?? req.query.entitieId ?? '').toString().trim();
    if (/^\d+$/.test(entArg)) {
      entitieId = parseInt(entArg, 10);
    } else if (entArg) {
      const [[row]] = await db.query(`SELECT id FROM ententies WHERE route = ? LIMIT 1`, [entArg]);
      entitieId = row?.id ? Number(row.id) : 0;
    }
    if (!entitieId) return res.json({ entitie_id: 0, lang, count: 0, titles: {} });

    // 3) ids parsen
    const ids = String(req.query.ids || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
    if (!ids.length) return res.json({ entitie_id: entitieId, lang, count: 0, titles: {} });

    const langs = [lang, 'en', 'de'].filter((v,i,a)=> v && SUPPORTED_LANGS.includes(v) && a.indexOf(v)===i);
    console.log(`[TR-API] entitie=${entitieId} lang=${lang} ids=${ids.length} order=${langs.join('>')}`);

    const placeholdersIds   = ids.map(()=>'?').join(',');
    const placeholdersLangs = langs.map(()=>'?').join(',');
    const orderField        = langs.map(()=>'?').join(',');

    const [rows] = await db.query(
      `SELECT advert_id, language, title, description
         FROM listing_translations
        WHERE entitie_id = ?
          AND advert_id IN (${placeholdersIds})
          AND language IN (${placeholdersLangs})
        ORDER BY FIELD(language, ${orderField})`,
      [entitieId, ...ids, ...langs, ...langs]
    );

    // erste (beste) Zeile pro advert_id
    const titles = {};
    const descriptions = {};
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.advert_id)) continue;
      seen.add(r.advert_id);
      if (r.title)       titles[r.advert_id] = r.title;
      if (r.description) descriptions[r.advert_id] = r.description;
    }

    return res.json({
      entitie_id: entitieId,
      lang,
      count: Object.keys(titles).length,
      titles,
      map: titles,
    });
  } catch (err) {
    console.error('[TR-API] error:', err);
    next(err);
  }
});

app.use((req, res, next) => {
  const originalSend = res.send.bind(res);

  res.send = function (body) {
    // 🔒 Guard: schon behandelt → normal senden
    if (res.locals.__handled404) {
      return originalSend(body);
    }

    if (res.statusCode === 404) {
      res.locals.__handled404 = true; // 🔑 verhindert Rekursion

      return res.status(404).render('errors/404', {
        seo: {
          title: '404 – Seite nicht gefunden | Herando',
          meta_description: 'Die aufgerufene Seite oder Kategorie existiert nicht.',
          robots: 'noindex,follow'
        },
        currentUrl: req.originalUrl
      });
    }

    return originalSend(body);
  };

  next();
});

/* ────────────────────────────────────────────────────────────────────────────
 * Router
 * ──────────────────────────────────────────────────────────────────────────── */
app.use(trackRouter);
app.use('/admin', adminRouter);

app.use('/', templateRouter);


// direkt nach dem session-Setup
// bevor deine Routen geladen werden
// Nach Session + req.user Middleware
// direkt nach dem Session-Setup + req.user-Middleware




/* ────────────────────────────────────────────────────────────────────────────
 * HTTPS / SNI
 * ──────────────────────────────────────────────────────────────────────────── */
const options = {
  key:  fs.readFileSync('/etc/ssl/private/herando_com.key',    'utf8'),
  cert: fs.readFileSync('/etc/ssl/certs/herando_com.chain.crt','utf8'),
  SNICallback: (servername, cb) => {
    const ctx = tls.createSecureContext(
      servername && servername.toLowerCase() === 'herando.at'
        ? {
            key:  fs.readFileSync('/etc/ssl/private/herando_at.key',     'utf8'),
            cert: fs.readFileSync('/etc/ssl/certs/herando_at.chain.crt', 'utf8'),
          }
        : {
            key:  fs.readFileSync('/etc/ssl/private/herando_com.key',    'utf8'),
            cert: fs.readFileSync('/etc/ssl/certs/herando_com.chain.crt','utf8'),
          }
    );
    cb(null, ctx);
  }
};

/* ────────────────────────────────────────────────────────────────────────────
 * Server Start
 * ──────────────────────────────────────────────────────────────────────────── */
const port = process.env.PORT || 3004;
https.createServer(options, app).listen(port, '0.0.0.0', () => {
  console.log(`✅ HTTPS-Server läuft auf https://0.0.0.0:${port}`);
});

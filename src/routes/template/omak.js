require('dotenv').config();
const express = require('express');
const router = express.Router();
const { unserialize } = require('php-unserialize');     // ← HIER hinzufügen!
const db             = require('../../db');
const slugify = require('slugify');
const fs     = require('fs');
const path   = require('path');
const nodePath = require('path'); 
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const geoip = require('geoip-lite');
const { buildListingImageResponsive } = require('../../lib/responsive-listing-images');
const { buildPostingCoverResponsive } = require('../../lib/responsive-posting-cover');
const { buildResponsiveHeroAttrs } = require('../../lib/responsive-hero-images');
const DISABLE_PAYMENT = process.env.DISABLE_PAYMENT === 'true';

const imagesBase = path.resolve('/', 'media', 'herando', 'images');

function resolveImageFilename(tableName, itemId, candidate) {
  const dir = path.join(imagesBase, tableName, String(itemId));
  // 1) Kandidat aus DB prüfen
  if (candidate) {
    const candidatePath = path.join(dir, candidate);
    if (fs.existsSync(candidatePath)) {
      return candidate;
    }
  }
  // 2) Fallback: erst‐mögliche Bilddatei im Ordner
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
      .sort();            // optional sortieren
    if (files.length > 0) {
      return files[0];
    }
  } catch (e) {
    // Ordner existiert nicht oder Lesefehler → weiter zum Platzhalter
  }
  // 3) Platzhalter
  return 'placeholder.jpg';
}

function extractImage(serialized) {
  if (!serialized) return null;
  // Wenn JSON, normal verarbeiten
  try {
    const json = JSON.parse(serialized);
    if (json.image) return json.image;
  } catch (e) {
    // Wenn PHP-Serialisierung
    const match = serialized.match(/s:\d+:"([^"]+\.(jpg|png|jpeg|webp))"/i);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function resolveDisplay(field, value) {
  const maps = {
    strap_color: {
      1: "Schwarz",
      2: "Braun",
      3: "Silber",
      4: "Gold",
      255: "Sonstige"
    },
    dial_color: {
      1: "Schwarz",
      2: "Weiß",
      3: "Blau",
      4: "Grün",
      5: "Silber",
      6: "Gold",
      255: "Sonstige"
    }
  };

  return maps[field]?.[value] || value || "-";
}


const specsConfig = {
  cars: [
    { field: 'external',          key: 'labels.common.external_id', fb: 'Externe ID' },
    { field: 'mileage',           key: 'labels.car.mileage',        fb: 'Kilometerstand' },
    { field: 'gearbox',           key: 'labels.car.transmission',   fb: 'Getriebe' },
    { field: 'fuel',              key: 'labels.car.fuel',           fb: 'Kraftstoff' },
    { field: 'firstRegistration', key: 'labels.car.firstReg',       fb: 'Erstzulassung' },
    { field: 'color',             key: 'labels.car.color',          fb: 'Farbe' },
    { field: 'countryName',       key: 'labels.common.country',     fb: 'Land' },
    { field: 'priceFormatted',    key: 'labels.common.price',       fb: 'Preis' },
  ],
  yachts: [
    { field: 'external',      key: 'labels.common.external_id', fb: 'Externe ID' },
    { field: 'model',         key: 'labels.common.model',       fb: 'Modell' },
    { field: 'length',        key: 'labels.yacht.length',       fb: 'Länge (m)' },
    { field: 'beam',          key: 'labels.yacht.beam',         fb: 'Breite (m)' },
    { field: 'engine',        key: 'labels.yacht.engines',      fb: 'Motortyp' },
    { field: 'power',         key: 'labels.yacht.power',        fb: 'Leistung (kW)' },
    { field: 'fuel_tankage',  key: 'labels.yacht.tank',         fb: 'Tankvolumen (l)' },
    { field: 'countryName',   key: 'labels.common.country',     fb: 'Land' },
    { field: 'priceFormatted',key: 'labels.common.price',       fb: 'Preis' },
  ],
  watches: [
    { field: 'external',         key: 'labels.common.external_id', fb: 'Externe ID' },
    { field: 'model',            key: 'labels.common.model',       fb: 'Modell' },
    { field: 'case_material',    key: 'labels.watch.case',         fb: 'Gehäusematerial' },
    { field: 'diameter',         key: 'labels.watch.diameter',     fb: 'Durchmesser' },
    { field: 'movement_caliber', key: 'labels.watch.caliber',      fb: 'Kaliber' },
    { field: 'waterproof',       key: 'labels.watch.waterproof',   fb: 'Wasserdicht' },
    { field: 'countryName',      key: 'labels.common.country',     fb: 'Land' },
    { field: 'priceFormatted',   key: 'labels.common.price',       fb: 'Preis' },
  ],
  properties: [
    { field: 'external',     key: 'labels.common.external_id',   fb: 'Externe ID' },
    { field: 'city',         key: 'labels.property.location',    fb: 'Ort' },
    { field: 'propertytype', key: 'labels.property.property_type', fb: 'Immobilientyp' },
    { field: 'livingarea',   key: 'labels.property.living',      fb: 'Wohnfläche (m²)' },
    { field: 'bedrooms',     key: 'labels.property.bedrooms',    fb: 'Schlafzimmer' },
    { field: 'bathrooms',    key: 'labels.property.baths',       fb: 'Badezimmer' },
    { field: 'year',         key: 'labels.property.built',       fb: 'Baujahr' },
    { field: 'countryName',  key: 'labels.common.country',       fb: 'Land' },
    { field: 'priceFormatted', key: 'labels.common.price',       fb: 'Preis' },
  ]
};
// Server-seitiges t(); nutzt i18next, wenn vorhanden
const tSrv = (key, fb) => {
  const fn = req.t || res.locals?.t; // i18next middleware o.ä.
  try { return fn ? fn(key, { lng: activeLang, defaultValue: fb }) : fb; }
  catch { return fb; }
};


const taxRates = {
  AT: 0.20, BE: 0.21, BG: 0.20, HR: 0.25,
  CY: 0.19, CZ: 0.21, DK: 0.25, EE: 0.20,
  FI: 0.24, FR: 0.20, DE: 0.19, GR: 0.24,
  HU: 0.27, IE: 0.23, IT: 0.22, LV: 0.21,
  LT: 0.21, LU: 0.17, MT: 0.18, NL: 0.21,
  PL: 0.23, PT: 0.23, RO: 0.19, SK: 0.20,
  SI: 0.22, ES: 0.21, SE: 0.25
};
const { generateInvoice } = require('../../service/invoiceService');
const transporter = nodemailer.createTransport({
  host:     process.env.SMTP_HOST,
  port:     parseInt(process.env.SMTP_PORT, 10),
  secure:   process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
// Ganz oben in der Datei, nach allen require-Statements:
const today = new Date().toISOString().slice(0,10);

const authModule = require('./auth'); 
router.use('/auth', authModule);
const buyerRouter = require('./buyer');
router.use('/buyer', buyerRouter);
//const accountRouter = require('./account');
//router.use('/account', accountRouter);

// ---- Whitelist: Cars-Extras als Checkboxen ----
  const CAR_EXTRAS = [
    { field: 'abs', label: 'ABS' },
    { field: 'esp', label: 'ESP' },
    { field: 'asr', label: 'ASR/Traktionskontrolle' },
    { field: 'airbags', label: 'Airbags' },
    { field: 'isofix', label: 'Isofix' },

    { field: 'xenon', label: 'Xenon' },
    { field: 'bixenon', label: 'Bi-Xenon' },
    { field: 'led', label: 'LED' },
    { field: 'laser', label: 'Laserlicht' },
    { field: 'foglamp', label: 'Nebelscheinwerfer' },
    { field: 'daytime_lights', label: 'Tagfahrlicht' },
    { field: 'adaptive_lights', label: 'Adaptives Licht' },
    { field: 'glare_free', label: 'Blendfreies Fernlicht' },
    { field: 'highbeam_assistant', label: 'Fernlichtassistent' },
    { field: 'headlight_washer', label: 'Scheinwerferreinigung' },

    { field: 'immobilizer', label: 'Wegfahrsperre' },
    { field: 'electric_windows', label: 'Elektr. Fensterheber' },
    { field: 'electric_adjusted_seats', label: 'Elektr. Sitze' },
    { field: 'electric_heated_seats', label: 'Sitzheizung' },
    { field: 'ventilated_seats', label: 'Sitzbelüftung' },
    { field: 'electric_mirrors', label: 'Elektr. Spiegel' },
    { field: 'electric_tailgate', label: 'Elektr. Heckklappe' },
    { field: 'assisted_steering', label: 'Servolenkung' },
    { field: 'light_sensor', label: 'Lichtsensor' },
    { field: 'cruise_control', label: 'Tempomat' },
    { field: 'adaptive_cruise_control', label: 'Abstandstempomat' },

    { field: 'collision_avoidance', label: 'Notbremsassistent' },
    { field: 'blind_spot_monitor', label: 'Toter-Winkel-Assistent' },
    { field: 'lane_departure_warning', label: 'Spurhalteassistent' },

    { field: 'aux_heating', label: 'Standheizung' },
    { field: 'central_locking', label: 'Zentralverriegelung' },
    { field: 'keyless_central_locking', label: 'Keyless' },
    { field: 'rain_sensor', label: 'Regensensor' },
    { field: 'head_up_display', label: 'Head-Up-Display' },

    { field: 'climatisation', label: 'Klimaanlage' },

    { field: 'parking_front', label: 'Parksensoren vorne' },
    { field: 'parking_rear', label: 'Parksensoren hinten' },
    { field: 'parking_camera', label: 'Rückfahrkamera' },
    { field: 'parking_self', label: 'Parkassistent' },

    { field: 'tuner_radio', label: 'Radio' },
    { field: 'radio_dab', label: 'DAB' },
    { field: 'mp3interface', label: 'MP3' },
    { field: 'navigation', label: 'Navigation' },
    { field: 'tv', label: 'TV' },
    { field: 'soundsystem', label: 'Soundsystem' },
    { field: 'touchscreen', label: 'Touchscreen' },
    { field: 'voice_control', label: 'Sprachsteuerung' },
    { field: 'usb', label: 'USB' },
    { field: 'apple_car_play', label: 'Apple CarPlay' },
    { field: 'android_auto', label: 'Android Auto' },
    { field: 'wifi_hotspot', label: 'WLAN-Hotspot' },
    { field: 'music_streaming', label: 'Streaming' },
    { field: 'inductive_charging', label: 'Induktives Laden' },
    { field: 'digital_cockpit', label: 'Digitales Cockpit' },
    { field: 'multifunction_steeringwheel', label: 'Multifunktionslenkrad' },
    { field: 'cdplayer', label: 'CD-Player' },
    { field: 'bluetooth', label: 'Bluetooth' },
    { field: 'onboard_computer', label: 'Bordcomputer' },
    { field: 'handsfree_kit', label: 'Freisprecheinrichtung' },

    { field: 'alloy_wheels', label: 'Alufelgen' },
    { field: 'sports_suspension', label: 'Sportfahrwerk' },
    { field: 'sports_package', label: 'Sportpaket' },
    { field: 'sports_seats', label: 'Sportsitze' },
    { field: 'trailer_coupling', label: 'Anhängerkupplung' },

    { field: 'sunroof', label: 'Schiebedach' },
    { field: 'panoramic_roof', label: 'Panoramadach' },
    { field: 'roof_rack', label: 'Dachreling' },
    { field: 'skibag', label: 'Skisack' },

    { field: 'summer_tires', label: 'Sommerreifen' },
    { field: 'winter_tires', label: 'Winterreifen' },
    { field: 'all_season_tires', label: 'Allwetterreifen' },
    { field: 'tire_pressure_monitoring', label: 'Reifendrucksensor' },

    { field: 'winter_package', label: 'Winterpaket' },
    { field: 'smokers_package', label: 'Raucherpaket' },

    { field: 'air_suspension', label: 'Luftfederung' },
    { field: 'startstop_system', label: 'Start/Stopp' },
    { field: 'hill_climb', label: 'Berganfahrhilfe' },
    { field: 'fatigue', label: 'Müdigkeitserkennung' },
    { field: 'dimming_mirror', label: 'Abblendbarer Spiegel' },
    { field: 'nightvision', label: 'Nachtsicht' },
    { field: 'emergency_call', label: 'Notrufsystem' },
    { field: 'traffic_signs', label: 'Verkehrszeichenerkennung' },
    { field: 'speed_limiter', label: 'Geschwindigkeitsbegrenzer' },
    { field: 'distance_warning', label: 'Abstandswarner' },

    { field: 'heated_windshield', label: 'Frontscheibenheizung' },
    { field: 'heated_steering_wheel', label: 'Lenkradheizung' },
    { field: 'arm_rest', label: 'Armlehne' },
    { field: 'lumbar_support', label: 'Lendenwirbelstütze' },
    { field: 'massage_seats', label: 'Massagesitze' },
    { field: 'fold_flat_passenger_seat', label: 'Umklappbarer Beifahrersitz' },
    { field: 'ambient_lighting', label: 'Ambientebeleuchtung' },
    { field: 'leather_steering_wheel', label: 'Lederlenkrad' },
  ];

// Felder die nicht binär sind (Vorhandensein = Wert > 0)
const CAR_EXTRA_NUMERIC_PRESENT = new Set(['climatisation']);
const ENTITY_EXTRA_FIELDS = {
  cars: [
    "cartype", "fuel", "gearbox", "drivetrain",
    "color", "mileage", "year",     "firstregistration",
    "firstregistration_month"  
  ],
  yachts: [
    "yachttype", "length", "beam", "draft", "berths", "year"
  ],
  properties: [
    "propertytype", "bedrooms", "bathrooms", "livingarea"
  ],
  watches: [
    "watchtype", "gender", "movement", "case_material"
  ],
  lifestyles: [
  ]
};


(async () => {
  try {
    // Einfaches Test-Query
    const [rows] = await db.query('SELECT 1+1 AS result');
    console.log(`✅ Datenbank läuft: 1+1 = ${rows[0].result}`);
  } catch (err) {
    console.error('❌ Datenbankverbindung fehlgeschlagen:', err.message);
    process.exit(1); // Optional: Prozess beenden, wenn DB down ist
  }
})();

async function loadLayoutData() {
  // 1) Kategorien
  const [entieties] = await db.query(`
    SELECT id, name, route
      FROM ententies
     ORDER BY id
  `);

  // 2) Footer‑Columns + Links
  const [cols]  = await db.query(`
    SELECT id, title, sort_order
      FROM footer_columns
     ORDER BY sort_order, title
  `);
  const [links] = await db.query(`
    SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
      FROM footer_links
     ORDER BY column_id, sort_order
  `);

  const footerColumns = cols.map(col => ({
    id:         col.id,
    title:      col.title,
    sort_order: col.sort_order,
    phone:      null,
    links:      []
  }));

  for (const l of links) {
    const col = footerColumns.find(c => c.id === l.column_id);
    if (!col) continue;
    if (l.is_phone) col.phone = l.phone_number;
    else            col.links.push({ text: l.link_text, url: l.link_url });
  }

  return { entieties, footerColumns };
}

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


router.get('/auth/login', (req, res) => {
  res.render('pages/templates/login', { error: null, 
    user,
   });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [[user]] = await db.query(
      `SELECT id, email, password, confirmed, role
         FROM users
        WHERE email = ? AND confirmed = 1
        LIMIT 1`,
      [email]
    );
    if (!user) {
      return res.render('pages/templates/login', { error: 'Benutzer nicht gefunden oder nicht bestätigt.'
       });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.render('pages/templates/login', { error: 'Falsches Passwort.'
       });
    }

    console.log(`🔑 Login erfolgreich für User ID=${user.id}, DB-Rolle=${user.role}`);

    req.session.userId = user.id;
    req.session.role   = user.role;
    req.session.lastLogin = new Date(); // 🕒 in Session speichern
    console.log(`💾 In Session gespeichert: userId=${req.session.userId}, role=${req.session.role}`);

    await db.query(
      `UPDATE users SET lastrun = NOW() WHERE id = ?`,
      [user.id]
    );

    console.log(`🕒 Letzter Login für User ID=${user.id} in DB auf ${new Date().toLocaleString('de-DE')} gesetzt.`);



    return res.redirect('/');
  } catch (err) {
    console.error(err);
    return res.render('pages/templates/login', { error: 'Fehler beim Einloggen. Bitte später erneut.'
     });
  }
});

function ensureAdmin(req, res, next) {
  if (!req.session.userId) {
    console.log('🔒 Kein eingeloggter User – Weiterleitung zu /auth/login');
    return res.redirect('/auth/login');
  }

  if (!req.user) {
    console.log('🔒 Zugriff verweigert: req.user ist nicht gesetzt');
    return res.status(403).send('Zugriff verweigert: Ungültige Session.');
  }

  if (req.user.role !== 9) {
    console.log(`🔒 Eingeloggt (ID=${req.session.userId}), aber req.user.role=${req.user.role} (≠ 9)`);
    return res.status(403).send('Zugriff verweigert: Du hast keine Admin-Rechte.');
  }

  console.log(`✅ Zugriff erlaubt: User ID=${req.session.userId}, role=${req.user.role}`);
  next();
}

// ─── Middleware: globales user-Objekt für alle EJS-Templates ─────────────────
router.use(async (req, res, next) => {
  const userId = req.session.userId;
  if (!userId) {
    res.locals.user       = null;
    res.locals.hasPackage = false;
    return next();
  }

  try {
    // 1) Basis‑Userdaten laden
    const [[u]] = await db.query(
      `SELECT firstname, lastname, email, phone
         FROM users
        WHERE id = ?`,
      [userId]
    );
    res.locals.user = u || null;

    // 2) Paket‑Flag
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



router.get('/', async (req, res, next) => {
  const user = res.locals.user;

  try {
    console.log('🛠️  GET / (Startseite) wurde aufgerufen - Admin ist eingeloggt');

    const lang = res.locals.lang; 
    const ui   = res.locals.ui;   
    const t    = res.locals.t;    

    // --- SEO laden (DEIN Block unverändert) ---
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(
      `SELECT 
        title,
        description          AS meta_description,
        robots,
        og_title,
        og_description,
        og_image,
        twitter_card,
        jsonld               AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };
    res.locals.seo = seo;

    // --- DEIN REST bleibt wie gehabt (Autos, Marken, Ententies, Footer, Magazin, etc.) ---
    const [carRows] = await db.query(`
      SELECT id, name AS title, pictures
      FROM cars
      ORDER BY created DESC
      LIMIT 24
    `);
    const items = carRows.map(car => {
      const pics = unserialize(car.pictures || 'a:0:{}') || [];
      const mainPicFilename = Array.isArray(pics) && pics.length > 0
        ? (pics[0] && pics[0].image ? pics[0].image : String(pics[0]))
        : 'placeholder.jpg';
      return {
        id: car.id,
        title: car.title,
        imageUrl: `/images/cars/${car.id}/${encodeURIComponent(mainPicFilename)}`,
        reference: car.title
      };
    });

    const [brandRows] = await db.query(`SELECT id, name FROM marken ORDER BY id`);
    const chunkSize = 10;
    const brandChunks = [];
    for (let i = 0; i < brandRows.length; i += chunkSize) {
      brandChunks.push(brandRows.slice(i, i + chunkSize));
    }

    const currentEntitieId = Math.max(parseInt(req.query.entitieId || '1', 10), 1);
    const [entieties] = await db.query(`
      SELECT id, name, route, table_name
      FROM ententies
      ORDER BY id
    `);

    const [cols] = await db.query(`
      SELECT id, title, sort_order
      FROM footer_columns
      ORDER BY sort_order, title
    `);
    const [links] = await db.query(`
      SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
      FROM footer_links
      ORDER BY column_id, sort_order
    `);
    const footerColumns = cols.map(col => ({
      id: col.id, title: col.title, sort_order: col.sort_order, phone: null, links: []
    }));
    for (const link of links) {
      const colItem = footerColumns.find(c => c.id === link.column_id);
      if (!colItem) continue;
      if (link.is_phone) colItem.phone = link.phone_number;
      else colItem.links.push({ text: link.link_text, url: link.link_url });
    }

// --- Magazin-Posts mit Übersetzungen ---
const currentLang = res.locals.lang || 'de';

const [magRows] = await db.query(`
  SELECT 
    p.id,
    p.slug,
    p.cover_image,
    p.author,
    COALESCE(pt.title, p.title)       AS title,
    COALESCE(pt.content, p.content)   AS content
  FROM postings p
  LEFT JOIN postings_translations pt
    ON pt.post_id = p.id
   AND pt.language = ?
  WHERE p.category = 'magazin'
    AND p.published_at IS NOT NULL
    AND p.published_at <= NOW()
  ORDER BY p.published_at DESC
  LIMIT 8
`, [currentLang]);

const magazinPosts = magRows.map((p, idx) => ({
  title:   p.title,
  slug:    p.slug,
  image:   `/uploads/postings/${p.slug}/${p.cover_image || 'placeholder.jpg'}`,
  coverImg: buildPostingCoverResponsive(p.slug, p.cover_image, idx === 0 ? 'main' : 'side'),
  author:  p.author,
  excerpt: (p.content || '')
             .replace(/<[^>]+>/g, '')   // HTML-Tags weg
             .substring(0, 150)        // Vorschau kürzen
             .trim() + '…'
}));




    const heroSlide1PreloadHref = buildResponsiveHeroAttrs(
      t('home_hero_slide1_image', '/assets/herando-home-slider-luxusimmobilien.webp')
    ).preloadHref;

    // Rendern – JETZT MIT ui UND lang
    res.render('pages/templates/index', {
      items,
      brandChunks,
      currentEntitieId,
      entieties,
      isHomePage: true,
      homeEntityOrder: [],
      footerColumns,
      magazinPosts,
      user,
      popularModels: [],
      moreModelLinks: [],
      ui,
      lang,
      t,
      heroSlide1PreloadHref,
      buildResponsiveHeroAttrs,
    });

  } catch (err) {
    next(err);
  }
});

function makeUrlSlug(str) {
  return str
    .toString()
    .toLowerCase()
    .replace(/<\/?[^>]+(>|$)/g, "")   // entfernt HTML-Tags wie <h1>
    .replace(/\s+/g, '-')             // Leerzeichen → "-"
    .replace(/[^a-z0-9\-]/g, '')      // nur a-z, 0-9 und -
    .replace(/\-\-+/g, '-')           // mehrere - → eins
    .replace(/^-+/, '')               // Trim "-" am Anfang
    .replace(/-+$/, '');              // Trim "-" am Ende
}




// GET /api/catalog_ads/:entitieId
router.get('/api/catalog_ads/:entitieId', async (req, res, next) => {
  const entId = parseInt(req.params.entitieId, 10);
  console.log(`🛠️  GET /api/catalog_ads/${entId} wurde aufgerufen`);

  try {
    // a) Table-Name + Route ermitteln
    const [[ent]] = await db.query(
      'SELECT table_name, route FROM ententies WHERE id = ?',
      [entId]
    );
    if (!ent) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    // b) Extra-Selects & Joins je nach Tabelle
    let extraFields = '';
    let extraJoins = '';

    switch (ent.table_name) {
      case 'cars':
        extraFields = `
          , t.cartype
          , t.mileage
          , t.fuel
          , t.firstregistration
          , t.firstregistration_month
        `;
        break;

      case 'watches':
        extraJoins = 'LEFT JOIN brands b ON b.id = t.brand_id';
        extraFields = `
          , b.name AS brand
          , t.model
          , t.year
          , t.watchtype
          , t.gender
          , t.movement
          , t.case_material
        `;
        break;

      case 'properties':
        extraFields = `
          , t.propertytype
          , t.investmenttype
          , t.bedrooms
          , t.bathrooms
          , t.livingarea
        `;
        break;

      case 'yachts':
        extraFields = `
          , t.yachttype
          , t.length
          , t.beam
          , t.draft
          , t.berths
          , t.year
        `;
        break;
    }

    // c) Aktive Ads aus catalog_ads laden
    const today = new Date().toISOString().slice(0, 10);
    const [adsResult] = await db.query(`
      SELECT
        ca.id           AS catalogAdId,
        ca.advert_id    AS advertId,
        t.name          AS title,
        t.price         AS price,
        t.pictures      AS picturesSerialized,
        t.country_id    AS countryId,
        c.code          AS countryCode,
        c.de            AS countryNameDe,
        c.en            AS countryNameEn
        ${extraFields}
      FROM catalog_ads AS ca
      JOIN ${ent.table_name} AS t
        ON t.id = ca.advert_id
      ${extraJoins}
      LEFT JOIN countries AS c
        ON c.id = t.country_id
      WHERE ca.entitie_id = ?
        AND ca.start_date <= ?
        AND ca.end_date   >= ?
      ORDER BY ca.start_date DESC, ca.id DESC
      LIMIT 24
    `, [entId, today, today]);

    // d) Mapping mit Bildern + Extra-Feldern
    const items = adsResult.map(row => {
      const rawPics  = unserialize(row.picturesSerialized || 'a:0:{}') || [];
      const picsArr  = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);
      const first    = picsArr[0];
      const candidate = (first && typeof first === 'object')
        ? first.image
        : String(first || '');
      const filename = resolveImageFilename(ent.table_name, row.advertId, candidate);
      const listingImg = buildListingImageResponsive(
        ent.table_name,
        row.advertId,
        filename,
        ent.table_name === 'watches'
      );

      return {
        catalogAdId: row.catalogAdId,
        reference:   row.advertId, // für URL
        title:       row.title || `${row.brand || ''} ${row.model || ''}`.trim(),
        price:       row.price,
        priceFormatted: row.price ? new Intl.NumberFormat('de-DE').format(row.price) + ' €' : null,
        imageUrl:    listingImg.src,
        imageSrcset: listingImg.srcset,
        imageSizes: listingImg.sizes,
        countryId:   row.countryId,
        countryCode: row.countryCode,
        countryNameDe: row.countryNameDe,
        countryNameEn: row.countryNameEn,

        // cars
        cartype: row.cartype || null,
        mileage: row.mileage || null,
        fuel: row.fuel || null,
        firstregistration: row.firstregistration || null,
        firstregistration_month: row.firstregistration_month || null,

        // watches
        brand: row.brand || null,
        model: row.model || null,
        year: row.year || null,
        watchtype: row.watchtype || null,
        gender: row.gender || null,
        movement: row.movement || null,
        case_material: row.case_material || null,

        // properties
        propertytype: row.propertytype || null,
        investmenttype: row.investmenttype || null,
        bedrooms: row.bedrooms || null,
        bathrooms: row.bathrooms || null,
        livingarea: row.livingarea || null,

        // yachts
        yachttype: row.yachttype || null,
        length: row.length || null,
        beam: row.beam || null,
        draft: row.draft || null,
        berths: row.berths || null,
      };
    });

    console.log(`   → ${items.length} items geladen für ${ent.table_name}`);
    res.json(items);

  } catch (err) {
    console.error('🚨 Fehler in /api/catalog_ads:', err);
    next(err);
  }
});




router.get('/api/advert_inserat/:entitieId', async (req, res, next) => {
  const entId = parseInt(req.params.entitieId, 10);
  console.log(`🛠️  GET /api/advert_inserat/${entId} wurde aufgerufen`);

  try {
    // a) Table-Name holen
    const [[ent]] = await db.query(
      'SELECT table_name, route FROM ententies WHERE id = ?',
      [entId]
    );
    if (!ent) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    // b) Extra-Selects & Joins je nach Tabelle
    let extraFields = '';
    let extraJoins = '';

    switch (ent.table_name) {
      case 'cars':
        extraFields = `
          , t.cartype
          , t.mileage
          , t.fuel
          , t.firstregistration
          , t.firstregistration_month
        `;
        break;

      case 'watches':
        extraJoins = 'LEFT JOIN brands b ON b.id = t.brand_id';
        extraFields = `
          , b.name AS brand
          , t.model
          , t.year
          , t.watchtype
          , t.gender
          , t.movement
          , t.case_material
        `;
        break;

      case 'properties':
        extraFields = `
          , t.propertytype
          , t.investmenttype
          , t.bedrooms
          , t.bathrooms
          , t.livingarea
        `;
        break;

      case 'yachts':
        extraFields = `
          , t.yachttype
          , t.length
          , t.beam
          , t.draft
          , t.berths
          , t.year
        `;
        break;
    }

    // c) Alle Inserate, die heute aktiv sind
    const today = new Date().toISOString().slice(0, 10);
    const [rows] = await db.query(`
        SELECT
          ai.id         AS adId,
          ai.advert_id  AS itemId,
          ai.start_date AS startDate,
          ai.end_date   AS endDate,
          t.name        AS title,
          t.price       AS price,
          t.pictures    AS picsSerialized,
          t.country_id  AS countryId,
          c.code        AS countryCode,
          c.de          AS countryNameDe,
          c.en          AS countryNameEn
          ${extraFields}
        FROM advert_inserat AS ai
        JOIN ${ent.table_name} AS t
          ON t.id = ai.advert_id
        ${extraJoins}
        LEFT JOIN countries AS c
          ON c.id = t.country_id
        WHERE ai.entitie_id = ?
          AND ai.start_date <= ?
          AND ai.end_date   >= ?
        ORDER BY ai.start_date DESC
        LIMIT 20
    `, [entId, today, today]);

    // d) Mapping
    const items = rows.map(row => {
      const rawPics  = unserialize(row.picsSerialized || 'a:0:{}') || [];
      const picsArr  = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);
      const first    = picsArr[1];
      const candidate = (first && typeof first === 'object')
        ? first.image
        : String(first || '');
      const filename = resolveImageFilename(ent.table_name, row.itemId, candidate);
      const cleanTitle = row.title || `${row.brand || ''} ${row.model || ''}`.trim();
      const listingImg = buildListingImageResponsive(
        ent.table_name,
        row.itemId,
        filename,
        ent.table_name === 'watches'
      );

      return {
        id:        row.adId,
        reference: row.itemId,
        title:     cleanTitle,            // fürs Anzeigen
        slug:      makeUrlSlug(cleanTitle), // fürs Routing
        price:     row.price,
        priceFormatted: row.price ? new Intl.NumberFormat('de-DE').format(row.price) + ' €' : null,
        imageUrl:  listingImg.src,
        imageSrcset: listingImg.srcset,
        imageSizes: listingImg.sizes,
        countryId: row.countryId,
        countryCode: row.countryCode,
        countryNameDe: row.countryNameDe,
        countryNameEn: row.countryNameEn,

        // cars
        cartype: row.cartype || null,
        mileage: row.mileage || null,
        fuel: row.fuel || null,
        firstregistration: row.firstregistration || null,
        firstregistration_month: row.firstregistration_month || null,

        // watches
        brand: row.brand || null,
        model: row.model || null,
        year: row.year || null,
        watchtype: row.watchtype || null,
        gender: row.gender || null,
        movement: row.movement || null,
        case_material: row.case_material || null,

        // properties
        propertytype: row.propertytype || null,
        investmenttype: row.investmenttype || null,
        bedrooms: row.bedrooms || null,
        bathrooms: row.bathrooms || null,
        livingarea: row.livingarea || null,

        // yachts
        yachttype: row.yachttype || null,
        length: row.length || null,
        beam: row.beam || null,
        draft: row.draft || null,
        berths: row.berths || null,
      };
    });

    console.log(`   → ${items.length} items geladen für ${ent.table_name}`);
    res.json(items);

  } catch (err) {
    console.error('🚨 Fehler in /api/advert_inserat:', err);
    next(err);
  }
});




// ─── 1) Suche über alle Entitäten hinweg ───────────────────
// ─── Such‐Route (/search) ───────────────────────────────────────────────────
router.get('/search', async (req, res, next) => {
  const user = res.locals.user;

  try {
    const searchTerm = (req.query.q || '').trim();
    console.log(`🛠️  GET /search?q=${searchTerm} aufgerufen`);

    // 1) Lade alle Entitäten (für Navbar oder Filter)
    const [entieties] = await db.query(`
      SELECT id, name, route, table_name, description
        FROM ententies
       ORDER BY id
    `);
    console.log('→ Kategorien geladen:', entieties.map(e => e.route).join(', '));

    // 2) Wenn kein Suchbegriff, direkt leeres Ergebnis rendern
    if (!searchTerm) {
      return res.render('pages/templates/search', {
        entieties,
        searchTerm: '',
        items: [],
        currentPage: 1,
        totalPages: 0,
        limit: 60
      });
    }

    // 3) Suche in jeder Entitätstabelle nach name LIKE '%Suchbegriff%'
    let allItems = [];
    for (const ent of entieties) {
      const table = db.escapeId(ent.table_name);
      const sql = `
        SELECT
          id,
          pictures,
          price,
          name
        FROM ${table}
        WHERE status = 3
          AND visible = 1
          AND name LIKE ?
      `;
      const params = [`%${searchTerm}%`];

      console.log(`→ Suche in ${ent.table_name} nach '%${searchTerm}%': ${sql}`);
      const [rows] = await db.query(sql, params);

      const mapped = rows.map(row => {
        let raw;
        try {
          raw = unserialize(row.pictures || 'a:0:{}') || [];
        } catch {
          raw = [];
        }
        const pics    = Array.isArray(raw) ? raw : Object.values(raw);
        const mainPic = pics[0]?.image || 'placeholder.jpg';
        const priceNum = row.price != null ? Number(row.price) : null;

        return {
          id:             row.id,
          title:          row.name,
          pictures:       pics,
          mainPic,
          price:          priceNum,
          priceFormatted: priceNum > 0
                            ? priceNum.toLocaleString('de-DE') + ' €'
                            : 'Preis auf Anfrage',
          route:          ent.route
        };
      });

      console.log(`→ ${ent.route}: ${mapped.length} Treffer`);
      allItems = allItems.concat(mapped);
    }

    // 4) Sortiere alphabetisch nach Titel
    allItems.sort((a, b) => a.title.localeCompare(b.title));

    // 5) Paginierung
    const currentPage = Math.max(1, parseInt(req.query.hp, 10) || 1);
    const limit       = Math.max(1, parseInt(req.query.limit, 10) || 60);
    const offset      = (currentPage - 1) * limit;
    const totalCount  = allItems.length;
    const totalPages  = Math.ceil(totalCount / limit);

    console.log(`→ Gesamt‐Suchtreffer: ${totalCount}, Seite ${currentPage}/${totalPages}`);

    // 6) Nur die aktuelle Seite ausliefern
    const pageItems = allItems.slice(offset, offset + limit);

     const [cols]  = await db.query(
      `SELECT id, title, sort_order
         FROM footer_columns
        ORDER BY sort_order, title`
    );
    const [links] = await db.query(
      `SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
         FROM footer_links
        ORDER BY column_id, sort_order`
    );
    // Gruppieren
    const footerColumns = cols.map(col => ({
      id:         col.id,
      title:      col.title,
      sort_order: col.sort_order,
      phone:      null,
      links:      []
    }));
    for (const link of links) {
      const col = footerColumns.find(c => c.id === link.column_id);
      if (!col) continue;
      if (link.is_phone) col.phone = link.phone_number;
      else               col.links.push({ text: link.link_text, url: link.link_url });
    }

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
  title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
  meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
  robots:              seoRow?.robots || 'index,follow',
  canonical_url:       buildCanonical(req),
  og_title:            seoRow?.og_title || seoRow?.title || null,
  og_description:      seoRow?.og_description || seoRow?.meta_description || null,
  og_image:            seoRow?.og_image || null,
  twitter_card:        seoRow?.twitter_card || 'summary_large_image',
  structured_data_json:seoRow?.structured_data_json || null,
  hreflang_json:       null
};

// Lokale Variable für alle Views verfügbar
res.locals.seo = seo;

    // 7) Rendern des Templates „search.ejs“
    return res.render('pages/templates/search', {
      entieties,
      searchTerm,
      items: pageItems,
      currentPage,
      totalPages,
      limit, 
      footerColumns,
      user,
    });
  } catch (err) {
    console.error('🔥  Fehler in GET /search:', err);
    return next(err);
  }
});

router.get('/angebote', async (req, res, next) => {
  const user = res.locals.user;

  try {
    // 1) Alle Pakete laden
    const [packages] = await db.query(`
      SELECT id, name, description, price, registration_type
        FROM packages
       ORDER BY sort_order
    `);

    const commercialPackages = packages.filter(p => p.registration_type === 'commercial');
    const privatePackages = packages.filter(p => p.registration_type === 'private');

    // 2) Alle Länder für das Select (deutscher Name)
    const [countries] = await db.query(`
      SELECT id, de AS name
        FROM countries
       WHERE visible = 1
       ORDER BY de
    `);

    // 3) Alle Kategorien (ententies)
    const [categories] = await db.query(`
      SELECT id, name
        FROM ententies
       ORDER BY name
    `);

    // ─── NEU: Footer-Daten laden ──────────────────────────
    const [cols]  = await db.query(
      `SELECT id, title, sort_order
         FROM footer_columns
        ORDER BY sort_order, title`
    );
    const [links] = await db.query(
      `SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
         FROM footer_links
        ORDER BY column_id, sort_order`
    );
    // Gruppieren
    const footerColumns = cols.map(col => ({
      id:         col.id,
      title:      col.title,
      sort_order: col.sort_order,
      phone:      null,
      links:      []
    }));
    for (const link of links) {
      const col = footerColumns.find(c => c.id === link.column_id);
      if (!col) continue;
      if (link.is_phone) col.phone = link.phone_number;
      else               col.links.push({ text: link.link_text, url: link.link_url });
    }
    

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
  title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
  meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
  robots:              seoRow?.robots || 'index,follow',
  canonical_url:       buildCanonical(req),
  og_title:            seoRow?.og_title || seoRow?.title || null,
  og_description:      seoRow?.og_description || seoRow?.meta_description || null,
  og_image:            seoRow?.og_image || null,
  twitter_card:        seoRow?.twitter_card || 'summary_large_image',
  structured_data_json:seoRow?.structured_data_json || null,
  hreflang_json:       null
};

// Lokale Variable für alle Views verfügbar
res.locals.seo = seo;

    console.log('🟢 [Angebote] commercialPackages:', commercialPackages.length);
    console.log('🟢 [Angebote] privatePackages:', privatePackages.length);

    res.render('pages/templates/angebote', {
      commercialPackages,
      privatePackages,
      packages,
      countries,
      categories, 
      entieties: categories,
      footerColumns,
      user,

    });
  } catch (err) {
    next(err);
  }
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

router.post('/angebote/buchen', async (req, res, next) => {
  try {
    console.log('POST /angebote/buchen aufgerufen');

    // ─── 1) E-Mail-Check ───────────────────────────────────
    const [[existingUser]] = await db.query(
      `SELECT id FROM users WHERE email = ?`,
      [req.body.email]
    );
    if (existingUser && existingUser.id) {
      console.warn('E-Mail bereits registriert:', req.body.email);
      return res
        .status(400)
        .send('Für diese E-Mail existiert bereits ein Benutzer. Bitte melden Sie sich an.');
    }

    // ─── 2) Session–Daten & Pflichtfelder ────────────────
    req.session.pendingOrder = {
      package_id:  req.body.package_id,
      category_id: req.body.category_id,
      country_id:  req.body.country_id,
      vatid:       req.body.vatid,
      firstname:   req.body.firstname,
      lastname:    req.body.lastname,
      company:     req.body.company,
      street:      req.body.street,
      housenumber: req.body.housenumber,
      postcode:    req.body.postcode,
      city:        req.body.city,
      phone:       req.body.phone,
      email:       req.body.email
    };
    const required = [
      'package_id','country_id','firstname','lastname',
      'street','housenumber','postcode','city','email'
    ];
    for (const f of required) {
      if (!req.session.pendingOrder[f]) {
        console.warn(`Fehlendes Pflichtfeld: ${f}`);
        return res.status(400).send(`Fehlendes Pflichtfeld: ${f}`);
      }
    }

    // ─── 3a) Paketinfos holen ─────────────────────────────
    const [[pkgInfo]] = await db.query(
      `SELECT name, price FROM packages WHERE id = ?`,
      [req.body.package_id]
    );
    if (!pkgInfo) {
      console.error('Kein Paket gefunden mit ID:', req.body.package_id);
      return res.status(404).send('Paket nicht gefunden');
    }

    // ─── 3b) Country-Meta (Name & Code) aus countries ─────
    const [[countryMeta]] = await db.query(
      `SELECT de AS countryName, code AS countryCode
         FROM countries
        WHERE id = ?`,
      [req.body.country_id]
    );
    if (!countryMeta) {
      console.error('Kein Land gefunden mit ID:', req.body.country_id);
      return res.status(404).send('Land nicht gefunden');
    }

    // ─── 3c) Steuersatz & Abkürzung aus country_tax_rates ─
    const [[countryTax]] = await db.query(
      `SELECT tax_rate, abbreviation
         FROM country_tax_rates
        WHERE country_id = ?`,
      [req.body.country_id]
    );
    const baseTaxRate = countryTax?.tax_rate     ?? 0;
    const countryAbbr = countryTax?.abbreviation ?? countryMeta.countryCode;

    // ─── 3d) Netto-Betrag aus DB holen (nicht dividieren!) ─
    const netCalculated = pkgInfo.price;  // <–– Hier: Preis aus DB ist bereits Netto

    console.log(`DEBUG: Netto-Preis aus DB = ${netCalculated} €, VAT-ID = "${req.body.vatid}", country = "${countryMeta.countryCode}"`);

    // ─── 4) Dry-Run-Order zusammenbauen ────────────────────
    const dryRunOrder = {
      product:              pkgInfo.name,
      amount:               netCalculated,
      taxPercentage:        baseTaxRate,
      partner_first_name:   req.body.firstname,
      partner_last_name:    req.body.lastname,
      partner_firmenname:   req.body.company,
      partner_address:      `${req.body.street} ${req.body.housenumber}`,
      partner_city:         `${req.body.postcode} ${req.body.city}`,
      partner_country:      countryMeta.countryCode,
      partner_atu_nummer:   req.body.vatid,
      partner_partnerident: 'DUMMY-ID',
      partner_abbreviation: countryAbbr,
      order_number:         'DUMMY-000'
    };

    // ─── 5) Dry-Run: PDF erzeugen testen ──────────────────
    try {
      await testInvoice(dryRunOrder);
      console.log('Vorkontrolle: Rechnung kann erstellt werden');
    } catch (err) {
      console.error('Vorkontrolle fehlgeschlagen:', err);
      return res
        .status(500)
        .send('Fehler bei der Rechnungs-Erstellung. Bitte prüfen Sie Ihre Eingaben.');
    }

    // ─── 6) Testmodus: PDF-Vorschau liefern ────────────────
    if (DISABLE_PAYMENT) {
      console.log('Payment deaktiviert – liefere PDF-Vorschau aus');
      return generateInvoice(dryRunOrder, (err, pdfBytes) => {
        if (err) {
          console.error('PDF-Generierung im Testmodus fehlgeschlagen:', err);
          return res.status(500).send('Fehler beim Erzeugen der Test-PDF.');
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="rechnung_preview.pdf"');
        res.send(pdfBytes);
      });
    }

    // ─── 7) Country-Code in Session ───────────────────────
    req.session.pendingOrder.country_code = countryMeta.countryCode;
    console.log('Country-Code:', countryMeta.countryCode);

    // ─── 8) Netto → Brutto-Berechnung für Stripe ─────────
    const vatForStripe = (!req.body.vatid || countryMeta.countryCode === 'CZ')
                          ? baseTaxRate
                          : 0;
    const grossPrice  = netCalculated * (1 + vatForStripe / 100);
    const amountCents = Math.round(grossPrice * 100);

    console.log(`DEBUG: Stripe rechnet Brutto = ${grossPrice.toFixed(2)} € (Netto ${netCalculated} € + ${vatForStripe}% MwSt) als ${amountCents} Cent`);

    // ─── 9) Stripe-Checkout-Session erzeugen ─────────────
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `Paket #${req.body.package_id}` },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      client_reference_id: 'pending',
      success_url: `${req.protocol}://${req.get('host')}/zahlung/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${req.protocol}://${req.get('host')}/angebote?canceled=1`
    });
    console.log('Stripe-Checkout-Session erzeugt:', session.id);

    // ─── 10) Redirect zu Stripe ───────────────────────────
    res.redirect(303, session.url);

  } catch (err) {
    console.error('Fehler in POST /angebote/buchen:', err);
    next(err);
  }
});

router.get('/zahlung/success', async (req, res, next) => {
  const user = res.locals.user;

  try {
    const sessionId = req.query.session_id;
    const pending   = req.session.pendingOrder;
    if (!sessionId || !pending) {
      return res.status(400).send('Ungültiger Vorgang.');
    }

    // 1) Stripe-Session prüfen
    const sessionObj = await stripe.checkout.sessions.retrieve(sessionId);
    if (sessionObj.payment_status !== 'paid') {
      return res.status(400).send('Zahlung nicht abgeschlossen.');
    }

    // 2) User anlegen oder finden
    const data = pending;
    let [[userRow]] = await db.query(
      `SELECT id, language FROM users WHERE email = ?`,
      [data.email]
    );
    const isNewUser = !(userRow && userRow.id);
    let userId, lang;
    if (isNewUser) {
      const saltRounds = 10;
      const rawPassword = 'herando123';
      const hashedPassword = await bcrypt.hash(rawPassword, saltRounds);

      const [r] = await db.query(
        `INSERT INTO users
          (firstname, lastname, email, street, housenumber, postcode, city,
            phone, company, vatid, password, language, created, modified)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [
          data.firstname,
          data.lastname,
          data.email,
          data.street,
          data.housenumber,
          data.postcode,
          data.city,
          data.phone,
          data.company,
          data.vatid,
          hashedPassword,
          data.language || 'de'
        ]
      );
      userId = r.insertId;
      lang   = data.language || 'de';
    } else {
      userId = userRow.id;
      lang   = userRow.language || 'de';
    }

    // 3) Order anlegen
    const [[pkgNameRow]] = await db.query(
      `SELECT name FROM packages WHERE id = ?`,
      [data.package_id]
    );
    const productName = pkgNameRow.name;
    const [orderRes] = await db.query(
      `INSERT INTO orders
         (user_id, package_id, product, category_id, country_id,
          firstname, lastname, company, vatid,
          street, housenumber, postcode, city, phone, email, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        userId,
        data.package_id,
        productName,
        data.category_id,
        data.country_id,
        data.firstname,
        data.lastname,
        data.company,
        data.vatid,
        data.street,
        data.housenumber,
        data.postcode,
        data.city,
        data.phone,
        data.email
      ]
    );
    const orderId = orderRes.insertId;

    // 4) selected_packages anlegen
    const [[pkg]] = await db.query(
      `SELECT duration_amt, duration_unit, inseratenanzahl
         FROM packages WHERE id = ?`,
      [data.package_id]
    );
    const startDate = new Date();
    const endDate   = new Date(startDate);
    const jsUnits = { days: 'Date', months: 'Month', years: 'FullYear' };
    const jsUnit  = jsUnits[pkg.duration_unit] || 'Date';
    endDate[`set${jsUnit}`]( endDate[`get${jsUnit}`]() + pkg.duration_amt );
    await db.query(
      `INSERT INTO selected_packages
         (user_id, package_id, category_id, country_id,
          start_date, end_date, max_listings, used_listings, order_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,NOW())`,
      [
        userId,
        data.package_id,
        data.category_id,
        data.country_id,
        startDate,
        endDate,
        pkg.inseratenanzahl,
        0,
        orderId
      ]
    );

    // 5) Payment-Record anlegen
    await db.query(
      `INSERT INTO payments
         (order_id, amount, currency, provider_id, status, created_at)
       VALUES (?,?,?,?,?,NOW())`,
      [
        orderId,
        sessionObj.amount_total / 100,
        sessionObj.currency.toUpperCase(),
        sessionObj.payment_intent,
        'succeeded'
      ]
    );

    // 6) PDF-Rechnung generieren & speichern
    const [[orderData]] = await db.query(
      `SELECT 
         o.*,
         p.name           AS product,
         pm.amount        AS amount,
         ctr.tax_rate     AS taxPercentage,
         u.id             AS partner_partnerident,
         u.firstname      AS partner_first_name,
         u.lastname       AS partner_last_name,
         u.company        AS partner_firmenname,
         CONCAT(u.street,' ',u.housenumber) AS partner_address,
         CONCAT(u.postcode,' ',u.city)       AS partner_city,
         c.de             AS partner_country,
         u.vatid          AS partner_atu_nummer,
         ctr.abbreviation AS partner_abbreviation,
         o.id             AS order_number
       FROM orders o
       JOIN payments pm       ON pm.order_id             = o.id
       JOIN packages p        ON p.id                    = o.package_id
       JOIN users u           ON u.id                    = o.user_id
       JOIN countries c       ON c.id                    = o.country_id
       LEFT JOIN country_tax_rates ctr
         ON ctr.country_id    = o.country_id
       WHERE o.id = ?`,
      [orderId]
    );

    generateInvoice(orderData, async (err, pdfBytes) => {
      if (err) return console.error(err);
      const outDir = process.env.INVOICE_OUTPUT_DIR;
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const filePath = path.join(outDir, `invoice_${orderId}.pdf`);
      fs.writeFileSync(filePath, pdfBytes);

      // Übersetzungen laden
      const subjInvoice = await t('mail.invoice.subject', lang);
      const textInvoice = await t('mail.invoice.text', lang);

      // 7a) E-Mail mit Rechnung versenden
      transporter.sendMail({
        from:    process.env.SMTP_USER,
        to:      data.email,
        subject: subjInvoice,
        text:    textInvoice,
        attachments: [{ filename: `invoice_${orderId}.pdf`, path: filePath }]
      }, errMail => { if (errMail) console.error('Mail (Rechnung) error:', errMail); });

      // 7b) Zugangsdaten-Mail bei neuem User
      if (isNewUser) {
        const subjCred = await t('mail.credentials.subject', lang);
        let bodyCred   = await t('mail.credentials.body', lang);
        bodyCred = bodyCred
          .replace('{{email}}', data.email)
          .replace('{{password}}', 'herando123');

        transporter.sendMail({
          from:    process.env.SMTP_USER,
          to:      data.email,
          subject: subjCred,
          html:    bodyCred
        }, errCred => { if (errCred) console.error('Mail (Credentials) error:', errCred); });
      }
    });

    // 8) Cleanup & Bestätigungsseite
    delete req.session.pendingOrder;
    res.render('pages/templates/zahlung-success', {
      orderId,
      invoiceUrl: `/assets/pdf/invoices/invoice_${orderId}.pdf`, 
      pendingEmail: data.email,
      user,
    });

  } catch (err) {
    console.error('Error in /zahlung/success:', err);
    next(err);
  }
});


// Magazin-Übersicht
router.get('/magazin', async (req, res, next) => {
  const user = res.locals.user;

  // ✅ Sprachwahl: Query > Middleware > Cookie > Default
  const currentLang =
    req.query.lang ||
    res.locals.lang ||   // von Middleware (Session.lang)
    req.cookies.lang ||
    'de';

  try {
    console.log("🌍 Query.lang:", req.query.lang);
    console.log("🌍 res.locals.lang:", res.locals.lang);
    console.log("🌍 Cookie.lang:", req.cookies.lang);
    console.log("🌍 currentLang (nach Fallback):", currentLang);

    // Header-Nav
    const [entieties] = await db.query(`
      SELECT id, name, route
      FROM ententies
      ORDER BY id
    `);

    // Magazin-Posts (Basisdaten)
    const [rows] = await db.query(`
      SELECT id, title, slug, cover_image, author, content, published_at
      FROM postings
      WHERE category = 'magazin'
        AND published_at IS NOT NULL
      ORDER BY (published_at <= NOW()) DESC,
        CASE WHEN published_at <= NOW() THEN published_at END DESC,
        CASE WHEN published_at > NOW() THEN published_at END ASC
      LIMIT 10
    `);
    console.log("📰 Gefundene Magazin-Posts:", rows.length);

    // Übersetzungen
    let translations = {};
    if (currentLang !== 'de' && rows.length) {
      const ids = rows.map(r => r.id);
      console.log("🔎 Hole Übersetzungen für IDs:", ids);

      const placeholders = ids.map(() => '?').join(',');
      const sql = `
        SELECT post_id, title, content, seo_title, seo_description
        FROM postings_translations
        WHERE language = ? AND post_id IN (${placeholders})
      `;
      console.log("📜 SQL-Query:", sql);

      const [trs] = await db.query(sql, [currentLang, ...ids]);
      console.log(`📑 Gefundene Übersetzungen (${currentLang}):`, trs.length);

      for (const t of trs) {
        console.log(`✅ Übersetzung gefunden für Post ${t.post_id}: "${t.title}"`);
        translations[t.post_id] = t;
      }
    } else {
      console.log("⚠️ Keine Übersetzungen geladen (entweder Sprache = de oder keine Posts).");
    }

    // Aufbereiten
    const magazinPosts = rows.map(p => {
      const tr = translations[p.id];
      const title   = tr?.title || p.title;
      const content = tr?.content || p.content;
      const seoTitle = tr?.seo_title || title;
      const seoDesc  = tr?.seo_description || (content || '').replace(/<[^>]+>/g, '').substring(0, 160).trim();

      if (tr) {
        console.log(`🌐 Post ${p.id} (${p.slug}) mit Übersetzung -> "${title}"`);
      } else {
        console.log(`🟡 Post ${p.id} (${p.slug}) ohne Übersetzung -> nutze Original "${title}"`);
      }

      return {
        id: p.id,
        title,
        slug: p.slug,
        image: `/uploads/postings/${p.slug}/${p.cover_image || 'placeholder.jpg'}`,
        author: p.author,
        excerpt: (content || '').replace(/<[^>]+>/g, '').substring(0, 200).trim() + '…',
        seo_title: seoTitle,
        seo_description: seoDesc,
        published_at: p.published_at
      };
    });

    // Footer
    const [cols] = await db.query(`
      SELECT id, title, sort_order
      FROM footer_columns
      ORDER BY sort_order, title
    `);
    const [links] = await db.query(`
      SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
      FROM footer_links
      ORDER BY column_id, sort_order
    `);
    const footerColumns = cols.map(col => ({
      id: col.id,
      title: col.title,
      sort_order: col.sort_order,
      phone: null,
      links: []
    }));
    for (const link of links) {
      const col = footerColumns.find(c => c.id === link.column_id);
      if (!col) continue;
      if (link.is_phone) col.phone = link.phone_number;
      else col.links.push({ text: link.link_text, url: link.link_url });
    }

    // SEO-Meta global
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

    console.log("🔧 SEO Row geladen:", seoRow ? "Ja" : "Nein");

    const seo = {
      title: seoRow?.title || 'Herando Magazin – News, Trends & Luxus',
      meta_description: seoRow?.meta_description || 'Entdecken Sie spannende Artikel im Herando Magazin über Luxus, Autos, Immobilien, Yachten und mehr.',
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

    console.log("🚀 Render Magazin-Seite mit Sprache:", currentLang);

    // Rendern
    res.render('pages/templates/magazin', {
      entieties,
      magazinPosts,
      active: 'magazin',
      footerColumns,
      user,
      t: res.locals.t,
      lang: currentLang
    });
  } catch (err) {
    console.error("❌ Fehler in /magazin:", err);
    next(err);
  }
});






// Magazin-Detailseite
router.get('/magazin/:slug', async (req, res, next) => {
  const user = res.locals.user;

  // ✅ Sprachwahl: Query > Middleware > Cookie > Default
  const currentLang =
    req.query.lang ||
    res.locals.lang ||   // von Middleware (Session.lang)
    req.cookies.lang ||
    'de';

  try {
    console.log("🌍 Query.lang:", req.query.lang);
    console.log("🌍 res.locals.lang:", res.locals.lang);
    console.log("🌍 Cookie.lang:", req.cookies.lang);
    console.log("🌍 currentLang (nach Fallback):", currentLang);

    const slug = req.params.slug;

    // Header
    const [entieties] = await db.query(`
      SELECT id, name, route
      FROM ententies
      ORDER BY id
    `);

    // Footer
    const [cols] = await db.query(`
      SELECT id, title, sort_order
      FROM footer_columns
      ORDER BY sort_order, title
    `);
    const [links] = await db.query(`
      SELECT column_id, link_text, link_url, is_phone, phone_number, sort_order
      FROM footer_links
      ORDER BY column_id, sort_order
    `);
    const footerColumns = cols.map(col => ({
      id: col.id,
      title: col.title,
      sort_order: col.sort_order,
      phone: null,
      links: []
    }));
    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else col.links.push({ text: l.link_text, url: l.link_url });
    }

    // Original-Posting
    const [[page]] = await db.query(`
      SELECT id, title, slug, author, location, cover_image, additional_images, content, created, published_at
      FROM postings
      WHERE slug = ?
        AND published_at IS NOT NULL
    `, [slug]);

    if (!page) {
      console.warn("❌ Kein Posting gefunden für Slug:", slug);
      return res.status(404).send('Nicht gefunden');
    }

    console.log(`📰 Gefundenes Posting: ID=${page.id}, Slug=${page.slug}, Titel="${page.title}"`);

    // Übersetzung checken
    let translation = null;
    if (currentLang !== 'de') {
      const [[trow]] = await db.query(`
        SELECT title, content, seo_title, seo_description
        FROM postings_translations
        WHERE post_id = ? AND language = ?
      `, [page.id, currentLang]);

      if (trow) {
        translation = trow;
        console.log(`✅ Übersetzung geladen für Post ${page.id} (${slug}) -> "${translation.title}"`);
      } else {
        console.log(`🟡 Keine Übersetzung für Post ${page.id} (${slug}) in Sprache "${currentLang}"`);
      }
    } else {
      console.log("⚠️ Sprache = de, keine Übersetzungen geladen.");
    }

    // JSON-Feld parsen
    try {
      page.additional_images = JSON.parse(page.additional_images);
    } catch {
      page.additional_images = [];
    }

    // SEO
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
    `, [normalizePathUrl(req.path)]);

    console.log("🔧 SEO Row geladen:", seoRow ? "Ja" : "Nein");

    const isUpcoming =
      page.published_at && new Date(page.published_at) > new Date();

    const seo = {
      title: translation?.seo_title || seoRow?.title || page.title,
      meta_description: translation?.seo_description || seoRow?.meta_description || null,
      robots: isUpcoming ? 'noindex,follow' : (seoRow?.robots || 'index,follow'),
      canonical_url: buildCanonical(req),
      og_title: translation?.seo_title || seoRow?.og_title || null,
      og_description: translation?.seo_description || seoRow?.og_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };

    res.locals.seo = seo;

    console.log("🚀 Render Detailseite mit Sprache:", currentLang);

    // Render
    res.render('pages/templates/magazin-show', {
      entieties,
      footerColumns,
      page: {
        ...page,
        title: translation?.title || page.title,
        content: translation?.content || page.content
      },
      active: 'magazin',
      user,
      t: res.locals.t,
      lang: currentLang
    });
  } catch (err) {
    console.error("❌ Fehler in /magazin/:slug:", err);
    next(err);
  }
});



function isValidEmail(email){
return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}


// GET /newsletter/entities – liefert alle Ententies
router.get('/newsletter/entities', async (req, res) => {
try {
const [rows] = await db.query('SELECT id, name FROM ententies ORDER BY name');
res.json({ entities: rows });
} catch (err) {
console.error('getNewsletterEntities error', err);
res.status(500).json({ message: 'Serverfehler' });
}
});


router.post('/newsletter/subscribe', async (req, res) => {
try {
const { email, ententies_id, accepted } = req.body || {};


if (!isValidEmail(email)) {
return res.status(400).json({ message: 'Bitte eine gültige E‑Mail angeben.' });
}
if (!ententies_id) {
return res.status(400).json({ message: 'Bitte eine Kategorie wählen.' });
}
if (String(accepted) !== '1') {
return res.status(400).json({ message: 'Bitte Einwilligung bestätigen.' });
}


// prüfen ob ententies_id existiert
const [check] = await db.query('SELECT id FROM ententies WHERE id = ? LIMIT 1', [ententies_id]);
if (!check.length) {
return res.status(400).json({ message: 'Ungültige Kategorie.' });
}


const sql = `
INSERT INTO newsletter_subscribers (email, accepted, ententies_id)
VALUES (?, 1, ?)
ON DUPLICATE KEY UPDATE
accepted = VALUES(accepted),
ententies_id = VALUES(ententies_id)
`;


await db.query(sql, [email.trim(), ententies_id]);
res.json({ ok: true, message: 'Abonniert' });
} catch (err) {
console.error('subscribeNewsletter error', err);
res.status(500).json({ message: 'Serverfehler' });
}
});

router.get('/newsletter/check', async (req, res) => {
  try {
    const userEmail = req.session?.userEmail || null;
    if (!userEmail) return res.json({ subscribed: false });

    const [rows] = await db.query(
      'SELECT id FROM newsletter_subscribers WHERE email = ? AND accepted = 1 LIMIT 1',
      [userEmail]
    );

    res.json({ subscribed: rows.length > 0 });
  } catch (err) {
    console.error('Newsletter Check Error:', err);
    res.status(500).json({ subscribed: false });
  }
});


/*
router.post('/newsletter/subscribe', async (req, res, next) => {
  try {
    console.log('🔔 POST /newsletter/subscribe aufgerufen');
    console.log('Body:', req.body);

    const { email, privacy } = req.body;
    if (!email || privacy !== 'on') {
      console.log('❌ Validierung fehlgeschlagen – E-Mail oder Datenschutz fehlt');
      req.flash('error', 'Bitte E-Mail und Datenschutz akzeptieren.');
      return res.redirect(req.get('Referrer') || '/');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const ipAddress       = req.headers['x-forwarded-for']?.split(',').shift()
                         || req.socket.remoteAddress;
    // bcrypt.genSaltSync erzeugt einen zufälligen Salt-String – ideal als Token
    const hashToken       = bcrypt.genSaltSync(16);

    console.log('✅ E-Mail:', normalizedEmail);
    console.log('🌐 IP:', ipAddress);
    console.log('🔑 Hash-Token:', hashToken);

await db.query(`
  INSERT INTO newsletter
    (email, dsgvo, ip, hash, confirmed, created, modified)
  VALUES (?, 1, ?, ?, 0, NOW(), NOW())
  ON DUPLICATE KEY UPDATE
    dsgvo     = VALUES(dsgvo),
    ip        = VALUES(ip),
    hash      = VALUES(hash),
    confirmed = 0,
    modified  = NOW()
`, [
  normalizedEmail,
  ipAddress,
  hashToken
]);


    console.log('🎉 Anmeldung erfolgreich, Weiterleitung...');
    req.flash('success', 'Danke für Ihre Anmeldung! Bitte prüfen Sie jetzt Ihre E-Mail für die Bestätigung.');
    res.redirect(req.get('Referrer') || '/');
  } catch (err) {
    console.error('🚨 Fehler in /newsletter/subscribe:', err);
    next(err);
  }
});*/



router.get('/:pageKey', async (req, res, next) => {
  const user = res.locals.user;

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
      return next();
    }

    // 2) Hole die Kategorien (für die Navbar im Header)
    const [entieties] = await db.query(`
      SELECT name, route
        FROM ententies
       ORDER BY name
    `);

    // ─── NEU: Footer-Daten laden ──────────────────────────
    const [cols]  = await db.query(
      `SELECT id, title, sort_order
         FROM footer_columns
        ORDER BY sort_order, title`
    );
    const [links] = await db.query(
      `SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
         FROM footer_links
        ORDER BY column_id, sort_order`
    );
    // Gruppieren
    const footerColumns = cols.map(col => ({
      id:         col.id,
      title:      col.title,
      sort_order: col.sort_order,
      phone:      null,
      links:      []
    }));
    for (const link of links) {
      const col = footerColumns.find(c => c.id === link.column_id);
      if (!col) continue;
      if (link.is_phone) col.phone = link.phone_number;
      else               col.links.push({ text: link.link_text, url: link.link_url });
    }

    // 3) Rendern und beide Variablen übergeben

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
  title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
  meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
  robots:              seoRow?.robots || 'index,follow',
  canonical_url:       buildCanonical(req),
  og_title:            seoRow?.og_title || seoRow?.title || null,
  og_description:      seoRow?.og_description || seoRow?.meta_description || null,
  og_image:            seoRow?.og_image || null,
  twitter_card:        seoRow?.twitter_card || 'summary_large_image',
  structured_data_json:seoRow?.structured_data_json || null,
  hreflang_json:       null
};

// Lokale Variable für alle Views verfügbar
res.locals.seo = seo;

    res.render('pages/templates/pages/show', {
      page,        
      entieties, 
      footerColumns,
      user,
    });
  } catch (err) {
    next(err);
  }
});

// src/routes/template/index.js

router.get('/verkaufen-:slug', async (req, res, next) => {
  const user = res.locals.user;

  try {
    const slug = req.params.slug;

    // 1) Landing-Page laden
    const [[page]] = await db.query(
      `SELECT * FROM landing_pages WHERE slug = ?`,
      [slug]
    );
    if (!page) {
      // nicht gefunden → weiter zur nächsten Middleware (z.B. 404)
      return next();
    }

    // 2) Features parsen: JSON-Array oder Zeilenumbruch-String
    let featuresArr;
    try {
      const parsed = JSON.parse(page.features || '[]');
      featuresArr = Array.isArray(parsed) ? parsed : [];
    } catch {
      featuresArr = String(page.features || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line);
    }
    page.features = featuresArr;

    // 3) Gallery parsen: JSON-Array aus DB
    try {
      const parsed = JSON.parse(page.gallery || '[]');
      page.gallery = Array.isArray(parsed) ? parsed : [];
    } catch {
      page.gallery = [];
    }

    // 4) Navbar-Kategorien (optional)
    const [entieties] = await db.query(`
      SELECT name, route
        FROM ententies
       ORDER BY name
    `);

    // ─── NEU: Footer-Daten laden ──────────────────────────
    const [cols]  = await db.query(
      `SELECT id, title, sort_order
         FROM footer_columns
        ORDER BY sort_order, title`
    );
    const [links] = await db.query(
      `SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
         FROM footer_links
        ORDER BY column_id, sort_order`
    );
    // Gruppieren
    const footerColumns = cols.map(col => ({
      id:         col.id,
      title:      col.title,
      sort_order: col.sort_order,
      phone:      null,
      links:      []
    }));
    for (const link of links) {
      const col = footerColumns.find(c => c.id === link.column_id);
      if (!col) continue;
      if (link.is_phone) col.phone = link.phone_number;
      else               col.links.push({ text: link.link_text, url: link.link_url });
    }

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
  title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
  meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
  robots:              seoRow?.robots || 'index,follow',
  canonical_url:       buildCanonical(req),
  og_title:            seoRow?.og_title || seoRow?.title || null,
  og_description:      seoRow?.og_description || seoRow?.meta_description || null,
  og_image:            seoRow?.og_image || null,
  twitter_card:        seoRow?.twitter_card || 'summary_large_image',
  structured_data_json:seoRow?.structured_data_json || null,
  hreflang_json:       null
};

// Lokale Variable für alle Views verfügbar
res.locals.seo = seo;

    // 5) Rendern
    res.render('pages/templates/landing/show', {
      page,
      entieties, 
      footerColumns,
      user,
    });

  } catch (err) {
    next(err);
  }
});


const entityTypeMap = {
  properties: 1,
  watches:    2,
  cars:       3,
  yachts:     4,
  lifestyle:  5
};

// Ganz oben in src/routes/template/index.js, vor Deiner catch‑all Route
router.get('/:entityRoute/api/models', async (req, res, next) => {
  try {
    const { entityRoute } = req.params;

    // 1) Hole das table_name zur aktuellen Route
    const [[ent]] = await db.query(
      'SELECT table_name FROM ententies WHERE route = ?',
      [entityRoute]
    );
    if (!ent) {
      console.warn('⚠️ Entitie nicht gefunden für Route', entityRoute);
      return res.json([]);
    }
    const tableName = ent.table_name;

    // 2) Marken‑Parameter auslesen
    const brands = Array.isArray(req.query.brand)
      ? req.query.brand
      : (req.query.brand ? [req.query.brand] : []);
    if (!brands.length) {
      console.log('ℹ️ Keine Marken übergeben, gebe [] zurück');
      return res.json([]);
    }

    // 3) Platzhalter für IN‑Klausel
    const placeholders = brands.map(() => '?').join(',');

    // 4) Query zusammenbauen
    const sql = `
      SELECT DISTINCT m.id, m.name
        FROM models AS m
        JOIN ${tableName} AS t
          ON t.model_id = m.id
       WHERE t.brand_id IN (${placeholders})
       ORDER BY m.name
    `;

    console.log('🔧 SQL für /' + entityRoute + '/api/models:', sql.trim());
    console.log('🔢 Params:', brands);

    // 5) Ausführen
    const [rows] = await db.query(sql, brands);
    console.log('✅ Rows returned:', rows);

    return res.json(rows);
  } catch (err) {
    console.error('🚨 Fehler in /:entityRoute/api/models:', err);
    return next(err);
  }
});

// ganz unten in src/routes/template/index.js
router.get('/hersteller-marken', async (req, res, next) => {
  const user = res.locals.user;

  try {
    // 1) Navbar‑Kategorien
    const [entieties] = await db.query(`
      SELECT id, name, route
      FROM ententies
      ORDER BY id
    `);

    // 2) Footer‑Daten
    const [cols]  = await db.query(
      `SELECT id, title, sort_order
         FROM footer_columns
        ORDER BY sort_order, title`
    );
    const [links] = await db.query(
      `SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
         FROM footer_links
        ORDER BY column_id, sort_order`
    );
    const footerColumns = cols.map(c => ({ id:c.id, title:c.title, sort_order:c.sort_order, phone:null, links:[] }));
    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else            col.links.push({ text:l.link_text, url:l.link_url });
    }

    // 3) Liste der Marken‑Seonames, genau wie in deinem HTML
const displaySeonames = [
  '9ff','A-Lange-und-Soehne','Absolute','Admiral','Alalunga','Alpina','ALPINA',
  'Apple-Watch','Armand-Nicolet','Askania','Aston-Martin','Astondoa','Audemars-Piguet',
  'Audi','Austin','Azimut-Yachts','Baglietto','Baia','Baume-und-Mercier','Bell-und-Ross',
  'Beneteau','Benetti','Bentley','Blancpain','Bovet','Breguet','Breitling',
  'Bruno-Soehnle-Glashuette','Bulgari','Canados','Cartier','Catamaran','Certina',
  'Chanel','Chopard','Chronoswiss','Chrysler','Cigarette-Racing','Citizen','Cobra',
  'Corvette','Cuervo-Y-Sobrinos','Cvstos','Cyclos-Watch','Daimler','Dalla-Pieta',
  'Damasko','Daniel-Roth','Davosa','De-Bethune','De-Grisogono','Dior','Dodge',
  'Dominator','Ebel','Eberhard-und-Co','Edox','Erwin-Sattler','Eterna','Excalibur',
  'Fairline','Falcon-Yachts','Fipa-Italiana','FISKER','Formula','Fortis','Franck-Muller',
  'Frederique-Constant','Gemballa','Gerald-Genta','Girard-Perregaux','Glashuette-Original',
  'Graham','Grand-Seiko','Greubel-Forsey','Gucci','Gumpert','H-Moser-und-Cie','Hatteras',
  'Honda','Horch','Hublot','Hummer','Invicta','Italcraft','IWC','Jaeger-LeCoultre','Jaguar',
  'Jaguar-Yachts','Jeanneau','Jeep','Jensen','Junghans','Koenigsegg','Laco','Lagonda',
  'Lagoon','Lancaster','Lancia','Land-Rover','Lang-und-Heyne','Lexus','Lincoln','Linssen',
  'Longines','Lotus','Louis-Erard','Louis-Moinet','Maiora','Marcello-C','Maserati',
  'Maurice-Lacroix','Maybach','Mazda','McLaren','Meistersinger','Mercedes-Benz','MG',
  'Michel-Herbelin','Mido','Mitsubishi','Mondomarine','Montblanc','Morgan','Mosler',
  'Muehle-Glashuette','Nauticfish','Nimbus','Nivrel','NOMOS','Novitec','Omega','Oris',
  'Packard','Pagani','Panerai','Panther','Parmigiani-Fleurier','Patek-Philippe',
  'Paul-Picot','Pedrazzini','Pequignet','Perrelet','Pershing','Peugeot','Piaget',
  'Pierce-Arrow','Plymouth','Poljot','Pontiac','Porsche-Design','Posillipo','Princess',
  'Pursuit','Rado','Rainer-Brand','Raymond-Weil','Renault','Revue-Thommen','Richard-Mille',
  'Riley','Rimac','Riviera','Roger-Dubuis','Rolex','Romain-Jerome','Rover','RUF',
  'Sanlorenzo','Schaumburg-Watch','Schwarz-Etienne','Seiko','Sevenfriday','Sinn','Sothis',
  'Stowa','Studebaker','Sunbeam','Sunseeker','TAG-Heuer','TECHART','Tecnomar','Tesla',
  'Tiffany','Tissot','Titoni','Tourby','Toyota','Triumph','Tudor','Tutima','TVR','U-Boat',
  'Ulysse-Nardin','Union-Glashuette','Universal-Geneve','Vacheron-Constantin',
  'Victorinox-Swiss-Army','Volkswagen','Volvo','Vulcain','Wempe','Wiesmann','Zannetti',
  'Zenith','Zeno-Watch-Basel'
];


    // 4) Nur diese Marken abfragen und in der gleichen Reihenfolge ausgeben
    const placeholders = displaySeonames.map(()=>'?').join(',');
    const [brands] = await db.query(
      `SELECT id, name, seoname, type
         FROM brands
        WHERE seoname IN (${placeholders})
        ORDER BY FIELD(seoname, ${placeholders})`,
      [...displaySeonames, ...displaySeonames]
    );

    // 5) Nach Kategorie‑Route gruppieren
    const typeToRoute = { 1:'properties',2:'watches',3:'cars',4:'yachts',5:'lifestyles' };
    const groupedBrands = brands.reduce((acc,b) => {
      const route = typeToRoute[b.type]||'other';
      (acc[route]=acc[route]||[]).push(b);
      return acc;
    }, {});

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
  title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
  meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
  robots:              seoRow?.robots || 'index,follow',
  canonical_url:       buildCanonical(req),
  og_title:            seoRow?.og_title || seoRow?.title || null,
  og_description:      seoRow?.og_description || seoRow?.meta_description || null,
  og_image:            seoRow?.og_image || null,
  twitter_card:        seoRow?.twitter_card || 'summary_large_image',
  structured_data_json:seoRow?.structured_data_json || null,
  hreflang_json:       null
};

// Lokale Variable für alle Views verfügbar
res.locals.seo = seo;

    res.render('pages/templates/hersteller-marken', {
      entieties,
      groupedBrands,
      footerColumns, 
      user,
    });
  } catch(err) {
    next(err);
  }
});

const TITLES = [
  { key: 'title.dr', value: 'Dr.' },
  { key: 'title.dr_med', value: 'Dr. med.' },
  { key: 'title.dr_jur', value: 'Dr. jur.' },
  { key: 'title.dr_phil', value: 'Dr. phil.' },
  { key: 'title.dr_rer_nat', value: 'Dr. rer. nat.' },
  { key: 'title.dr_hc', value: 'Dr. h.c.' },
  { key: 'title.prof', value: 'Prof.' },
  { key: 'title.prof_dr', value: 'Prof. Dr.' },
  { key: 'title.prof_dr_med', value: 'Prof. Dr. med.' },
  { key: 'title.dipl_ing', value: 'Dipl.-Ing.' },
  { key: 'title.ing', value: 'Ing.' },
  { key: 'title.mag', value: 'Mag.' },
  { key: 'title.mag_dr', value: 'Mag. Dr.' },
  { key: 'title.bsc', value: 'B.Sc.' },
  { key: 'title.msc', value: 'M.Sc.' },
  { key: 'title.mba', value: 'MBA' },
  { key: 'title.llb', value: 'LL.B.' },
  { key: 'title.llm', value: 'LL.M.' },
  { key: 'title.ba', value: 'B.A.' },
  { key: 'title.ma', value: 'M.A.' },
  { key: 'title.phd', value: 'Ph.D.' },
  { key: 'title.md', value: 'M.D.' }
];



const omakContactFormRateLimit = {};
function omakGetContactClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  const raw = forwarded || realIp || req.ip || '';
  return raw.replace(/^::ffff:/, '').trim();
}
function omakNormalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 254);
}
function omakIsValidEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}
function omakIsRateLimited(bucket, key, maxRequests = 5, windowMs = 60 * 60 * 1000) {
  const now = Date.now();
  const current = bucket[key];
  if (!current || now - current.firstTime > windowMs) {
    bucket[key] = { count: 1, firstTime: now };
    return false;
  }
  current.count += 1;
  return current.count > maxRequests;
}

// GET /contact: Seite anzeigen
router.get('/contact', async (req, res, next) => {
  const user = res.locals.user;

  try {
    const layout = await loadLayoutData();

    const contactFlash = req.session.contactFormFlash || null;
    if (contactFlash) delete req.session.contactFormFlash;

    const success = contactFlash?.success || req.query.success;
    const error = contactFlash?.error || req.query.error;
    const flashFormData = contactFlash?.formData || {};



    // FormData zurückfüllen
    const formData = {
      anrede:       flashFormData.anrede       ?? req.query.anrede       ?? '',
      titel:        flashFormData.titel        ?? req.query.titel        ?? '',
      first_name:   flashFormData.first_name   ?? req.query.first_name   ?? '',
      last_name:    flashFormData.last_name    ?? req.query.last_name    ?? '',
      ichbin:       flashFormData.ichbin       ?? req.query.ichbin       ?? '',
      firma:        flashFormData.firma        ?? req.query.firma        ?? '',
      kundennummer: flashFormData.kundennummer ?? req.query.kundennummer ?? '',
      telefon_prefix: flashFormData.telefon_prefix ?? req.query.telefon_prefix ?? '',
      email:        flashFormData.email        ?? req.query.email        ?? '',
      telefon:      flashFormData.telefon      ?? req.query.telefon      ?? '',
      nachricht:    flashFormData.nachricht    ?? req.query.nachricht    ?? '',
      datenschutz:  flashFormData.datenschutz  ?? req.query.datenschutz  ?? ''
    };

    const [phonePrefixRows] = await db.query(
      `SELECT code,
              COALESCE(NULLIF(de,''), en, code) AS name,
              prefix
         FROM countries
        WHERE prefix IS NOT NULL
          AND prefix <> ''
        ORDER BY COALESCE(NULLIF(de,''), en, code) ASC`
    );
    const phonePrefixOptions = (phonePrefixRows || []).map((r) => ({
      code: String(r.code || '').toUpperCase(),
      name: String(r.name || r.code || '').trim(),
      prefix: String(r.prefix || '').trim().replace(/^\+?/, '+')
    }));

    // Eingeloggte Nutzer automatisch vorbefüllen (nur leere Felder überschreiben)
    if (req.session?.userId) {
      const [[contactUser]] = await db.query(
        `SELECT u.id, u.firstname, u.lastname, u.email, u.company, u.phone, u.mobile, u.country_id,
                c.prefix AS country_prefix
           FROM users u
           LEFT JOIN countries c ON c.id = u.country_id
          WHERE u.id = ?
          LIMIT 1`,
        [req.session.userId]
      );

      if (contactUser) {
        const buildPhoneWithPrefix = (prefixRaw, ...candidates) => {
          const raw = candidates.map(v => String(v || '').trim()).find(Boolean) || '';
          if (!raw) return '';

          let phone = raw.replace(/\s+/g, ' ').trim();
          if (/^\+/.test(phone)) return phone;
          if (/^00\d+/.test(phone)) return `+${phone.slice(2)}`;

          const prefixClean = String(prefixRaw || '').trim();
          if (!prefixClean) return phone;
          const prefix = prefixClean.startsWith('+') ? prefixClean : `+${prefixClean}`;

          const prefixDigits = prefix.replace(/\D/g, '');
          const phoneDigits = phone.replace(/\D/g, '');
          if (prefixDigits && phoneDigits.startsWith(prefixDigits)) {
            return `${prefix} ${phoneDigits.slice(prefixDigits.length)}`.trim();
          }

          return `${prefix} ${phone.replace(/^0+/, '')}`.trim();
        };
        const splitPhoneForForm = (prefixRaw, fullPhoneRaw) => {
          const prefixClean = String(prefixRaw || '').trim();
          const prefix = prefixClean ? (prefixClean.startsWith('+') ? prefixClean : `+${prefixClean}`) : '';
          const raw = String(fullPhoneRaw || '').trim();
          if (!raw) return { prefix, local: '' };

          let local = raw;
          const rawDigits = raw.replace(/\D/g, '');
          const prefixDigits = prefix.replace(/\D/g, '');

          if (/^00\d+/.test(raw)) {
            local = `+${raw.slice(2)}`;
          }
          if (prefixDigits && rawDigits.startsWith(prefixDigits)) {
            local = rawDigits.slice(prefixDigits.length);
          } else if (raw.startsWith(prefix)) {
            local = raw.slice(prefix.length);
          }

          local = String(local || '').replace(/^\+/, '').trim();
          return { prefix, local };
        };

        const customerNumber = String(contactUser.id || '').padStart(9, '0');
        const prefillPhoneCombined = buildPhoneWithPrefix(contactUser.country_prefix, contactUser.phone, contactUser.mobile);
        const prefillPhoneParts = splitPhoneForForm(contactUser.country_prefix, prefillPhoneCombined);
        const prefillRole = String(contactUser.company || '').trim() ? 'Firma' : 'Privat';

        if (!String(formData.first_name || '').trim()) formData.first_name = contactUser.firstname || '';
        if (!String(formData.last_name || '').trim()) formData.last_name = contactUser.lastname || '';
        if (!String(formData.email || '').trim()) formData.email = contactUser.email || '';
        if (!String(formData.firma || '').trim()) formData.firma = contactUser.company || '';
        if (!String(formData.kundennummer || '').trim()) formData.kundennummer = customerNumber || '';
        if (!String(formData.ichbin || '').trim()) formData.ichbin = prefillRole;
        if (!String(formData.telefon_prefix || '').trim()) formData.telefon_prefix = prefillPhoneParts.prefix || '';
        if (!String(formData.telefon || '').trim()) formData.telefon = prefillPhoneParts.local || '';
      }
    }

    // SEO laden
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
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };
    res.locals.seo = seo;

    // 🔢 Captcha erzeugen
    const a = Math.floor(Math.random() * 9) + 1;
    const b = Math.floor(Math.random() * 9) + 1;
    const ops = ['+', '-'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    const expected = op === '+' ? a + b : a - b;
    const captcha = { question: `${a} ${op} ${b}` };

    // In Session speichern
    req.session.captchaExpected = expected;
    console.log("👉 Neues Captcha erzeugt:", captcha.question, "=", expected);

    res.render('pages/templates/contact', {
      ...layout,
      success,
      error,
      formData,
      phonePrefixOptions,
      user,
      captcha,
      TITLES, 
      timestamp: Date.now()
    });
  } catch (err) {
    next(err);
  }
});


// POST /contact: Formular verarbeiten
router.post(
  '/contact',
  express.urlencoded({ extended: false }),
  async (req, res, next) => {
    const tContact = (key, fallback) => {
      const fn =
        (res.locals && typeof res.locals.t === 'function' && res.locals.t) ||
        (typeof req.t === 'function' ? req.t : null);
      if (!fn) return fallback;
      try { return fn(key, { defaultValue: fallback }); } catch {}
      try { return fn(key, fallback); } catch {}
      try { return fn(key); } catch {}
      return fallback;
    };

    const {
      anrede, titel, first_name, last_name,
      ichbin, firma, kundennummer,
      email, telefon_prefix, telefon, nachricht, datenschutz,
      formRendered,
      website,           // Honeypot
      captcha_answer     // Eingabe vom User
    } = req.body;

    const errors = [];
    const spamReasons = [];
    let spamScore = 0;
    let suppressAutoReply = false;
    let hardSpamBlock = false;
    const addSpamSignal = (points, reason) => {
      spamScore += Number(points || 0);
      if (reason) spamReasons.push(reason);
    };
    const requestIp = omakGetContactClientIp(req);
    const normalizedEmailAddr = omakNormalizeEmail(email);
    const normalizedPhonePrefixRaw = String(telefon_prefix || '').trim();
    const normalizedPhonePrefix = normalizedPhonePrefixRaw
      ? normalizedPhonePrefixRaw.replace(/^\+?/, '+')
      : '';
    const normalizedPhoneLocal = String(telefon || '').trim();
    const combinePhoneFromParts = (prefixRaw, phoneRaw) => {
      const phone = String(phoneRaw || '').trim();
      if (!phone) return '';
      if (/^\+/.test(phone)) return phone;
      if (/^00\d+/.test(phone)) return `+${phone.slice(2)}`;
      const prefix = String(prefixRaw || '').trim();
      if (!prefix) return phone;
      return `${prefix} ${phone.replace(/^0+/, '')}`.trim();
    };
    const normalizedPhone = combinePhoneFromParts(normalizedPhonePrefix, normalizedPhoneLocal);
    const normalizedMessage = String(nachricht || '').trim();
    const contactFormState = {
      anrede: anrede || '',
      titel: titel || '',
      first_name: first_name || '',
      last_name: last_name || '',
      ichbin: ichbin || '',
      firma: firma || '',
      kundennummer: kundennummer || '',
      email: email || '',
      telefon_prefix: telefon_prefix || '',
      telefon: telefon || '',
      nachricht: nachricht || '',
      datenschutz: datenschutz || ''
    };

    // Honeypot
    if (website && website.trim() !== "") {
      console.log("❌ Spam-Verdacht (Honeypot ausgefüllt):", website);
      errors.push(tContact('contact.backend.error.spam_detected', 'Spam erkannt.'));
      addSpamSignal(100, 'honeypot-filled');
    }

    // Pflichtfelder prüfen
    if (!first_name)  errors.push(tContact('contact.backend.error.first_name_required', 'Bitte Vorname ausfüllen.'));
    if (!last_name)   errors.push(tContact('contact.backend.error.last_name_required', 'Bitte Nachname ausfüllen.'));
    if (!email)       errors.push(tContact('contact.backend.error.email_required', 'Bitte E-Mail-Adresse ausfüllen.'));
    if (!telefon_prefix) errors.push(tContact('contact.backend.error.phone_prefix_required', 'Bitte Telefonvorwahl auswählen.'));
    if (!normalizedPhoneLocal) errors.push(tContact('contact.backend.error.phone_required', 'Bitte Telefon ausfüllen.'));
    if (!normalizedMessage) errors.push(tContact('contact.backend.error.message_required', 'Bitte Nachricht ausfüllen.'));
    if (datenschutz !== "on") errors.push(tContact('contact.backend.error.privacy_required', 'Bitte Datenschutz akzeptieren.'));
    if (email && !omakIsValidEmailAddress(normalizedEmailAddr)) {
      errors.push(tContact('contact.backend.error.email_invalid', 'Bitte gültige E-Mail-Adresse eingeben.'));
      addSpamSignal(25, 'invalid-email-format');
    }

    const renderedAtMs = Number(formRendered || 0);
    if (Number.isFinite(renderedAtMs) && renderedAtMs > 0) {
      const elapsedMs = Date.now() - renderedAtMs;
      if (elapsedMs < 2500) addSpamSignal(70, `submitted-too-fast:${elapsedMs}ms`);
      else if (elapsedMs < 5000) addSpamSignal(25, `submitted-fast:${elapsedMs}ms`);
      if (elapsedMs > 24 * 60 * 60 * 1000) addSpamSignal(10, 'stale-form');
    } else {
      addSpamSignal(15, 'missing-formRendered');
    }

    if (requestIp && omakIsRateLimited(omakContactFormRateLimit, `contact-form:ip:${requestIp}`, 5, 60 * 60 * 1000)) {
      addSpamSignal(120, 'ip-rate-limit');
    }
    if (normalizedEmailAddr && omakIsRateLimited(omakContactFormRateLimit, `contact-form:email:${normalizedEmailAddr}`, 3, 60 * 60 * 1000)) {
      addSpamSignal(120, 'email-rate-limit');
    }

    if (normalizedMessage) {
      if (normalizedMessage.length < 15) addSpamSignal(35, 'message-too-short');
      const linkMatches = normalizedMessage.match(/(?:https?:\/\/|www\.)/gi) || [];
      if (linkMatches.length >= 1) addSpamSignal(10, `contains-link:${linkMatches.length}`);
      if (linkMatches.length > 2) {
        addSpamSignal(80, `too-many-links:${linkMatches.length}`);
        hardSpamBlock = true;
      }

      const hardKeywordMatches = normalizedMessage.match(/\b(?:casino|crypto|bitcoin|forex|loan|viagra|porn|escort|telegram|whatsapp)\b/gi) || [];
      if (hardKeywordMatches.length) {
        const hardKeywords = Array.from(new Set(hardKeywordMatches.map(k => String(k).toLowerCase())));
        addSpamSignal(120 + Math.max(0, hardKeywordMatches.length - 1) * 20, `hard-spam-keywords:${hardKeywords.join('|')}`);
        hardSpamBlock = true;
      }

      const softKeywordMatches = normalizedMessage.match(/\b(?:seo|backlink)\b/gi) || [];
      if (softKeywordMatches.length) {
        const softKeywords = Array.from(new Set(softKeywordMatches.map(k => String(k).toLowerCase())));
        addSpamSignal(Math.min(60, softKeywordMatches.length * 25), `soft-spam-keywords:${softKeywords.join('|')}`);
      }

      if (/(.)\1{6,}/.test(normalizedMessage)) addSpamSignal(15, 'repeated-chars');
      if (/[<>{}]/.test(normalizedMessage)) addSpamSignal(10, 'html-like-content');
    }

    // Captcha prüfen
    console.log("👉 captcha_answer (vom User):", captcha_answer);
    console.log("👉 captchaExpected (in Session):", req.session.captchaExpected);

    const expected = req.session.captchaExpected;
    if (parseInt(captcha_answer, 10) !== expected) {
      console.log("❌ Captcha Prüfung fehlgeschlagen!");
      errors.push(tContact('contact.backend.error.captcha_failed', 'Die Sicherheitsfrage wurde falsch beantwortet.'));
    } else {
      console.log("✅ Captcha erfolgreich gelöst!");
    }

    // Session zurücksetzen
    req.session.captchaExpected = null;

    if (hardSpamBlock || spamScore >= 60) {
      errors.push(tContact('contact.backend.error.request_blocked', 'Ihre Anfrage konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.'));
    } else if (spamScore >= 25) {
      suppressAutoReply = true;
    }

    if (errors.length) {
      if (spamScore > 0) {
        console.warn('⚠️ Kontaktformular blockiert/fehlerhaft', {
          ip: requestIp,
          email: normalizedEmailAddr,
          spamScore,
          spamReasons
        });
      }
      console.log("❌ Fehlerliste:", errors);
      req.session.contactFormFlash = {
        error: errors.join("\n"),
        formData: contactFormState
      };
      return res.redirect("/contact");
    }

    try {
      const [[duplicateContact]] = await db.query(
        `SELECT id, created_at
           FROM contacts
          WHERE LOWER(email) = ?
            AND TRIM(message) = ?
            AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
          ORDER BY id DESC
          LIMIT 1`,
        [normalizedEmailAddr, normalizedMessage]
      );

      if (duplicateContact) {
        console.warn('⚠️ Kontaktformular-Duplikat blockiert', {
          ip: requestIp,
          email: normalizedEmailAddr,
          duplicateId: duplicateContact.id
        });
        req.session.contactFormFlash = {
          error: tContact('contact.backend.error.duplicate_recent', 'Eine ähnliche Anfrage wurde bereits gesendet. Bitte warten Sie kurz oder ändern Sie Ihre Nachricht.'),
          formData: contactFormState
        };
        return res.redirect("/contact");
      }

      await db.query(
        `INSERT INTO contacts
          (salutation, title, first_name, last_name, role,
           company, customer_number, email, phone, message)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          anrede||null, titel||null,
          first_name, last_name,
          ichbin||"Privat",
          firma||null, kundennummer||null,
          normalizedEmailAddr || email, normalizedPhone, normalizedMessage
        ]
      );

      console.log("✅ Kontaktformular erfolgreich gespeichert:", email);

      const contactRecipient =
        process.env.CONTACT_FORM_TO ||
        'support@herando.com';

      const senderName = [first_name, last_name].filter(Boolean).join(' ').trim() || 'Kontaktformular';
      const requestHost = String(req.get('host') || req.hostname || 'herando.com');
      const mailFromAddress = process.env.CONTACT_FORM_FROM || 'support@herando.com';

      const internalMailText = [
        tContact('contact.backend.mail.internal.title', 'Neue Kontaktanfrage über /contact'),
        '',
        `${tContact('contact.backend.mail.internal.label.website', 'Website/Host')}: ${requestHost}`,
        `${tContact('contact.backend.mail.internal.label.name', 'Name')}: ${senderName}`,
        `IP: ${requestIp || '-'}`,
        `${tContact('contact.backend.mail.internal.label.salutation', 'Anrede')}: ${anrede || '-'}`,
        `${tContact('contact.backend.mail.internal.label.title', 'Titel')}: ${titel || '-'}`,
        `${tContact('contact.backend.mail.internal.label.role', 'Ich bin')}: ${ichbin || 'Privat'}`,
        `${tContact('contact.backend.mail.internal.label.company', 'Firma')}: ${firma || '-'}`,
        `${tContact('contact.backend.mail.internal.label.customer_number', 'Kundennummer')}: ${kundennummer || '-'}`,
        `${tContact('contact.backend.mail.internal.label.email', 'E-Mail')}: ${normalizedEmailAddr || email || '-'}`,
        `${tContact('contact.backend.mail.internal.label.phone', 'Telefon')}: ${normalizedPhone || '-'}`,
        `${tContact('contact.backend.mail.internal.label.spam_score', 'Spam-Score')}: ${spamScore}`,
        `${tContact('contact.backend.mail.internal.label.spam_reasons', 'Spam-Hinweise')}: ${spamReasons.length ? spamReasons.join(', ') : '-'}`,
        '',
        `${tContact('contact.backend.mail.internal.label.message', 'Nachricht')}:`,
        normalizedMessage || '-'
      ].join('\n');

      const confirmGreeting = String(
        tContact('contact.backend.mail.confirm.greeting', 'Hallo {{name}},')
      ).replace('{{name}}', senderName);
      const confirmationMailText = [
        confirmGreeting,
        '',
        tContact('contact.backend.mail.confirm.line1', 'vielen Dank für Ihre Nachricht an Herando.'),
        tContact('contact.backend.mail.confirm.line2', 'Wir haben Ihre Anfrage erhalten und melden uns schnellstmöglich bei Ihnen.'),
        '',
        `${tContact('contact.backend.mail.confirm.data_header', 'Ihre Angaben')}:`,
        `${tContact('contact.backend.mail.confirm.label.email', 'E-Mail')}: ${normalizedEmailAddr || email || '-'}`,
        `${tContact('contact.backend.mail.confirm.label.phone', 'Telefon')}: ${normalizedPhone || '-'}`,
        `${tContact('contact.backend.mail.confirm.label.company', 'Firma')}: ${firma || '-'}`,
        '',
        `${tContact('contact.backend.mail.confirm.message_header', 'Ihre Nachricht')}:`,
        normalizedMessage || '-',
        '',
        tContact('contact.backend.mail.confirm.closing', 'Mit freundlichen Grüßen'),
        tContact('contact.backend.mail.confirm.signature', 'Ihr Herando Team')
      ].join('\n');

      const mailJobs = [];

      if (contactRecipient) {
        mailJobs.push(
          transporter.sendMail({
            from: `"Herando Support" <${mailFromAddress}>`,
            to: contactRecipient,
            replyTo: normalizedEmailAddr || email,
            subject: `${tContact('contact.backend.mail.internal.subject_prefix', 'Neue Kontaktanfrage von')} ${senderName}`,
            text: internalMailText
          })
        );
      } else {
        console.warn('⚠️ Kein Empfänger für Kontaktformular-Mail konfiguriert (CONTACT_FORM_TO/ADMIN_EMAIL/SMTP_USER).');
      }

      if ((normalizedEmailAddr || email) && !suppressAutoReply) {
        mailJobs.push(
          transporter.sendMail({
            from: `"Herando Support" <${mailFromAddress}>`,
            to: normalizedEmailAddr || email,
            replyTo: contactRecipient || mailFromAddress,
            subject: tContact('contact.backend.mail.confirm.subject', 'Ihre Kontaktanfrage bei Herando'),
            text: confirmationMailText
          })
        );
      } else if (suppressAutoReply) {
        console.warn('⚠️ Absender-Bestätigung beim Kontaktformular unterdrückt (Spam-Score)', {
          ip: requestIp,
          email: normalizedEmailAddr || email,
          spamScore,
          spamReasons
        });
      }

      if (mailJobs.length) {
        const mailResults = await Promise.allSettled(mailJobs);
        const mailErrors = mailResults.filter(r => r.status === 'rejected');
        if (mailErrors.length) {
          console.error('❌ Kontaktformular-Mailversand teilweise fehlgeschlagen:', mailErrors.map(r => r.reason));
        } else {
          console.log('✅ Kontaktformular-Mails versendet (Empfänger + Absenderbestätigung).');
        }
      }

      req.session.contactFormFlash = {
        success: tContact('contact.backend.success.sent', 'Deine Nachricht wurde erfolgreich abgeschickt!'),
        formData: {}
      };
      res.redirect("/contact");
    } catch (err) {
      console.error("❌ DB Fehler beim Speichern:", err);
      next(err);
    }
  }
);







// --------------------------------------
//  Händler‑Inserate
// --------------------------------------
router.get(
  '/seller/:sellerId',
  async (req, res, next) => {
    const user = res.locals.user;

    try {
      const sellerId = parseInt(req.params.sellerId, 10);
      if (isNaN(sellerId)) {
        return res.status(400).send('Ungültige Händler‑ID');
      }

      // 1) Alle Kategorien laden (für Navbar)
      const [entities] = await db.query(`
        SELECT id, name, route, table_name
        FROM ententies
        ORDER BY id
      `);

      // 2) Händlerprofil (ohne Telefon/Mail)
      const [[user]] = await db.query(`
        SELECT id, firstname, lastname, company, street, housenumber, postcode, city, country_id
        FROM users
        WHERE id = ? AND blacklist = 0 AND confirmed = 1
      `, [sellerId]);

      if (!user) {
        return res.status(404).send('Händler nicht gefunden');
      }

      const [[country]] = await db.query(
        'SELECT de FROM countries WHERE id = ?',
        [user.country_id]
      );
      const sellerProfile = {
        id:      user.id,
        name:    `${user.firstname} ${user.lastname}`,
        company: user.company || null,
        address: [
          user.street,
          user.housenumber,
          user.postcode,
          user.city,
          country?.de
        ].filter(Boolean).join(', ')
      };

      // 3) Über alle Entitäten hinweg die Inserate dieses Händlers sammeln
      let allItems = [];
      for (const ent of entities) {
        const table = db.escapeId(ent.table_name);
        const [rows] = await db.query(`
          SELECT id, name AS title, price, pictures
          FROM ${table}
          WHERE user_id = ?
            AND status = 3
            AND visible = 1
        `, [sellerId]);

        const mapped = rows.map(r => {
          let rawPics;
          try { rawPics = unserialize(r.pictures || 'a:0:{}'); }
          catch { rawPics = []; }
          const pics = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);

          // ► Slug schon hier berechnen, nicht im Template
          const slug = slugify(r.title, { lower: true, strict: true });

          return {
            id:             r.id,
            route:          ent.route,
            title:          r.title,
            slug,           // ← neu
            priceFormatted: r.price
                              ? Number(r.price).toLocaleString('de-DE') + ' €'
                              : 'Preis auf Anfrage',
            image:          `/images/${ent.route}/${r.id}/${(pics[0]?.image||'placeholder.jpg')}`
          };
        });

        allItems = allItems.concat(mapped);
      }

      // 4) Footer‑Daten
      const [cols]  = await db.query(`
        SELECT id, title, sort_order
        FROM footer_columns
        ORDER BY sort_order, title
      `);
      const [links] = await db.query(`
        SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
        FROM footer_links
        ORDER BY column_id, sort_order
      `);
      const footerColumns = cols.map(col => ({
        id:         col.id,
        title:      col.title,
        sort_order: col.sort_order,
        phone:      null,
        links:      []
      }));
      for (const link of links) {
        const fc = footerColumns.find(c => c.id === link.column_id);
        if (!fc) continue;
        if (link.is_phone) fc.phone = link.phone_number;
        else               fc.links.push({ text: link.link_text, url: link.link_url });

        
      }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 30;
  // … sammele alle Inserate wie gehabt in allItems …
  const total = allItems.length;
  const pages = Math.ceil(total / perPage);

  // slice für die aktuelle Seite
  const pagedItems = allItems.slice((page - 1) * perPage, page * perPage);

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
  title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
  meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
  robots:              seoRow?.robots || 'index,follow',
  canonical_url:       buildCanonical(req),
  og_title:            seoRow?.og_title || seoRow?.title || null,
  og_description:      seoRow?.og_description || seoRow?.meta_description || null,
  og_image:            seoRow?.og_image || null,
  twitter_card:        seoRow?.twitter_card || 'summary_large_image',
  structured_data_json:seoRow?.structured_data_json || null,
  hreflang_json:       null
};

// Lokale Variable für alle Views verfügbar
res.locals.seo = seo;

      // 5) Rendern
      res.render('pages/templates/seller-list', {
        entities,
        entieties:      entities,     // für Dein Header‑Partial
        sellerProfile,                // name, company, address
        allItems,                     // inkl. item.slug
        footerColumns, 
        allItems: pagedItems,
        pagination: { page, pages, total }, 
        user,

      });
    } catch (err) {
      next(err);
    }
  }
);

// --- kleine Helper (falls im Projekt schon vorhanden, diese hier entfernen) ---
function tryUnserialize(str) {
  try {
    if (typeof unserialize === 'function') return unserialize(str);
  } catch {}
  // Fallback: leeres Array
  return [];
}

function fallbackResolveImageFilename(entityRoute, id, candidate) {
  if (typeof resolveImageFilename === 'function') {
    try { return resolveImageFilename(entityRoute, id, candidate); } catch {}
  }
  return (candidate && String(candidate).trim()) || 'mainpicture.jpg';
}

// Map für Watches-Delivery (UI --> echte DB-Spalten)
const WATCH_DELIVERY_MAP = {
  papers:   'authenticity_papers',
  box:      'authenticity_box',
  warranty: 'authenticity_warranty'
};

// Map-Funktion IDs -> DB-Spalten (z.B. "alarm" -> "function_alarm")
const toWatchFunctionCol = (v) => {
  const k = String(v || '').trim().toLowerCase();
  if (!k) return null;
  return k.startsWith('function_') ? k : `function_${k}`;
};

router.get('/:entityRoute',  async (req, res, next) => { 
  const user = res.locals.user;

  try {
    const entityRoute = req.params.entityRoute;

    // 1) Kategorien laden
    const [entities] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);
    const currentEntity = entities.find(e => e.route === entityRoute);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    const tableName = db.escapeId(currentEntity.table_name);
    const categoryTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles: 6 };
    const type = categoryTypeMap[entityRoute] || null;

    // 2) Pagination
    const currentPage = Math.max(1, parseInt(req.query.hp, 10) || 1);
    const limit       = Math.max(1, parseInt(req.query.limit, 10) || 60);
    const offset      = (currentPage - 1) * limit;

    // 3) Eingehende Filter sammeln
    const rawFilters = {
      // Allgemein
      brand:            req.query.brand,
      model:            req.query.model,
      yearMin:          req.query.yearMin,
      mileageMax:       req.query.mileageMax,
      priceMax:         req.query.priceMax,
      paymentType:      req.query.paymentType,
      location:         req.query.location,
      country:          req.query.country,
      registrationYear: req.query.registrationYear,
      nextHuYear:       req.query.nextHuYear,
      cartype:          req.query.cartype,
      fuel:             req.query.fuel,
      gearbox:          req.query.gearbox,
      drivetrain:       req.query.drivetrain,
      interior:         req.query.interior,
      airbags:          req.query.airbags,
      climatisation:    req.query.climatisation,
      interior_color:   req.query.interior_color,

      // Yachts
      yachttype:        req.query.yachttype,
      lengthMax:        req.query.lengthMax,
      widthMax:         req.query.widthMax,
      draftMax:         req.query.draftMax,
      cabinsMin:        req.query.cabinsMin,
      engines_count:    req.query.engines_count,
      power_kw:         req.query.power_kw,
      tank_volume:      req.query.tank_volume,
      displacement:     req.query.displacement,
      cruise_speed:     req.query.cruise_speed,
      max_speed:        req.query.max_speed,
      hours_run:        req.query.hours_run,
      flag:             req.query.flag,

      // Properties
      propertytype:     req.query.propertytype,
      investmenttype:   req.query.investmenttype,
      priceMin:         req.query.priceMin,
      areaMin:          req.query.areaMin,
      roomsMin:         req.query.roomsMin,
      bathroomsMin:     req.query.bathroomsMin,
      heating:          req.query.heating,

      // Watches (Lookup)
      watchtype:        req.query.watchtype,
      gender:           req.query.gender,
      case_material:    req.query.case_material,
      strap_material:   req.query.strap_material,
      strap_color:      req.query.strap_color,
      bezel_material:   req.query.bezel_material,
      dial_shape:       req.query.dial_shape,
      dial_numbers:     req.query.dial_numbers,
      dial_color:       req.query.dial_color,
      waterproof:       req.query.waterproof,
      movement:         req.query.movement,
      // Watches (Multi von UI)
      functions:        req.query.functions,     // z.B. ['alarm','chronograph']
      delivery:         req.query.delivery,      // z.B. ['papers','box','warranty']

      // Lifestyle
      lifestyleType:        req.query.lifestyleType,
      lifestyleSubcategory: req.query.lifestyleSubcategory,
      q:                    req.query.q,
    };

    // alle feature_* dynamisch übernehmen (Booleans)
    Object.keys(req.query).forEach(k => {
      if (k.startsWith('feature_')) rawFilters[k] = req.query[k];
    });

    // Normalisieren (Arrays) + Zahlen parsen
    const sel = Object.entries(rawFilters).reduce((acc, [key, value]) => {
      let arr;
      if (value === undefined || value === '') arr = [];
      else if (Array.isArray(value)) arr = value;
      else arr = [value];

      acc[key] = arr.map(v => {
        const num = Number(v);
        return Number.isFinite(num) && String(v).trim() !== '' ? num : v;
      });
      return acc;
    }, {});

    // Car extras (nur falls vorhanden)
    const extrasRaw = req.query.extras;
    sel.extras = (extrasRaw === undefined || extrasRaw === '' ? [] :
                  Array.isArray(extrasRaw) ? extrasRaw : [extrasRaw])
                  .map(String)
                  .filter(v => CAR_EXTRAS?.some?.(e => e.field === v));

    // 4) attribute_options holen
// Sprachen-Whitelist (Spaltennamen in ui_translations)
const UI_LANG_COLS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];

// Robust ermittelte aktive Sprache (z. B. 'en-US' -> 'en'), mit Fallback 'de'
const activeLanguage = (() => {
  const raw   = String(res.locals.lang || '').toLowerCase(); // z.B. "en-us"
  const short = raw.split(/[-_]/)[0];                         // -> "en"
  return UI_LANG_COLS.includes(short) ? short : 'de';
})();

// Sicher, weil aus Whitelist
const langCol = activeLanguage;

// 4) attribute_options holen – jetzt mit Übersetzungen aus ui_translations
const [allOpts] = await db.query(`
  SELECT
    ao.column_name,
    ao.option_value AS id,
    COALESCE(
      NULLIF(uit.${langCol}, ''),  -- aktive Sprache
      NULLIF(uit.en, ''),          -- Fallback
      NULLIF(uit.de, ''),          -- Fallback
      ao.option_label              -- letzter Fallback
    ) AS name
  FROM attribute_options ao
  LEFT JOIN ui_translations uit
    ON uit.\`key\` = CONCAT('filters.', ao.entitie_route, '.', ao.column_name, '.', ao.option_value)
  WHERE ao.entitie_route = ?
  ORDER BY ao.sort_order, CAST(ao.option_value AS UNSIGNED), ao.option_value
`, [entityRoute]);

const opts = (column) =>
  allOpts
    .filter(o => o.column_name === column)
    .map(({ id, name }) => ({ id, name }));


    // 4a) Deklaration aller Filter-Arrays
    let countries = [], brands = [], models = [], years = [],
        registrationYears = [], nextHuYears = [],
        // WATCHES
        watchTypes = [], genders = [],
        caseMaterials = [], strapMaterials = [], strapColors = [],
        bezelMaterials = [], dialShapes = [], dialNumbers = [], dialColors = [], crystals = [],
        claspMaterials = [], claspTypes = [], waterproofs = [], movements = [], functions = [], deliveries = [],
        // YACHTS
        yachtTypes = [], prices = [], boatTypes = [], categories = [],
        tankVolumes = [], crewCounts = [], displacements = [], berths = [],
        enginesCount = [], powerKw = [], hoursRun = [],
        cruiseSpeed = [], maxSpeed = [], hullMaterials = [],
        beamWidths = [], lengths = [], drafts = [], cabins = [], flags = [],
        // CARS
        cartypes = [], fuels = [], gearboxes = [], drivetrains = [], transmissions = [],
        colors = [], interiors = [], drives = [], engines = [],
        emissionClasses = [], pollutionClasses = [], badges = [],
        airbags = [], climatisations = [],
        // PROPERTIES/LIFESTYLES
        propertyTypes = [], lifestyleTypes = [], heatingTypes = [], plotSizes = [],
        livingAreas = [], floors = [], rooms = [], bathrooms = [], lifestyleSubcategories = [];

    // 4b) Jahre generisch
    [years] = await db.query(`
      SELECT DISTINCT year
      FROM ${tableName}
      WHERE year IS NOT NULL
      ORDER BY year DESC
    `);

    // Länder (sichtbar)
    const [allCountries] = await db.query(`
      SELECT c.id, c.de AS name, c.parent_id, p.de AS region
      FROM countries AS c
      LEFT JOIN countries AS p ON c.parent_id = p.id
      WHERE c.visible = 1
      ORDER BY COALESCE(p.de, c.de), c.de
    `);
    countries = allCountries;

    // 4c) Entity-spezifische Optionen
    if (entityRoute === 'cars') {
      const [reg]  = await db.query(`
        SELECT DISTINCT firstregistration AS year
        FROM ${tableName}
        WHERE firstregistration IS NOT NULL
        ORDER BY firstregistration DESC
      `);
      registrationYears = reg.map(r => r.year);

      const [insp] = await db.query(`
        SELECT DISTINCT maininspection AS year
        FROM ${tableName}
        WHERE maininspection IS NOT NULL
        ORDER BY maininspection DESC
      `);
      nextHuYears = insp.map(r => r.year);

      cartypes         = opts('cartype');
      fuels            = opts('fuel');
      gearboxes        = opts('gearbox');
      drivetrains      = opts('drivetrain');
      transmissions    = opts('transmission');
      colors           = opts('color');
      interiors        = opts('interior');
      drives           = opts('drive');
      engines          = opts('engine');
      emissionClasses  = opts('emission_class');
      pollutionClasses = opts('pollution_class');
      airbags          = opts('airbags');
      climatisations   = opts('climatisation');
      badges           = opts('environmental_badge');
    }

    if (entityRoute === 'properties') {
      propertyTypes = opts('propertytype');
      heatingTypes  = opts('heating');
      plotSizes     = opts('plot_size');
      livingAreas   = opts('living_area');
      floors        = opts('floors');
      rooms         = opts('rooms');
      bathrooms     = opts('bathrooms');
    }

    if (entityRoute === 'watches') {
      watchTypes      = opts('watchtype');
      genders         = opts('gender');
      caseMaterials   = opts('case_material');
      strapMaterials  = opts('strap_material');
      strapColors     = opts('strap_color');
      bezelMaterials  = opts('bezel_material');
      dialShapes      = opts('dial_shape');
      dialNumbers     = opts('dial_numbers');
      dialColors      = opts('dial_color');
      crystals        = opts('crystal');
      claspMaterials  = opts('clasp_material');
      claspTypes      = opts('clasp_type');
      waterproofs     = opts('waterproof');
      movements       = opts('movement');
      functions       = opts('functions');   // UI-Optionen (IDs -> function_* Columns)
      deliveries      = opts('delivery');    // UI-Optionen (IDs -> authenticity_* Columns)

      const [watchCountries] = await db.query(`
        SELECT c.id, c.de AS name
        FROM countries AS c
        WHERE c.visible = 1
        ORDER BY c.de
      `);
      countries = watchCountries;
    }

    if (entityRoute === 'yachts') {
      yachtTypes    = opts('yachttype');
      prices        = opts('price');
      boatTypes     = opts('boattype');
      categories    = opts('category');
      displacements = opts('displacement');
      berths        = opts('berths');
      enginesCount  = opts('engines_count');
      powerKw       = opts('power_kw');
      hoursRun      = opts('hours_run');
      cruiseSpeed   = opts('cruise_speed');
      maxSpeed      = opts('max_speed');
      tankVolumes   = opts('tank_volume');
      hullMaterials = opts('hull_material');
      beamWidths    = opts('beam');
      lengths       = opts('length');
      drafts        = opts('draft');
      cabins        = opts('cabins');
      crewCounts    = opts('crew');
      flags         = opts('flag');

      const [yachtCountries] = await db.query(`
        SELECT c.id, c.de AS name
        FROM countries AS c
        WHERE c.visible = 1
        ORDER BY c.de
      `);
      countries = yachtCountries;
    }

    if (entityRoute === 'lifestyles') {
      [lifestyleTypes] = await db.query(
        `SELECT id, name FROM brands WHERE type = 6 ORDER BY name`
      );
      if (lifestyleTypes.length > 0) {
        const brandIds = lifestyleTypes.map(b => b.id);
        const placeholders = brandIds.map(() => '?').join(',');
        [lifestyleSubcategories] = await db.query(
          `SELECT id, name, brand_id AS parentId
           FROM models
           WHERE brand_id IN (${placeholders})
           ORDER BY name`,
          brandIds
        );
      }
    }

    // 5) WHERE-Builder
    const where = ['status=3', 'visible=1', 'pictures IS NOT NULL'];
    const params = [];
    const add = (cond, ...vals) => { where.push(cond); params.push(...vals); };
    const addIN = (col, arr) => {
      if (Array.isArray(arr) && arr.length) {
        add(`${db.escapeId(col)} IN (${arr.map(()=>'?').join(',')})`, ...arr);
      }
    };
    const baseWhere  = where.join(' AND ');
    const baseParams = [...params];

    // Allgemein
    if (sel.brand.length) addIN('brand_id', sel.brand);
    if (sel.model.length) addIN('model_id', sel.model);

    if (sel.yearMin.length)    add('year >= ?', Math.min(...sel.yearMin));
    if (sel.mileageMax.length) add('mileage <= ?', Math.min(...sel.mileageMax));
    if (sel.priceMax.length)   add('price <= ?', Math.min(...sel.priceMax));
    if (sel.paymentType.length) addIN('payment_type', sel.paymentType);

    if (sel.location.length) {
      const term = `%${String(sel.location[0]).trim()}%`;
      add(`(city LIKE ? OR country_id IN (SELECT id FROM countries WHERE de LIKE ?))`, term, term);
    }

    if (sel.interior.length)       addIN('interior', sel.interior);
    if (sel.airbags.length)        addIN('airbags', sel.airbags);
    if (sel.climatisation.length)  addIN('climatisation', sel.climatisation);
    if (sel.interior_color.length) addIN('interior_color', sel.interior_color);

    if (sel.country.length)          addIN('country_id', sel.country);
    if (sel.registrationYear.length) addIN('firstregistration', sel.registrationYear);
    if (sel.nextHuYear.length)       addIN('maininspection', sel.nextHuYear);
    if (sel.cartype.length)          addIN('cartype', sel.cartype);
    if (sel.fuel.length)             addIN('fuel', sel.fuel);
    if (sel.gearbox.length)          addIN('gearbox', sel.gearbox);
    if (sel.drivetrain.length)       addIN('drivetrain', sel.drivetrain);

    // Autos: Extras
    if (sel.extras && sel.extras.length) {
      sel.extras.forEach(f => {
        if (CAR_EXTRA_NUMERIC_PRESENT?.has?.(f)) where.push(`${db.escapeId(f)} > 0`);
        else where.push(`${db.escapeId(f)} = 1`);
      });
    }

    // Yachts
    if (sel.yachttype.length) addIN('yachttype', sel.yachttype);
    if (sel.lengthMax.length) add('length <= ?', Math.min(...sel.lengthMax));
    if (sel.widthMax?.length) add('beam <= ?',   Math.min(...sel.widthMax));
    if (sel.draftMax?.length) add('draft <= ?',  Math.min(...sel.draftMax));
    if (sel.cabinsMin.length) add('cabins >= ?', Math.max(...sel.cabinsMin));
    if (sel.engines_count.length) addIN('engines_count', sel.engines_count);
    if (sel.power_kw.length)      addIN('power_kw', sel.power_kw);
    if (sel.tank_volume.length)   addIN('tank_volume', sel.tank_volume);
    if (sel.displacement.length)  addIN('displacement', sel.displacement);
    if (sel.cruise_speed.length)  addIN('cruise_speed', sel.cruise_speed);
    if (sel.max_speed.length)     addIN('max_speed', sel.max_speed);
    if (sel.hours_run.length)     addIN('hours_run', sel.hours_run);
    if (sel.flag.length)          addIN('flag', sel.flag);

    // Lifestyle
    if (sel.q && sel.q.length) {
      const term = `%${String(sel.q[0]).trim()}%`;
      add(`name LIKE ?`, term);
    }
    if (sel.lifestyleType.length)        addIN('brand_id', sel.lifestyleType);
    if (sel.lifestyleSubcategory.length) addIN('model_id', sel.lifestyleSubcategory);

    // Properties
    if (entityRoute === 'properties') {
      if (sel.propertytype.length) addIN('propertytype', sel.propertytype);
      if (sel.country.length)      addIN('country_id',   sel.country);
      if (sel.priceMin.length)     add('price >= ?',     Math.max(...sel.priceMin));
      if (sel.areaMin.length)      add('livingarea >= ?',Math.max(...sel.areaMin));
      if (sel.roomsMin.length)     add('bedrooms >= ?',  Math.max(...sel.roomsMin));
      if (sel.bathroomsMin.length) add('bathrooms >= ?', Math.max(...sel.bathroomsMin));
      if (sel.heating.length)      addIN('heating',      sel.heating);
    }

    // WATCHES – Lookup-Felder + Features + Functions + Delivery
    if (entityRoute === 'watches') {
      addIN('watchtype',      sel.watchtype);
      addIN('gender',         sel.gender);
      addIN('case_material',  sel.case_material);
      addIN('strap_material', sel.strap_material);
      addIN('strap_color',    sel.strap_color);
      addIN('bezel_material', sel.bezel_material);
      addIN('dial_shape',     sel.dial_shape);
      addIN('dial_numbers',   sel.dial_numbers);
      addIN('dial_color',     sel.dial_color);
      addIN('waterproof',     sel.waterproof);
      addIN('movement',       sel.movement);
      addIN('clasp_material', sel.clasp_material);
      addIN('clasp_type',     sel.clasp_type);
      addIN('crystal',        sel.crystal);

      // Features: jedes gesetzte feature_* => =1
      Object.keys(sel).forEach(k => {
        if (!k.startsWith('feature_')) return;
        const on = (Array.isArray(sel[k]) ? sel[k] : [sel[k]]).some(v => String(v) === '1');
        if (on) where.push(`${db.escapeId(k)} = 1`);
      });

      // Functions: mappe auf einzelne Boolean-Spalten function_*
      if (sel.functions && sel.functions.length) {
        sel.functions.forEach(v => {
          const col = toWatchFunctionCol(v);
          if (col) where.push(`${db.escapeId(col)} = 1`);
        });
      }

      // Delivery: mappe auf authenticity_* Spalten
      if (sel.delivery && sel.delivery.length) {
        sel.delivery.forEach(v => {
          const col = WATCH_DELIVERY_MAP[String(v).toLowerCase()];
          if (col) where.push(`${db.escapeId(col)} = 1`);
        });
      }
    }

    // Marken/Modelle-Listen (nur Grundbedingungen → baseWhere)
    if (['cars','watches','yachts'].includes(entityRoute)) {
      [brands] = await db.query(`
        SELECT b.id, b.name
        FROM brands AS b
        JOIN ${tableName} AS t
          ON t.brand_id = b.id
         AND ${baseWhere}
        WHERE b.type = ?
        GROUP BY b.id, b.name
        ORDER BY b.name
      `, [type, ...baseParams]);

      if (Array.isArray(sel.brand) && sel.brand.length && ['cars','watches'].includes(entityRoute)) {
        const ph = sel.brand.map(() => '?').join(',');
        [models] = await db.query(`
          SELECT m.id, m.name
          FROM models AS m
          JOIN ${tableName} AS t
            ON t.model_id = m.id
           AND t.brand_id IN (${ph})
           AND ${baseWhere}
          GROUP BY m.id, m.name
          ORDER BY m.name
        `, [...sel.brand, ...baseParams]);
      } else {
        models = [];
      }
    } else {
      brands = opts('brand');
      models = [];
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

// 6) Count
const [[{ totalCount }]] = await db.query(
  `SELECT COUNT(*) AS totalCount FROM ${tableName} ${whereClause}`, params
);
const totalPages = Math.ceil(totalCount / limit);

// 7) Items (Basisdaten)
let rows;

const hasFilter = Object.values(sel).some(v => Array.isArray(v) && v.length);

if (!hasFilter) {
  console.log('➡️ UNION-Mode für Ads zuerst aktiv');
  console.log('currentEntity.id:', currentEntity.id, 'route:', currentEntity.route);

  // 🟢 Extra-Felder für aktuelle Entity holen
  const extraCols = (ENTITY_EXTRA_FIELDS[currentEntity.route] || [])
    .map(f => `t.${db.escapeId(f)}`)
    .join(", ");

  const selectCols = `
    t.id, t.pictures, t.price, t.name, t.currency
    ${extraCols ? ', ' + extraCols : ''}
  `;

  const [unionRows] = await db.query(
    `
(
  SELECT ${selectCols}, 1 AS is_ad
  FROM ${tableName} t
  JOIN slider_ads sa
    ON sa.advert_id = t.id
   AND sa.entitie_id = ?
   AND NOW() BETWEEN sa.start_date AND sa.end_date
  WHERE ${baseWhere}
)
UNION ALL
(
  SELECT ${selectCols}, 0 AS is_ad
  FROM ${tableName} t
  WHERE ${baseWhere}
    AND t.id NOT IN (
      SELECT advert_id
      FROM slider_ads
      WHERE entitie_id = ?
        AND NOW() BETWEEN start_date AND end_date
    )
)
ORDER BY is_ad DESC, id DESC
LIMIT ? OFFSET ?
    `,
    [currentEntity.id, ...baseParams, currentEntity.id, ...baseParams, limit, offset]
  );

  rows = unionRows;
} else {
  // ✅ Mit Filter → normale Abfrage
  console.log('➡️ Normal-Mode mit Filtern aktiv');

  const [normalRows] = await db.query(
    `SELECT id, pictures, price, name, currency
     FROM ${tableName}
     ${whereClause}
     ORDER BY published DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  rows = normalRows;
}

// Debug-Ausgaben
console.log('HasFilter:', hasFilter);
console.log('QueryParams:', params);
console.log('baseWhere:', baseWhere);
console.log('whereClause:', whereClause);
console.log('rows.length:', rows?.length);




    // 7a) Übersetzungen overlay (active -> en -> de)
    const SUPPORTED_LANGS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
    const activeLang = (res.locals.lang && SUPPORTED_LANGS.includes(res.locals.lang))
      ? res.locals.lang : 'de';
    const langOrder = (activeLang === 'de') ? ['de','en'] : [activeLang, 'en', 'de'];

    const idList = rows.map(r => r.id);
    const titleMap = new Map(); // id -> bestTitle

    if (idList.length) {
      const idPlaceholders   = idList.map(() => '?').join(',');
      const langPlaceholders = langOrder.map(() => '?').join(',');
      // listing_translations: entitie_id = currentEntity.id, advert_id = Stammdatensatz-ID
      const [trRows] = await db.query(
        `SELECT advert_id, language, title
           FROM listing_translations
          WHERE entitie_id = ?
            AND advert_id IN (${idPlaceholders})
            AND language IN (${langPlaceholders})
          ORDER BY FIELD(language, ${langPlaceholders})`,
        [currentEntity.id, ...idList, ...langOrder, ...langOrder]
      );
      const seen = new Set();
      for (const r of trRows) {
        if (seen.has(r.advert_id)) continue;
        seen.add(r.advert_id);
        if (r.title) titleMap.set(r.advert_id, r.title);
      }
    }

    // Preis-Format je Sprache (Euro bleibt)
    const LOCALE_MAP = {
      de:'de-DE', en:'en-US', fr:'fr-FR', it:'it-IT', es:'es-ES',
      nl:'nl-NL', tr:'tr-TR', cs:'cs-CZ', ru:'ru-RU', ja:'ja-JP', pl:'pl-PL'
    };
    const priceLocale = LOCALE_MAP[activeLang] || 'de-DE';

const items = rows.map(r => {
  const raw  = tryUnserialize(r.pictures || 'a:0:{}') || [];
  const pics = Array.isArray(raw) ? raw : Object.values(raw);
  const first = pics[1];
  const candidate = typeof first === 'string' ? first : (first?.image || '');
  const filename  = fallbackResolveImageFilename(entityRoute, r.id, candidate);
  const p         = r.price != null ? Number(r.price) : null;

  const title = titleMap.get(r.id) || r.name;

  // 🟢 dynamisch Extra-Felder übernehmen
  const extraFields = Object.fromEntries(
    (ENTITY_EXTRA_FIELDS[entityRoute] || []).map(f => [f, r[f] ?? null])
  );

  // 🔎 Debug-Ausgabe
  console.log('🟢 Mapping Item:', {
    id: r.id,
    title,
    entity: entityRoute,
    ...extraFields
  });

  return {
    id: r.id,
    title,
    pictures: pics,
    mainPic: filename,
    imageUrl: `/images/${entityRoute}/${r.id}/${encodeURIComponent(filename)}`,
    price: (p != null && Number(p) > 0) ? Number(p) : null,
    priceFormatted: (p != null && Number(p) > 0)
      ? new Intl.NumberFormat(priceLocale || 'de-DE', {
          style: 'currency',
          currency: (r.currency || 'EUR').toUpperCase(),
          maximumFractionDigits: 0
        }).format(Number(p))
      : null,
    priceOnRequest: !(p != null && Number(p) > 0),

    ...extraFields // 🟢 hier werden cartype, fuel, … etc. reingemischt
  };
});


// 🔹 Extra-Felder für den Slider dynamisch bestimmen
const sliderExtraColsArr = (ENTITY_EXTRA_FIELDS[currentEntity.route] || []);
const sliderExtraColsSQL = sliderExtraColsArr.map(f => `t.${db.escapeId(f)}`).join(', ');
const sliderSelectCols = `
  t.id,
  t.name AS title,
  t.pictures,
  t.price,
  t.currency
  ${sliderExtraColsSQL ? ', ' + sliderExtraColsSQL : ''}
`;

// 🔹 Slider-Items laden (mit Extra-Spalten)
const [sliderItems] = await db.query(
  `
  SELECT ${sliderSelectCols}
  FROM advert_inserat ks
  JOIN ${db.escapeId(currentEntity.table_name)} t
    ON t.id = ks.advert_id
  WHERE ks.entitie_id = ?
    AND ks.start_date <= CURDATE()
    AND ks.end_date   >= CURDATE()
  ORDER BY ks.start_date DESC
  LIMIT 12
  `,
  [currentEntity.id]
);

// 🔹 Titel-Übersetzungen (wie gehabt)
const sliderIdList = sliderItems.map(r => r.id);
const sliderTitleMap = new Map();

if (sliderIdList.length) {
  const idPh  = sliderIdList.map(() => '?').join(',');
  const langPh = langOrder.map(() => '?').join(',');
  const [trSlider] = await db.query(
    `
    SELECT advert_id, language, title
    FROM listing_translations
    WHERE entitie_id = ?
      AND advert_id IN (${idPh})
      AND language IN (${langPh})
    ORDER BY FIELD(language, ${langPh})
    `,
    [currentEntity.id, ...sliderIdList, ...langOrder, ...langOrder]
  );
  const seen = new Set();
  for (const r of trSlider) {
    if (seen.has(r.advert_id)) continue;
    seen.add(r.advert_id);
    if (r.title) sliderTitleMap.set(r.advert_id, r.title);
  }
}

// 🔹 Slider-Items mappen (inkl. Extra-Felder)
const slider = sliderItems.map(r => {
  const raw  = tryUnserialize(r.pictures || 'a:0:{}') || [];
  const pics = Array.isArray(raw) ? raw : Object.values(raw);
  const first = pics[1];
  const candidate = typeof first === 'string' ? first : (first?.image || '');
  const filename  = fallbackResolveImageFilename(currentEntity.route, r.id, candidate);

  const p     = r.price != null ? Number(r.price) : null;
  const title = sliderTitleMap.get(r.id) || r.title;

  // Extra-Felder aus dem SELECT übernehmen
  const extra = Object.fromEntries(
    sliderExtraColsArr.map(f => [f, r[f] ?? null])
  );

  const item = {
    id: r.id,
    title,
    mainPic: filename,
    imageUrl: `/images/${currentEntity.route}/${r.id}/${encodeURIComponent(filename)}`,
    price: p,
    priceFormatted: (p && p > 0)
      ? new Intl.NumberFormat(priceLocale || 'de-DE', {
          style: 'currency',
          currency: (r.currency || 'EUR').toUpperCase(),
          maximumFractionDigits: 0
        }).format(p)
      : null,
    ...extra
  };

  console.log('🟣 Slider item mapped:', { id: item.id, route: currentEntity.route, ...extra });
  return item;
});



    // 8) Footer
    const [cols]  = await db.query(`SELECT id,title,sort_order FROM footer_columns ORDER BY sort_order,title`);
    const [links] = await db.query(`
      SELECT column_id,link_text,link_url,is_phone,phone_number
      FROM footer_links
      ORDER BY column_id,sort_order
    `);
    const footerColumns = cols.map(c => ({ id: c.id, title: c.title, phone: null, links: [] }));
    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else col.links.push({ text: l.link_text, url: l.link_url });
    }

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
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };

    // Lokale Variable für alle Views verfügbar
    res.locals.seo = seo;

    // 9) Render
    res.render('pages/templates/category', {
      entieties: entities,
      currentEntity,
      filters: {
        // allgemein
        brands,
        models,
        years,
        countries,
        registrationYears,
        nextHuYears,

        // watches
        watchTypes,
        genders,
        caseMaterials,
        strapMaterials,
        strapColors,
        bezelMaterials,
        dialShapes,
        dialNumbers,
        dialColors,
        crystals,
        claspMaterials,
        claspTypes,
        waterproofs,
        movements,
        functions,
        deliveries,

        // cars
        cartypes,
        fuels,
        gearboxes,
        drivetrains,
        transmissions,
        colors,
        interiors,
        airbags,
        climatisations,
        drives,
        engines,
        emissionClasses,
        pollutionClasses,
        badges,

        // yachts
        yachtTypes,
        tankVolumes,
        crewCounts,
        displacements,
        berths,
        enginesCount,
        powerKw,
        hoursRun,
        cruiseSpeed,
        maxSpeed,
        hullMaterials,
        beamWidths,
        lengths,
        drafts,
        cabins,
        flags,

        // properties
        propertyTypes,
        heating:    heatingTypes,
        plotSize:   plotSizes,
        livingArea: livingAreas,
        floors,
        rooms,
        bathrooms,

        // lifestyles
        lifestyleTypes,
        lifestyleSubcategories,
      },

      slider,
      selectedFilters: sel,
      items,
      currentPage,
      totalPages,
      limit,
      totalCount,
      footerColumns,
      user,
    });

  } catch (err) {
    console.error('🚨 Fehler in GET /:entityRoute:', err);
    next(err);
  }
});


function toArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

const IN = (arr) => arr.map(()=>'?').join(',');

// ===== Yacht-Spalten dynamisch ermitteln (einmalig pro Prozess) =====
let YACHT_COLS = {
  HOURS: null,        // engine_hours | hours | ...
  HULL: null,         // hull | hull_material | ...
  FLAG: null,         // country_id | flag | ...
  POWER: null,        // power | power_kw | horsepower
  TANK: null,         // fuel_tankage | tank_volume | water_tankage
  CRUISE: null,       // cruising_speed | cruise_speed
  ENGINES: null       // engines | engines_count
};
let YACHT_COLS_READY = false;

async function getExistingCol(tableName, candidates) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName.replace(/`/g,'')] // falls mit escapeId reingereicht
  );
  const have = new Set(rows.map(r => r.COLUMN_NAME));
  return candidates.find(c => have.has(c)) || null;
}

async function resolveYachtCols(tableName) {
  const hours   = await getExistingCol(tableName, ['engine_hours','hours','mot_hours','running_hours']);
  const hull    = await getExistingCol(tableName, ['hull','hull_material','hullmaterial','material','hull_mat','hull_material_id']);
  const flag    = await getExistingCol(tableName, ['country_id','flag','flag_id','flagcode','flag_code','flag_country']);
  const power   = await getExistingCol(tableName, ['power','power_kw','horsepower']);
  const tank    = await getExistingCol(tableName, ['fuel_tankage','tank_volume','water_tankage']);
  const cruise  = await getExistingCol(tableName, ['cruising_speed','cruise_speed']);
  const engines = await getExistingCol(tableName, ['engines','engines_count']);

  YACHT_COLS = { HOURS: hours, HULL: hull, FLAG: flag, POWER: power, TANK: tank, CRUISE: cruise, ENGINES: engines };
  YACHT_COLS_READY = true;
}

async function ensureYachtColsResolved(tableName) {
  if (!YACHT_COLS_READY) await resolveYachtCols(tableName);
}

// Liefert die zu nutzende DB-Spalte für einen Yacht-Filter-Key (oder null)
function yc(key) {
  switch (key) {
    case 'hours_run':     return YACHT_COLS.HOURS;
    case 'hull_material': return YACHT_COLS.HULL;
    case 'flag':          return YACHT_COLS.FLAG;
    case 'power_kw':      return YACHT_COLS.POWER || 'power';
    case 'tank_volume':   return YACHT_COLS.TANK || 'fuel_tankage';
    case 'cruise_speed':  return YACHT_COLS.CRUISE || 'cruising_speed';
    case 'engines_count': return YACHT_COLS.ENGINES || 'engines';
    case 'max_speed':     return 'max_speed';
    case 'displacement':  return 'displacement';
    case 'yachttype':     return 'yachttype';
    default:              return key;
  }
}

// -------------------------------------------------------------
// 1) normalizeFilters
// -------------------------------------------------------------
function normalizeFilters(q) {
  const raw = {
    // general
    brand: q.brand, model: q.model, yearMin: q.yearMin,
    priceMin: q.priceMin, priceMax: q.priceMax,
    location: q.location, country: q.country,
    cartype: q.cartype, fuel: q.fuel, gearbox: q.gearbox, drivetrain: q.drivetrain,

    // cars
    registrationYear: q.registrationYear,
    nextHuYear: q.nextHuYear,
    paymentType: q.paymentType,
    mileageMax: q.mileageMax,
    powerMin: q.powerMin,
    powerMax: q.powerMax,
    powerUnit: q.powerUnit, // 'PS' | 'kW'
    displacementMin: q.displacementMin,
    displacementMax: q.displacementMax,
    transmission: q.transmission,
    consumptionMax: q.consumptionMax,
    pollution_class: q.pollution_class,
    emission_class: q.emission_class,
    particulate_filter: q.particulate_filter, // '1' => true
    environmental_badge: q.environmental_badge,
    interior_color: q.interior_color,
    interior: q.interior,
    airbags: q.airbags,
    climatisation: q.climatisation,
    extras: q.extras,

    // watches
    watchtype: q.watchtype, gender: q.gender, case_material: q.case_material,
    strap_material: q.strap_material, strap_color: q.strap_color,
    bezel_material: q.bezel_material, dial_shape: q.dial_shape,
    dial_numbers: q.dial_numbers, waterproof: q.waterproof,
    movement: q.movement, functions: q.functions, delivery: q.delivery,

    // yachts
    yachttype: q.yachttype, lengthMax: q.lengthMax, widthMax: q.widthMax,
    draftMax: q.draftMax, cabinsMin: q.cabinsMin, engines_count: q.engines_count,
    power_kw: q.power_kw, tank_volume: q.tank_volume, displacement: q.displacement,
    cruise_speed: q.cruise_speed, max_speed: q.max_speed,
    hours_run: q.hours_run, flag: q.flag, hull_material: q.hull_material,

    // properties
    propertytype: q.propertytype,
    investmenttype: q.investmenttype,
    quality: q.quality,
    propertyshape: q.propertyshape,
    heating: q.heating,
    energysource: q.energysource,
    energypass: q.energypass,
    energypass_type: q.energypass_type,
    energypass_valueMax: q.energypass_valueMax,
    landareaMin: q.landareaMin,
    landareaMax: q.landareaMax,
    areaMin: q.areaMin,
    areaMax: q.areaMax,
    floorsMin: q.floorsMin,
    floorsMax: q.floorsMax,
    roomsMin: q.roomsMin,
    bathroomsMin: q.bathroomsMin,

    // lifestyle
    lifestyleType: q.lifestyleType,
    lifestyleSubcategory: q.lifestyleSubcategory,
    q: q.q
  };

  return Object.entries(raw).reduce((acc,[k,v])=>{
    const arr = toArray(v).map(x=>{
      if (k === 'particulate_filter') return String(x) === '1' ? 1 : 0;
      const n = parseFloat(x);
      return isNaN(n) ? x : n;
    });
    acc[k] = arr;
    return acc;
  }, {});
}

// -------------------------------------------------------------
// 2) buildWhere
// -------------------------------------------------------------
function buildWhere(entityRoute, tableName, sel) {
  const where = ['status=3', 'visible=1', 'pictures IS NOT NULL'];
  const params = [];
  const add = (cond, ...vals) => { where.push(cond); params.push(...vals); };

  // --- General ---
  if (Array.isArray(sel.brand) && sel.brand.length)
    add(`brand_id IN (${IN(sel.brand)})`, ...sel.brand);

  if (Array.isArray(sel.model) && sel.model.length)
    add(`model_id IN (${IN(sel.model)})`, ...sel.model);

  if (Array.isArray(sel.yearMin) && sel.yearMin.length)
    add(`year >= ?`, Math.min(...sel.yearMin));

  if (Array.isArray(sel.priceMin) && sel.priceMin.length)
    add(`price >= ?`, Math.max(...sel.priceMin));

  if (Array.isArray(sel.priceMax) && sel.priceMax.length)
    add(`price <= ?`, Math.min(...sel.priceMax));

  if (Array.isArray(sel.country) && sel.country.length)
    add(`country_id IN (${IN(sel.country)})`, ...sel.country);

  // --- Properties: freitext location -> city ---
  if (Array.isArray(sel.location) && sel.location.length && entityRoute === 'properties') {
    add(`city LIKE ?`, `%${String(sel.location[0]).trim()}%`);
  }

  // --- Cars ---
  if (entityRoute === 'cars') {
    if (Array.isArray(sel.paymentType) && sel.paymentType.length)
      add(`payment_type IN (${IN(sel.paymentType)})`, ...sel.paymentType);

    if (Array.isArray(sel.mileageMax) && sel.mileageMax.length)
      add(`mileage <= ?`, Math.min(...sel.mileageMax));

    if (Array.isArray(sel.cartype) && sel.cartype.length)
      add(`cartype IN (${IN(sel.cartype)})`, ...sel.cartype);

    if (Array.isArray(sel.fuel) && sel.fuel.length)
      add(`fuel IN (${IN(sel.fuel)})`, ...sel.fuel);

    if (Array.isArray(sel.gearbox) && sel.gearbox.length)
      add(`gearbox IN (${IN(sel.gearbox)})`, ...sel.gearbox);

    if (Array.isArray(sel.drivetrain) && sel.drivetrain.length)
      add(`drivetrain IN (${IN(sel.drivetrain)})`, ...sel.drivetrain);

    if (Array.isArray(sel.registrationYear) && sel.registrationYear.length)
      add(`firstregistration IN (${IN(sel.registrationYear)})`, ...sel.registrationYear);

    if (Array.isArray(sel.nextHuYear) && sel.nextHuYear.length)
      add(`maininspection IN (${IN(sel.nextHuYear)})`, ...sel.nextHuYear);

    const unit = (Array.isArray(sel.powerUnit) && sel.powerUnit[0] ? sel.powerUnit[0] : 'PS').toString().toLowerCase();
    if (Array.isArray(sel.powerMin) && sel.powerMin.length)
      add(`power_${unit} >= ?`, Math.min(...sel.powerMin));

    if (Array.isArray(sel.powerMax) && sel.powerMax.length)
      add(`power_${unit} <= ?`, Math.min(...sel.powerMax));

    if (Array.isArray(sel.displacementMin) && sel.displacementMin.length)
      add(`displacement >= ?`, Math.min(...sel.displacementMin));

    if (Array.isArray(sel.displacementMax) && sel.displacementMax.length)
      add(`displacement <= ?`, Math.min(...sel.displacementMax));

    if (Array.isArray(sel.transmission) && sel.transmission.length)
      add(`transmission IN (${IN(sel.transmission)})`, ...sel.transmission);

    if (Array.isArray(sel.consumptionMax) && sel.consumptionMax.length)
      add(`consumption_combined <= ?`, Math.min(...sel.consumptionMax));

    if (Array.isArray(sel.pollution_class) && sel.pollution_class.length)
      add(`pollution_class IN (${IN(sel.pollution_class)})`, ...sel.pollution_class);

    if (Array.isArray(sel.emission_class) && sel.emission_class.length)
      add(`emission_class IN (${IN(sel.emission_class)})`, ...sel.emission_class);

    if (Array.isArray(sel.particulate_filter) && sel.particulate_filter.length && sel.particulate_filter[0] === 1)
      where.push(`particulate_filter = 1`);

    if (Array.isArray(sel.environmental_badge) && sel.environmental_badge.length)
      add(`environmental_badge IN (${IN(sel.environmental_badge)})`, ...sel.environmental_badge);

    if (Array.isArray(sel.interior_color) && sel.interior_color.length)
      add(`interior_color IN (${IN(sel.interior_color)})`, ...sel.interior_color);

    if (Array.isArray(sel.interior) && sel.interior.length)
      add(`interior IN (${IN(sel.interior)})`, ...sel.interior);

    if (Array.isArray(sel.airbags) && sel.airbags.length)
      add(`airbags IN (${IN(sel.airbags)})`, ...sel.airbags);

    if (Array.isArray(sel.climatisation) && sel.climatisation.length)
      add(`climatisation IN (${IN(sel.climatisation)})`, ...sel.climatisation);

    if (Array.isArray(sel.extras) && sel.extras.length) {
      sel.extras.forEach(f => {
        const col = String(f);
        if (typeof CAR_EXTRA_NUMERIC_PRESENT !== 'undefined' && CAR_EXTRA_NUMERIC_PRESENT.has(col)) {
          where.push(`${db.escapeId(col)} > 0`);
        } else {
          where.push(`${db.escapeId(col)} = 1`);
        }
      });
    }
  }

  // --- Watches ---
  if (entityRoute === 'watches') {
    const inC = (k) => Array.isArray(sel[k]) && sel[k].length ? add(`${k} IN (${IN(sel[k])})`, ...sel[k]) : null;
    [
      'watchtype','gender','case_material','strap_material','strap_color',
      'bezel_material','dial_shape','dial_numbers','waterproof',
      'movement','functions','delivery'
    ].forEach(inC);
  }

  // --- Yachts ---
  if (entityRoute === 'yachts') {
    const numMin = (key) => {
      const col = yc(key);
      if (col && Array.isArray(sel[key]) && sel[key].length)
        add(`${db.escapeId(col)} >= ?`, Math.min(...sel[key]));
    };
    const inList = (key) => {
      const col = yc(key);
      if (col && Array.isArray(sel[key]) && sel[key].length)
        add(`${db.escapeId(col)} IN (${IN(sel[key])})`, ...sel[key]);
    };

    inList('yachttype');
    if (Array.isArray(sel.lengthMax) && sel.lengthMax.length)
      add(`length <= ?`, Math.min(...sel.lengthMax));

    if (Array.isArray(sel.widthMax) && sel.widthMax.length)
      add(`beam <= ?`, Math.min(...sel.widthMax));

    if (Array.isArray(sel.draftMax) && sel.draftMax.length)
      add(`draft <= ?`, Math.min(...sel.draftMax));

    if (Array.isArray(sel.cabinsMin) && sel.cabinsMin.length)
      add(`cabins >= ?`, Math.max(...sel.cabinsMin));

    inList('engines_count');

    numMin('power_kw');
    numMin('tank_volume');
    numMin('displacement');
    numMin('cruise_speed');
    numMin('max_speed');
    numMin('hours_run');

    inList('flag');
    inList('hull_material');
  }

  // --- Properties ---
  if (entityRoute === 'properties') {
    if (Array.isArray(sel.propertytype) && sel.propertytype.length)
      add(`propertytype IN (${IN(sel.propertytype)})`, ...sel.propertytype);

    if (Array.isArray(sel.investmenttype) && sel.investmenttype.length)
      add(`investmenttype IN (${IN(sel.investmenttype)})`, ...sel.investmenttype);

    if (Array.isArray(sel.quality) && sel.quality.length)
      add(`quality IN (${IN(sel.quality)})`, ...sel.quality);

    if (Array.isArray(sel.propertyshape) && sel.propertyshape.length)
      add(`propertyshape IN (${IN(sel.propertyshape)})`, ...sel.propertyshape);

    if (Array.isArray(sel.heating) && sel.heating.length)
      add(`heating IN (${IN(sel.heating)})`, ...sel.heating);

    if (Array.isArray(sel.energysource) && sel.energysource.length)
      add(`energysource IN (${IN(sel.energysource)})`, ...sel.energysource);

    if (Array.isArray(sel.energypass) && sel.energypass.length)
      add(`energypass IN (${IN(sel.energypass)})`, ...sel.energypass);

    if (Array.isArray(sel.energypass_type) && sel.energypass_type.length)
      add(`energypass_type IN (${IN(sel.energypass_type)})`, ...sel.energypass_type);

    if (Array.isArray(sel.energypass_valueMax) && sel.energypass_valueMax.length)
      add(`energypass_value <= ?`, Math.min(...sel.energypass_valueMax));

    if (Array.isArray(sel.landareaMin) && sel.landareaMin.length)
      add(`landarea >= ?`, Math.max(...sel.landareaMin));

    if (Array.isArray(sel.landareaMax) && sel.landareaMax.length)
      add(`landarea <= ?`, Math.min(...sel.landareaMax));

    if (Array.isArray(sel.areaMin) && sel.areaMin.length)
      add(`livingarea >= ?`, Math.max(...sel.areaMin));

    if (Array.isArray(sel.areaMax) && sel.areaMax.length)
      add(`livingarea <= ?`, Math.min(...sel.areaMax));

    if (Array.isArray(sel.floorsMin) && sel.floorsMin.length)
      add(`floors >= ?`, Math.max(...sel.floorsMin));

    if (Array.isArray(sel.floorsMax) && sel.floorsMax.length)
      add(`floors <= ?`, Math.min(...sel.floorsMax));

    if (Array.isArray(sel.roomsMin) && sel.roomsMin.length)
      add(`bedrooms >= ?`, Math.max(...sel.roomsMin));

    if (Array.isArray(sel.bathroomsMin) && sel.bathroomsMin.length)
      add(`bathrooms >= ?`, Math.max(...sel.bathroomsMin));
  }

  return { where: where.join(' AND '), params };
}


// -------------------------------------------------------------
// 3) loadFilterOptions
// -------------------------------------------------------------
async function loadFilterOptions(entityRoute, tableName, type, baseWhere, baseParams, langCol = 'de') {
  // Optionen aus attribute_options + Übersetzungen aus ui_translations
  const [allOpts] = await db.query(
    `SELECT 
       ao.column_name,
       ao.option_value AS id,
       COALESCE(
         NULLIF(uit.${langCol}, ''),
         NULLIF(uit.en, ''),
         NULLIF(uit.de, ''),
         ao.option_label
       ) AS name
     FROM attribute_options ao
     LEFT JOIN ui_translations uit
       ON uit.\`key\` = CONCAT('filters.', ao.entitie_route, '.', ao.column_name, '.', ao.option_value)
     WHERE ao.entitie_route = ?
     ORDER BY ao.sort_order,
              CAST(ao.option_value AS UNSIGNED),
              ao.option_value`,
    [entityRoute]
  );
  const opts = (col) => allOpts.filter(o => o.column_name === col).map(({id,name}) => ({ id:String(id), name }));

  // Alias-Where (JOINs benutzen t.*)
  const baseWhereT = baseWhere
    .replace(/\bstatus\b/g, 't.status')
    .replace(/\bvisible\b/g, 't.visible')
    .replace(/\bpictures\b/g, 't.pictures');

  // Gemeinsames
  let years=[], countries=[];
  {
    const [yearRows] = await db.query(
      `SELECT DISTINCT year FROM ${tableName}
        WHERE year IS NOT NULL
        ORDER BY year DESC`
    );
    years = yearRows.map(r => r.year);

    // Länder mehrsprachig, falls Spalte existiert, sonst Fallback 'de'
    const langColSafe = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'].includes(langCol) ? langCol : 'de';
    const [allCountries] = await db.query(
      `SELECT 
         c.id,
         COALESCE(NULLIF(c.${langColSafe}, ''), c.de)      AS name,
         c.parent_id,
         COALESCE(NULLIF(p.${langColSafe}, ''), p.de)      AS region
       FROM countries c
  LEFT JOIN countries p ON c.parent_id = p.id
      WHERE c.visible = 1
      ORDER BY COALESCE(p.${langColSafe}, p.de, c.${langColSafe}, c.de),
               c.${langColSafe}, c.de`
    );
    countries = allCountries;
  }

  // Vorbelegung
  let brands=[], models=[],
      registrationYears=[], nextHuYears=[],
      watchTypes=[], genders=[], caseMaterials=[], strapMaterials=[], strapColors=[],
      bezelMaterials=[], dialShapes=[], dialNumbers=[], waterproofs=[], movements=[], functions=[], deliveries=[],
      yachtTypes=[], prices=[], boatTypes=[], categories=[], tankVolumes=[], crewCounts=[], displacements=[], berths=[],
      enginesCount=[], powerKw=[], hoursRun=[], cruiseSpeed=[], maxSpeed=[], hullMaterials=[], beamWidths=[], lengths=[],
      drafts=[], cabins=[], flags=[],
      cartypes=[], fuels=[], gearboxes=[], drivetrains=[], transmissions=[], colors=[], interiors=[],
      emissionClasses=[], pollutionClasses=[], badges=[], airbags=[], climatisations=[],
      propertyTypes=[], heatingTypes=[], plotSizes=[], livingAreas=[], floors=[], rooms=[], bathrooms=[],
      investmentTypes=[], qualities=[], propertyShapes=[], energySources=[], energyPasses=[], energyPassTypes=[],
      lifestyleTypes=[], lifestyleSubcategories=[], features=[];

  // cars
  if (entityRoute === 'cars') {
    const [reg]  = await db.query(`SELECT DISTINCT firstregistration AS year FROM ${tableName} WHERE firstregistration IS NOT NULL ORDER BY firstregistration DESC`);
    registrationYears = reg.map(r=>r.year);
    const [insp] = await db.query(`SELECT DISTINCT maininspection   AS year FROM ${tableName} WHERE maininspection   IS NOT NULL ORDER BY maininspection   DESC`);
    nextHuYears = insp.map(r=>r.year);

    cartypes         = opts('cartype');
    fuels            = opts('fuel');
    gearboxes        = opts('gearbox');
    drivetrains      = opts('drivetrain');
    transmissions    = opts('transmission');
    colors           = opts('color');
    interiors        = opts('interior');
    emissionClasses  = opts('emission_class');
    pollutionClasses = opts('pollution_class');
    badges           = opts('environmental_badge');
    airbags          = opts('airbags');
    climatisations   = opts('climatisation');

    const [brandRows] = await db.query(
      `SELECT b.id, b.name
         FROM brands b
         JOIN ${tableName} t ON t.brand_id=b.id AND ${baseWhereT}
        WHERE b.type=?
        GROUP BY b.id, b.name
        ORDER BY b.name`,
      [...baseParams, type]
    );
    brands = brandRows;
  }

  // watches
  if (entityRoute === 'watches') {
    const [brandRows] = await db.query(
      `SELECT b.id, b.name
         FROM brands b
         JOIN ${tableName} t ON t.brand_id=b.id AND ${baseWhereT}
        WHERE b.type=?
        GROUP BY b.id, b.name
        ORDER BY b.name`,
      [...baseParams, type]
    );
    brands = brandRows;

    watchTypes     = opts('watchtype');
    genders        = opts('gender');
    caseMaterials  = opts('case_material');
    strapMaterials = opts('strap_material');
    strapColors    = opts('strap_color');
    bezelMaterials = opts('bezel_material');
    dialShapes     = opts('dial_shape');
    dialNumbers    = opts('dial_numbers');
    waterproofs    = opts('waterproof');
    movements      = opts('movement');
    functions      = opts('functions');
    deliveries     = opts('delivery');
  }

  // yachts
  if (entityRoute === 'yachts') {
    await ensureYachtColsResolved(tableName);

    const [brandRows] = await db.query(
      `SELECT b.id, b.name
         FROM brands b
         JOIN ${tableName} t ON t.brand_id=b.id AND ${baseWhereT}
        WHERE b.type=?
        GROUP BY b.id, b.name
        ORDER BY b.name`,
      [...baseParams, type]
    );
    brands = brandRows;

    yachtTypes    = opts('yachttype');
    powerKw       = opts('power_kw');
    hoursRun      = opts('hours_run');
    cruiseSpeed   = opts('cruise_speed');
    maxSpeed      = opts('max_speed');
    tankVolumes   = opts('tank_volume');
    displacements = opts('displacement');

    // In attribute_options heißt das Feld oft 'hull'
    hullMaterials = opts('hull');

    // Flag kann 'flag' oder 'country_id' sein -> probiere beide
    const flagOpts      = opts('flag');
    const countryIdOpts = opts('country_id');
    flags = flagOpts.length ? flagOpts : countryIdOpts;

    // Fallbacks aus Tabelle, falls keine Options gepflegt
    if (!hullMaterials.length && YACHT_COLS.HULL) {
      const c = db.escapeId(YACHT_COLS.HULL);
      const [rows] = await db.query(
        `SELECT DISTINCT ${c} AS id, ${c} AS name
           FROM ${tableName} t
          WHERE ${baseWhereT} AND ${c} IS NOT NULL AND ${c} <> ''
          ORDER BY ${c}`, baseParams
      );
      hullMaterials = rows.map(r => ({ id:String(r.id), name:r.name }));
    }
    if (!flags.length && YACHT_COLS.FLAG) {
      const c = db.escapeId(YACHT_COLS.FLAG);
      const [rows] = await db.query(
        `SELECT DISTINCT ${c} AS id, ${c} AS name
           FROM ${tableName} t
          WHERE ${baseWhereT} AND ${c} IS NOT NULL AND ${c} <> ''
          ORDER BY ${c}`, baseParams
      );
      flags = rows.map(r => ({ id:String(r.id), name:r.name }));
    }
  }

  // properties
  if (entityRoute === 'properties') {
    propertyTypes     = opts('propertytype');
    investmentTypes   = opts('investmenttype');
    heatingTypes      = opts('heating');
    qualities         = opts('quality');
    propertyShapes    = opts('propertyshape');
    energySources     = opts('energysource');
    energyPasses      = opts('energypass');
    energyPassTypes   = opts('energypass_type');

    // optionale „bereichs“-Listen (wenn du sie in attribute_options pflegst)
    plotSizes         = opts('plot_size');
    livingAreas       = opts('living_area');
    floors            = opts('floors');
    rooms             = opts('rooms');
    bathrooms         = opts('bathrooms');
  }

  // lifestyles
  if (entityRoute === 'lifestyles') {
    const [lt] = await db.query(`SELECT id, name FROM brands WHERE type = 6 ORDER BY name`);
    lifestyleTypes = lt;
    if (lifestyleTypes.length) {
      const ids = lifestyleTypes.map(b=>b.id);
      const ph  = ids.map(()=>'?').join(',');
      const [subs] = await db.query(
        `SELECT id, name, brand_id AS parentId
           FROM models
          WHERE brand_id IN (${ph})
          ORDER BY name`,
        ids
      );
      lifestyleSubcategories = subs;
    }
  }

  return {
    // common
    brands, models, years, countries, registrationYears, nextHuYears,
    // watches
    watchTypes, genders, caseMaterials, strapMaterials, strapColors, bezelMaterials, dialShapes, dialNumbers, waterproofs, movements, functions, deliveries, features,
    // cars
    cartypes, fuels, gearboxes, drivetrains, transmissions, colors, interiors, airbags, climatisations, emissionClasses, pollutionClasses, badges,
    // yachts
    yachtTypes, prices, boatTypes, categories, tankVolumes, crewCounts, displacements, berths,
    enginesCount, powerKw, hoursRun, cruiseSpeed, maxSpeed, hullMaterials, beamWidths, lengths, drafts, cabins, flags,
    // properties
    propertyTypes, investmentTypes, heating: heatingTypes, plotSize: plotSizes, livingArea: livingAreas,
    floors, rooms, bathrooms, qualities, propertyShapes, energySources, energyPasses, energyPassTypes,
    // lifestyles
    lifestyleTypes, lifestyleSubcategories,
    // extras (falls global vorhanden)
    extras: (typeof CAR_EXTRAS !== 'undefined' ? CAR_EXTRAS : [])
  };
}


// ================= ROUTES ==============================

router.get('/:entityRoute/filters',  async (req, res, next) => {
  const user = res.locals.user;
  try {
    // --- Sprachwahl ---
    const SUPPORTED_LANGS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
    const pickLang = (req) => {
      const inSup = v => v && SUPPORTED_LANGS.includes(v);
      const qLang       = String(req.query.lang || '').toLowerCase();
      const hdrLang     = String(req.get?.('x-lang') || '').toLowerCase();
      const sessLang    = String(req.session?.lang || '').toLowerCase();
      const cookieLang  = String(req.cookies?.lang || '').toLowerCase();
      const acceptFirst = String(req.headers['accept-language'] || '').toLowerCase().split(',')[0].split('-')[0];
      return inSup(qLang) ? qLang
           : inSup(hdrLang) ? hdrLang
           : inSup(sessLang) ? sessLang
           : inSup(cookieLang) ? cookieLang
           : inSup(acceptFirst) ? acceptFirst
           : 'de';
    };
    const activeLang = pickLang(req);
    const langCol = activeLang;

    const entityRoute = req.params.entityRoute;

    const [entities] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);
    const currentEntity = entities.find(e => e.route === entityRoute);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    const tableName = db.escapeId(currentEntity.table_name);
    const categoryTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles: 6 };
    const type = categoryTypeMap[entityRoute] || null;

    const baseWhere  = 'status=3 AND visible=1 AND pictures IS NOT NULL';
    const baseParams = [];

    // 👉 Hilfsfunktion für Arrays
    const normArray = v =>
      (v === undefined || v === null || v === ''
        ? []
        : Array.isArray(v)
          ? v
          : [v]);

    // Ausgewählte Filter erzwingen Arrays
    const selectedFilters = {
      ...req.query,
      brand: normArray(req.query.brand).map(String),
      model: normArray(req.query.model).map(String),
      extras: normArray(req.query.extras)
        .map(String)
        .filter(v => (typeof CAR_EXTRAS !== 'undefined') && CAR_EXTRAS.some(e => e.field === v))
    };

    // 👉 Debug-Ausgabe
    console.log("DEBUG sel vor buildWhere:", JSON.stringify(selectedFilters, null, 2));

    // sel an buildWhere übergeben
    const sel = { ...selectedFilters };
    const { where: finalWhere, params: finalParams } = buildWhere(entityRoute, tableName, sel);

    // Footer/
    const [cols]  = await db.query(`SELECT id,title,sort_order FROM footer_columns ORDER BY sort_order,title`);
    const [links] = await db.query(`SELECT column_id,link_text,link_url,is_phone,phone_number FROM footer_links ORDER BY column_id,sort_order`);
    const footerColumns = cols.map(c => ({ id:c.id, title:c.title, phone:null, links:[] }));
    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else col.links.push({ text:l.link_text, url:l.link_url });
    }

    // Filteroptionen
    const filters = await loadFilterOptions(entityRoute, tableName, type, baseWhere, baseParams, langCol);

    // SEO
    const urlPath = normalizePathUrl(req.path); 
    const [[seoRow]] = await db.query(
      `SELECT title, description AS meta_description, robots, og_title, og_description, og_image, twitter_card, jsonld AS structured_data_json
         FROM seo_meta
        WHERE path_pattern = ?
        LIMIT 1`,
      [urlPath]
    );
    const seo = {
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };
    res.locals.seo = seo;

    // Rendern
    res.render('pages/templates/filterpage', {
      entieties: entities,
      currentEntity,
      filters,
      selectedFilters,
      footerColumns,
      user,
      activeLang
    });
  } catch (err) {
    console.error('🚨 Fehler in GET /:entityRoute/filters:', err);
    next(err);
  }
});





// GENERISCHER COUNT (für alle Entities)
router.get('/api/:entityRoute/count', async (req,res,next)=>{
  try{
    const entityRoute = req.params.entityRoute;
    const [rows] = await db.query(
      `SELECT table_name FROM ententies WHERE route=? LIMIT 1`, [entityRoute]
    );
    const tableRow = rows && rows[0];
    if (!tableRow || !tableRow.table_name) return res.json({ count: 0 });

    const tableName = db.escapeId(tableRow.table_name);
    const sel = normalizeFilters(req.query);
    const { where, params } = buildWhere(entityRoute, tableName, sel);

    const [[{ cnt }]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE ${where}`, params
    );
    res.json({ count: cnt });
  }catch(e){
    console.error('count error', e);
    res.status(500).json({ count: 0 });
  }
});

// MODELLE je Entity (für das Marken->Model Dropdown)
router.get('/api/:entityRoute/models', async (req,res,next)=>{
  try{
    const entityRoute = req.params.entityRoute;
    const brands = toArray(req.query.brand).map(Number).filter(Boolean);
    if (!brands.length) return res.json([]);

    const [rowsTN] = await db.query(
      `SELECT table_name FROM ententies WHERE route=? LIMIT 1`, [entityRoute]
    );
    const tableRow = rowsTN && rowsTN[0];
    if (!tableRow || !tableRow.table_name) return res.json([]);

    const tableName = db.escapeId(tableRow.table_name);
    const baseWhere = 'status=3 AND visible=1 AND pictures IS NOT NULL';

    const ph = brands.map(()=>'?').join(',');
    const [rows] = await db.query(`
      SELECT m.id, m.name
      FROM models m
      JOIN ${tableName} t ON t.model_id=m.id AND t.brand_id IN (${ph}) AND ${baseWhere}
      GROUP BY m.id, m.name
      ORDER BY m.name
    `, brands);
    res.json(rows);
  }catch(e){
    console.error('models error', e);
    res.status(500).json([]);
  }
});





// Brand-Seite: /:entityRoute/:brandSeo
router.get('/:entityRoute/:brandSeo',  async (req, res, next) => {
  const user = res.locals.user;

  try {
    const entityRoute = req.params.entityRoute;
    const brandSeoRaw = req.params.brandSeo;
    const brandSeo    = String(brandSeoRaw || '').toLowerCase();

    // 1) Kategorien laden
    const [entities] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);
    const currentEntity = entities.find(e => e.route === entityRoute);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    // 2) entityTypeMap (für brands.type)
    const entityTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles: 6 };
    const categoryType  = entityTypeMap[entityRoute];
    if (!categoryType)  return res.status(404).send('Kategorie nicht gefunden');

    // 3) Marke per seoname
    const [brandRows] = await db.query(`
      SELECT id, name, seoname, meta_de, de
      FROM brands
      WHERE type = ? AND LOWER(seoname) = ?
      LIMIT 1
    `, [categoryType, brandSeo]);
    if (brandRows.length === 0) return res.status(404).send('Marke nicht gefunden');

    const brand   = brandRows[0];
    const brandId = brand.id;
    const brandDescription =
      (brand.de && brand.de.trim()) || (brand.meta_de && brand.meta_de.trim()) || '';

    // 4) Filter-Parameter
    const q = req.query;
    const pick = (name) => {
      const v = q[`filter[${name}]`];
      if (v == null) return [];
      return Array.isArray(v) ? v.map(String) : [String(v)];
    };

    const filterBrandIds = [String(brandId)];
    const filterModelIds = pick('model');

    const numOrNull = (v) => (v == null || v === '' ? null : Number(v));
    const filterPriceMin = numOrNull(q['filter[priceMin]']);
    const filterPriceMax = numOrNull(q['filter[priceMax]']);
    const filterYearMin  = numOrNull(q['filter[yearMin]']);
    const filterYearMax  = numOrNull(q['filter[yearMax]']);

    const filterLocation  = (q['filter[location]'] || '').trim() || null;
    const filterInEurope  = q['filter[inEurope]']  === 'true';
    const filterInEU      = q['filter[inEU]']      === 'true';
    const filterInGermany = q['filter[inGermany]'] === 'true';
    const filterCountryId = q['filter[countryId]'] ? String(q['filter[countryId]']) : null;

    // 5) Filter-Optionen (Marken/Modelle)
    const [allBrandRows] = await db.query(`
      SELECT id, name, seoname
      FROM brands
      WHERE type = ?
      ORDER BY name
    `, [categoryType]);

    let modelRows = [];
    if (filterBrandIds.length) {
      const ph = filterBrandIds.map(() => '?').join(',');
      [modelRows] = await db.query(`
        SELECT m.id, m.name, m.brand_id
        FROM models AS m
        JOIN brands AS b ON m.brand_id = b.id
        WHERE b.type = ? AND m.brand_id IN (${ph})
        ORDER BY m.name
      `, [categoryType, ...filterBrandIds]);
    }

    // 6) Weitere Options (Jahre/Länder)
    const tableNameEscaped = db.escapeId(currentEntity.table_name);
    const [yearRows] = await db.query(`
      SELECT DISTINCT year
      FROM ${tableNameEscaped}
      WHERE year IS NOT NULL
      ORDER BY year DESC
    `);
    const [countryRows] = await db.query(`
      SELECT id, de AS name
      FROM countries
      WHERE visible = 1
      ORDER BY de
    `);

    // 7) Attribute-Optionen
    const [allOpts] = await db.query(`
      SELECT column_name,
             option_value AS id,
             option_label AS name
      FROM attribute_options
      WHERE entitie_route = ?
      ORDER BY sort_order
    `, [entityRoute]);

    const getOpts = (col) =>
      allOpts.filter(o => o.column_name === col)
             .map(o => ({ id: String(o.id), name: o.name }));

    // 8) Filters-Objekt
    const filtersOut = {
      brands: allBrandRows,
      models: modelRows,
      years:  yearRows,
      countries: countryRows,
      propertytypes: [],
      cartypes: [], fuels: [], gearboxes: [], drivetrains: [],
      watchTypes: [], genders: [], caseMaterials: [],
      yachtTypes: [], lengths: [], beamWidths: [], drafts: [], cabins: []
    };

    if (entityRoute === 'properties') {
      filtersOut.propertytypes = [
        { id:'10', name:'Finca' },
        { id:'5',  name:'Penthouse' },
        { id:'11', name:'Privatinsel' },
        { id:'6',  name:'Villa/Haus' },
        { id:'8',  name:'Maisonette-Wohnung' },
        { id:'4',  name:'Wohnung' },
        { id:'12', name:'Schloss/Herrenhaus' },
        { id:'255',name:'Sonstige Immobilien' },
      ];
    } else if (entityRoute === 'cars') {
      filtersOut.cartypes    = getOpts('cartype');
      filtersOut.fuels       = getOpts('fuel');
      filtersOut.gearboxes   = getOpts('gearbox');
      filtersOut.drivetrains = getOpts('drivetrain');
    } else if (entityRoute === 'watches') {
      filtersOut.watchTypes    = getOpts('watchtype');
      filtersOut.genders       = getOpts('gender');
      filtersOut.caseMaterials = getOpts('case_material');
    } else if (entityRoute === 'yachts') {
      filtersOut.yachtTypes = getOpts('yachttype');
      filtersOut.lengths    = getOpts('length');
      filtersOut.beamWidths = getOpts('beam');
      filtersOut.drafts     = getOpts('draft');
      filtersOut.cabins     = getOpts('cabins');
    }

    // 9) WHERE-Klausel
    const where = ['status = 3', 'visible = 1', 'pictures IS NOT NULL'];
    const params = [];

    if (filterBrandIds.length) {
      const ph = filterBrandIds.map(() => '?').join(',');
      where.push(`brand_id IN (${ph})`);
      params.push(...filterBrandIds);
    }
    if (filterModelIds.length) {
      const ph = filterModelIds.map(() => '?').join(',');
      where.push(`model_id IN (${ph})`);
      params.push(...filterModelIds);
    }
    if (filterPriceMin !== null) { where.push(`price >= ?`); params.push(filterPriceMin); }
    if (filterPriceMax !== null) { where.push(`price <= ?`); params.push(filterPriceMax); }
    if (filterYearMin  !== null) { where.push(`year  >= ?`); params.push(filterYearMin); }
    if (filterYearMax  !== null) { where.push(`year  <= ?`); params.push(filterYearMax); }

    if (filterLocation) {
      where.push(`(city LIKE ? OR country_id IN (SELECT id FROM countries WHERE de LIKE ?))`);
      params.push(`%${filterLocation}%`, `%${filterLocation}%`);
    }
    if (filterInEurope)  where.push(`country_id IN (SELECT id FROM countries WHERE continent='Europe')`);
    if (filterInEU)      where.push(`country_id IN (SELECT id FROM countries WHERE eu_member=1)`);
    if (filterInGermany) where.push(`country_id IN (SELECT id FROM countries WHERE de='Deutschland')`);
    if (filterCountryId) { where.push(`country_id = ?`); params.push(filterCountryId); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // 10) Pagination
    const currentPage = Math.max(1, parseInt(q.hp, 10) || 1);
    const limit       = Math.max(1, parseInt(q.limit, 10) || 60);
    const offset      = (currentPage - 1) * limit;

    // 11) Count + Daten (Extra-Felder!)
    const extraCols = (ENTITY_EXTRA_FIELDS[entityRoute] || [])
      .map(f => `t.${db.escapeId(f)}`)
      .join(", ");

    const selectCols = `
      t.id, t.pictures, t.price, t.name, t.currency
      ${extraCols ? ', ' + extraCols : ''}
    `;

    const [[{ totalCount }]] = await db.query(`
      SELECT COUNT(*) AS totalCount
      FROM ${tableNameEscaped} t
      ${whereClause}
    `, params);

    const [rows] = await db.query(`
      SELECT ${selectCols}
      FROM ${tableNameEscaped} t
      ${whereClause}
      ORDER BY published DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    // 12) Mapping Items
    const items = rows.map(row => {
      let rawPics;
      try { rawPics = unserialize(row.pictures || 'a:0:{}') || []; }
      catch { rawPics = []; }
      const picsArray = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);
      const mainPic   = picsArray.length ? (picsArray[0]?.image || 'placeholder.jpg') : 'placeholder.jpg';

      const currency  = (row.currency || 'EUR').toUpperCase();
      const rawPrice  = row.price;
      const hasPrice  = rawPrice != null && rawPrice !== '' && Number(rawPrice) > 0;
      const priceNum  = hasPrice ? Number(rawPrice) : null;

      const locale = (res.locals?.locale || 'de-DE');
      const priceFormatted = hasPrice
        ? new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(priceNum)
        : null;

      const extraFields = Object.fromEntries(
        (ENTITY_EXTRA_FIELDS[entityRoute] || []).map(f => [f, row[f] ?? null])
      );

      return {
        id: row.id,
        title: row.name,
        pictures: picsArray,
        mainPic,
        price: priceNum,
        currency,
        priceFormatted,
        priceOnRequest: !hasPrice,
        ...extraFields
      };
    });

    const totalPages = Math.ceil(totalCount / limit);

    // 13) Footer
    const [cols]  = await db.query(`SELECT id, title, sort_order FROM footer_columns ORDER BY sort_order, title`);
    const [links] = await db.query(`
      SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
      FROM footer_links
      ORDER BY column_id, sort_order
    `);
    const footerColumns = cols.map(col => ({ id: col.id, title: col.title, sort_order: col.sort_order, phone: null, links: [] }));
    for (const link of links) {
      const col = footerColumns.find(c => c.id === link.column_id);
      if (!col) continue;
      if (link.is_phone) col.phone = link.phone_number;
      else               col.links.push({ text: link.link_text, url: link.link_url });
    }

    // 14) SEO
    const urlPath = normalizePathUrl(req.path); 
    const [[seoRow]] = await db.query(
      `SELECT title, description AS meta_description, robots, og_title, og_description, og_image, twitter_card, jsonld AS structured_data_json
       FROM seo_meta
       WHERE path_pattern = ?
       LIMIT 1`,
      [urlPath]
    );

    const seo = {
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando.',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };
    res.locals.seo = seo;

    // 15) Rendern
    res.render('pages/templates/category', {
      entities,
      currentEntity,
      brandDescription,
      items,
      currentPage,
      totalPages,
      limit,
      totalCount,
      filters: filtersOut,
      selectedFilters: {
        brandIds: filterBrandIds,
        modelIds: filterModelIds,
        propertytypes: [],
        priceMin: filterPriceMin,
        priceMax: filterPriceMax,
        yearMin:  filterYearMin,
        yearMax:  filterYearMax,
        location: filterLocation,
        inEurope: filterInEurope,
        inEU:     filterInEU,
        inGermany: filterInGermany,
        countryId: filterCountryId,
        cartype:    pick('cartype'),
        fuel:       pick('fuel'),
        gearbox:    pick('gearbox'),
        drivetrain: pick('drivetrain')
      },
      query: req.query,
      entieties: entities,
      footerColumns,
      user,
      slider: [],
    });

  } catch (err) {
    console.error('🚨 Fehler in Brand-Route:', err);
    next(err);
  }
});







function parseDescriptionSections(html) {
  const sections = [];
  // Match <p><strong>Title:</strong></p> followed by content until next <p><strong>
  const sectionRegex = /<p>\s*<strong>([^<:]+):<\/strong>\s*<\/p>([\s\S]*?)(?=<p>\s*<strong>[^<:]+:<\/strong>|$)/gi;
  let match;
  while ((match = sectionRegex.exec(html)) !== null) {
    const title = match[1].trim();
    const content = match[2];
    // Extract <li> items
    const itemMatches = [...content.matchAll(/<li>(.*?)<\/li>/gi)].map(m => m[1].trim());
    sections.push({ title, items: itemMatches, body: itemMatches.length ? null : content.trim() });
  }
  return sections;
}

/*
router.get('/:entityRoute',  async (req, res, next) => { 
  const user = res.locals.user;

  try {
    const entityRoute = req.params.entityRoute;

    // 1) Kategorien laden
    const [entities] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);
    const currentEntity = entities.find(e => e.route === entityRoute);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    const tableName = db.escapeId(currentEntity.table_name);
    const categoryTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles: 6 };
    const type = categoryTypeMap[entityRoute] || null;

    // 2) Pagination
    const currentPage = Math.max(1, parseInt(req.query.hp, 10) || 1);
    const limit       = Math.max(1, parseInt(req.query.limit, 10) || 60);
    const offset      = (currentPage - 1) * limit;

    // 3) Eingehende Filter sammeln
    const rawFilters = {
      // Allgemein
      brand:            req.query.brand,
      model:            req.query.model,
      yearMin:          req.query.yearMin,
      mileageMax:       req.query.mileageMax,
      priceMax:         req.query.priceMax,
      paymentType:      req.query.paymentType,
      location:         req.query.location,
      country:          req.query.country,
      registrationYear: req.query.registrationYear,
      nextHuYear:       req.query.nextHuYear,
      cartype:          req.query.cartype,
      fuel:             req.query.fuel,
      gearbox:          req.query.gearbox,
      drivetrain:       req.query.drivetrain,
      interior:         req.query.interior,
      airbags:          req.query.airbags,
      climatisation:    req.query.climatisation,
      interior_color:   req.query.interior_color,

      // Yachts
      yachttype:        req.query.yachttype,
      lengthMax:        req.query.lengthMax,
      widthMax:         req.query.widthMax,
      draftMax:         req.query.draftMax,
      cabinsMin:        req.query.cabinsMin,
      engines_count:    req.query.engines_count,
      power_kw:         req.query.power_kw,
      tank_volume:      req.query.tank_volume,
      displacement:     req.query.displacement,
      cruise_speed:     req.query.cruise_speed,
      max_speed:        req.query.max_speed,
      hours_run:        req.query.hours_run,
      flag:             req.query.flag,

      // Properties
      propertytype:     req.query.propertytype,
      investmenttype:   req.query.investmenttype,
      priceMin:         req.query.priceMin,
      areaMin:          req.query.areaMin,
      roomsMin:         req.query.roomsMin,
      bathroomsMin:     req.query.bathroomsMin,
      heating:          req.query.heating,

      // Watches (Lookup)
      watchtype:        req.query.watchtype,
      gender:           req.query.gender,
      case_material:    req.query.case_material,
      strap_material:   req.query.strap_material,
      strap_color:      req.query.strap_color,
      bezel_material:   req.query.bezel_material,
      dial_shape:       req.query.dial_shape,
      dial_numbers:     req.query.dial_numbers,
      dial_color:       req.query.dial_color,
      waterproof:       req.query.waterproof,
      movement:         req.query.movement,
      // Watches (Multi von UI)
      functions:        req.query.functions,     // z.B. ['alarm','chronograph']
      delivery:         req.query.delivery,      // z.B. ['papers','box','warranty']

      // Lifestyle
      lifestyleType:        req.query.lifestyleType,
      lifestyleSubcategory: req.query.lifestyleSubcategory,
      q:                    req.query.q,
    };

    // alle feature_* dynamisch übernehmen (Booleans)
    Object.keys(req.query).forEach(k => {
      if (k.startsWith('feature_')) rawFilters[k] = req.query[k];
    });

    // Normalisieren (Arrays) + Zahlen parsen
    const sel = Object.entries(rawFilters).reduce((acc, [key, value]) => {
      let arr;
      if (value === undefined || value === '') arr = [];
      else if (Array.isArray(value)) arr = value;
      else arr = [value];

      acc[key] = arr.map(v => {
        const num = Number(v);
        return Number.isFinite(num) && String(v).trim() !== '' ? num : v;
      });
      return acc;
    }, {});

    // Car extras (nur falls vorhanden)
    const extrasRaw = req.query.extras;
    sel.extras = (extrasRaw === undefined || extrasRaw === '' ? [] :
                  Array.isArray(extrasRaw) ? extrasRaw : [extrasRaw])
                  .map(String)
                  .filter(v => CAR_EXTRAS?.some?.(e => e.field === v));

    // 4) attribute_options holen
// Sprachen-Whitelist (Spaltennamen in ui_translations)
const UI_LANG_COLS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];

// Robust ermittelte aktive Sprache (z. B. 'en-US' -> 'en'), mit Fallback 'de'
const activeLanguage = (() => {
  const raw   = String(res.locals.lang || '').toLowerCase(); // z.B. "en-us"
  const short = raw.split(/[-_]/)[0];                         // -> "en"
  return UI_LANG_COLS.includes(short) ? short : 'de';
})();

// Sicher, weil aus Whitelist
const langCol = activeLanguage;



// 4) attribute_options holen – jetzt mit Übersetzungen aus ui_translations
const [allOpts] = await db.query(`
  SELECT
    ao.column_name,
    ao.option_value AS id,
    COALESCE(
      NULLIF(uit.${langCol}, ''),  -- aktive Sprache
      NULLIF(uit.en, ''),          -- Fallback
      NULLIF(uit.de, ''),          -- Fallback
      ao.option_label              -- letzter Fallback
    ) AS name
  FROM attribute_options ao
  LEFT JOIN ui_translations uit
    ON uit.\`key\` = CONCAT('filters.', ao.entitie_route, '.', ao.column_name, '.', ao.option_value)
  WHERE ao.entitie_route = ?
  ORDER BY ao.sort_order, CAST(ao.option_value AS UNSIGNED), ao.option_value
`, [entityRoute]);

const opts = (column) =>
  allOpts
    .filter(o => o.column_name === column)
    .map(({ id, name }) => ({ id, name }));


    // 4a) Deklaration aller Filter-Arrays
    let countries = [], brands = [], models = [], years = [],
        registrationYears = [], nextHuYears = [],
        // WATCHES
        watchTypes = [], genders = [],
        caseMaterials = [], strapMaterials = [], strapColors = [],
        bezelMaterials = [], dialShapes = [], dialNumbers = [], dialColors = [], crystals = [],
        claspMaterials = [], claspTypes = [], waterproofs = [], movements = [], functions = [], deliveries = [],
        // YACHTS
        yachtTypes = [], prices = [], boatTypes = [], categories = [],
        tankVolumes = [], crewCounts = [], displacements = [], berths = [],
        enginesCount = [], powerKw = [], hoursRun = [],
        cruiseSpeed = [], maxSpeed = [], hullMaterials = [],
        beamWidths = [], lengths = [], drafts = [], cabins = [], flags = [],
        // CARS
        cartypes = [], fuels = [], gearboxes = [], drivetrains = [], transmissions = [],
        colors = [], interiors = [], drives = [], engines = [],
        emissionClasses = [], pollutionClasses = [], badges = [],
        airbags = [], climatisations = [],
        // PROPERTIES/LIFESTYLES
        propertyTypes = [], lifestyleTypes = [], heatingTypes = [], plotSizes = [],
        livingAreas = [], floors = [], rooms = [], bathrooms = [], lifestyleSubcategories = [];

    // 4b) Jahre generisch
    [years] = await db.query(`
      SELECT DISTINCT year
      FROM ${tableName}
      WHERE year IS NOT NULL
      ORDER BY year DESC
    `);

    // Länder (sichtbar)
    const [allCountries] = await db.query(`
      SELECT c.id, c.de AS name, c.parent_id, p.de AS region
      FROM countries AS c
      LEFT JOIN countries AS p ON c.parent_id = p.id
      WHERE c.visible = 1
      ORDER BY COALESCE(p.de, c.de), c.de
    `);
    countries = allCountries;

    // 4c) Entity-spezifische Optionen
    if (entityRoute === 'cars') {
      const [reg]  = await db.query(`
        SELECT DISTINCT firstregistration AS year
        FROM ${tableName}
        WHERE firstregistration IS NOT NULL
        ORDER BY firstregistration DESC
      `);
      registrationYears = reg.map(r => r.year);

      const [insp] = await db.query(`
        SELECT DISTINCT maininspection AS year
        FROM ${tableName}
        WHERE maininspection IS NOT NULL
        ORDER BY maininspection DESC
      `);
      nextHuYears = insp.map(r => r.year);

      cartypes         = opts('cartype');
      fuels            = opts('fuel');
      gearboxes        = opts('gearbox');
      drivetrains      = opts('drivetrain');
      transmissions    = opts('transmission');
      colors           = opts('color');
      interiors        = opts('interior');
      drives           = opts('drive');
      engines          = opts('engine');
      emissionClasses  = opts('emission_class');
      pollutionClasses = opts('pollution_class');
      airbags          = opts('airbags');
      climatisations   = opts('climatisation');
      badges           = opts('environmental_badge');
    }

    if (entityRoute === 'properties') {
      propertyTypes = opts('propertytype');
      heatingTypes  = opts('heating');
      plotSizes     = opts('plot_size');
      livingAreas   = opts('living_area');
      floors        = opts('floors');
      rooms         = opts('rooms');
      bathrooms     = opts('bathrooms');
    }

    if (entityRoute === 'watches') {
      watchTypes      = opts('watchtype');
      genders         = opts('gender');
      caseMaterials   = opts('case_material');
      strapMaterials  = opts('strap_material');
      strapColors     = opts('strap_color');
      bezelMaterials  = opts('bezel_material');
      dialShapes      = opts('dial_shape');
      dialNumbers     = opts('dial_numbers');
      dialColors      = opts('dial_color');
      crystals        = opts('crystal');
      claspMaterials  = opts('clasp_material');
      claspTypes      = opts('clasp_type');
      waterproofs     = opts('waterproof');
      movements       = opts('movement');
      functions       = opts('functions');   // UI-Optionen (IDs -> function_* Columns)
      deliveries      = opts('delivery');    // UI-Optionen (IDs -> authenticity_* Columns)

      const [watchCountries] = await db.query(`
        SELECT c.id, c.de AS name
        FROM countries AS c
        WHERE c.visible = 1
        ORDER BY c.de
      `);
      countries = watchCountries;
    }

    if (entityRoute === 'yachts') {
      yachtTypes    = opts('yachttype');
      prices        = opts('price');
      boatTypes     = opts('boattype');
      categories    = opts('category');
      displacements = opts('displacement');
      berths        = opts('berths');
      enginesCount  = opts('engines_count');
      powerKw       = opts('power_kw');
      hoursRun      = opts('hours_run');
      cruiseSpeed   = opts('cruise_speed');
      maxSpeed      = opts('max_speed');
      tankVolumes   = opts('tank_volume');
      hullMaterials = opts('hull_material');
      beamWidths    = opts('beam');
      lengths       = opts('length');
      drafts        = opts('draft');
      cabins        = opts('cabins');
      crewCounts    = opts('crew');
      flags         = opts('flag');

      const [yachtCountries] = await db.query(`
        SELECT c.id, c.de AS name
        FROM countries AS c
        WHERE c.visible = 1
        ORDER BY c.de
      `);
      countries = yachtCountries;
    }

    if (entityRoute === 'lifestyles') {
      [lifestyleTypes] = await db.query(
        `SELECT id, name FROM brands WHERE type = 6 ORDER BY name`
      );
      if (lifestyleTypes.length > 0) {
        const brandIds = lifestyleTypes.map(b => b.id);
        const placeholders = brandIds.map(() => '?').join(',');
        [lifestyleSubcategories] = await db.query(
          `SELECT id, name, brand_id AS parentId
           FROM models
           WHERE brand_id IN (${placeholders})
           ORDER BY name`,
          brandIds
        );
      }
    }

    // 5) WHERE-Builder
    const where = ['status=3', 'visible=1', 'pictures IS NOT NULL'];
    const params = [];
    const add = (cond, ...vals) => { where.push(cond); params.push(...vals); };
    const addIN = (col, arr) => {
      if (Array.isArray(arr) && arr.length) {
        add(`${db.escapeId(col)} IN (${arr.map(()=>'?').join(',')})`, ...arr);
      }
    };
    const baseWhere  = where.join(' AND ');
    const baseParams = [...params];

    // Allgemein
    if (sel.brand.length) addIN('brand_id', sel.brand);
    if (sel.model.length) addIN('model_id', sel.model);

    if (sel.yearMin.length)    add('year >= ?', Math.min(...sel.yearMin));
    if (sel.mileageMax.length) add('mileage <= ?', Math.min(...sel.mileageMax));
    if (sel.priceMax.length)   add('price <= ?', Math.min(...sel.priceMax));
    if (sel.paymentType.length) addIN('payment_type', sel.paymentType);

    if (sel.location.length) {
      const term = `%${String(sel.location[0]).trim()}%`;
      add(`(city LIKE ? OR country_id IN (SELECT id FROM countries WHERE de LIKE ?))`, term, term);
    }

    if (sel.interior.length)       addIN('interior', sel.interior);
    if (sel.airbags.length)        addIN('airbags', sel.airbags);
    if (sel.climatisation.length)  addIN('climatisation', sel.climatisation);
    if (sel.interior_color.length) addIN('interior_color', sel.interior_color);

    if (sel.country.length)          addIN('country_id', sel.country);
    if (sel.registrationYear.length) addIN('firstregistration', sel.registrationYear);
    if (sel.nextHuYear.length)       addIN('maininspection', sel.nextHuYear);
    if (sel.cartype.length)          addIN('cartype', sel.cartype);
    if (sel.fuel.length)             addIN('fuel', sel.fuel);
    if (sel.gearbox.length)          addIN('gearbox', sel.gearbox);
    if (sel.drivetrain.length)       addIN('drivetrain', sel.drivetrain);

    // Autos: Extras
    if (sel.extras && sel.extras.length) {
      sel.extras.forEach(f => {
        if (CAR_EXTRA_NUMERIC_PRESENT?.has?.(f)) where.push(`${db.escapeId(f)} > 0`);
        else where.push(`${db.escapeId(f)} = 1`);
      });
    }

    // Yachts
    if (sel.yachttype.length) addIN('yachttype', sel.yachttype);
    if (sel.lengthMax.length) add('length <= ?', Math.min(...sel.lengthMax));
    if (sel.widthMax?.length) add('beam <= ?',   Math.min(...sel.widthMax));
    if (sel.draftMax?.length) add('draft <= ?',  Math.min(...sel.draftMax));
    if (sel.cabinsMin.length) add('cabins >= ?', Math.max(...sel.cabinsMin));
    if (sel.engines_count.length) addIN('engines_count', sel.engines_count);
    if (sel.power_kw.length)      addIN('power_kw', sel.power_kw);
    if (sel.tank_volume.length)   addIN('tank_volume', sel.tank_volume);
    if (sel.displacement.length)  addIN('displacement', sel.displacement);
    if (sel.cruise_speed.length)  addIN('cruise_speed', sel.cruise_speed);
    if (sel.max_speed.length)     addIN('max_speed', sel.max_speed);
    if (sel.hours_run.length)     addIN('hours_run', sel.hours_run);
    if (sel.flag.length)          addIN('flag', sel.flag);

    // Lifestyle
    if (sel.q && sel.q.length) {
      const term = `%${String(sel.q[0]).trim()}%`;
      add(`name LIKE ?`, term);
    }
    if (sel.lifestyleType.length)        addIN('brand_id', sel.lifestyleType);
    if (sel.lifestyleSubcategory.length) addIN('model_id', sel.lifestyleSubcategory);

    // Properties
    if (entityRoute === 'properties') {
      if (sel.propertytype.length) addIN('propertytype', sel.propertytype);
      if (sel.country.length)      addIN('country_id',   sel.country);
      if (sel.priceMin.length)     add('price >= ?',     Math.max(...sel.priceMin));
      if (sel.areaMin.length)      add('livingarea >= ?',Math.max(...sel.areaMin));
      if (sel.roomsMin.length)     add('bedrooms >= ?',  Math.max(...sel.roomsMin));
      if (sel.bathroomsMin.length) add('bathrooms >= ?', Math.max(...sel.bathroomsMin));
      if (sel.heating.length)      addIN('heating',      sel.heating);
    }

    // WATCHES – Lookup-Felder + Features + Functions + Delivery
    if (entityRoute === 'watches') {
      addIN('watchtype',      sel.watchtype);
      addIN('gender',         sel.gender);
      addIN('case_material',  sel.case_material);
      addIN('strap_material', sel.strap_material);
      addIN('strap_color',    sel.strap_color);
      addIN('bezel_material', sel.bezel_material);
      addIN('dial_shape',     sel.dial_shape);
      addIN('dial_numbers',   sel.dial_numbers);
      addIN('dial_color',     sel.dial_color);
      addIN('waterproof',     sel.waterproof);
      addIN('movement',       sel.movement);
      addIN('clasp_material', sel.clasp_material);
      addIN('clasp_type',     sel.clasp_type);
      addIN('crystal',        sel.crystal);

      // Features: jedes gesetzte feature_* => =1
      Object.keys(sel).forEach(k => {
        if (!k.startsWith('feature_')) return;
        const on = (Array.isArray(sel[k]) ? sel[k] : [sel[k]]).some(v => String(v) === '1');
        if (on) where.push(`${db.escapeId(k)} = 1`);
      });

      // Functions: mappe auf einzelne Boolean-Spalten function_*
      if (sel.functions && sel.functions.length) {
        sel.functions.forEach(v => {
          const col = toWatchFunctionCol(v);
          if (col) where.push(`${db.escapeId(col)} = 1`);
        });
      }

      // Delivery: mappe auf authenticity_* Spalten
      if (sel.delivery && sel.delivery.length) {
        sel.delivery.forEach(v => {
          const col = WATCH_DELIVERY_MAP[String(v).toLowerCase()];
          if (col) where.push(`${db.escapeId(col)} = 1`);
        });
      }
    }

    // Marken/Modelle-Listen (nur Grundbedingungen → baseWhere)
    if (['cars','watches','yachts'].includes(entityRoute)) {
      [brands] = await db.query(`
        SELECT b.id, b.name
        FROM brands AS b
        JOIN ${tableName} AS t
          ON t.brand_id = b.id
         AND ${baseWhere}
        WHERE b.type = ?
        GROUP BY b.id, b.name
        ORDER BY b.name
      `, [type, ...baseParams]);

      if (Array.isArray(sel.brand) && sel.brand.length && ['cars','watches'].includes(entityRoute)) {
        const ph = sel.brand.map(() => '?').join(',');
        [models] = await db.query(`
          SELECT m.id, m.name
          FROM models AS m
          JOIN ${tableName} AS t
            ON t.model_id = m.id
           AND t.brand_id IN (${ph})
           AND ${baseWhere}
          GROUP BY m.id, m.name
          ORDER BY m.name
        `, [...sel.brand, ...baseParams]);
      } else {
        models = [];
      }
    } else {
      brands = opts('brand');
      models = [];
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    // 6) Count
    const [[{ totalCount }]] = await db.query(
      `SELECT COUNT(*) AS totalCount FROM ${tableName} ${whereClause}`, params
    );
    const totalPages = Math.ceil(totalCount / limit);

    // 7) Items (Basisdaten)
    const [rows] = await db.query(
      `SELECT id, pictures, price, name
       FROM ${tableName}
       ${whereClause}
       ORDER BY published DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // 7a) Übersetzungen overlay (active -> en -> de)
    const SUPPORTED_LANGS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
    const activeLang = (res.locals.lang && SUPPORTED_LANGS.includes(res.locals.lang))
      ? res.locals.lang : 'de';
    const langOrder = (activeLang === 'de') ? ['de','en'] : [activeLang, 'en', 'de'];

    const idList = rows.map(r => r.id);
    const titleMap = new Map(); // id -> bestTitle

    if (idList.length) {
      const idPlaceholders   = idList.map(() => '?').join(',');
      const langPlaceholders = langOrder.map(() => '?').join(',');
      // listing_translations: entitie_id = currentEntity.id, advert_id = Stammdatensatz-ID
      const [trRows] = await db.query(
        `SELECT advert_id, language, title
           FROM listing_translations
          WHERE entitie_id = ?
            AND advert_id IN (${idPlaceholders})
            AND language IN (${langPlaceholders})
          ORDER BY FIELD(language, ${langPlaceholders})`,
        [currentEntity.id, ...idList, ...langOrder, ...langOrder]
      );
      const seen = new Set();
      for (const r of trRows) {
        if (seen.has(r.advert_id)) continue;
        seen.add(r.advert_id);
        if (r.title) titleMap.set(r.advert_id, r.title);
      }
    }

    // Preis-Format je Sprache (Euro bleibt)
    const LOCALE_MAP = {
      de:'de-DE', en:'en-US', fr:'fr-FR', it:'it-IT', es:'es-ES',
      nl:'nl-NL', tr:'tr-TR', cs:'cs-CZ', ru:'ru-RU', ja:'ja-JP', pl:'pl-PL'
    };
    const priceLocale = LOCALE_MAP[activeLang] || 'de-DE';

    const items = rows.map(r => {
      const raw  = tryUnserialize(r.pictures || 'a:0:{}') || [];
      const pics = Array.isArray(raw) ? raw : Object.values(raw);
      const first = pics[0];
      const candidate = typeof first === 'string' ? first : (first?.image || '');
      const filename  = fallbackResolveImageFilename(entityRoute, r.id, candidate);
      const p         = r.price != null ? Number(r.price) : null;

      const title = titleMap.get(r.id) || r.name;

      return {
        id: r.id,
        title,
        pictures: pics,
        mainPic: filename,
        imageUrl: `/images/${entityRoute}/${r.id}/${encodeURIComponent(filename)}`,
        price: (p != null && Number(p) > 0) ? Number(p) : null,
        priceFormatted: (p != null && Number(p) > 0)
          ? new Intl.NumberFormat(priceLocale || 'de-DE', {
              style: 'currency',
              currency: (r.currency || 'EUR').toUpperCase(),
              maximumFractionDigits: 0
            }).format(Number(p))
          : null,
        priceOnRequest: !(p != null && Number(p) > 0)
      };

    });

const [sliderItems] = await db.query(
  `SELECT t.id,
          t.name AS title,
          t.pictures,
          t.price,
          t.currency
   FROM katalog_slider ks
   JOIN ${db.escapeId(currentEntity.table_name)} t
     ON t.id = ks.advert_id
   WHERE ks.entitie_id = ?
     AND ks.start_date <= CURDATE()
     AND ks.end_date   >= CURDATE()
   ORDER BY ks.start_date DESC
   LIMIT 12`,
  [currentEntity.id]
);



const sliderIdList = sliderItems.map(r => r.id);
const sliderTitleMap = new Map();

if (sliderIdList.length) {
  const idPh = sliderIdList.map(() => '?').join(',');
  const langPh = langOrder.map(() => '?').join(',');
  const [trSlider] = await db.query(
    `SELECT advert_id, language, title
       FROM listing_translations
      WHERE entitie_id = ?
        AND advert_id IN (${idPh})
        AND language IN (${langPh})
      ORDER BY FIELD(language, ${langPh})`,
    [currentEntity.id, ...sliderIdList, ...langOrder, ...langOrder]
  );
  const seen = new Set();
  for (const r of trSlider) {
    if (seen.has(r.advert_id)) continue;
    seen.add(r.advert_id);
    if (r.title) sliderTitleMap.set(r.advert_id, r.title);
  }
}

const slider = sliderItems.map(r => {
  const raw  = tryUnserialize(r.pictures || 'a:0:{}') || [];
  const pics = Array.isArray(raw) ? raw : Object.values(raw);
  const first = pics[0];
  const candidate = typeof first === 'string' ? first : (first?.image || '');
  const filename  = fallbackResolveImageFilename(currentEntity.route, r.id, candidate);

  const p = r.price != null ? Number(r.price) : null;

  const title = sliderTitleMap.get(r.id) || r.title;

  return {
    id: r.id,
    title,
    mainPic: filename,
    imageUrl: `/images/${currentEntity.route}/${r.id}/${encodeURIComponent(filename)}`,
    price: p,
    priceFormatted: (p && p > 0)
      ? new Intl.NumberFormat('de-DE', {
          style: 'currency',
          currency: (r.currency || 'EUR').toUpperCase(),
          maximumFractionDigits: 0
        }).format(p)
      : null
  };
});




    

    // 8) Footer
    const [cols]  = await db.query(`SELECT id,title,sort_order FROM footer_columns ORDER BY sort_order,title`);
    const [links] = await db.query(`
      SELECT column_id,link_text,link_url,is_phone,phone_number
      FROM footer_links
      ORDER BY column_id,sort_order
    `);
    const footerColumns = cols.map(c => ({ id: c.id, title: c.title, phone: null, links: [] }));
    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else col.links.push({ text: l.link_text, url: l.link_url });
    }

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
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando. Jetzt finden & verkaufen!',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };

    // Lokale Variable für alle Views verfügbar
    res.locals.seo = seo;

    // 9) Render
    res.render('pages/templates/category', {
      entieties: entities,
      currentEntity,
      filters: {
        // allgemein
        brands,
        models,
        years,
        countries,
        registrationYears,
        nextHuYears,

        // watches
        watchTypes,
        genders,
        caseMaterials,
        strapMaterials,
        strapColors,
        bezelMaterials,
        dialShapes,
        dialNumbers,
        dialColors,
        crystals,
        claspMaterials,
        claspTypes,
        waterproofs,
        movements,
        functions,
        deliveries,

        // cars
        cartypes,
        fuels,
        gearboxes,
        drivetrains,
        transmissions,
        colors,
        interiors,
        airbags,
        climatisations,
        drives,
        engines,
        emissionClasses,
        pollutionClasses,
        badges,

        // yachts
        yachtTypes,
        tankVolumes,
        crewCounts,
        displacements,
        berths,
        enginesCount,
        powerKw,
        hoursRun,
        cruiseSpeed,
        maxSpeed,
        hullMaterials,
        beamWidths,
        lengths,
        drafts,
        cabins,
        flags,

        // properties
        propertyTypes,
        heating:    heatingTypes,
        plotSize:   plotSizes,
        livingArea: livingAreas,
        floors,
        rooms,
        bathrooms,

        // lifestyles
        lifestyleTypes,
        lifestyleSubcategories,
      },
      selectedFilters: sel,
      slider,
      items,
      currentPage,
      totalPages,
      limit,
      totalCount,
      footerColumns,
      user,
    });

  } catch (err) {
    console.error('🚨 Fehler in GET /:entityRoute:', err);
    next(err);
  }
});
*/

// ============================================================================
// 1) Kategorie / Brand / Model (Liste)
// Beispiel: /cars/bmw/m3
// ============================================================================
// Kategorie-Route mit Brand/Model-Filter
router.get('/:entityRoute/:brandSlug/:modelSlug', async (req, res, next) => {
  try {
    const { entityRoute, brandSlug, modelSlug } = req.params;

    // 👉 Slugs decodieren und normalisieren
    const cleanedBrandSlug = slugify(decodeURIComponent(brandSlug), { lower: true, strict: true });
    const cleanedModelSlug = slugify(decodeURIComponent(modelSlug), { lower: true, strict: true });

    // 1) Kategorien laden
    const [entities] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);

    const currentEntity = entities.find(e => e.route === entityRoute);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    const tableName = db.escapeId(currentEntity.table_name);
    const categoryTypeMap = { properties: 1, watches: 2, cars: 3, yachts: 4, lifestyles: 6 };
    const type = categoryTypeMap[entityRoute] || null;

    // Pagination
    const currentPage = Math.max(1, parseInt(req.query.hp, 10) || 1);
    const limit       = Math.max(1, parseInt(req.query.limit, 10) || 60);
    const offset      = (currentPage - 1) * limit;

    // Sprache
    const SUPPORTED_LANGS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
    const rawLang   = String(res.locals.lang || '').toLowerCase();
    const shortLang = rawLang.split(/[-_]/)[0];
    const langCol   = SUPPORTED_LANGS.includes(shortLang) ? shortLang : 'de';

    // Filter normalisieren
    let sel = normalizeFilters(req.query);

    // 🔑 Brand suchen
    let brandId;
    {
      const [brands] = await db.query(`SELECT id, name FROM brands WHERE type = ?`, [type]);
      const matching = brands.find(b => slugify(b.name, { lower: true, strict: true }) === cleanedBrandSlug);
      if (matching) brandId = matching.id;
    }

    if (!brandId) {
      console.warn('[CATEGORY] Brand nicht gefunden:', cleanedBrandSlug);
      return next();
    }
    sel.brand = [brandId]; // immer Array

    // 🔑 Model suchen
    let modelId;
    {
      const [models] = await db.query(`SELECT id, name, brand_id FROM models WHERE brand_id = ?`, [brandId]);
      const matching = models.find(m => slugify(m.name, { lower: true, strict: true }) === cleanedModelSlug);
      if (matching) modelId = matching.id;
    }

    if (!modelId) {
      console.warn('[CATEGORY] Model nicht gefunden:', cleanedModelSlug);
      return next();
    }
    sel.model = [modelId]; // immer Array

    // ✅ Arrays sicherstellen
    ['brand', 'model'].forEach(key => {
      if (!Array.isArray(sel[key])) {
        sel[key] = sel[key] !== undefined && sel[key] !== null && sel[key] !== ''
          ? [sel[key]]
          : [];
      }
    });

    // Debug
    console.log("DEBUG Filters (backend normalized):", {
      brand: sel.brand,
      model: sel.model
    });

    // WHERE bauen
    const { where: baseWhere, params: baseParams } = buildWhere(entityRoute, tableName, sel);

    // Filter-Optionen laden
    const filterOptions = await loadFilterOptions(entityRoute, tableName, type, baseWhere, baseParams, langCol);

    // Count + Items (Extra-Felder)
    const extraCols = (ENTITY_EXTRA_FIELDS[entityRoute] || [])
      .map(f => `t.${db.escapeId(f)}`)
      .join(", ");

    const selectCols = `
      t.id, t.pictures, t.price, t.name, t.currency
      ${extraCols ? ', ' + extraCols : ''}
    `;

    const [[{ totalCount }]] = await db.query(
      `SELECT COUNT(*) AS totalCount FROM ${tableName} t WHERE ${baseWhere}`,
      baseParams
    );
    const totalPages = Math.ceil(totalCount / limit);

    const [rows] = await db.query(
      `SELECT ${selectCols}
         FROM ${tableName} t
        WHERE ${baseWhere}
        ORDER BY published DESC
        LIMIT ? OFFSET ?`,
      [...baseParams, limit, offset]
    );

    // Übersetzungen für Titel
    const idList = rows.map(r => r.id);
    const titleMap = new Map();
    if (idList.length) {
      const idPH = idList.map(() => '?').join(',');
      const langOrder = (langCol === 'de') ? ['de','en'] : [langCol,'en','de'];
      const langPH = langOrder.map(() => '?').join(',');

      const [trRows] = await db.query(
        `SELECT advert_id, language, title
           FROM listing_translations
          WHERE entitie_id = ?
            AND advert_id IN (${idPH})
            AND language IN (${langPH})
          ORDER BY FIELD(language, ${langPH})`,
        [currentEntity.id, ...idList, ...langOrder, ...langOrder]
      );
      const seen = new Set();
      for (const r of trRows) {
        if (seen.has(r.advert_id)) continue;
        seen.add(r.advert_id);
        if (r.title) titleMap.set(r.advert_id, r.title);
      }
    }

    // Preis-Locale
    const LOCALE_MAP = {
      de:'de-DE', en:'en-US', fr:'fr-FR', it:'it-IT', es:'es-ES',
      nl:'nl-NL', tr:'tr-TR', cs:'cs-CZ', ru:'ru-RU', ja:'ja-JP', pl:'pl-PL'
    };
    const priceLocale = LOCALE_MAP[langCol] || 'de-DE';

    // Items mappen
    const items = rows.map(r => {
      const raw  = tryUnserialize(r.pictures || 'a:0:{}') || [];
      const pics = Array.isArray(raw) ? raw : Object.values(raw);
      const first = pics[0];
      const candidate = typeof first === 'string' ? first : (first?.image || '');
      const filename  = fallbackResolveImageFilename(entityRoute, r.id, candidate);
      const p         = r.price != null ? Number(r.price) : null;

      const title = titleMap.get(r.id) || r.name;

      const extraFields = Object.fromEntries(
        (ENTITY_EXTRA_FIELDS[entityRoute] || []).map(f => [f, r[f] ?? null])
      );

      return {
        id: r.id,
        title,
        pictures: pics,
        mainPic: filename,
        imageUrl: filename
          ? `/images/${entityRoute}/${r.id}/${encodeURIComponent(filename)}`
          : null,
        price: (p != null && Number(p) > 0) ? Number(p) : null,
        priceFormatted: (p != null && Number(p) > 0)
          ? new Intl.NumberFormat(priceLocale, {
              style: 'currency',
              currency: (r.currency || 'EUR').toUpperCase(),
              maximumFractionDigits: 0
            }).format(Number(p))
          : null,
        priceOnRequest: !(p != null && Number(p) > 0),
        ...extraFields
      };
    });

    // SEO
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
      title:               seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description:    seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote: Luxus-Autos, exklusive Yachten, Traum-Immobilien & Uhren bei Herando.',
      robots:              seoRow?.robots || 'index,follow',
      canonical_url:       buildCanonical(req),
      og_title:            seoRow?.og_title || seoRow?.title || null,
      og_description:      seoRow?.og_description || seoRow?.meta_description || null,
      og_image:            seoRow?.og_image || null,
      twitter_card:        seoRow?.twitter_card || 'summary_large_image',
      structured_data_json:seoRow?.structured_data_json || null,
      hreflang_json:       null
    };
    res.locals.seo = seo;

    // Rendern
    res.render('pages/templates/category', {
      entities,
      entieties: entities,
      selectedFilters: sel,
      filters: filterOptions,
      currentEntity,
      items,
      totalCount,
      totalPages,
      currentPage,
      filterOptions,
      sel,
      login_user: req.user,
      currentUrl: req.url,
      headerTitle: currentEntity.name,
      seo,
      limit,
      slider: [],
    });

  } catch (err) {
    console.error('🚨 Fehler in Brand+Model-Route:', err);
    res.status(500).send('Serverfehler');
  }
});




// ============================================================================
// 2) Produktdetail (Detailseite)
// Beispiel: /cars/12345/bmw-m3
// ============================================================================
router.get('/:entityRoute/:id/:slug', async (req, res, next) => {
  const { id } = req.params;

  // ✅ Nur wenn ID eine Zahl ist → Detailseite
  if (!/^\d+$/.test(id)) {
    return next();
  }
  const startedAt = Date.now();
  console.log('[DETAIL] >>> Request start', {
    path: req.originalUrl,
    params: req.params,
    query: req.query,
    ua: req.headers['user-agent']
  });

  const user = res.locals.user;

  // --- Sprachwahl -----------------------------------------------------------
  const SUPPORTED_LANGS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
  const pickLang = (req) => {
    const qLang       = String(req.query.lang || '').toLowerCase();
    const hdrLang     = String(req.get?.('x-lang') || '').toLowerCase();
    const sessLang    = String(req.session?.lang || '').toLowerCase();
    const cookieLang  = String(req.cookies?.lang || '').toLowerCase();
    const acceptFirst = String(req.headers['accept-language'] || '').toLowerCase().split(',')[0].split('-')[0];
    const inSup = v => v && SUPPORTED_LANGS.includes(v);
    return inSup(qLang) ? qLang
         : inSup(hdrLang) ? hdrLang
         : inSup(sessLang) ? sessLang
         : inSup(cookieLang) ? cookieLang
         : inSup(acceptFirst) ? acceptFirst
         : 'de';
  };
  // -> aktiv: activeLanguage (und als Alias activeLang)
  const activeLanguage = pickLang(req);
  const activeLang     = activeLanguage;
  const langs          = [activeLanguage, 'en', 'de'].filter((v,i,a)=> v && SUPPORTED_LANGS.includes(v) && a.indexOf(v)===i);
  const phLangs        = langs.map(()=>'?').join(',');
  const orderLang      = langs.map(()=>'?').join(',');
  console.log('[DETAIL][i18n] activeLanguage:', activeLanguage, 'fallback-order:', langs);

  // ✅ Backend-Übersetzer im Scope der Route (nutzt res.locals.t oder req.t)
  const tSrv = (key, fb) => {
    const tFn =
      (res.locals && typeof res.locals.t === 'function' && res.locals.t) ||
      (typeof req.t === 'function' ? req.t : null);
    try { return tFn ? tFn(key, { lng: activeLanguage, defaultValue: fb }) : fb; }
    catch (e) {
      console.warn('[DETAIL][i18n] tSrv failed for key', key, e);
      return fb;
    }
  };

  try {
    const { entityRoute, id, slug } = req.params;
    console.log('[DETAIL] entityRoute:', entityRoute, 'id:', id, 'slug:', slug);

    // 1) Kategorien
    const [entities] = await db.query(`
      SELECT id, name, route, table_name
      FROM ententies
      ORDER BY id
    `);
    const currentEntity = entities.find(e => e.route === entityRoute);
    console.log('[DETAIL] entities count:', entities?.length, 'currentEntity:', currentEntity);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    // 1a) Spaltenliste (reference?)
    const [entCols] = await db.query(
      `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [currentEntity.table_name]
    );
    const colSet = new Set((entCols || []).map(c => String(c.COLUMN_NAME).toLowerCase()));
    const HAS_REF = colSet.has('reference');
    console.log('[DETAIL] column count:', entCols?.length, 'HAS_REF:', HAS_REF);

    // 2) Hauptdatensatz
    const table = db.escapeId(currentEntity.table_name);
    const [[itemRow]] = await db.query(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!itemRow) return res.status(404).send('Artikel nicht gefunden');
    console.log('[DETAIL] itemRow.id:', itemRow.id, 'name:', itemRow.name);

    // 2a) i18n-Texte (title/description) per listing_translations
    const advertKey = HAS_REF && itemRow.reference != null && Number(itemRow.reference) > 0
      ? Number(itemRow.reference) : Number(itemRow.id);
    console.log('[DETAIL][i18n] advertKey:', advertKey);

    let bestTr = null;
    try {
      const [trRows] = await db.query(
        `SELECT language, title, description
           FROM listing_translations
          WHERE entitie_id = ?
            AND advert_id  = ?
            AND language   IN (${phLangs})
          ORDER BY FIELD(language, ${orderLang})
          LIMIT 1`,
        [currentEntity.id, advertKey, ...langs, ...langs]
      );
      bestTr = trRows?.[0] || null;
      console.log('[DETAIL][i18n] translation found:', !!bestTr, bestTr?.language);
    } catch (e) {
      console.warn('[DETAIL][i18n] translation query failed:', e);
    }

    // 3) Slug prüfen – immer auf Basistitel (itemRow.name)!
    const realSlug = slugify(itemRow.name, { lower: true, strict: true });
    if (realSlug !== slug) {
      console.log('[DETAIL] slug mismatch -> redirect 301', { realSlug, given: slug });
      return res.redirect(301, `/${entityRoute}/${id}/${realSlug}`);
    }

    // 4) Bilder (nur DB)
    let rawPics;
    try { rawPics = unserialize(itemRow.pictures || 'a:0:{}') || []; } catch { rawPics = []; }
    const pics = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);
    console.log('[DETAIL][pics] from DB:', pics.length);

    const dbGalleryFilenames = [];
    const seenGallery = new Set();
    for (const pic of pics) {
      const rawValue = typeof pic === 'string' ? pic : pic?.image;
      if (!rawValue) continue;

      const value = String(rawValue).trim();
      if (!value) continue;

      let key = value;
      try {
        key = decodeURIComponent(value);
      } catch (_) {}
      key = key.toLowerCase();

      if (seenGallery.has(key)) continue;
      seenGallery.add(key);
      dbGalleryFilenames.push(value);
    }
    console.log('[DETAIL][pics] unique DB gallery:', dbGalleryFilenames.length);

    let mainFilename = null;
    if (itemRow.mainpicture && typeof itemRow.mainpicture === 'string' && itemRow.mainpicture.trim() !== '') {
      const rawMain = itemRow.mainpicture.trim();
      if (rawMain.startsWith('a:')) {
        try {
          const parsedMain = unserialize(rawMain);
          if (parsedMain && typeof parsedMain === 'object' && parsedMain.image) {
            mainFilename = String(parsedMain.image).trim();
          }
        } catch (_) {}
      } else {
        mainFilename = rawMain;
      }
    }
    if (!mainFilename) {
      const first = pics[0];
      mainFilename = typeof first === 'string' ? first : (first?.image || 'placeholder.jpg');
    }

    const thumbnailFilenames = dbGalleryFilenames.length ? dbGalleryFilenames : ['placeholder.jpg'];
    console.log('[DETAIL][pics] main:', mainFilename, 'thumbs:', thumbnailFilenames.length);

    // 5) Marke/Modell/Land/EZ
    let brandName   = '–';
    let modelName   = '–';
    let countryName = '–';

    if (itemRow.brand_id) {
      const [[b]] = await db.query('SELECT name FROM brands WHERE id = ?', [itemRow.brand_id]);
      brandName = b?.name || '–';
    }
    if (itemRow.model_id) {
      const [[m]] = await db.query('SELECT name FROM models WHERE id = ?', [itemRow.model_id]);
      modelName = m?.name || '–';
    }
    if (itemRow.country_id) {
      const [[c]] = await db.query('SELECT de FROM countries WHERE id = ?', [itemRow.country_id]);
      countryName = c?.de || '–';
    }
    const firstRegistration = itemRow.firstregistration
      ? (itemRow.firstregistration_month
          ? `${itemRow.firstregistration_month}/${itemRow.firstregistration}`
          : `${itemRow.firstregistration}`)
      : '–';
    console.log('[DETAIL] names:', { brandName, modelName, countryName, firstRegistration });

    // 6) Preis (sprachspezifisches Format + POR-Text)
    const priceNum = itemRow.price != null ? Number(itemRow.price) : null;
    const porText  = tSrv('labels.common.price_on_request', 'Preis auf Anfrage');
    const priceFormatted =
      priceNum != null && priceNum > 0
        ? new Intl.NumberFormat(activeLanguage || 'de', { style: 'currency', currency: 'EUR' }).format(priceNum)
        : porText;
    console.log('[DETAIL] price:', { priceNum, priceFormatted, lang: activeLanguage });

    // 7) Item – alles aus SQL + unsere Extras
    let item = { ...itemRow };  // enthält jede Spalte aus der Tabelle (cars, watches, yachts, properties, lifestyle)

    item.id             = id;
    item.title          = bestTr?.title || itemRow.name;
    item.description    = bestTr?.description || itemRow.description;
    item.price          = priceNum;
    item.priceFormatted = priceFormatted;
    item.pictures       = pics;
    item.mainPic        = mainFilename;
    item.imageUrl       = `/images/${entityRoute}/${id}/${encodeURIComponent(mainFilename)}`;
    item.thumbnailUrls  = thumbnailFilenames.map(fn => `/images/${entityRoute}/${id}/${encodeURIComponent(fn)}`);
    item.brandName      = brandName;
    item.modelName      = modelName;
    item.countryName    = countryName;
    item.firstRegistration = firstRegistration;


    // 8) Attribute/Options (übersetzt aus ui_translations)
    const UI_LANG_COLS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
    const langCol = UI_LANG_COLS.includes(String(activeLanguage).toLowerCase())
      ? String(activeLanguage).toLowerCase()
      : 'de';

    // Standard-Optionen aus attribute_options -> ui_translations (per Key)
    const [optsRows] = await db.query(`
      SELECT 
        ao.column_name,
        ao.option_value,
        COALESCE(
          NULLIF(uit.${langCol}, ''),  -- aktive Sprache
          NULLIF(uit.en, ''),          -- Fallback
          NULLIF(uit.de, ''),          -- Fallback
          ao.option_label              -- letzter Fallback
        ) AS name
      FROM attribute_options ao
      LEFT JOIN ui_translations uit
        ON uit.\`key\` = CONCAT('filters.', ao.entitie_route, '.', ao.column_name, '.', ao.option_value)
      WHERE ao.entitie_route = ?
      ORDER BY ao.sort_order,
               CAST(ao.option_value AS UNSIGNED),
               ao.option_value
    `, [entityRoute]);

    const optionsMap = optsRows.reduce((acc, { column_name, option_value, name }) => {
      (acc[column_name] ||= {})[String(option_value)] = name;
      return acc;
    }, {});
    console.log('[DETAIL][options/i18n] rows:', optsRows.length, 'lang:', langCol);

    // === SPEZIAL: Felder, die NICHT in attribute_options liegen (z.B. color / Watches dial/strap) ===
    const specialFields = [
      { field: 'color',       keyPrefix: `filters.${entityRoute}.color.` },
      // für Watches schon vorbereitet:
      { field: 'dial_color',  keyPrefix: `filters.${entityRoute}.dial_color.` },
      { field: 'strap_color', keyPrefix: `filters.${entityRoute}.strap_color.` }
    ];
    const specialVals = specialFields
      .map(s => ({ ...s, value: itemRow[s.field] }))
      .filter(s => s.value !== undefined && s.value !== null && String(s.value) !== '');

    let specialMap = {};
    if (specialVals.length) {
      const keys = specialVals.map(s => s.keyPrefix + String(s.value));
      const ph   = keys.map(()=>'?').join(',');
      const [trs] = await db.query(`
        SELECT \`key\`,
               COALESCE(NULLIF(${langCol}, ''), NULLIF(en,''), NULLIF(de,'')) AS name
          FROM ui_translations
         WHERE \`key\` IN (${ph})
      `, keys);
      trs.forEach(r => { specialMap[r.key] = r.name; });
    }

    // Fallback-Dictionary für Farben (nur falls keine ui_translation existiert)
    const COLOR_FALLBACK = {
      de: { '0':'—','1':'Schwarz','2':'Weiß','3':'Rot','4':'Grau','5':'Blau','6':'Silber','7':'Orange','8':'Grün','9':'Beige','10':'Braun','11':'Gelb','12':'Gold','13':'Violett','14':'Bronze','15':'Perlweiß','16':'Transparent','17':'Bordeaux','18':'Champagner','19':'Pink','20':'Rosé','22':'Perlmutt','23':'Cremefarben','255':'Sonstige' },
      en: { '0':'—','1':'Black','2':'White','3':'Red','4':'Grey','5':'Blue','6':'Silver','7':'Orange','8':'Green','9':'Beige','10':'Brown','11':'Yellow','12':'Gold','13':'Purple','14':'Bronze','15':'Pearl white','16':'Transparent','17':'Bordeaux','18':'Champagne','19':'Pink','20':'Rose','22':'Mother of pearl','23':'Cream','255':'Other' }
      // weitere Sprachen bei Bedarf…
    };
    const COLOR_FALLBACK_LANG = COLOR_FALLBACK[langCol] || COLOR_FALLBACK.de;

    // universeller Resolver: zuerst optionsMap, dann ui_translations(Spezial), dann Fallbacks, sonst Rohwert
    const resolveDisplay = (field, rawVal) => {
      const vKey = rawVal == null ? null : String(rawVal);
      if (vKey != null && optionsMap[field]?.[vKey]) return optionsMap[field][vKey];

      const spec = specialFields.find(s => s.field === field);
      if (spec && vKey != null) {
        const uiKey = spec.keyPrefix + vKey;
        if (specialMap[uiKey]) return specialMap[uiKey];
        if (field === 'color' && COLOR_FALLBACK_LANG[vKey]) return COLOR_FALLBACK_LANG[vKey];
      }
      return (rawVal != null && rawVal !== '') ? rawVal : '–';
    };

    // Dein bestehendes specsConfig darf {field,label} ODER {field,key,fb} enthalten.
    const cfgRaw = specsConfig[currentEntity.route] || [];
    // Normalisieren auf {field,key,fb}
    const cfg = cfgRaw.map(s => {
      if (s.key) return s;
      const mapKeyByLabel = {
        // cars
        'Externe ID':'labels.common.external_id',
        'Kilometerstand':'labels.car.mileage',
        'Getriebe':'labels.car.transmission',
        'Kraftstoff':'labels.car.fuel',
        'Erstzulassung':'labels.car.firstReg',
        'Farbe':'labels.car.color',
        'Land':'labels.common.country',
        'Preis':'labels.common.price',
        // yachts
        'Modell':'labels.common.model',
        'Länge (m)':'labels.yacht.length',
        'Breite (m)':'labels.yacht.beam',
        'Motortyp':'labels.yacht.engines',
        'Leistung (kW)':'labels.yacht.power',
        'Tankvolumen (l)':'labels.yacht.tank',
        // watches
        'Gehäusematerial':'labels.watch.case',
        'Durchmesser':'labels.watch.diameter',
        'Kaliber':'labels.watch.caliber',
        'Wasserdicht':'labels.watch.waterproof',
        // properties
        'Ort':'labels.property.location',
        'Immobilientyp':'labels.property.property_type',
        'Wohnfläche (m²)':'labels.property.living',
        'Schlafzimmer':'labels.property.bedrooms',
        'Badezimmer':'labels.property.baths',
        'Baujahr':'labels.property.built'
      };
      return { field: s.field, key: mapKeyByLabel[s.label] || 'labels.common.'+s.label, fb: s.label };
    });

    item.specs = [
      { label: tSrv('labels.common.brand', 'Marke'),  value: item.brandName },
      { label: tSrv('labels.common.model', 'Modell'), value: item.modelName },
      ...cfg.map(({ field, key, fb }) => {
        const rawVal     = (field in item ? item[field] : itemRow[field]); // ID/Code oder direkter Wert
        const displayVal = resolveDisplay(field, rawVal);
        return { label: tSrv(key, fb), value: displayVal };
      })
    ];
    console.log('[DETAIL] specs built:', item.specs.length);

    // 9) Empfehlungen
    const selectCols = HAS_REF ? 'id, name, price, pictures, reference' : 'id, name, price, pictures';
    const [recs] = await db.query(`
      SELECT ${selectCols}
      FROM ${table}
      WHERE status = 3 AND visible = 1
        AND JSON_LENGTH(pictures) > 0 AND id <> ?
      ORDER BY RAND()
      LIMIT 12
    `, [id]);
    console.log('[DETAIL] recommendations raw:', recs.length);

    let recommendedItems = recs.map(r => {
      const rpRaw  = unserialize(r.pictures || 'a:0:{}');
      const rpics  = Array.isArray(rpRaw) ? rpRaw : Object.values(rpRaw);
      const main   = (rpics[0] && rpics[0].image) ? rpics[0].image : String(rpics[0] || 'placeholder.jpg');
      const num    = r.price != null ? Number(r.price) : null;
      return {
        id:             r.id,
        reference:      HAS_REF ? (r.reference ?? null) : null,
        title:          r.name,
        slug:           slugify(r.name, { lower: true, strict: true }),
        imageUrl:       `/images/${entityRoute}/${r.id}/${encodeURIComponent(main)}`,
        priceFormatted: num != null ? new Intl.NumberFormat(activeLanguage || 'de', { style: 'currency', currency: 'EUR' }).format(num) : '–'
      };
    });

    // 9a) Empfehlungs-Übersetzungen
    if (recommendedItems.length) {
      const recAdvertKeys = recommendedItems.map(x =>
        HAS_REF && x.reference != null && Number(x.reference) > 0 ? Number(x.reference) : Number(x.id)
      );
      const phIds = recAdvertKeys.map(()=>'?').join(',');
      try {
        const [trs] = await db.query(
          `SELECT advert_id, language, title
             FROM listing_translations
            WHERE entitie_id = ?
              AND advert_id IN (${phIds})
              AND language   IN (${phLangs})
            ORDER BY FIELD(language, ${orderLang})`,
          [currentEntity.id, ...recAdvertKeys, ...langs, ...langs]
        );
        console.log('[DETAIL][recs][i18n] hits:', trs.length);
        const bestById = new Map();
        for (const r of trs) if (r.title && !bestById.has(r.advert_id)) bestById.set(r.advert_id, r.title);
        recommendedItems = recommendedItems.map(r => {
          const k = HAS_REF && r.reference != null && Number(r.reference) > 0 ? Number(r.reference) : Number(r.id);
          const t = bestById.get(k);
          return t ? { ...r, title: t } : r;
        });
      } catch (e) {
        console.warn('[DETAIL][recs][i18n] query failed:', e);
      }
    }

    // 10) Description parsen
    const sections    = parseDescriptionSections(item.description || '');
    const tableTitles = ['Ausstattung', 'Sonderausstattung'];
    item.descriptionTable    = sections.filter(sec => tableTitles.includes(sec.title))
                                       .map(sec => ({ title: sec.title, value: sec.items.join(', ') }));
    item.descriptionSections = sections.filter(sec => !tableTitles.includes(sec.title));
    console.log('[DETAIL] description sections:', sections.length);

    // 11) Verkäufer
    let seller = null;
if (itemRow.user_id) {
  const [[u]] = await db.query(`
    SELECT id, firstname, lastname, company,
           street,housenumber,postcode,city,country_id,
           phone,mobile,email, logo, website, imprint,
           details_name_hidden,details_address_hidden,
           details_phone_hidden,details_email_hidden
    FROM users
    WHERE id = ? AND blacklist = 0 AND confirmed = 1
  `, [itemRow.user_id]);

  if (u) {
    const [[c2]]  = await db.query('SELECT de FROM countries WHERE id = ?', [u.country_id]);
    const sellerCountry = c2?.de || '–';

    seller = {
      id:       u.id,
      logo:     u.logo,

      // Firma
      company:  u.company || null,
      street:   u.street,
      housenumber: u.housenumber,
      postcode: u.postcode,
      city:     u.city,
      country:  sellerCountry,
      website:  u.website,

      // Impressum
      imprint:  u.imprint,

      // Ansprechpartner
      firstname: u.firstname,
      lastname:  u.lastname,
      phone:     !u.details_phone_hidden  ? (u.phone || u.mobile) : null,
      email:     !u.details_email_hidden  ? u.email               : null,
    };
  }
}

    console.log('[DETAIL] seller present:', !!seller);

    // 12) Footer
    const [cols]  = await db.query(`
      SELECT id, title, sort_order
      FROM footer_columns
      ORDER BY sort_order, title
    `);
    const [links] = await db.query(`
      SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
      FROM footer_links
      ORDER BY column_id, sort_order
    `);
    const footerColumns = cols.map(col => ({ id: col.id, title: col.title, sort_order: col.sort_order, phone: null, links: [] }));
    for (const link of links) {
      const fc = footerColumns.find(c => c.id === link.column_id);
      if (!fc) continue;
      if (link.is_phone) fc.phone = link.phone_number;
      else               fc.links.push({ text: link.link_text, url: link.link_url });
    }
    console.log('[DETAIL] footer columns:', footerColumns.length);

const baseImageUrl = "/"; // URL fürs Frontend

let moreItems = [];

for (const ent of entities) {
const [rows] = await db.execute(
  `SELECT *, '${ent.route}' AS entity
   FROM ${ent.table_name}
   WHERE user_id = ? 
     AND id != ? 
     AND visible = 1
   ORDER BY created DESC
   LIMIT 20`,
  [item.user_id, item.id]
);



  console.log(`\n--- ${ent.name} (${ent.table_name}) ---`);
  console.log(`Gefundene Datensätze: ${rows.length}`);

rows.forEach(r => {
  console.log(`\nItem-ID: ${r.id}, Name: ${r.name}`);

  let img = null;

  img = extractImage(r.mainpicture);

  if (!img) {
    img = extractImage(r.pictures);
  }
  if (!img) {
    img = "placeholder.jpg";
    console.log(`❌ Kein Bild gefunden → Fallback: ${img}`);
  } else {
    console.log(`✅ Bild extrahiert: ${img}`);
  }
  r.mainpicture = `/images/${r.entity}/${r.id}/${encodeURIComponent(img)}`;
  console.log(`➡ Finaler Bildpfad (URL): ${r.mainpicture}`);
});
  if (rows.length > 0) {
    moreItems.push({
      entity: ent.name,
      route: ent.route,
      items: rows
    });
  }
}

const gearboxMap = {
  1: "Manuell",
  2: "Automatik",
  3: "Halbautomatik"
};

const fuelMap = {
  1: "Benzin",
  2: "Diesel",
  3: "Hybrid",
  4: "Elektro",
  5: "Gas"
};

const investmentTypeMap = {
  1: "Wohnimmobilien",
  2: "Hotels & Gastronomie",
  3: "Gewerbe",
  4: "Grundstücke",
  5: "Pflegeimmobilien",
  6: "Wohn-/Geschäftshaus"
};

const qualityMap = {
  1: "Einfach",
  2: "Normal",
  3: "Gehoben",
  4: "Luxus",
  5: "Erstbezug"
};

const propertyTypeMap = {
  4: "Wohnung",
  5: "Penthouse",
  6: "Villa/Haus",
  8: "Maisonette",
  10: "Finca",
  11: "Privatinsel",
  12: "Schloss/Herrenhaus",
  255: "Sonstige"
};

const propertyShapeMap = {
  1: "Erstbezug",
  2: "Erstbezug nach Sanierung",
  3: "Wie neu",
  4: "Renoviert",
  5: "Modernisiert",
  6: "Saniert",
  7: "Gepflegt"
};

const stageMap = {
  1: "Geplant",
  2: "Im Bau",
  3: "Fertiggestellt"
};

const heatingMap = {
  1: "Elektroheizung",
  2: "Stoffheizung",
  3: "Zentralheizung",
  4: "Blockheizkraftwerk",
  5: "Elektroheizung", // (doppelt in DB)
  6: "Fernwärme",
  7: "Fußbodenheizung",
  8: "Gasheizung",
  9: "Pelletheizung",
  10: "Nachtspeicherheiz",
  11: "Ölheizung",
  12: "Solarheizung",
  13: "Wärmepumpe"
};

const energySourceMap = {
  1: "Holz",
  2: "Öl",
  3: "Gas",
  4: "Strom",
  5: "Solar",
  6: "Geothermie",
  7: "Alternative"
};

const energyPassMap = {
  0: "Nicht verfügbar",
  1: "Verfügbar",
  2: "Nicht notwendig"
};

const energyPassTypeMap = {
  1: "Verbrauchsausweis",
  2: "Bedarfsausweis"
};

const categoryMap = {
  1: "Motorschiff",
  2: "Segelboot"
};

// Yacht Mappings
const yachtTypeMap = {
  1: "Motoryacht",
  2: "Sportkreuzer",
  3: "Kajütkreuzer",
  4: "Kreuzer",
  5: "Runabout",
  6: "Daycruiser",
  7: "Sportfischer",
  8: "Dutchman",
  9: "Motor Cabin Boat",
  10: "Flybridge",
  11: "Hausboot",
  12: "See-Erlaubnis",
  13: "Elektroboot",
  14: "Kajütboot",
  15: "Katamaran",
  16: "Offshore-Boot",
  17: "Trawler",
  18: "Solarboot",
  19: "Wasserski-Boot",
  20: "Sportboot"
};

const hullMap = {
  1: "GFK",
  2: "Stahl",
  3: "Aluminium",
  4: "Polyester",
  5: "GRP",
  6: "Verbundwerkstoff",
  7: "Holz",
  8: "Kevlar/Carbon"
};

const shapeMap = {
  1: "Wie neu",
  2: "Sehr gut",
  3: "Gut",
  4: "Charter"
};





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

    console.log('[DETAIL] >> render', {
      route: currentEntity.route,
      itemId: item.id,
      recs: recommendedItems.length,
      lang: activeLanguage,
      ms: Date.now() - startedAt
    });

    // 13) Render
      res.render('pages/templates/detail', {
        entities,
        currentEntity,
        item,
        recommendedItems,
        seller,
        footerColumns,
        entieties: entities,
        user,
        moreItems, 
        gearboxMap,
        fuelMap,
        resolveDisplay, 
        investmentTypeMap,
        qualityMap,
        propertyTypeMap,
        propertyShapeMap,
        stageMap,
        heatingMap,
        energySourceMap,
        energyPassMap,
        energyPassTypeMap,
        yachtTypeMap, 
        hullMap, 
        fuelMap, 
        shapeMap,
        categoryMap, 
        slider: [],
      });


  } catch (err) {
    console.error('[DETAIL][ERROR]', err);
    next(err);
  }
});


module.exports = router;

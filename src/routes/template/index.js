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

function buildCategoryTitle(query, entityRoute) {
  // 1) Suchleiste
  if (query.search && query.search.trim() !== '') {
    return query.search.trim();
  }

  // 2) Filter: Model
  if (query.model && query.model !== '') {
    return query.model;
  }

  // 3) Filter: Brand
  if (query.brand && query.brand !== '') {
    return query.brand;
  }

  // 4) Standard je nach Kategorie
  switch (entityRoute) {
    case 'cars':
      return 'Premiumautos, Sportwagen & Oldtimer';
    case 'watches':
      return 'Premiumuhren';
    case 'properties':
      return 'Premiumimmobilien';
    case 'yachts':
      return 'Boote & Yachten';
    case 'lifestyles':
      return 'Lifestyle';
    default:
      return '';
  }
}

function capitalize(str) {
  return str
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractMainImage(mainpicture, pictures) {
  try {
    if (mainpicture && typeof mainpicture === "string" && mainpicture.trim() !== "") {
      const str = mainpicture.trim();
      if (str.startsWith("a:")) {
        try {
          const mp = unserialize(str);
          if (mp && typeof mp === "object" && mp.image) return mp.image;
        } catch {}
      }
      return str;
    }

    if (pictures) {
      const raw = Array.isArray(pictures) ? pictures : Object.values(pictures || {});
      if (raw.length > 0) {
        const first = raw[0];
        if (typeof first === "object" && first.image) return first.image;
        if (typeof first === "string") return first;
      }
    }
  } catch {}

  return "placeholder.jpg";
}

function extractMainImageSimple(mainpictureField, picturesArray) {
  try {
    if (mainpictureField && typeof mainpictureField === "string" && mainpictureField.trim() !== "") {
      const s = mainpictureField.trim();
      if (s.startsWith("a:")) {
        const mp = unserialize(s);
        if (mp && mp.image) return mp.image;
      }
      return s; // direkter String
    }

    // Fallback: erstes Bild der pictures-Array
    if (picturesArray && picturesArray.length > 0) {
      const first = picturesArray[0];
      if (typeof first === "string") return first;
      if (first && first.image) return first.image;
    }
  } catch {}

  return "placeholder.jpg";
}

// 🔽 SORTING (muss IN der Route sein, weil req hier existiert)

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

router.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();

  const parts = req.url.split('?')[0].split('/').filter(Boolean);
  if (parts.length !== 2) return next();

  const [entityRoute, slug] = parts;

  const slugify = s =>
    s.toLowerCase()
     .normalize('NFD')
     .replace(/[\u0300-\u036f]/g, '')
     .replace(/[^a-z0-9]+/g, '-')
     .replace(/^-+|-+$/g, '');

  try {
    const [rows] = await db.query(`
      SELECT column_name, option_value, option_label
      FROM attribute_options
      WHERE entitie_route = ?
    `, [entityRoute]);

    const match = rows.find(r =>
      slugify(r.option_label) === slugify(slug)
    );

    if (match) {
      const queryAdd = `${match.column_name}=${match.option_value}`;
      const existingQuery = req.url.includes('?')
        ? '&' + req.url.split('?')[1]
        : '';

      // 🔥 ENTSCHEIDEND: URL intern auf /cars kürzen
      req.url = `/${entityRoute}?${queryAdd}${existingQuery}`;

      console.log('✅ SEO URL transformed to:', req.url);
    }

    next();
  } catch (e) {
    next(e);
  }
});


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
  const MASTER_EMAIL = 'office@herando.com';
  const MASTER_PASS = 'Herando12345678!';

  // 🔐 Wenn Session schon gesetzt → direkt durchlassen
  if (req.session && req.session.masterLoggedIn) {
    console.log(`✅ Master bereits eingeloggt (${MASTER_EMAIL})`);
    return next();
  }

  // 📩 Wenn Login-Daten im Body (POST)
  if (req.method === 'POST' && req.body && req.body.email && req.body.password) {
    const { email, password } = req.body;

    if (email === MASTER_EMAIL && password === MASTER_PASS) {
      req.session.masterLoggedIn = true; // 💾 Session speichern
      console.log(`🔓 Login erfolgreich: ${email}`);
      return res.redirect(req.originalUrl || '/'); // Weiter zur angeforderten Seite
    } else {
      console.log(`❌ Fehlgeschlagener Login-Versuch: ${email}`);
      return res.render('pages/templates/log', { error: 'Falsche Zugangsdaten!' });
    }
  }

  // 🧱 Kein Login aktiv → Login-Seite anzeigen
  console.log('🔒 Kein Master-Login aktiv – zeige Login-Seite');
  return res.render('pages/templates/log', { error: null });
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

function getMegaMenu(route) {
  const map = {
    cars: {
      brands: ["Lamborghini","Ferrari","Porsche","Mercedes-Benz"],
      categories: ["Coupé","Cabrio","SUV","Limousine"]
    },
    watches: {
      brands: ["Patek Philippe","Rolex","Breitling","Omega"],
      categories: ["Armbanduhr","Taschenuhr","Antike Uhr"]
    },
    yachts: {
      brands: ["Sunseeker","Princess","Benetti"],
      categories: ["Motor Yacht","Flybridge","Katamaran"]
    },
    properties: {
      brands: [],
      categories: ["Villa","Finca","Wohnung","Haus"]
    }
  };

  return map[route] || null;
}

router.get('/test/:entityRoute/:id/:slug', ensureAdmin, async (req, res, next) => {
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

    // 4) Bilder (DB & Ordner)
    let rawPics;
    try { rawPics = unserialize(itemRow.pictures || 'a:0:{}') || []; } catch { rawPics = []; }
    const pics = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);
    console.log('[DETAIL][pics] from DB:', pics.length);

    const folder = path.join(imagesBase, entityRoute, String(id));
    let allImgs = [];
    try {
      allImgs = fs.readdirSync(folder).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    } catch { allImgs = []; }
    console.log('[DETAIL][pics] from folder:', allImgs.length, folder);

    function getFilteredImages(images) {
      if (!images.length) return [];
      const cleaned = images.filter(filename => {
        const n = path.basename(filename, path.extname(filename));
        return !/-Square\d+$/i.test(n);
      });
      if (!cleaned.length) return [];
      const groups = {};
      cleaned.forEach(filename => {
        const ext = path.extname(filename);
        const n = path.basename(filename, ext);
        let baseName;
        if (/_(?:large|largex2|medium|mediumx2|small|smallx2)$/i.test(n)) {
          const withoutSize = n.replace(/_(large|largex2|medium|mediumx2|small|smallx2)$/i, '');
          const i = withoutSize.lastIndexOf('-');
          baseName = i !== -1 ? withoutSize.substring(0, i) : withoutSize;
        } else {
          const i = n.lastIndexOf('-');
          baseName = i !== -1 ? n.substring(0, i) : n;
        }
        (groups[baseName] ||= []).push(filename);
      });
      const out = [];
      Object.values(groups).forEach(group => {
        if (group.length === 1) { out.push(group[0]); return; }
        const withoutSize = group.filter(f => {
          const n = path.basename(f, path.extname(f));
          return !/_(?:large|largex2|medium|mediumx2|small|smallx2)$/i.test(n);
        });
        if (withoutSize.length) out.push(withoutSize[0]);
        else {
          const x2 = group.find(f => /_largex2\./i.test(f));
          const l  = group.find(f => /_large\./i.test(f) && !/_largex2\./i.test(f));
          out.push(x2 || l || group[0]);
        }
      });
      return out.sort();
    }


    const filteredImages = allImgs.length
      ? getFilteredImages(allImgs)
      : pics.map(pic => typeof pic === 'string' ? pic : (pic.image || 'placeholder.jpg'));
    console.log('[DETAIL][pics] filtered:', filteredImages.length);

    // ⭐ NEUE MASTER-BILDLOGIK ⭐
    const mainFilename = extractMainImage(itemRow.mainpicture, pics);

    // Thumbnails: wenn Ordner-Bilder existieren → diese; sonst fallback
    const thumbnailFilenames = filteredImages.length
      ? filteredImages
      : pics.map(p => (typeof p === "string" ? p : p?.image)).filter(Boolean);

    if (!thumbnailFilenames.length) {
      thumbnailFilenames.push("placeholder.jpg");
    }

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
        ? res.locals.convertPrice(priceNum)
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
    if (item.imageUrl && Array.isArray(item.thumbnailUrls)) {
      const main = item.imageUrl;
      item.thumbnailUrls = [ main, ...item.thumbnailUrls.filter(u => u !== main) ];
    }

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
        priceFormatted: num != null
          ? res.locals.convertPrice(num)
          : '–'
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

let seller = null;
let isPrivateSeller = false;  // ✅ existiert immer

if (itemRow.user_id) {

  // ✅ User laden
  const [[u]] = await db.query(`
    SELECT id, firstname, lastname, company,
           street, housenumber, postcode, city, country_id,
           phone, mobile, email, logo, website, imprint,
           details_phone_hidden, details_email_hidden
    FROM users
    WHERE id = ? AND blacklist = 0 AND confirmed = 1
  `, [itemRow.user_id]);

  // ✅ Pakettyp laden (private / commercial)
  const [[pkg]] = await db.query(`
    SELECT p.registration_type
    FROM selected_packages sp
    JOIN packages p ON p.id = sp.package_id
    WHERE sp.user_id = ?
    ORDER BY sp.end_date DESC
    LIMIT 1
  `, [itemRow.user_id]);

  isPrivateSeller = (pkg?.registration_type === 'private'); // ✅ jetzt safe

  if (u) {
    const [[c2]]  = await db.query('SELECT de FROM countries WHERE id = ?', [u.country_id]);
    const sellerCountry = c2?.de || '–';

    seller = {
      id: u.id,
      slug: makeSlug(u),   // ✅ HINZUFÜGEN
      logo: u.logo,
      company: u.company || null,
      street: isPrivateSeller ? null : u.street,
      housenumber: isPrivateSeller ? null : u.housenumber,
      postcode: u.postcode,
      city: u.city,
      country: sellerCountry,
      website: u.website,
      imprint: u.imprint,
      firstname: u.firstname,
      lastname: u.lastname,
      phone: !u.details_phone_hidden ? (u.phone || u.mobile) : null,
      email: !u.details_email_hidden ? u.email : null
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

// NEW MASTER IMAGE LOGIC
const rpics = safeParsePictures(r.pictures);
const img = extractMainImage(r.mainpicture, rpics);

r.mainpicture = `/images/${r.entity}/${r.id}/${encodeURIComponent(img)}`;
console.log(`➡ Neuer finaler Bildpfad (URL): ${r.mainpicture}`);

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
// =============================================
// 🔧 IMMOBILIEN-ÜBERSETZUNGEN (Backend-Loader)
// =============================================

let propertyMaps = {
  investment: {},
  quality: {},
  properties: {},
  shape: {},
  stage: {},
  heating: {},
  energy: {},
  energy_pass: {},
  energy_pass_type: {}
};

try {
  const [propertyTranslations] = await db.query(`
    SELECT 
      \`key\`,
      COALESCE(NULLIF(${langCol}, ''), NULLIF(en, ''), NULLIF(de, '')) AS text
    FROM ui_translations
    WHERE \`key\` LIKE 'filters.properties.%'
  `);

  propertyMaps = propertyTranslations.reduce((acc, row) => {
    const parts = row.key.split('.'); // filters.properties.<group>.<id>
    if (parts.length < 4) return acc;

    const group = parts[2]; // e.g. investment, quality, heating
    const id = parts[3];    // numeric ID
    if (!acc[group]) acc[group] = {};
    acc[group][id] = row.text;
    return acc;
  }, {
    investment: {},
    quality: {},
    properties: {},
    shape: {},
    stage: {},
    heating: {},
    energy: {},
    energy_pass: {},
    energy_pass_type: {}
  });

  console.log(`[PROPERTIES][i18n] ${propertyTranslations.length} Übersetzungen geladen.`);
} catch (err) {
  console.warn('[PROPERTIES][i18n] Fehler beim Laden der Übersetzungen:', err);
}

// ============================
// ✅ Fallback + Integritätsprüfung
// ============================

// Hilfsfunktion: Prüft, ob Map wirklich gültige Texte enthält
const isValidMap = (obj) =>
  obj &&
  Object.keys(obj).length > 0 &&
  Object.values(obj).some((v) => typeof v === 'string' && v.trim() !== '' && isNaN(v));

// === Investmenttypen ===
const investmentTypeMap = isValidMap(propertyMaps.investment)
  ? Object.fromEntries(
      Object.entries(propertyMaps.investment).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Wohnimmobilien",
      2: "Hotels & Gastronomie",
      3: "Gewerbe",
      4: "Grundstücke",
      5: "Pflegeimmobilien",
      6: "Wohn-/Geschäftshaus"
    };

// === Qualitätsstufen ===
const qualityMap = isValidMap(propertyMaps.quality)
  ? Object.fromEntries(
      Object.entries(propertyMaps.quality).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Einfach",
      2: "Normal",
      3: "Gehoben",
      4: "Luxus",
      5: "Erstbezug"
    };

// === Immobilientypen ===
const propertyTypeFallback = {
  4: "Wohnung",
  5: "Penthouse",
  6: "Villa/Haus",
  8: "Maisonette",
  10: "Finca",
  11: "Privatinsel",
  12: "Schloss/Herrenhaus",
  255: "Sonstige"
};

const propertyTypeMap = Object.fromEntries(
  Object.entries(propertyTypeFallback).map(([k, fallback]) => {
    const dbValue = propertyMaps.properties?.[k];
    return [parseInt(k), dbValue && dbValue.trim() !== "" ? dbValue : fallback];
  })
);


// === Objektzustand / Form ===
const propertyShapeMap = isValidMap(propertyMaps.shape)
  ? Object.fromEntries(
      Object.entries(propertyMaps.shape).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Erstbezug",
      2: "Erstbezug nach Sanierung",
      3: "Wie neu",
      4: "Renoviert",
      5: "Modernisiert",
      6: "Saniert",
      7: "Gepflegt"
    };

// === Bauphase ===
const stageMap = isValidMap(propertyMaps.stage)
  ? Object.fromEntries(
      Object.entries(propertyMaps.stage).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Geplant",
      2: "Im Bau",
      3: "Fertiggestellt"
    };

// === Heizungsarten ===
const heatingMap = isValidMap(propertyMaps.heating)
  ? Object.fromEntries(
      Object.entries(propertyMaps.heating).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Elektroheizung",
      2: "Stoffheizung",
      3: "Zentralheizung",
      4: "Blockheizkraftwerk",
      5: "Elektroheizung",
      6: "Fernwärme",
      7: "Fußbodenheizung",
      8: "Gasheizung",
      9: "Pelletheizung",
      10: "Nachtspeicherheizung",
      11: "Ölheizung",
      12: "Solarheizung",
      13: "Wärmepumpe"
    };

// === Energiequellen ===
const energySourceMap = isValidMap(propertyMaps.energy)
  ? Object.fromEntries(
      Object.entries(propertyMaps.energy).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Holz",
      2: "Öl",
      3: "Gas",
      4: "Strom",
      5: "Solar",
      6: "Erdwärme",
      7: "Alternative"
    };

// === Energieausweis (Verfügbarkeit) ===
const energyPassMap = isValidMap(propertyMaps.energy_pass)
  ? Object.fromEntries(
      Object.entries(propertyMaps.energy_pass).map(([k, v]) => [parseInt(k), v])
    )
  : {
      0: "Nicht verfügbar",
      1: "Verfügbar",
      2: "Nicht notwendig"
    };

// === Energieausweis Typ ===
const energyPassTypeMap = isValidMap(propertyMaps.energy_pass_type)
  ? Object.fromEntries(
      Object.entries(propertyMaps.energy_pass_type).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Verbrauchsausweis",
      2: "Bedarfsausweis"
    };

let yachtMaps = { category: {}, yachttype: {}, hull: {}, shape: {} };

try {
  const [yachtTranslations] = await db.query(`
    SELECT 
      \`key\`,
      COALESCE(NULLIF(${langCol}, ''), NULLIF(en,''), NULLIF(de,'')) AS text
    FROM ui_translations
    WHERE \`key\` LIKE 'filters.yachts.%'
  `);

  yachtMaps = yachtTranslations.reduce((acc, row) => {
    const parts = row.key.split('.');
    if (parts.length < 4) return acc;
    const group = parts[2];  // yachttype / category / hull / shape
    const value = parts[3];
    if (!acc[group]) acc[group] = {};
    acc[group][value] = row.text;
    return acc;
  }, { category: {}, yachttype: {}, hull: {}, shape: {} });

  console.log('[YACHT][i18n] Dynamische Yacht-Übersetzungen geladen:', yachtTranslations.length);
} catch (err) {
  console.warn('[YACHT][i18n] Fehler beim Laden der Übersetzungen:', err);
}

// Fallback: wenn DB leer ist → deutsche Defaultwerte
const categoryMap = yachtMaps.category || {
  1: "Motorschiff",
  2: "Segelboot"
};

const yachtTypeMap = yachtMaps.yachttype || {
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

const hullMap = yachtMaps.hull || {
  1: "GFK",
  2: "Stahl",
  3: "Aluminium",
  4: "Polyester",
  5: "GRP",
  6: "Verbundwerkstoff",
  7: "Holz",
  8: "Kevlar/Carbon"
};

const shapeMap = yachtMaps.shape || {
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

    // 🧹 HTML Entities aus item und recommendedItems bereinigen
function deepDecodeHTML(str) {
  if (!str) return '';
  let decoded = String(str);
  for (let i = 0; i < 3; i++) {
    decoded = decoded
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\u00a0/g, ' ');
  }
  return decoded.trim();
}

// Anwenden auf item (Details)
item.title = deepDecodeHTML(item.title);
item.description = deepDecodeHTML(item.description);

// Anwenden auf Empfehlungen (falls vorhanden)
if (Array.isArray(recommendedItems)) {
  for (const rec of recommendedItems) {
    rec.title = deepDecodeHTML(rec.title);
  }
}

// Anwenden auf "moreItems" falls vorhanden (mehr vom Verkäufer)
if (Array.isArray(moreItems)) {
  for (const group of moreItems) {
    if (Array.isArray(group.items)) {
      for (const prod of group.items) {
        prod.name = deepDecodeHTML(prod.name);
        prod.subtitle = deepDecodeHTML(prod.subtitle);
      }
    }
  }
}

console.log("===== [SIMILAR] START =====");
console.log("Entity:", currentEntity.route);
console.log("Item ID:", item.id);
console.log("Raw ItemRow brand/model/city/category:", {
  brand_id: itemRow.brand_id,
  model_id: itemRow.model_id,
  city: itemRow.city,
  property_type: itemRow.property_type,
  country_id: itemRow.country_id,
  category: itemRow.category,
  yachttype: itemRow.yachttype,
  user_id: itemRow.user_id
});

let similarItems = [];

try {

  //
  // ==========================
  //  WATCHES
  // ==========================
  //
  if (currentEntity.route === 'watches') {
    console.log("Running SIMILAR query for WATCHES…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, user_id
      FROM watches
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
             (brand_id = ? AND model_id = ?)
          OR (brand_id = ?)
        )
      ORDER BY
        (brand_id = ?) DESC,
        (model_id = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.brand_id, itemRow.model_id,
      itemRow.brand_id,
      itemRow.brand_id, itemRow.model_id
    ]);

    console.log("[SIMILAR][WATCHES] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  CARS
  // ==========================
  //
  else if (currentEntity.route === 'cars') {
    console.log("Running SIMILAR query for CARS…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, user_id
      FROM cars
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
          (brand_id = ? AND model_id = ?)
          OR (brand_id = ?)
        )
      ORDER BY
        (brand_id = ?) DESC,
        (model_id = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.brand_id, itemRow.model_id,
      itemRow.brand_id,
      itemRow.brand_id, itemRow.model_id
    ]);

    console.log("[SIMILAR][CARS] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  PROPERTIES
  // ==========================
  //
  else if (currentEntity.route === 'properties') {
    console.log("Running SIMILAR query for PROPERTIES…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, mainpicture, user_id
      FROM properties
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
          (city = ?)
          OR (country_id = ?)
          OR (propertytype = ?)
        )
      ORDER BY
        (city = ?) DESC,
        (country_id = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.city,
      itemRow.country_id,
      itemRow.propertytype,
      itemRow.city,
      itemRow.country_id
    ]);

    console.log("[SIMILAR][PROPERTIES] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  YACHTS
  // ==========================
  //
  else if (currentEntity.route === 'yachts') {
    console.log("Running SIMILAR query for YACHTS…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, user_id
      FROM yachts
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
          (category = ?)
          OR (yachttype = ?)
        )
      ORDER BY
        (category = ?) DESC,
        (yachttype = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.category,
      itemRow.yachttype,
      itemRow.category,
      itemRow.yachttype
    ]);

    console.log("[SIMILAR][YACHTS] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  LIFESTYLES  (FIXED – part of correct chain)
  // ==========================
  //
else if (currentEntity.route === 'lifestyles') {
  console.log("Running SIMILAR query for LIFESTYLES (simplified)…");

  const [rows] = await db.query(`
    SELECT id, name, price, pictures, mainpicture, brand_id, model_id, user_id
    FROM lifestyles
    WHERE visible = 1
      AND status = 3
      AND id != ?
      AND user_id != ?
      AND (
           (brand_id = ? AND model_id = ?)
        OR (brand_id = ?)
      )
    ORDER BY
      (brand_id = ?) DESC,
      (model_id = ?) DESC,
      RAND()
    LIMIT 20
  `, [
    item.id,
    itemRow.user_id,
    itemRow.brand_id, itemRow.model_id,
    itemRow.brand_id,
    itemRow.brand_id, itemRow.model_id
  ]);

  console.log("[SIMILAR][LIFESTYLES] rows:", rows.length);
  similarItems = rows;
}


  //
  // ==========================
  //  NO OTHER CATEGORIES → EMPTY
  // ==========================
  //
  else {
    console.log("[SIMILAR] No matching entity, clearing similarItems");
    similarItems = [];
  }

} catch (err) {
  console.warn("[DETAIL][SIMILAR] error:", err);
}

console.log("[SIMILAR] Before map(), items:", similarItems.length);

//
// ==========================
// 🔥 Mapping + Bild-Logik
// ==========================
//

similarItems = similarItems.map(r => {
  console.log("[SIMILAR][MAP] Processing item:", r.id, r.name);

  const rpics = safeParsePictures(r.pictures);
  const img = extractMainImage(r.mainpicture, rpics);

  const out = {
    id: r.id,
    title: r.name,
    slug: slugify(r.name, { lower: true, strict: true }),
    imageUrl: `/images/${currentEntity.route}/${r.id}/${encodeURIComponent(img)}`,
    price: r.price,
    priceFormatted: r.price ? res.locals.convertPrice(r.price) : "Preis auf Anfrage"
  };

  console.log("[SIMILAR][MAP] FINAL ITEM:", out.imageUrl);
  return out;
});


console.log("[SIMILAR] FINAL similarItems:", similarItems.length);
console.log("===== [SIMILAR] END =====");



    // 13) Render
      res.render('pages/templates/test', {
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
        yachtTypeMap: yachtMaps.yachttype || {},
        hullMap:      yachtMaps.hull || {},
        shapeMap:     yachtMaps.shape || {},
        categoryMap, 
        slider: [],
        isPrivateSeller,
        similarItems,
        convertPrice: res.locals.convertPrice 
      });


  } catch (err) {
    console.error('[DETAIL][ERROR]', err);
    next(err);
  }
});

 


router.get('/', ensureAdmin, async (req, res, next) => {
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
  ORDER BY p.created DESC
  LIMIT 8
`, [currentLang]);

const magazinPosts = magRows.map(p => ({
  title:   p.title,
  slug:    p.slug,
  image:   `/uploads/postings/${p.slug}/${p.cover_image || 'placeholder.jpg'}`,
  author:  p.author,
  excerpt: (p.content || '')
             .replace(/<[^>]+>/g, '')   // HTML-Tags weg
             .substring(0, 150)        // Vorschau kürzen
             .trim() + '…'
}));

res.render('pages/templates/index', {
  items,
  brandChunks,
  currentEntitieId,
  entieties,
  footerColumns,
  magazinPosts,
  user,
  popularModels: [],
  moreModelLinks: [],
  ui,
  lang,
  t,

  // 🔥 HIER FEHLTEN DIESE 2
  catLabel: (route, fallback) => {
    // falls dein Label-System existiert
    return ui?.categories?.[route]?.label || fallback || route;
  },

  getMegaMenu: (route) => {
    const map = {
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

    return map[route] || null;
  }
});


  } catch (err) {
    next(err);
  }
});




router.post('/', ensureAdmin, (req, res) => {});


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


router.get('/api/advert_inserat/:entitieId', async (req, res, next) => {
  const entId = parseInt(req.params.entitieId, 10);

  try {
    // a) Table-Name holen
    const [[ent]] = await db.query(
      'SELECT table_name, route FROM ententies WHERE id = ?',
      [entId]
    );
    if (!ent) return res.status(404).json({ error: 'Entity not found' });

    // b) Extra-Felder
    let extraFields = '';
    let extraJoins = '';

    switch (ent.table_name) {
      case 'cars':
        extraFields = `
          , t.cartype, t.mileage, t.fuel, t.firstregistration, t.firstregistration_month
        `;
        break;

      case 'watches':
        extraJoins = 'LEFT JOIN brands b ON b.id = t.brand_id';
        extraFields = `
          , b.name AS brand, t.model, t.year, t.watchtype, t.gender, t.movement, t.case_material
        `;
        break;

      case 'properties':
        extraFields = `
          , t.propertytype, t.investmenttype, t.bedrooms, t.bathrooms, t.livingarea
        `;
        break;

      case 'yachts':
        extraFields = `
          , t.yachttype, t.length, t.beam, t.draft, t.berths, t.year
        `;
        break;
    }

    // c) Aktive Inserate laden
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
        t.mainpicture AS mainpicture,
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
        AND t.status = 3
        AND t.visible = 1
      ORDER BY ai.start_date DESC
      LIMIT 20
    `, [entId, today, today]);

    const convertPrice = res.locals.convertPrice;
    const userCurrency = res.locals.currency || 'EUR';

    const items = rows.map(row => {
      // 📌 Titel säubern (aber KEIN Slug erzeugen)
      const cleanTitle = (row.title || `${row.brand || ''} ${row.model || ''}`)
        .replace(/<\/?[^>]+>/gi, '')         // HTML weg
        .replace(/&[a-z]+;/gi, '')           // Entities weg
        .replace(/[^a-zA-Z0-9\s.-]/g, '')    // Sondermüll weg
        .replace(/\s+/g, ' ')
        .trim();

      // 🖼 Bilder
      let rawPics;
      try {
        rawPics = unserialize(row.picsSerialized || 'a:0:{}') || [];
      } catch (_) {
        rawPics = [];
      }
      const picsArr = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);

      let mainImg = row.mainpicture || null;
      try {
        if (mainImg && mainImg.startsWith("a:")) {
          const tmp = unserialize(mainImg);
          if (tmp && tmp.image) mainImg = tmp.image.trim();
        }
      } catch (_) {}

      if (!mainImg && picsArr.length > 0) {
        const f = picsArr[0];
        mainImg = typeof f === "string" ? f.trim() : (f.image ? f.image.trim() : null);
      }

      if (!mainImg) mainImg = "herando-weblogo.png";

      const imageUrl = mainImg === "herando-weblogo.png"
        ? `/assets/herando-weblogo.png`
        : `/images/${ent.table_name}/${row.itemId}/${encodeURIComponent(mainImg)}`;

      // 💰 Preisverarbeitung
      const price = row.price || 0;

      return {
        ...row,   // ALLES behalten (brand, model etc.)
        id: row.adId,
        reference: row.itemId,
        title: cleanTitle,
        imageUrl,
        price,
        priceFormatted: price ? new Intl.NumberFormat('de-DE').format(price) + ' €' : null,
        priceConverted: convertPrice(price, userCurrency)
      };
    });

    res.json(items);

  } catch (err) {
    console.error('🚨 Fehler in /api/advert_inserat:', err);
    next(err);
  }
});


router.get('/api/catalog_ads/:entitieId', async (req, res, next) => {
  const entId = parseInt(req.params.entitieId, 10);
  console.log('🟢 [API CALL] /api/catalog_ads/:entitieId →', entId);

  try {
    // a) Table-Name + Route ermitteln
    const [[ent]] = await db.query(
      'SELECT table_name, route FROM ententies WHERE id = ?',
      [entId]
    );
    if (!ent) {
      console.warn('⚠️ [catalog_ads] Keine Entitie gefunden für ID:', entId);
      return res.status(404).json({ error: 'Entity not found' });
    }

    console.log(`📘 [catalog_ads] Tabelle: ${ent.table_name} | Route: ${ent.route}`);

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

    const today = new Date().toISOString().slice(0, 10);
    console.log('📅 [catalog_ads] Heutiges Datum:', today);

    const [adsResult] = await db.query(`
      SELECT
        ca.id           AS catalogAdId,
        ca.advert_id    AS advertId,
        t.name          AS title,
        t.price         AS price,
        t.pictures      AS picturesSerialized,
        t.mainpicture   AS mainpicture,
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

    console.log(`📊 [catalog_ads] ${adsResult.length} Datensätze gefunden in ${ent.table_name}`);

    const convertPrice = res.locals.convertPrice;
    const userCurrency = res.locals.currency || 'EUR';

    console.log('💱 [catalog_ads] Aktuelle Benutzerwährung:', userCurrency);

    // ⭐ NEU: ALLE Felder zurückgeben – nicht nur ein paar ⭐
    const items = adsResult.map((row, i) => {
      const rawPics = unserialize(row.picturesSerialized || 'a:0:{}') || [];
      const picsArr = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);

      const mainImg = extractMainImageSimple(row.mainpicture, picsArr);
      const filename = resolveImageFilename(ent.table_name, row.advertId, mainImg);

      const originalPrice = row.price || 0;
      const converted = convertPrice ? convertPrice(originalPrice, userCurrency) : originalPrice;

      console.log(`   🧾 [${i + 1}] ${row.title || 'Kein Titel'} | EUR: ${originalPrice} | ${userCurrency}: ${converted}`);

      return {
        ...row, // ⭐ ALLE extraFields inkludieren ⭐

        catalogAdId: row.catalogAdId,
        reference: row.advertId,
        title: row.title || `${row.brand || ''} ${row.model || ''}`.trim(),
        price: originalPrice,
        priceFormatted: originalPrice
          ? new Intl.NumberFormat('de-DE').format(originalPrice) + ' €'
          : null,
        priceConverted: converted,

        imageUrl: `/images/${ent.table_name}/${row.advertId}/${encodeURIComponent(filename)}`
      };
    });

    console.log('✅ [catalog_ads] Fertig! Antwort wird gesendet mit', items.length, 'Elementen');
    res.json(items);

  } catch (err) {
    console.error('🚨 [catalog_ads] Fehler:', err);
    next(err);
  }
});

async function getFiltersForEntity(entity) {
  // Hole die richtige Entity aus der Datenbank
  const [entities] = await db.query(`
    SELECT id, name, route, table_name, description
    FROM ententies
    ORDER BY id
  `);

  const currentEntity = entities.find(e => e.route === entity);
  if (!currentEntity) return {};

  const tableName = db.escapeId(currentEntity.table_name);

  const categoryTypeMap = {
    properties: 1,
    watches: 2,
    cars: 3,
    yachts: 4,
    lifestyles: 5
  };

  const type = categoryTypeMap[entity] || null;

  const baseWhere = "status=3 AND visible=1 AND pictures IS NOT NULL";
  const baseParams = [];

  // Sprache egal – nimm Deutsch
  const langCol = "de";

  // UND JETZT: deine Original-Funktion nutzen
  return await loadFilterOptions(
    entity,
    tableName,
    type,
    baseWhere,
    baseParams,
    langCol
  );
}

// ---------------------------------------------
// LADEN DER FILTER AUS DER DATENBANK
// (DEIN bestehendes getFiltersForEntity() wird benutzt)
// ---------------------------------------------
async function loadFiltersFromDB(entity) {
  try {
    return await getFiltersForEntity(entity);
  } catch (err) {
    console.log("❌ loadFiltersFromDB ERROR:", err);
    return {};
  }
}

const WATCH_BOOLEAN_LABELS = {
    function_alarm: "Alarm",
    function_chronograph: "Chronograph",
    function_date: "Datum",
    function_day: "Wochentag",
    function_month: "Monat",
    function_year: "Jahr",
    function_4year: "Schaltjahr-Anzeige",
    function_perpetual_calendar: "Ewiger Kalender",
    function_gmt: "GMT / Zweite Zeitzone",
    function_timeequation: "Zeitgleichung",
    function_minuterepeater: "Minutenrepetition",
    function_repetition: "Repetition",
    function_jumping_hour: "Springende Stunde",
    function_double_chronograph: "Doppelchronograph",
    function_panorama: "Panorama",
    function_calendar: "Kalender",
    function_moonphase: "Mondphase",
    function_smallseconds: "Kleine Sekunde",
    function_tachymeter: "Tachymeter",
    function_centralseconds: "Zentrale Sekunde",
    function_flyback: "Flyback",
    function_striking_mechanism: "Schlagwerk",

    feature_heliumvalve: "Heliumventil",
    feature_tourbillon: "Tourbillon",
    feature_diamondsbezel: "Diamantlünette",
    feature_chronometer: "Chronometer zertifiziert",
    feature_master_chronometer: "Master Chronometer",
    feature_rotatingbezel: "Drehbare Lünette",
    feature_powerreserve: "Gangreserve",
    feature_luminescenthands: "Leuchtzeiger",
    feature_pocketwatch: "Taschenuhr",
    feature_luminescentnumerals: "Leuchtziffern",
    feature_luminous_indexes: "Leuchtindizes",
    feature_waterresistant: "Wasserresistent",
    feature_screwedcrone: "Verschraubte Krone",
    feature_screwed_pushers: "Verschraubte Drücker",
    feature_crown_left: "Krone links",
    feature_skeletonized: "Skelettiert",
    feature_guilloched: "Guillochiert",
    feature_hand_guilloched: "Hand-Guillochiert",
    feature_gemsetting: "Steinbesatz",
    feature_geneva_seal: "Genfer Siegel",
    feature_limited_edition: "Limitierte Edition",
    feature_quickset_mechanism: "Quickset Mechanismus",
    feature_original: "Original",
    feature_pvd: "PVD Beschichtung",
    feature_solar: "Solaruhr",
    feature_display_back: "Sichtboden",
    feature_bluedsteel_hands: "Gebläute Stahlzeiger",
    feature_worldtime_clock: "Weltzeituhr",
    feature_smartwatch: "Smartwatch",
    feature_onehand_watch: "Einzeigeruhr"
};

const BOOLEAN_FILTER_LABELS = {
  onlyOldtimer: 'Oldtimer'
};



router.get('/api/:entity/translate-filters', async (req, res) => {
  const entity = req.params.entity;
  const q = { ...req.query }; // shallow copy

  console.log("─────────────────────────────────────────────");
  console.log("📌 API REQUEST Translating Filters");
  console.log("📌 Entity:", entity);
  console.log("📌 Query:", q);

  const output = {};
  const INVESTMENT_PREFIX = 'Renditeimmobilie';


  // ---------------------------------------------------
  // IGNORE pagination params
  // ---------------------------------------------------
  ['hp', 'page', 'limit', 'view'].forEach(k => delete q[k]);

  // ---------------------------------------------------
  // HARDCODED BOOLEAN LABELS (GLOBAL)
  // ---------------------------------------------------
  const BOOLEAN_FILTER_LABELS = {
    onlyOldtimer: 'Oldtimer'
  };

  
  // ---------------------------------------------------
  // LOAD ATTRIBUTE OPTIONS
  // ---------------------------------------------------
  let attributeOptions = [];
  try {
    const [rows] = await db.query(
      `SELECT column_name, option_value, option_label
       FROM attribute_options
       WHERE entitie_route = ?`,
      [entity]
    );
    attributeOptions = rows;
  } catch (err) {
    console.error("❌ ERROR loading attribute_options:", err);
  }

  // ---------------------------------------------------
  // LOAD BRANDS / MODELS / COUNTRIES
  // ---------------------------------------------------
  let brands = [];
  let models = [];
  let countries = [];

  try {
    const [b] = await db.query(`SELECT id, name FROM brands ORDER BY name`);
    brands = b;

    const [m] = await db.query(`SELECT id, name, brand_id FROM models ORDER BY name`);
    models = m;

    const [c] = await db.query(`SELECT id, de AS name FROM countries`);
    countries = c;
  } catch (err) {
    console.error("❌ ERROR loading brands/models/countries:", err);
  }

  // ---------------------------------------------------
  // HELPERS
  // ---------------------------------------------------
  const findAttributeLabel = (column, val) =>
    attributeOptions.find(
      o =>
        o.column_name === column &&
        String(o.option_value) === String(val)
    )?.option_label || null;

  const findBrand   = id => brands.find(b => String(b.id) === String(id))?.name || null;
  const findModel   = id => models.find(m => String(m.id) === String(id))?.name || null;
  const findCountry = id => countries.find(c => String(c.id) === String(id))?.name || null;

  // ---------------------------------------------------
  // PROCESS QUERY FILTERS (ORDER IS IMPORTANT)
  // ---------------------------------------------------
  for (const key in q) {
    const rawVal = q[key];
    const val = Array.isArray(rawVal) ? rawVal[0] : rawVal;
    const normKey = key.replace(/\[\]$/, '');

    if (val === undefined || val === null || String(val).trim() === '') continue;

    // ---------------------------------------------------
    // 1️⃣ HARDCODED BOOLEAN FILTERS (Oldtimer etc.)
    // ---------------------------------------------------
    if (BOOLEAN_FILTER_LABELS[normKey] && String(val) === '1') {
      output[normKey] = BOOLEAN_FILTER_LABELS[normKey];
      continue;
    }

    // ---------------------------------------------------
    // 2️⃣ WATCH BOOLEAN LABELS
    // ---------------------------------------------------
    if (entity === 'watches' && WATCH_BOOLEAN_LABELS?.[normKey]) {
      if (String(val) === '1') {
        output[normKey] = WATCH_BOOLEAN_LABELS[normKey];
      }
      continue;
    }

    // ---------------------------------------------------
    // 3️⃣ BRAND
    // ---------------------------------------------------
    if (normKey === 'brand' || normKey === 'brand_id') {
      const name = findBrand(val);
      if (name) {
        output.brand = name;
        continue;
      }
    }

    // ---------------------------------------------------
    // 4️⃣ MODEL
    // ---------------------------------------------------
    if (normKey === 'model' || normKey === 'model_id') {
      const name = findModel(val);
      if (name) {
        output.model = name;
        continue;
      }
    }

    // ---------------------------------------------------
    // 5️⃣ COUNTRY
    // ---------------------------------------------------
    if (normKey === 'country' || normKey === 'country_id') {
      const name = findCountry(val);
      if (name) {
        output.country = name;
        continue;
      }
    }

  if (normKey === 'investmenttype') {
    const label = findAttributeLabel('investmenttype', val);
    if (label) {
      output.investmenttype = `${INVESTMENT_PREFIX} - ${label}`;
    }
    continue;
  }


    // ---------------------------------------------------
    // 6️⃣ ATTRIBUTE OPTIONS (dynamic)
    // ---------------------------------------------------
    const attrLabel = findAttributeLabel(normKey, val);
    if (attrLabel) {
      output[normKey] = attrLabel;
      continue;
    }

    // ---------------------------------------------------
    // ❌ FALLBACK → IGNORE (KEIN RAW-WERT MEHR!)
    // ---------------------------------------------------
  }

  console.log("📤 FINAL RESPONSE:", output);
  console.log("─────────────────────────────────────────────");

  res.json(output);
});





function buildAndLike(terms, columns) {
  const clause = terms
    .map(() => `(${columns.map(() => '?? LIKE ?').join(' OR ')})`)
    .join(' AND ');
  const params = [];
  for (const term of terms) {
    const like = `%${term}%`;
    for (const col of columns) params.push(col, like);
  }
  return { clause, params };
}

// 🔹 Dynamisches Label aus attribute_options
async function getAttributeLabel(entitie, column, value) {
  const [rows] = await db.query(
    `SELECT option_label 
     FROM attribute_options 
     WHERE entitie_route = ? 
       AND column_name = ? 
       AND option_value = ? 
     LIMIT 1`,
    [entitie, column, value]
  );
  return rows.length ? rows[0].option_label : null;
}

// 🔹 Hauptsuche
router.get('/api/search/suggestions', async (req, res) => {
  const qRaw = req.query.q || '';
  const q = qRaw.trim();

  console.log("🔥🔥🔥 ROUTER STARTED — RAW request:", req.query);

  if (q.length < 2) {
    console.log("⚠️ Query zu kurz → Abbruch");
    return res.json({
      brandModels: [],
      propertySuggestions: [],
      models: [],
      sellers: [],
      listings: []
    });
  }

  const terms = q.split(/[\s\*\-_,.]+/).filter(Boolean);
  console.log("🔍 [Parsed Terms]", terms);

  const likeQ = `%${q}%`;

  const routeMap = {
    1: 'properties',
    2: 'watches',
    3: 'cars',
    4: 'yachts',
    5: 'lifestyles'
  };

  try {
    // ============================================================
    // 1️⃣ PROPERTY CATEGORY SUGGESTIONS
    // ============================================================
    console.log("🏠 [PROPERTY-SUGGESTIONS] Suche gestartet…");

    const propertyTypeMap = {
      villa: { id: 6, label: "Villa / Haus" },
      haus: { id: 6, label: "Villa / Haus" },
      finca: { id: 10, label: "Finca" },
      penthouse: { id: 5, label: "Penthouse" },
      wohnung: { id: 4, label: "Wohnung" },
      apartment: { id: 4, label: "Apartment" },
      insel: { id: 11, label: "Privatinsel" },
      privatinsel: { id: 11, label: "Privatinsel" },
      schloss: { id: 12, label: "Schloss / Herrenhaus" },
      herrenhaus: { id: 12, label: "Herrenhaus" }
    };

    let propertySuggestions = [];

    for (const t of terms) {
      const key = t.toLowerCase();
      console.log(`➡️ Prüfe Term "${key}" in PROPERTY MAP…`);

      if (propertyTypeMap[key]) {
        const match = propertyTypeMap[key];
        console.log("✅ PROPERTY TYPE MATCH:", match);

        propertySuggestions.push({
          title: match.label,
          subtitle: "Immobilientyp",
          url: `/properties?propertytype=${match.id}`
        });
      } else {
        console.log(`❌ Kein Property-Match für "${key}"`);
      }
    }

    console.log("🏠 FINAL PROPERTY SUGGESTIONS:", propertySuggestions);


    // ============================================================
    // 2️⃣ BRAND SEARCH
    // ============================================================
    console.log("🏷️ [BRAND SEARCH] Gestartet… LIKE:", likeQ);

    const [brandMatch] = await db.query(
      `SELECT id, name, type FROM brands WHERE name LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1`,
      [likeQ]
    );

    console.log("🏷️ BRAND RESULT:", brandMatch);

    let brandModels = [];

    if (brandMatch.length) {
      const { id: brandId, name: brandName, type: brandType } = brandMatch[0];

      console.log(`🏷️ BRAND ERKANNT → ${brandName}, Type=${brandType}`);

      if (brandType !== 1) {
        const baseUrl = `/${routeMap[brandType]}`;
        console.log("📌 BRAND gehört NICHT zu Properties → Modelle laden…");

        const [modelsByBrand] = await db.query(
          `SELECT id, name FROM models WHERE brand_id = ? ORDER BY name ASC LIMIT 10`,
          [brandId]
        );

        console.log("📌 MODELLE vom BRAND:", modelsByBrand);

        brandModels = [
          {
            title: brandName,
            subtitle: "Marke",
            url: `${baseUrl}?brand=${brandId}`
          },
          ...modelsByBrand.map(m => ({
            title: `${brandName} ${m.name}`,
            subtitle: "Modell",
            url: `${baseUrl}?brand=${brandId}&model=${m.id}`
          }))
        ];
      }
    } else {
      console.log("❌ Kein BRAND MATCH gefunden!");
    }


    // ============================================================
    // 3️⃣ MODEL SEARCH
    // ============================================================
    console.log("🔧 [MODELL-SUCHE] Gestartet");

    const { clause: modelClause, params: modelParams } =
      buildAndLike(terms, ["m.name", "b.name"]);

    console.log("🔧 MODEL SQL WHERE CLAUSE:", modelClause);
    console.log("🔧 MODEL SQL PARAMS:", modelParams);

    const [modelsByName] = await db.query(
      `
        SELECT m.id, m.name AS model, m.brand_id, b.name AS brand, b.type
        FROM models m
        LEFT JOIN brands b ON b.id = m.brand_id
        WHERE ${modelClause}
        AND b.type != 1
        ORDER BY m.name ASC
        LIMIT 10
      `,
      modelParams
    );

    console.log("🔧 MODEL RESULTS:", modelsByName);

    const models = modelsByName.map(r => ({
      title: `${r.brand ? r.brand + " " : ""}${r.model}`,
      subtitle: "Modell",
      url: `/${routeMap[r.type]}?brand=${r.brand_id}&model=${r.id}`
    }));


    // ============================================================
    // 4️⃣ SELLER SEARCH
    // ============================================================
    console.log("🧑‍💼 [SELLER SEARCH] Gestartet");

    const { clause: sellerClause, params: sellerParams } =
      buildAndLike(terms, ["u.company", "u.firstname", "u.lastname"]);

    console.log("🧑‍💼 SELLER WHERE:", sellerClause);
    console.log("🧑‍💼 SELLER PARAMS:", sellerParams);

    const [sellerRows] = await db.query(
      `
      SELECT u.id, u.company, u.firstname, u.lastname
      FROM users u
      WHERE ${sellerClause}
      AND (u.role = 'dealer' OR u.company IS NOT NULL)
      LIMIT 5
      `,
      sellerParams
    );

    console.log("🧑‍💼 SELLER RESULTS:", sellerRows);

      const sellers = sellerRows.map(s => {
        const name = s.company || `${s.firstname} ${s.lastname}`;
        const slug = slugify(name, { lower: true, strict: true });

        return {
          entity: "seller",
          title: name,
          subtitle: "Händler",
          url: `/seller/${slug}`
        };
      });

    // ============================================================
    // 5️⃣ LISTINGS
    // ============================================================
    console.log("📦 [LISTINGS] Suche gestartet…");

    const listings = [];

    const entities = [
      { table: "cars", label: "Auto", column: "cartype", hasBrand: true },
      { table: "watches", label: "Uhr", hasBrand: true },
      { table: "yachts", label: "Yacht", column: "yachttype", hasBrand: true },
      { table: "properties", label: "Immobilie", column: "propertytype", hasBrand: false },
      { table: "lifestyles", label: "Lifestyle", hasBrand: false }
    ];

    for (const e of entities) {
      console.log(`📦 Suche in Tabelle: ${e.table}`);

      const alias = e.table[0];
      let joins = `LEFT JOIN users u ON u.id = ${alias}.user_id`;

      if (e.hasBrand) {
        joins += ` LEFT JOIN brands br ON br.id = ${alias}.brand_id`;
      }

      const searchCols = [
        `${alias}.name`,
        `${alias}.city`,
        "u.company",
        "u.firstname",
        "u.lastname"
      ];

      const { clause, params } = buildAndLike(terms, searchCols);

      console.log(`📦 SQL für ${e.table}:`, clause, params);

      const [rows] = await db.query(
        `
SELECT ${alias}.id,
       ${alias}.name AS title,
       ${alias}.city,
       u.company,
       ${e.hasBrand ? "br.name AS brand," : ""}
       ${e.column ? `${alias}.${e.column}` : "NULL"} AS type_value,
       ${alias}.mainpicture
        FROM ${e.table} ${alias}
        ${joins}
        WHERE ${alias}.visible = 1
          AND ${alias}.status = 3
          AND ${clause}
        ORDER BY ${alias}.id DESC
        LIMIT 8
        `,
        params
      );

      console.log(`📦 RESULTS für ${e.table}:`, rows);

listings.push(
  ...rows.map(r => ({
    entity: e.table,
    title: r.brand ? `${r.brand} ${r.title}` : r.title,
    subtitle: `${e.label} • ${r.city || ""}`,
    image: r.mainpicture
      ? `/images/${e.table}/${r.id}/${r.mainpicture}`
      : '/images/placeholder.jpg',
    url: `/${e.table}/${r.id}/${slugify(r.title, { lower: true, strict: true })}`
  }))
);

    }


    // ============================================================
    // 6️⃣ FINAL RESPONSE
    // ============================================================
    console.log("📤 FINAL RESPONSE:", {
      propertySuggestions,
      brandModels,
      models,
      sellers,
      listings
    });

    res.json({
      propertySuggestions,
      brandModels,
      models,
      sellers,
      listings
    });

  } catch (err) {
    console.error("❌ Search API Error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});







// ─── 1) Suche über alle Entitäten hinweg ───────────────────
// ─── Such‐Route (/search) ───────────────────────────────────────────────────
router.get('/search', ensureAdmin, async (req, res, next) => {
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
    const limit       = Math.max(1, parseInt(req.query.limit, 10) || 32);
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
  try {
    // 🧠 Benutzer korrekt aus Session laden
    let user = null;

    if (req.session.userId) {
      user = {
        id: req.session.userId,
        role: req.session.role,
        type: req.session.userType,
        email: req.session.user?.email || ''
      };
    }

    // Lokale Variablen für Templates
    res.locals.user = user;
    res.locals.login_user = user;
    res.locals.currentUrl = req.url;
    res.locals.headerTitle = 'Angebote';

    // SAFE
    let userType = user?.type || '';
    let userHasPackage = false;

    // 🔹 Prüfen, ob Nutzer aktives Paket hat (SAFE)
    if (user?.id) {
      const [activePackages] = await db.query(`
        SELECT COUNT(*) AS count
        FROM selected_packages
        WHERE user_id = ?
          AND end_date > NOW()
      `, [user.id]);
      userHasPackage = activePackages[0].count > 0;
    }

    // 🔹 Pakete laden
    const [packages] = await db.query(`
      SELECT id, name, description, price, registration_type, sort_order
      FROM packages
      ORDER BY sort_order
    `);

    const commercialPackages = packages.filter(p => p.registration_type === 'commercial');
    const privatePackages = packages.filter(p => p.registration_type === 'private');

    // 🔹 Länder & Kategorien laden
    const [countries] = await db.query(`
      SELECT id, de AS name FROM countries WHERE visible = 1 ORDER BY de
    `);

    const [categories] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);

    // Für Header (Dropdowns)
    const entieties = categories;
    res.locals.entieties = entieties;

    // 🔹 Footer laden
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

    // 🔹 SEO laden
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT title, description AS meta_description, robots,
             og_title, og_description, og_image, twitter_card,
             jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren | Kaufen & Verkaufen',
      meta_description: seoRow?.meta_description || 'Entdecken Sie über 100.000 Premium-Angebote...',
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

    // Standard-Paket
    const privateDefaultId = privatePackages.length ? privatePackages[0].id : null;
    const commercialDefaultId = commercialPackages.length ? commercialPackages[0].id : null;

    // Debug
    console.log('👤 Benutzer:', user);
    console.log('💡 userType:', userType, '| userHasPackage:', userHasPackage);
    console.log('🧩 locals:', {
      login_user: res.locals.login_user,
      currentUrl: res.locals.currentUrl,
      headerTitle: res.locals.headerTitle,
    });

    // 🔹 Page Render
    res.render('pages/templates/angebote', {
      commercialPackages,
      privatePackages,
      packages,
      countries,
      categories,
      entieties,
      footerColumns,
      user,
      userHasPackage,
      userType,
      privateDefaultId,
      commercialDefaultId,
      login_user: user,
      currentUrl: req.url,
      headerTitle: 'Angebote',
    });

  } catch (err) {
    console.error('🔥 Fehler in /angebote:', err);
    next(err);
  }
});

router.get('/sitemap', async (req, res, next) => {
  
  try {
    // =====================================================
    // 🧠 User aus Session
    // =====================================================
    let user = null;

    if (req.session.userId) {
      user = {
        id: req.session.userId,
        role: req.session.role,
        type: req.session.userType,
        email: req.session.user?.email || ''
      };
    }

    res.locals.user = user;
    res.locals.login_user = user;
    res.locals.currentUrl = req.url;
    res.locals.headerTitle = 'Sitemap';

    // =====================================================
    // 1) ENTITIES
    // =====================================================
    const [entities] = await db.query(`
      SELECT id, name, route, table_name
      FROM ententies
      WHERE route IN ('cars','watches','yachts','properties','lifestyles')
      ORDER BY FIELD(route,'cars','watches','yachts','properties','lifestyles')
    `);

    res.locals.entieties = entities;

    // =====================================================
    // 2) Statische Seiten
    // =====================================================
const staticLinks = [
  {
    title: 'Allgemein',
    links: [
      { title: 'Home', url: '/' },
      { title: 'Suchen', url: '/search' },
      { title: 'Autos', url: '/cars' },
      { title: 'Uhren', url: '/watches' },
      { title: 'Yachten', url: '/yachts' },
      { title: 'Immobilien', url: '/properties' },
      { title: 'Lifestyle', url: '/lifestyles' }
    ]
  },

  {
    title: 'Verkaufen',
    links: [
      { title: 'Angebote', url: '/angebote' },
      { title: 'Angebote für Händler', url: '/angebote' },
      { title: 'Inserat erstellen', url: '/buyer/sold' },
    ]
  },

  {
    title: 'Account',
    links: [
      { title: 'Login', url: '/auth/login' },
      { title: 'Registrieren', url: '/auth/register' }
    ]
  },

  {
    title: 'Service & Info',
    links: [
      { title: 'Hilfe / FAQs', url: '/faq' },
      { title: 'Datenschutzerklärung', url: '/datenschutzerklaerung' },
      { title: 'Magazin', url: '/magazin' },
      { title: 'Kontakt', url: '/contact' },
      { title: 'Über uns', url: '/ueber-uns' }
    ]
  }
];


    // =====================================================
    // 3) Sitemap-Daten
    // =====================================================
    const sitemapEntities = [];

    const UI_LANG_COLS = ['de','en','fr','it','tr','ja','cs','ru','es','nl','pl'];
    const rawLang = String(res.locals.lang || 'de').toLowerCase();
    const lang = UI_LANG_COLS.includes(rawLang.split(/[-_]/)[0])
      ? rawLang.split(/[-_]/)[0]
      : 'de';

    for (const e of entities) {
      const table = db.escapeId(e.table_name);

      // ✅ FIX: KEIN slug
      const [items] = await db.query(`
        SELECT id, name
        FROM ${table}
        WHERE status = 3
          AND visible = 1
        ORDER BY published DESC
      `);

      let brands = [];

      if (['cars','watches','yachts'].includes(e.route)) {
        [brands] = await db.query(`
          SELECT DISTINCT b.id, b.name
          FROM brands b
          JOIN ${table} t ON t.brand_id = b.id
          WHERE t.status = 3
            AND t.visible = 1
          ORDER BY b.name
        `);
      }

      if (e.route === 'lifestyles') {
        [brands] = await db.query(`
          SELECT id, name
          FROM brands
          WHERE type = 5
          ORDER BY name
        `);
      }

      const [categories] = await db.query(`
        SELECT
          ao.column_name,
          ao.option_value,
          COALESCE(
            NULLIF(uit.${lang}, ''),
            NULLIF(uit.en, ''),
            NULLIF(uit.de, ''),
            ao.option_label
          ) AS option_label
        FROM attribute_options ao
        LEFT JOIN ui_translations uit
          ON uit.\`key\` = CONCAT(
            'filters.', ao.entitie_route, '.', ao.column_name, '.', ao.option_value
          )
        WHERE ao.entitie_route = ?
          AND ao.column_name IN (
            'cartype','watchtype','yachttype','propertytype','lifestyleType'
          )
        ORDER BY ao.column_name, ao.sort_order
      `, [e.route]);

      sitemapEntities.push({
        route: e.route,
        name: e.name,
        items,
        brands,
        categories
      });
    }

    // =====================================================
    // 4) Footer
    // =====================================================
    const [cols] = await db.query(`
      SELECT id, title, sort_order
      FROM footer_columns
      ORDER BY sort_order, title
    `);

    const [links] = await db.query(`
      SELECT column_id, link_text, link_url, is_phone, phone_number
      FROM footer_links
      ORDER BY column_id, sort_order
    `);

    const footerColumns = cols.map(c => ({
      id: c.id,
      title: c.title,
      phone: null,
      links: []
    }));

    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else col.links.push({ text: l.link_text, url: l.link_url });
    }

    // =====================================================
    // 5) SEO
    // =====================================================
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT title,
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

    res.locals.seo = {
      title: seoRow?.title || 'Sitemap | Herando',
      meta_description: seoRow?.meta_description || 'Alle Seiten, Kategorien, Marken und Inserate auf Herando.',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || seoRow?.title || null,
      og_description: seoRow?.og_description || seoRow?.meta_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };

    // =====================================================
    // 6) Render
    // =====================================================
    res.render('pages/templates/sitemap', {
      staticLinks,
      sitemapEntities,
      footerColumns,
      user,
      login_user: user,
      currentUrl: req.url,
      headerTitle: 'Sitemap'
    });

  } catch (err) {
    console.error('🔥 Fehler in /sitemap:', err);
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

router.post('/newsletter/subscribe', async (req, res) => {
  try {
    const { name, email, ententies_ids, accepted } = req.body;
    const user = req.user || res.locals?.user || null;

    // ─────────────────────────────────────────────
    // 1️⃣ Basic Validation
    // ─────────────────────────────────────────────
    const cleanEmail = String(email || '').trim().toLowerCase();

    if (!cleanEmail || !Array.isArray(ententies_ids) || ententies_ids.length === 0) {
      return res.status(400).json({ message: 'E-Mail und Kategorien erforderlich.' });
    }

    if (String(accepted) !== '1') {
      return res.status(400).json({ message: 'Einwilligung erforderlich.' });
    }

    // ─────────────────────────────────────────────
    // 2️⃣ Name ermitteln (Login > Formular > NULL)
    // ─────────────────────────────────────────────
    let finalName = null;

    if (user && (user.firstname || user.lastname)) {
      finalName = `${user.firstname || ''} ${user.lastname || ''}`.trim();
    }

    if (!finalName && name) {
      finalName = String(name).trim();
    }

    if (!finalName) finalName = null;

    // ─────────────────────────────────────────────
    // 3️⃣ Subscriber anlegen oder aktualisieren
    // ─────────────────────────────────────────────
    const [result] = await db.query(
      `
      INSERT INTO newsletter_subscribers (name, email, accepted)
      VALUES (?, ?, 1)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        accepted = 1
      `,
      [finalName, cleanEmail]
    );

    // Subscriber-ID ermitteln
    let subscriberId = result.insertId;

    if (!subscriberId) {
      const [[row]] = await db.query(
        'SELECT id FROM newsletter_subscribers WHERE email = ?',
        [cleanEmail]
      );
      subscriberId = row.id;
    }

    // ─────────────────────────────────────────────
    // 4️⃣ Kategorien neu setzen
    // ─────────────────────────────────────────────
    await db.query(
      'DELETE FROM newsletter_subscriber_ententies WHERE subscriber_id = ?',
      [subscriberId]
    );

    const values = ententies_ids.map(entId => [subscriberId, entId]);

    await db.query(
      `
      INSERT INTO newsletter_subscriber_ententies
      (subscriber_id, ententies_id)
      VALUES ?
      `,
      [values]
    );

    // ─────────────────────────────────────────────
    // 5️⃣ Erfolg
    // ─────────────────────────────────────────────
    return res.json({ ok: true, message: 'Newsletter abonniert.' });

  } catch (err) {
    console.error('subscribeNewsletter error', err);
    return res.status(500).json({ message: 'Serverfehler.' });
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
      SELECT id, title, slug, cover_image, author, content
      FROM postings
      WHERE category = 'magazin'
      ORDER BY created DESC
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
        seo_description: seoDesc
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
      SELECT id, title, slug, author, location, cover_image, additional_images, content, created
      FROM postings
      WHERE slug = ?
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

    const seo = {
      title: translation?.seo_title || seoRow?.title || page.title,
      meta_description: translation?.seo_description || seoRow?.meta_description || null,
      robots: seoRow?.robots || 'index,follow',
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

router.get('/api/newsletter/preferences', async (req, res) => {
  try {
    const email = req.session?.userEmail;
    if (!email) return res.status(401).json({ message: 'Nicht eingeloggt.' });

    const [rows] = await db.query(`
      SELECT e.id, e.name
      FROM newsletter_subscribers s
      JOIN newsletter_subscriber_ententies se ON se.subscriber_id = s.id
      JOIN ententies e ON e.id = se.ententies_id
      WHERE s.email = ? AND s.accepted = 1
    `, [email]);

    res.json({ categories: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Serverfehler' });
  }
});

router.post('/api/user/privacy', async (req, res) => {
  try {
    if (!req.session?.userId) {
      return res.status(401).json({ message: 'Nicht eingeloggt' });
    }

    const { field, value } = req.body;

    // 🔒 Whitelist (SEHR wichtig)
    const allowed = [
      'details_name_hidden',
      'details_address_hidden',
      'details_phone_hidden',
      'details_email_hidden'
    ];

    if (!allowed.includes(field)) {
      return res.status(400).json({ message: 'Ungültiges Feld' });
    }

    await db.query(
      `UPDATE users SET ${field} = ? WHERE id = ?`,
      [value ? 1 : 0, req.session.userId]
    );

    res.json({ ok: true });

  } catch (err) {
    console.error('privacy update error', err);
    res.status(500).json({ message: 'Serverfehler' });
  }
});


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

router.get('/:entityRoute/allmodels', async (req, res, next) => {
  const user = res.locals.user;
  const entityRoute = String(req.params.entityRoute).toLowerCase();

  try {
    // 1) Route → Entity-ID lookup
    const [[entity]] = await db.query(`
      SELECT id, route
      FROM ententies
      WHERE LOWER(route) = ?
      LIMIT 1
    `, [entityRoute]);

    if (!entity) return res.status(404).send('Unknown category');

    // 2) Navbar
    const [entieties] = await db.query(`
      SELECT id, name, route
      FROM ententies
      ORDER BY id
    `);

    // 3) Footer
    const [cols]  = await db.query(`SELECT id, title, sort_order FROM footer_columns ORDER BY sort_order, title`);
    const [links] = await db.query(`SELECT id, column_id, link_text, link_url, is_phone, phone_number, sort_order
                                      FROM footer_links
                                      ORDER BY column_id, sort_order`);
    const footerColumns = cols.map(c => ({ id:c.id, title:c.title, phone:null, links:[] }));
    for (const l of links) {
      const col = footerColumns.find(c => c.id === l.column_id);
      if (!col) continue;
      if (l.is_phone) col.phone = l.phone_number;
      else col.links.push({ text:l.link_text, url:l.link_url });
    }

    // 4) Liste erlaube Seonames
const displaySeonames = [
  '9ff','A-Lange-und-Soehne','Absolute','Admiral','Alalunga','Alpina','ALPINA','BMW',
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
    const placeholders = displaySeonames.map(() => '?').join(',');

    let brands = [];
    switch (entity.route) {
      case 'cars':
        [brands] = await db.query(`
          SELECT 
            b.id, b.name, b.seoname, COUNT(c.id) AS total_ads
          FROM brands b
          JOIN cars c ON c.brand_id = b.id
          WHERE 
            b.seoname IN (${placeholders})
            AND c.status = 3
            AND c.visible = 1
          GROUP BY b.id, b.name, b.seoname
          ORDER BY b.name ASC
        `, [...displaySeonames]);
        break;

      case 'watches':
        [brands] = await db.query(`
          SELECT 
            b.id, b.name, b.seoname, COUNT(w.id) AS total_ads
          FROM brands b
          JOIN watches w ON w.brand_id = b.id
          WHERE 
            b.seoname IN (${placeholders})
            AND w.status = 3
            AND w.visible = 1
          GROUP BY b.id, b.name, b.seoname
          ORDER BY b.name ASC
        `, [...displaySeonames]);
        break;

      case 'yachts':
        [brands] = await db.query(`
          SELECT 
            b.id, b.name, b.seoname, COUNT(y.id) AS total_ads
          FROM brands b
          JOIN yachts y ON y.brand_id = b.id
          WHERE 
            b.seoname IN (${placeholders})
            AND y.status = 3
            AND y.visible = 1
          GROUP BY b.id, b.name, b.seoname
          ORDER BY b.name ASC
        `, [...displaySeonames]);
        break;

      default:
        brands = [];
    }

    const groupedBrands = { [entity.route]: brands };

    // 5) Überschrift dynamisch auf Deutsch
    const nameMap = {
      cars: 'Autos',
      watches: 'Uhren',
      yachts: 'Yachten',
      properties: 'Immobilien',
      lifestyles: 'Lifestyle'
    };

    // 6) SEO Basic
    res.locals.seo = {
      title: `Alle ${nameMap[entity.route]} Marken – Herando`,
      meta_description: `Alle exklusiven Marken für ${nameMap[entity.route]} jetzt auf Herando.`,
      canonical_url: buildCanonical(req)
    };

    res.render('pages/templates/hersteller-marken', {
      entieties,
      groupedBrands,
      footerColumns,
      user
    });

  } catch (err) {
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



// GET /contact: Seite anzeigen
router.get('/contact', async (req, res, next) => {
  const user = res.locals.user;

  try {
    const layout = await loadLayoutData();

    const { success, error } = req.query;



    // FormData zurückfüllen
    const formData = {
      anrede:       req.query.anrede       || '',
      titel:        req.query.titel        || '',
      first_name:   req.query.first_name   || '',
      last_name:    req.query.last_name    || '',
      ichbin:       req.query.ichbin       || '',
      firma:        req.query.firma        || '',
      kundennummer: req.query.kundennummer || '',
      email:        req.query.email        || '',
      telefon:      req.query.telefon      || '',
      nachricht:    req.query.nachricht    || '',
      datenschutz:  req.query.datenschutz  || ''
    };

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
    const {
      anrede, titel, first_name, last_name,
      ichbin, firma, kundennummer,
      email, telefon, nachricht, datenschutz,
      website,           // Honeypot
      captcha_answer     // Eingabe vom User
    } = req.body;

    const errors = [];

    // Honeypot
    if (website && website.trim() !== "") {
      console.log("❌ Spam-Verdacht (Honeypot ausgefüllt):", website);
      errors.push("Spam erkannt (Honeypot).");
    }

    // Pflichtfelder prüfen
    if (!first_name)  errors.push("Bitte Vorname ausfüllen.");
    if (!last_name)   errors.push("Bitte Nachname ausfüllen.");
    if (!email)       errors.push("Bitte E-Mail-Adresse ausfüllen.");
    if (!telefon)     errors.push("Bitte Telefon ausfüllen.");
    if (datenschutz !== "on") errors.push("Bitte Datenschutz akzeptieren.");

    // Captcha prüfen
    console.log("👉 captcha_answer (vom User):", captcha_answer);
    console.log("👉 captchaExpected (in Session):", req.session.captchaExpected);

    const expected = req.session.captchaExpected;
    if (parseInt(captcha_answer, 10) !== expected) {
      console.log("❌ Captcha Prüfung fehlgeschlagen!");
      errors.push("Die Sicherheitsfrage wurde falsch beantwortet.");
    } else {
      console.log("✅ Captcha erfolgreich gelöst!");
    }

    // Session zurücksetzen
    req.session.captchaExpected = null;

    if (errors.length) {
      console.log("❌ Fehlerliste:", errors);
      const params = new URLSearchParams({
        error: errors.join("\n"),
        ...req.body
      }).toString();
      return res.redirect("/contact?" + params);
    }

    try {
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
          email, telefon, nachricht||""
        ]
      );

      console.log("✅ Kontaktformular erfolgreich gespeichert:", email);

      const params = new URLSearchParams({
        success: "Deine Nachricht wurde erfolgreich abgeschickt!"
      }).toString();
      res.redirect("/contact?" + params);
    } catch (err) {
      console.error("❌ DB Fehler beim Speichern:", err);
      next(err);
    }
  }
);


// --------------------------------------
//  Slug-Funktion (GLOBAL & FEHLERSICHER!)
// --------------------------------------
function makeSlug(user) {
  if (!user) return "";

  const base =
    user.company && user.company.trim() !== ""
      ? user.company
      : `${user.firstname || ""} ${user.lastname || ""}`;

  return slugify(base, { lower: true, strict: true }).trim();
}

router.get('/seller/:sellerSlug', async (req, res, next) => {
  const user = res.locals.user;
  const sellerSlug = req.params.sellerSlug.toLowerCase();

  try {
    // 1️⃣ Händler laden
    const [sellerRows] = await db.query(`
      SELECT id, firstname, lastname, company, street, housenumber,
             postcode, city, country_id, logo
      FROM users
      WHERE confirmed = 1 AND blacklist = 0
    `);

    let sellerUser = null;
    for (const u of sellerRows) {
      if (makeSlug(u) === sellerSlug) {
        sellerUser = u;
        break;
      }
    }

    if (!sellerUser) {
      return res.status(404).send('Händler nicht gefunden');
    }

    const sellerId = sellerUser.id;
    console.log('SELLER ID:', sellerId);

    // 2️⃣ Entitäten
    const [entities] = await db.query(`
      SELECT id, name, route, table_name
      FROM ententies
      ORDER BY id
    `);

    // 3️⃣ Aktive Entitäten
    const activeEntities = [];
    for (const ent of entities) {
      const table = db.escapeId(ent.table_name);
      const [[row]] = await db.query(`
        SELECT COUNT(*) AS count
        FROM ${table}
        WHERE user_id = ? AND status = 3 AND visible = 1
      `, [sellerId]);

      if (row.count > 0) activeEntities.push(ent.route);
    }

    // 4️⃣ Land
    const [[country]] = await db.query(
      `SELECT de FROM countries WHERE id = ?`,
      [sellerUser.country_id]
    );

    // 4.1️⃣ LOGO (KORREKT: DB → Filesystem)
    let sellerLogo = null;
    let logoExists = false;

    if (sellerUser.logo) {
      const logoFsPath = path.resolve(
        '/media/herando/images/users',
        String(sellerId),
        sellerUser.logo
      );

      console.log('🔍 CHECK LOGO FILE:', logoFsPath);

      if (fs.existsSync(logoFsPath)) {
        logoExists = true;
        sellerLogo = `/images/users/${sellerId}/${sellerUser.logo}`;
        console.log('✅ LOGO FOUND:', sellerLogo);
      } else {
        console.log('❌ LOGO FILE NOT FOUND ON DISK');
      }
    } else {
      console.log('❌ NO LOGO SET IN DATABASE');
    }

    // 4.2️⃣ Verkäuferprofil
    const sellerProfile = {
      id: sellerUser.id,
      slug: sellerSlug,
      name: `${sellerUser.firstname} ${sellerUser.lastname}`,
      company: sellerUser.company || null,
      address: [
        sellerUser.street,
        sellerUser.housenumber,
        sellerUser.postcode,
        sellerUser.city,
        country?.de
      ].filter(Boolean).join(', '),
      logo: sellerLogo,
      hasLogo: logoExists
    };

    // 5️⃣ Inserate sammeln
    let allItems = [];

    const possibleFields = {
      cars: ["mileage", "fuel", "cartype", "firstregistration"],
      properties: ["propertytype", "livingarea", "rooms", "propertyshape"],
      yachts: ["length", "beam", "draft", "year", "fuel", "yachttype"],
      watches: ["gender", "movement", "case_material", "watchtype"]
    };

    for (const ent of entities) {
      if (!activeEntities.includes(ent.route)) continue;

      const table = db.escapeId(ent.table_name);
      const fields = possibleFields[ent.route] || [];

      const [columns] = await db.query(`SHOW COLUMNS FROM ${table}`);
      const columnNames = columns.map(c => c.Field);

      const existingFields = fields.filter(f => columnNames.includes(f));
      const extraFields = existingFields.length ? `, ${existingFields.join(', ')}` : '';

      const [rows] = await db.query(`
        SELECT id, name AS title, price, mainpicture, pictures${extraFields}
        FROM ${table}
        WHERE user_id = ? AND status = 3 AND visible = 1
      `, [sellerId]);

      const mapped = rows.map(r => {
        let main = null;

        if (r.mainpicture && typeof r.mainpicture === 'string' && r.mainpicture.trim() !== '') {
          if (r.mainpicture.startsWith('a:')) {
            try {
              const mp = unserialize(r.mainpicture);
              if (mp?.image) main = mp.image;
            } catch {}
          } else {
            main = r.mainpicture.trim();
          }
        }

        if (!main) {
          let raw = {};
          try { raw = unserialize(r.pictures || 'a:0:{}') || {}; } catch {}
          const pics = Object.keys(raw).sort((a, b) => a - b).map(k => raw[k]);
          if (pics.length) {
            const first = pics[0];
            main = typeof first === 'string' ? first : first?.image;
          }
        }

        if (!main) main = 'herando-weblogo.svg';

        const imagePath =
          main.startsWith('http') || main.startsWith('/')
            ? main
            : `/images/${ent.route}/${r.id}/${encodeURIComponent(main)}`;

        return {
          id: r.id,
          route: ent.route,
          title: r.title,
          slug: slugify(r.title || '', { lower: true, strict: true }),
          priceFormatted: r.price
            ? Number(r.price).toLocaleString('de-DE') + ' €'
            : 'Preis auf Anfrage',
          image: imagePath,
          ...Object.fromEntries(existingFields.map(f => [f, r[f] ?? null]))
        };
      });

      allItems.push(...mapped);
    }

    // 6️⃣ Pagination
    const perPage = parseInt(req.query.perPage, 10) || 32;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const total = allItems.length;
    const pages = Math.ceil(total / perPage);
    const pagedItems = allItems.slice((page - 1) * perPage, page * perPage);

    // 7️⃣ SEO
    const urlPath = normalizePathUrl(req.path);
    const [[seoRow]] = await db.query(`
      SELECT title, description AS meta_description, robots,
             og_title, og_description, og_image, twitter_card,
             jsonld AS structured_data_json
      FROM seo_meta
      WHERE path_pattern = ?
      LIMIT 1
    `, [urlPath]);

    const seo = {
      title: seoRow?.title || 'Herando – Luxus-Autos, Yachten, Immobilien & Uhren',
      meta_description: seoRow?.meta_description || '',
      robots: seoRow?.robots || 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoRow?.og_title || null,
      og_description: seoRow?.og_description || null,
      og_image: seoRow?.og_image || null,
      twitter_card: seoRow?.twitter_card || 'summary_large_image',
      structured_data_json: seoRow?.structured_data_json || null,
      hreflang_json: null
    };

    res.locals.seo = seo;

    // 8️⃣ Footer
    const [cols] = await db.query(
      `SELECT id,title,sort_order FROM footer_columns ORDER BY sort_order,title`
    );
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

    // 9️⃣ Render
    res.render('pages/templates/seller-list', {
      entieties: entities,
      activeEntities,
      sellerProfile,
      allItems: pagedItems,
      pagination: { page, pages, total, perPage },
      user,
      seo,
      footerColumns
    });

  } catch (err) {
    console.error('❌ Fehler in /seller/:sellerSlug:', err);
    next(err);
  }
});




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

  function seoSlug(str) {
    return String(str)
      .toLowerCase()
      .replace(/ä/g,'ae')
      .replace(/ö/g,'oe')
      .replace(/ü/g,'ue')
      .replace(/ß/g,'ss')
      .replace(/\s+/g,'-')
      .replace(/[^\w-]/g,'');
  }

// ================= SEO SLUG → INTERNAL FORWARD (URL bleibt schön) =================
router.get('/:entityRoute/:slug', ensureAdmin, async (req, res, next) => {
  const { entityRoute, slug } = req.params;

  try {
    const [rows] = await db.query(`
      SELECT column_name, option_value, option_label
      FROM attribute_options
      WHERE entitie_route = ?
    `, [entityRoute]);

    for (const r of rows) {
      const dbSlug = seoSlug(r.option_label);

      if (dbSlug === slug) {
        // 1. Parameter intern setzen
        req.query[r.column_name] = String(r.option_value);
        req.query.limit = '32';

        // 2. INTERNER TRICK: Wir ändern den Pfad der Anfrage
        // Von /cars/cabrio -> /cars
        req.url = `/${entityRoute}`; 

        // 3. Jetzt findet Express den Handler router.get('/:entityRoute')
        return next(); 
      }
    }

    next(); // Falls kein Match, geht es zum normalen 404 Handler
  } catch (e) {
    console.error('SEO ROUTE ERROR:', e);
    next();
  }
});











  router.get('/:entityRoute', ensureAdmin, async (req, res, next) => { 
    const user = res.locals.user;

    try {
      const entityRoute = req.params.entityRoute;
      const pageTitle = (() => {
      const q = req.query;

      if (q.model) return q.model;
      if (q.brand) return q.brand;
      if (q.search) return q.search;

      switch (entityRoute) {
        case 'cars':       return 'Premiumautos, Sportwagen & Oldtimer';
        case 'watches':    return 'Premiumuhren';
        case 'properties': return 'Premiumimmobilien';
        case 'yachts':     return 'Boote & Yachten';
        case 'lifestyles': return 'Lifestyle';
        default:           return '';
      }
    })();

      // 1) Kategorien laden
      const [entities] = await db.query(`
        SELECT id, name, route, table_name, description
        FROM ententies
        ORDER BY id
      `);
      const currentEntity = entities.find(e => e.route === entityRoute);
      if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

      const tableName = db.escapeId(currentEntity.table_name);
      const categoryTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles:5 };
      const type = categoryTypeMap[entityRoute] || null;

      // 2) Pagination
      const currentPage = Math.max(1, parseInt(req.query.hp, 10) || 1);
      const limit       = Math.max(1, parseInt(req.query.limit, 10) || 32);
      const offset      = (currentPage - 1) * limit;

      // 3) Eingehende Filter sammeln
      const rawFilters = {
        // Allgemein
        brand:            req.query.brand,
        model:            req.query.model,
        yearMin:          req.query.yearMin,
        yearMax:          req.query.yearMax,
        mileageMin:        req.query.mileageMin,
        mileageMax:       req.query.mileageMax,
        priceMax:         req.query.priceMax,
        paymentType:      req.query.paymentType,
        location:         req.query.location,
        country:          req.query.country,
        registrationYearMin: req.query.registrationYearMin,
        registrationYearMax: req.query.registrationYearMax,
        onlyOldtimer:     req.query.onlyOldtimer,
        //registrationYear: req.query.registrationYear,
        nextHuYear:       req.query.nextHuYear,
        cartype:          req.query.cartype,
        fuel:             req.query.fuel,
        gearbox:          req.query.gearbox,
        drivetrain:       req.query.drivetrain,
        interior:         req.query.interior,
        airbags:          req.query.airbags,
        climatisation:    req.query.climatisation,
        interior_color:   req.query.interior_color,
        horsepower_min:    req.query.horsepower_min,
        horsepower_max:    req.query.horsepower_max,
        power_min:         req.query.power_min,
        power_max:         req.query.power_max,
        consumptionMin:    req.query.consumptionMin,
        consumptionMax:    req.query.consumptionMax,
        capacity_min:      req.query.capacity_min,
        capacity_max:      req.query.capacity_max,
        emission_class:    req.query.emission_class,
        pollution_class:   req.query.pollution_class,
        environmental_badge: req.query.environmental_badge,
        body_color:         req.query.body_color,
        trailer_coupling_type: req.query.trailer_coupling_type,
        parking_aid:        req.query.parking_aid,
        cruise_control:     req.query.cruise_control,




        // Yachts
          yachttype: req.query.yachttype,

          hull_material: req.query.hull_material,
          flag: req.query.flag,

          // ----------------- Maße -----------------
          length_min: req.query.length_min,
          length_max: req.query.length_max,

          width_min: req.query.width_min,
          width_max: req.query.width_max,

          draft_min: req.query.draft_min,
          draft_max: req.query.draft_max,

          // Kabinen UI (du mappst das später auf "berths" oder lässt es separat)
          cabins_min: req.query.cabins_min,
          cabins_max: req.query.cabins_max,

          // ----------------- Motor/Power/Hours -----------------
          engines_count_min: req.query.engines_count_min,
          engines_count_max: req.query.engines_count_max,

          power_kw_min: req.query.power_kw_min,
          power_kw_max: req.query.power_kw_max,

          hours_run_min: req.query.hours_run_min,
          hours_run_max: req.query.hours_run_max,

          // ----------------- Tank/Verdrängung -----------------
          tank_volume_min: req.query.tank_volume_min,
          tank_volume_max: req.query.tank_volume_max,

          water_tankage_min: req.query.water_tankage_min,
          water_tankage_max: req.query.water_tankage_max,

          displacement_min: req.query.displacement_min,
          displacement_max: req.query.displacement_max,

          // ----------------- Speed (km/h + kn) -----------------
          cruising_speed_min: req.query.cruising_speed_min,
          cruising_speed_max: req.query.cruising_speed_max,

          cruising_speed_kn_min: req.query.cruising_speed_kn_min,
          cruising_speed_kn_max: req.query.cruising_speed_kn_max,

          max_speed_min: req.query.max_speed_min,
          max_speed_max: req.query.max_speed_max,

          max_speed_kn_min: req.query.max_speed_kn_min,
          max_speed_kn_max: req.query.max_speed_kn_max,

          // deine alte Logik hatte oft nur *Max oder nur Min
          lengthMax: req.query.lengthMax ?? req.query.length_max,
          widthMax:  req.query.widthMax  ?? req.query.width_max,
          draftMax:  req.query.draftMax  ?? req.query.draft_max,

          cabinsMin: req.query.cabinsMin ?? req.query.cabins_min,

          // engines_count (alte Logik: engines_count IN(...) oder engines_count_min/max)
          engines_count: req.query.engines_count, // falls du später wieder ein Select machst

          // power_kw / hours_run / tank_volume / displacement / cruise_speed / max_speed
          // (alte Keys → wir füttern sie mit den *_min Werten als Default)
          power_kw:     req.query.power_kw     ?? req.query.power_kw_min,
          hours_run:    req.query.hours_run    ?? req.query.hours_run_min,
          tank_volume:  req.query.tank_volume  ?? req.query.tank_volume_min,
          displacement: req.query.displacement ?? req.query.displacement_min,

          // alte "cruise_speed" hieß bei dir teils cruise_speed (ohne ing)
          cruise_speed: req.query.cruise_speed ?? req.query.cruising_speed_min,
          max_speed:    req.query.max_speed    ?? req.query.max_speed_min,


        // Properties
        propertytype:      req.query.propertytype,
        investmenttype:   req.query.investmenttype,
        priceMin:         req.query.priceMin,
        priceMax:         req.query.priceMax,
        areaMin:          req.query.areaMin,
        areaMax:          req.query.areaMax,
        landareaMin:      req.query.landareaMin,
        landareaMax:      req.query.landareaMax,
        roomsMin:         req.query.roomsMin,
        bathroomsMin:     req.query.bathroomsMin,
        heating:          req.query.heating,
        quality:             req.query.quality,
        stage:               req.query.stage,
        energysource:        req.query.energysource,
        energypass:          req.query.energypass,
        energypass_type:     req.query.energypass_type,
        energypass_valueMin: req.query.energypass_valueMin,
        energypass_valueMax: req.query.energypass_valueMax,
        floorsMin:           req.query.floorsMin,
        floorsMax:           req.query.floorsMax,
        roomsMax:            req.query.roomsMax,
        bathroomsMax:        req.query.bathroomsMax,
        yearMin:             req.query.yearMin,
        yearMax:             req.query.yearMax,


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
          clasp_material:   req.query.clasp_material,   // ❗ fehlt
          clasp_type:       req.query.clasp_type,       // ❗ fehlt
          crystal:          req.query.crystal,          // ❗ fehlt

          // ❗ DIE ZWEI GANZ WICHTIGEN (weil varchar + range)
          diameterMin:      req.query.diameterMin,     // ❗ fehlt
          diameterMax:      req.query.diameterMax,     // ❗ fehlt
          heightMin:        req.query.heightMin,       // ❗ fehlt
          heightMax:        req.query.heightMax,       // ❗ fehlt

          reference:        req.query.reference,

          // Watches (Multi von UI)
          functions:        req.query.functions,
          delivery:         req.query.delivery,


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
      const prevQuery = new URLSearchParams(
        (req.headers.referer || '').split('?')[1] || ''
      );

      const sel = Object.entries(rawFilters).reduce((acc, [key, value]) => {
        let arr;

        // Wenn leer → versuche Wert aus vorheriger URL zu holen
        if (value === '' || value === undefined) {
          const prevVal = prevQuery.get(key);
          if (prevVal) arr = [prevVal];
          else arr = [];
        }
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
            colors           = opts('color');
            interiors        = opts('interior');
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

          const rates = global.exchangeRates.rates || {};
          const userCurrency = req.session.currency || 'EUR';
          const userRate = rates[userCurrency] || 1;

          const rateCaseSQL = Object.entries(rates)
            .map(([cur, rate]) => `WHEN '${cur}' THEN ${rate}`)
            .join(' ');

          // 5) WHERE-Builder
          const where = [
            't.status = 3',
            't.visible = 1',
            't.pictures IS NOT NULL'
          ];

          // ⛔ Properties: Investment-Inserate standardmäßig ausblenden
          if (entityRoute === 'properties' && !sel.investmenttype.length) {
            where.push('(t.investmenttype IS NULL OR t.investmenttype = 0)');
          }


          const params = [];
          const add = (cond, ...vals) => { where.push(cond); params.push(...vals); };
          const addIN = (col, arr) => {
            if (Array.isArray(arr) && arr.length) {

              // Wenn schon t. dabei ist → nicht nochmal davor setzen
              const finalCol = col.startsWith('t.') ? col : `t.${col}`;

              add(`${finalCol} IN (${arr.map(()=>'?').join(',')})`, ...arr);
            }
          };
          const baseWhere  = where.join(' AND ');
          const baseParams = [...params];

          // Allgemein
          // brand
          if (['cars','watches','yachts','lifestyles'].includes(entityRoute)) {
            if (sel.brand.length) addIN('brand_id', sel.brand);
          }

          // model
          if (['cars','watches','lifestyles'].includes(entityRoute)) {
            if (sel.model.length) addIN('model_id', sel.model);
          }


          if (sel.yearMin.length)    add('year >= ?', Math.min(...sel.yearMin));
          if (sel.yearMax.length)    add('year <= ?', Math.max(...sel.yearMax));
          if (sel.mileageMin.length) add('mileage >= ?', Math.max(...sel.mileageMin));
          if (sel.mileageMax.length) add('mileage <= ?', Math.min(...sel.mileageMax));
          if (sel.priceMin.length) {
            add(`
              t.price >= (? * (
                (CASE t.currency ${rateCaseSQL} ELSE 1 END) / ?
              ))
            `,
            Math.max(...sel.priceMin),
            userRate
            );
          }

          if (sel.priceMax.length) {
            add(`
              t.price <= (? * (
                (CASE t.currency ${rateCaseSQL} ELSE 1 END) / ?
              ))
            `,
            Math.min(...sel.priceMax),
            userRate
            );
          }


          if (sel.paymentType.length) addIN('payment_type', sel.paymentType);

          if (sel.location.length) {
            const term = `%${String(sel.location[0]).trim()}%`;
            add(`(t.city LIKE ? OR t.country_id IN (SELECT id FROM countries WHERE de LIKE ?))`, term, term);
          }


          if (sel.interior.length)       addIN('interior', sel.interior);
          if (sel.airbags.length)        addIN('airbags', sel.airbags);
          if (sel.climatisation.length)  addIN('climatisation', sel.climatisation);
          if (sel.interior_color.length) addIN('interior_color', sel.interior_color);

          if (sel.country.length)          addIN('country_id', sel.country);
          //if (sel.registrationYear.length) addIN('firstregistration', sel.registrationYear);
          // Erstzulassung von – bis
          if (sel.registrationYearMin.length)
            add('firstregistration >= ?', Math.min(...sel.registrationYearMin));

          if (sel.registrationYearMax.length)
            add('firstregistration <= ?', Math.max(...sel.registrationYearMax));
          if (sel.onlyOldtimer && sel.onlyOldtimer.length) {
            where.push(`
              (
                (firstregistration IS NOT NULL AND firstregistration <= YEAR(CURDATE()) - 20)
                OR
                (year IS NOT NULL AND year <= YEAR(CURDATE()) - 20)
              )
            `);
          };

          if (sel.nextHuYear.length)       addIN('maininspection', sel.nextHuYear);

          if (currentEntity.route === 'cars') {
            if (sel.cartype.length)          addIN('cartype', sel.cartype);
            if (sel.fuel.length)             addIN('fuel', sel.fuel);
            if (sel.gearbox.length)          addIN('gearbox', sel.gearbox);
            if (sel.drivetrain.length)       addIN('drivetrain', sel.drivetrain);

            if (sel.emission_class.length)      addIN('emission_class', sel.emission_class);
            if (sel.pollution_class.length)     addIN('pollution_class', sel.pollution_class);
            if (sel.environmental_badge.length) addIN('environmental_badge', sel.environmental_badge);
          }

          // === PS / Leistung ===
          if (currentEntity.route === 'cars') {
            if (sel.horsepower_min.length) add('horsepower >= ?', Math.min(...sel.horsepower_min));
            if (sel.horsepower_max.length) add('horsepower <= ?', Math.max(...sel.horsepower_max));

            // === Leistung (kW) ===
            if (sel.power_min.length) add('power >= ?', Math.min(...sel.power_min));
            if (sel.power_max.length) add('power <= ?', Math.max(...sel.power_max));

            // === Verbrauch (kombiniert) ===
            if (sel.consumptionMin.length) add('consumption_combined >= ?', Math.min(...sel.consumptionMin));
            if (sel.consumptionMax.length) add('consumption_combined <= ?', Math.max(...sel.consumptionMax));

            // === Hubraum (cm³) ===
            if (sel.capacity_min.length) add('capacity >= ?', Math.min(...sel.capacity_min));
          }
          if (sel.capacity_max.length) add('capacity <= ?', Math.max(...sel.capacity_max));

          // 🎨 Karosseriefarbe = echtes Feld
          if (sel.body_color?.length) {
            addIN('color', sel.body_color);
          }

          // 🚚 Anhängerkupplung = 1 Bool Feld
          if (sel.trailer_coupling_type?.length) {
            where.push('t.trailer_coupling = 1');
          }

          // 🅿️ Einparkhilfe = mehrere Bool Felder
          if (sel.parking_aid?.length) {
            sel.parking_aid.forEach(v => {
              if (v == 1) where.push('t.parking_rear = 1');
              if (v == 2) where.push('t.parking_front = 1');
              if (v == 3) where.push('t.parking_camera = 1');
              if (v == 5) where.push('t.parking_self = 1');
            });
          }

          // 🛣 Tempomat
          if (sel.cruise_control?.length) {
            if (sel.cruise_control.includes('1'))
              where.push('t.cruise_control = 1');

            if (sel.cruise_control.includes('2'))
              where.push('t.adaptive_cruise_control = 1');
          }





          // Autos: Extras
          if (sel.extras && sel.extras.length) {
            sel.extras.forEach(f => {
              if (CAR_EXTRA_NUMERIC_PRESENT?.has?.(f)) where.push(`${db.escapeId(f)} > 0`);
              else where.push(`${db.escapeId(f)} = 1`);
            });
          }

          // Yachts
      // ================= YACHTS FILTER (MANUELL, passend zu deiner DB) =================
      if (entityRoute === 'yachts') {

        // Bootstyp
        if (sel.yachttype?.length) addIN('t.yachttype', sel.yachttype);

        // Länge / Breite / Tiefgang (DB: length, beam, draft)
        if (sel.length_min?.length) add('t.length >= ?', Math.max(...sel.length_min));
        if (sel.length_max?.length) add('t.length <= ?', Math.min(...sel.length_max));

        if (sel.width_min?.length)  add('t.beam >= ?',   Math.max(...sel.width_min));
        if (sel.width_max?.length)  add('t.beam <= ?',   Math.min(...sel.width_max));

        if (sel.draft_min?.length)  add('t.draft >= ?',  Math.max(...sel.draft_min));
        if (sel.draft_max?.length)  add('t.draft <= ?',  Math.min(...sel.draft_max));

        // Kabinen -> bei dir NICHT vorhanden, sinnvoller Ersatz: berths (Kojen)
        if (sel.cabins_min?.length) add('t.berths >= ?', Math.max(...sel.cabins_min));
        if (sel.cabins_max?.length) add('t.berths <= ?', Math.min(...sel.cabins_max));

        // Optional: berths direkt (falls du Inputs dafür hast)
        if (sel.berths_min?.length) add('t.berths >= ?', Math.max(...sel.berths_min));
        if (sel.berths_max?.length) add('t.berths <= ?', Math.min(...sel.berths_max));

        // Motorenanzahl (DB: engines)
        if (sel.engines_count_min?.length) add('t.engines >= ?', Math.max(...sel.engines_count_min));
        if (sel.engines_count_max?.length) add('t.engines <= ?', Math.min(...sel.engines_count_max));

        // Leistung (DB: power)  -> dein UI nennt es power_kw_*
        if (sel.power_kw_min?.length) add('t.power >= ?', Math.max(...sel.power_kw_min));
        if (sel.power_kw_max?.length) add('t.power <= ?', Math.min(...sel.power_kw_max));

        // Betriebsstunden (DB: engine_hours) -> dein UI nennt es hours_run_*
        if (sel.hours_run_min?.length) add('t.engine_hours >= ?', Math.max(...sel.hours_run_min));
        if (sel.hours_run_max?.length) add('t.engine_hours <= ?', Math.min(...sel.hours_run_max));

        // Tank Diesel (DB: fuel_tankage) -> dein UI nennt es tank_volume_*
        if (sel.tank_volume_min?.length) add('t.fuel_tankage >= ?', Math.max(...sel.tank_volume_min));
        if (sel.tank_volume_max?.length) add('t.fuel_tankage <= ?', Math.min(...sel.tank_volume_max));

        // Tank Wasser (DB: water_tankage) -> du hast Inputs dafür im EJS
        if (sel.water_tankage_min?.length) add('t.water_tankage >= ?', Math.max(...sel.water_tankage_min));
        if (sel.water_tankage_max?.length) add('t.water_tankage <= ?', Math.min(...sel.water_tankage_max));

        // Verdrängung
        if (sel.displacement_min?.length) add('t.displacement >= ?', Math.max(...sel.displacement_min));
        if (sel.displacement_max?.length) add('t.displacement <= ?', Math.min(...sel.displacement_max));

        // Cruising Speed km/h (DB: cruising_speed)
        if (sel.cruising_speed_min?.length) add('t.cruising_speed >= ?', Math.max(...sel.cruising_speed_min));
        if (sel.cruising_speed_max?.length) add('t.cruising_speed <= ?', Math.min(...sel.cruising_speed_max));

        // Cruising Speed kn (DB: cruising_speed_kn)
        if (sel.cruising_speed_kn_min?.length) add('t.cruising_speed_kn >= ?', Math.max(...sel.cruising_speed_kn_min));
        if (sel.cruising_speed_kn_max?.length) add('t.cruising_speed_kn <= ?', Math.min(...sel.cruising_speed_kn_max));

        // Max Speed km/h (DB: max_speed)
        if (sel.max_speed_min?.length) add('t.max_speed >= ?', Math.max(...sel.max_speed_min));
        if (sel.max_speed_max?.length) add('t.max_speed <= ?', Math.min(...sel.max_speed_max));

        // Max Speed kn (DB: max_speed_kn)
        if (sel.max_speed_kn_min?.length) add('t.max_speed_kn >= ?', Math.max(...sel.max_speed_kn_min));
        if (sel.max_speed_kn_max?.length) add('t.max_speed_kn <= ?', Math.min(...sel.max_speed_kn_max));

        // Rumpfmaterial (DB: hull) -> dein UI nennt es hull_material
        if (sel.hull_material?.length) addIN('t.hull', sel.hull_material);

        // Flag/Land: bei dir gibt es kein "flag" Feld -> nutze country_id
        if (sel.flag?.length) addIN('t.country_id', sel.flag);

        // Optional (DB vorhanden): crew
        if (sel.crew_min?.length) add('t.crew >= ?', Math.max(...sel.crew_min));
        if (sel.crew_max?.length) add('t.crew <= ?', Math.min(...sel.crew_max));
      }


      if (sel.q && sel.q.length) {
        const term = `%${String(sel.q[0]).trim()}%`;
        add(`(t.name LIKE ? OR u.company LIKE ?)`, term, term);
      }

      if (sel.lifestyleType.length)        addIN('brand_id', sel.lifestyleType);
      if (sel.lifestyleSubcategory.length) addIN('model_id', sel.lifestyleSubcategory);

          // Properties
      if (entityRoute === 'properties') {

        // 🟢 NEU — Investmenttypen
        if (sel.investmenttype.length)
          addIN('investmenttype', sel.investmenttype);

        if (sel.propertytype.length)
          addIN('propertytype', sel.propertytype);

        if (sel.country.length)
          addIN('t.country_id', sel.country);

        if (sel.areaMin.length)
          add('livingarea >= ?', Math.max(...sel.areaMin));

        if (sel.roomsMin.length)
          add('bedrooms >= ?', Math.max(...sel.roomsMin));

        if (sel.bathroomsMin.length)
          add('bathrooms >= ?', Math.max(...sel.bathroomsMin));

        if (sel.heating.length)
          addIN('heating', sel.heating);

        if (sel.areaMax?.length)
        add('livingarea <= ?', Math.min(...sel.areaMax));

          if (sel.landareaMin?.length)
          add('landarea >= ?', Math.max(...sel.landareaMin));

        if (sel.landareaMax?.length)
          add('landarea <= ?', Math.min(...sel.landareaMax));

        if (sel.quality.length)
        addIN('quality', sel.quality);

      if (sel.stage.length)
        addIN('stage', sel.stage);

      if (sel.energysource.length)
        addIN('energysource', sel.energysource);

      if (sel.energypass.length)
        addIN('energypass', sel.energypass);

      if (sel.energypass_type.length)
        addIN('energypass_type', sel.energypass_type);

      if (sel.energypass_valueMin.length)
        add('energypass_value >= ?', Math.max(...sel.energypass_valueMin));

      if (sel.energypass_valueMax.length)
        add('energypass_value <= ?', Math.min(...sel.energypass_valueMax));

      if (sel.floorsMin.length)
        add('floors >= ?', Math.max(...sel.floorsMin));

      if (sel.floorsMax.length)
        add('floors <= ?', Math.min(...sel.floorsMax));

      if (sel.roomsMax.length)
        add('bedrooms <= ?', Math.min(...sel.roomsMax));

      if (sel.bathroomsMax.length)
        add('bathrooms <= ?', Math.min(...sel.bathroomsMax));

      if (sel.yearMin.length)
        add('year >= ?', Math.min(...sel.yearMin));

      if (sel.yearMax.length)
        add('year <= ?', Math.min(...sel.yearMax));

      }


          // WATCHES – Lookup-Felder + Features + Functions + Delivery
      if (entityRoute === 'watches') {

        addIN('watchtype', sel.watchtype);
        addIN('gender', sel.gender);
        addIN('case_material', sel.case_material);
        addIN('strap_material', sel.strap_material);
        addIN('strap_color', sel.strap_color);
        addIN('bezel_material', sel.bezel_material);
        addIN('dial_shape', sel.dial_shape);
        addIN('dial_numbers', sel.dial_numbers);
        addIN('dial_color', sel.dial_color);
        addIN('waterproof', sel.waterproof);
        addIN('movement', sel.movement);
        addIN('clasp_material', sel.clasp_material);
        addIN('clasp_type', sel.clasp_type);
        addIN('crystal', sel.crystal);

        if (sel.reference?.length) {
          const term = `%${sel.reference[0]}%`;
          add(`t.reference LIKE ?`, term);
        }

        // Diameter / Height (varchar fix)
        if (sel.diameterMin?.length)
          add('CAST(t.diameter AS DECIMAL(10,2)) >= ?', Math.min(...sel.diameterMin));
        if (sel.diameterMax?.length)
          add('CAST(t.diameter AS DECIMAL(10,2)) <= ?', Math.max(...sel.diameterMax));

        if (sel.heightMin?.length)
          add('CAST(t.height AS DECIMAL(10,2)) >= ?', Math.min(...sel.heightMin));
        if (sel.heightMax?.length)
          add('CAST(t.height AS DECIMAL(10,2)) <= ?', Math.max(...sel.heightMax));

        // Features
        Object.keys(sel).forEach(k => {
          if (k.startsWith('feature_') && sel[k].length) {
            where.push(`${db.escapeId(k)} = 1`);
          }
        });

        // Functions
        function toWatchFunctionCol(v) {
          return 'function_' + v.replace(/_/g, '');
        }

        if (sel.functions?.length) {
          sel.functions.forEach(v => {
            const col = toWatchFunctionCol(v);
            where.push(`${db.escapeId(col)} = 1`);
          });
        }

        // Delivery
        const WATCH_DELIVERY_MAP = {
          papers: 'authenticity_papers',
          box: 'authenticity_box',
          warranty: 'authenticity_warranty'
        };

        sel.delivery = sel.delivery.map(v => String(v).toLowerCase());

        if (sel.delivery?.length) {
          sel.delivery.forEach(v => {
            const col = WATCH_DELIVERY_MAP[v];
            if (col) where.push(`${db.escapeId(col)} = 1`);
          });
        }
      }


          // Marken/Modelle-Listen (nur Grundbedingungen → baseWhere)
      if (['cars','watches','yachts'].includes(entityRoute)) {

        // ⭐ Standard: Cars/Watches/Yachts – Marken laden
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

        // ⭐ Standard: Modelle laden (nur wenn brand gesetzt)
      if (sel.brand.length || sel.model.length) {
        const brandIds = sel.brand.length
          ? sel.brand
          : await db.query(
              `SELECT DISTINCT brand_id FROM models WHERE id IN (${sel.model.map(()=>'?').join(',')})`,
              sel.model
            ).then(r => r[0].map(x => x.brand_id));

        const ph = brandIds.map(()=>'?').join(',');
        [models] = await db.query(`
          SELECT id, name
          FROM models
          WHERE brand_id IN (${ph})
          ORDER BY name
        `, brandIds);

      } else {
        models = [];
      }



      }

      /* ⭐⭐⭐ LIFESTYLES – NEUER BLOCK ⭐⭐⭐ */
      else if (entityRoute === 'lifestyles') {

        // 1) Lifestyle Kategorien (= brands)
        const [lifestyleBrands] = await db.query(`
          SELECT id, name
          FROM brands
          WHERE type = 5
          ORDER BY name
        `);

        brands = lifestyleBrands;
        lifestyleTypes = lifestyleBrands;   // 🟢 wichtig: an Filter weitergeben!

        // 2) Lifestyle Unterkategorien (= models)
        if (sel.lifestyleType && sel.lifestyleType.length > 0) {
          const ph = sel.lifestyleType.map(() => '?').join(',');

          const [subcategories] = await db.query(`
            SELECT id, name, brand_id AS parentId
            FROM models
            WHERE brand_id IN (${ph})
            ORDER BY name
          `, sel.lifestyleType);

          models = subcategories;
          lifestyleSubcategories = subcategories; // 🟢 wichtig

        } else {
          models = [];
          lifestyleSubcategories = [];
        }
      }


          const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

      // 6) Count
      const [[{ totalCount }]] = await db.query(
        `SELECT COUNT(*) AS totalCount
        FROM ${tableName} AS t
        JOIN users AS u ON u.id = t.user_id
        ${whereClause}`,
        params
      );

      const totalPages = Math.ceil(totalCount / limit);

      // 7) Items (Basisdaten)
      let rows;
      // 🟢 Wenn Entity "cars", dann Extra-Felder explizit hinzufügen
      if (currentEntity.route === 'cars') {
        ENTITY_EXTRA_FIELDS[currentEntity.route] = [
          'cartype',
          'fuel',
          'gearbox',
          'drivetrain',
          'color',
          'mileage',
          'year',
          'firstregistration',
          'firstregistration_month'
        ];
      }
      // 🔎 Filter- & Sort-Flags
      const hasFilter = Object.values(sel).some(v => Array.isArray(v) && v.length);
      const hasSort   = typeof req.query.sort === 'string' && req.query.sort !== '';

      // 🧠 Sortierung global definieren
      let orderBy = 'published DESC'; // 🟢 Standard: Neueste zuerst

      switch (req.query.sort) {
        case 'price_asc':
          orderBy = `(t.price * (${userRate} / (CASE t.currency ${rateCaseSQL} ELSE 1 END))) ASC`;
          break;
        case 'price_desc':
          orderBy = `(t.price * (${userRate} / (CASE t.currency ${rateCaseSQL} ELSE 1 END))) DESC`;
          break;
        case 'year_asc':
          orderBy = 'year ASC';
          break;
        case 'year_desc':
          orderBy = 'year DESC';
          break;
        case 'popularity':
          orderBy = 'visits DESC';
          break;
        case 'random':
          orderBy = 'RAND()';
          break;
        default:
          orderBy = 'published DESC';
      }

      console.log('🧠 Sortier-Query aktiv:', orderBy);

      // 🟢 Ads NUR wenn keine Filter UND keine Sortierung
      const allowAds = !hasFilter && !hasSort && currentPage === 1;

      if (allowAds) {
        console.log('➡️ UNION-Mode (Ads erlaubt)');
        console.log('currentEntity.id:', currentEntity.id, 'route:', currentEntity.route);

        const extraCols = (ENTITY_EXTRA_FIELDS[currentEntity.route] || [])
          .map(f => `t.${db.escapeId(f)}`)
          .join(', ');

        const selectCols = `
          t.id,
          t.pictures,
          t.mainpicture,
          t.price,
          t.name,
          t.currency,
          t.published,
          ctry.code AS country_code
          ${extraCols ? ', ' + extraCols : ''}
        `;

// ================== 🔎 ADS DEBUG ==================
console.log('================ ADS DEBUG ================');
console.log('Route:', currentEntity.route);
console.log('Entity ID:', currentEntity.id);
console.log('allowAds:', allowAds);
console.log('baseWhere:', baseWhere);
console.log('baseParams:', baseParams);

// Welche Autos sind laut DB gerade Werbung?
const [debugAds] = await db.query(`
  SELECT
    ca.advert_id,
    t.name,
    t.published,
    ca.start_date,
    ca.end_date
  FROM catalog_ads ca
  JOIN ${tableName} t ON t.id = ca.advert_id
  WHERE ca.entitie_id = ?
    AND CURDATE() BETWEEN ca.start_date AND ca.end_date
`, [currentEntity.id]);

console.log('🟥 catalog_ads Treffer:', debugAds.length);
debugAds.forEach(a => {
  console.log('   AD:', a.advert_id, '|', a.name, '| published:', a.published);
});
console.log('===========================================\n');


let finalRows = [];

// ================= ADS =================
if (allowAds) {
  const [ads] = await db.query(`
    SELECT ${selectCols}, 1 AS is_ad
    FROM catalog_ads ca
    JOIN ${tableName} t      ON t.id = ca.advert_id
    LEFT JOIN users u        ON u.id = t.user_id
    LEFT JOIN countries ctry ON ctry.id = u.country_id
    WHERE ca.entitie_id = ?
      AND CURDATE() BETWEEN ca.start_date AND ca.end_date
      AND ${baseWhere}
    ORDER BY ca.start_date DESC
  `, [currentEntity.id, ...baseParams]);

  finalRows.push(...ads);
}

// ================= NORMALE DATENSÄTZE =================
const [normalRows] = await db.query(`
  SELECT ${selectCols}, 0 AS is_ad
  FROM ${tableName} t
  LEFT JOIN users u        ON u.id = t.user_id
  LEFT JOIN countries ctry ON ctry.id = u.country_id
  WHERE ${where.join(' AND ')}
    AND t.id NOT IN (
      SELECT advert_id
      FROM catalog_ads
      WHERE entitie_id = ?
        AND CURDATE() BETWEEN start_date AND end_date
    )
  ORDER BY ${orderBy}
  LIMIT ? OFFSET ?
`, [...params, currentEntity.id, limit, offset]);

finalRows.push(...normalRows);

// 👉 GANZ WICHTIG
rows = finalRows;


// ================= DEBUG =================
console.log('🟩 FINAL LISTE:');
rows.slice(0, 10).forEach(r =>
  console.log('ROW:', r.id, '|', r.name, '| is_ad:', r.is_ad, '| published:', r.published)
);


// ================== 🔎 RESULT DEBUG ==================
console.log('================ RESULT DEBUG ================');
rows.slice(0, 10).forEach(r => {
  console.log(
    'ROW:',
    r.id,
    '|',
    r.name,
    '| is_ad:',
    r.is_ad,
    '| published:',
    r.published
  );
});
console.log('================================================\n');


    } else {
      console.log('➡️ Normal-Mode (keine Ads, sortiert/gefiltert)');

      const extraCols = (ENTITY_EXTRA_FIELDS[currentEntity.route] || [])
        .map(f => `t.${db.escapeId(f)}`)
        .join(', ');

      const selectCols = `
        t.id,
        t.pictures,
        t.mainpicture,
        t.price,
        t.name,
        t.currency,
        t.published,
        u.company,
        ctry.code AS country_code
        ${extraCols ? ', ' + extraCols : ''}
      `;

      const [normalRows] = await db.query(
        `
        SELECT ${selectCols}
        FROM ${tableName} AS t
        LEFT JOIN countries ctry ON ctry.id = t.country_id
        JOIN users u ON u.id = t.user_id
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
        `,
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
      let main = null;

      if (r.mainpicture && typeof r.mainpicture === "string" && r.mainpicture.trim() !== "") {
        if (r.mainpicture.startsWith("a:")) {
          try {
            const mp = unserialize(r.mainpicture);
            if (mp && typeof mp === "object" && mp.image) {
              main = mp.image;
            }
          } catch (e) {}
        } else {
          main = r.mainpicture.trim();
        }
      }

      if (!main) {
        let raw = {};
        try { raw = unserialize(r.pictures || 'a:0:{}') || {}; } catch {}
        const pics = Object.keys(raw).sort((a,b)=>a-b).map(k=>raw[k]);
        if (pics.length > 0) {
          const first = pics[0];
          main = typeof first === "string" ? first : first?.image;
        }
      }

      if (!main) main = "/assets/herando-weblogo.png";

      const filename = fallbackResolveImageFilename(entityRoute, r.id, main);
      const price = r.price != null ? Number(r.price) : null;

      // ⭐ HIER WICHTIG: Extra-Felder anhängen
      const extra = {};
      (ENTITY_EXTRA_FIELDS[currentEntity.route] || []).forEach(f => {
        extra[f] = r[f] ?? null;
      });

      return {
        id: r.id,
        title: titleMap.get(r.id) || r.name,   // 🟦 Übersetzung oder fallback
        mainPic: filename,
        countryCode: r.country_code || null,   // ✅ HIER
        imageUrl: `/images/${entityRoute}/${r.id}/${encodeURIComponent(filename)}`,
        price,
        priceFormatted: price ? res.locals.convertPrice(price) : null,
        ...extra   // ⭐ WICHTIG!
      };
    });


    // =====================================================
    // 🔹 SLIDER – PRIORISIERT (Typ → Model → Brand → Random)
    // =====================================================

    // Extra-Felder für Slider
    const sliderExtraColsArr = (ENTITY_EXTRA_FIELDS[currentEntity.route] || []);
    const sliderExtraColsSQL = sliderExtraColsArr.map(f => `t.${db.escapeId(f)}`).join(', ');

    const sliderSelectCols = `
      t.id,
      t.name AS title,
      t.pictures,
      t.mainpicture,
      t.price,
      t.currency
      ${sliderExtraColsSQL ? ', ' + sliderExtraColsSQL : ''}
    `;

    // -----------------------------------------------------
    // Helper: Chunk laden (ohne Duplikate)
    // -----------------------------------------------------
    async function loadSliderChunk(whereSql, params, limit, usedIds) {
      const usedSql = usedIds.length
        ? `AND t.id NOT IN (${usedIds.map(() => '?').join(',')})`
        : '';

      const [rows] = await db.query(
        `
        SELECT ${sliderSelectCols}
        FROM ${db.escapeId(currentEntity.table_name)} t
        WHERE ${whereSql}
        ${usedSql}
        ORDER BY t.published DESC
        LIMIT ?
        `,
        [...params, ...usedIds, limit]
      );

      return rows;
    }

  // -----------------------------------------------------
  // Basisbedingungen (immer gleich)
  // -----------------------------------------------------
    const BASE_SLIDER_WHERE = `
      t.status = 3
      AND t.visible = 1
      AND t.pictures IS NOT NULL
    `;

    // -----------------------------------------------------
    // Prioritäts-Stufen aufbauen
    // -----------------------------------------------------
    const sliderSteps = [];

    // 1️⃣ TYP (höchste Priorität)
    if (currentEntity.route === 'cars' && sel.cartype?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.cartype IN (${sel.cartype.map(() => '?').join(',')})`,
        params: sel.cartype
      });
    }

    // 0️⃣ CARS – OLDTIMER (höchste Priorität)
    if (
      currentEntity.route === 'cars' &&
      sel.onlyOldtimer?.length &&
      String(sel.onlyOldtimer[0]) === '1'
    ) {
      sliderSteps.unshift({
        where: `
          ${BASE_SLIDER_WHERE}
          AND (
            (t.firstregistration IS NOT NULL AND t.firstregistration <= YEAR(CURDATE()) - 20)
            OR
            (t.year IS NOT NULL AND t.year <= YEAR(CURDATE()) - 20)
          )
        `,
        params: []
      });
    }


    if (currentEntity.route === 'watches' && sel.watchtype?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.watchtype IN (${sel.watchtype.map(() => '?').join(',')})`,
        params: sel.watchtype
      });
    }

    if (currentEntity.route === 'yachts' && sel.yachttype?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.yachttype IN (${sel.yachttype.map(() => '?').join(',')})`,
        params: sel.yachttype
      });
    }

    // 2️⃣ MODEL (nur bei Entities die model_id haben)
    if (['cars','watches','lifestyles'].includes(currentEntity.route) && sel.model?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.model_id IN (${sel.model.map(() => '?').join(',')})`,
        params: sel.model
      });
    }


    // 3️⃣ BRAND (nur wo brand_id existiert)
    if (['cars','watches','yachts','lifestyles'].includes(currentEntity.route) && sel.brand?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.brand_id IN (${sel.brand.map(() => '?').join(',')})`,
        params: sel.brand
      });
    }


    // 1️⃣ PROPERTIES – PROPERTYTYPE (höchste Priorität)
    if (currentEntity.route === 'properties' && sel.propertytype?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.propertytype IN (${sel.propertytype.map(() => '?').join(',')})`,
        params: sel.propertytype
      });
    }

    // 1️⃣b PROPERTIES – INVESTMENTTYPE (zweite Priorität, optional)
    if (currentEntity.route === 'properties' && sel.investmenttype?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.investmenttype IN (${sel.investmenttype.map(() => '?').join(',')})`,
        params: sel.investmenttype
      });
    }

    // 1️⃣c PROPERTIES – LAND (optional, nur wenn gesetzt)
    if (currentEntity.route === 'properties' && sel.country?.length) {
      sliderSteps.push({
        where: `${BASE_SLIDER_WHERE} AND t.country_id IN (${sel.country.map(() => '?').join(',')})`,
        params: sel.country
      });
    }


    // -----------------------------------------------------
    // Slider befüllen (immer bis 12)
    // -----------------------------------------------------
    const SLIDER_LIMIT = 12;
    let sliderRows = [];
    let usedIds = [];

    for (const step of sliderSteps) {
      if (sliderRows.length >= SLIDER_LIMIT) break;

      const need = SLIDER_LIMIT - sliderRows.length;
      const chunk = await loadSliderChunk(step.where, step.params, need, usedIds);

      for (const r of chunk) {
        sliderRows.push(r);
        usedIds.push(r.id);
      }
    }

    // Prüfen ob Slider-Filter aktiv ist
    const hasSliderFilter =
      sel.brand?.length ||
      sel.model?.length ||
      sel.cartype?.length ||
      sel.watchtype?.length ||
      sel.yachttype?.length ||
      sel.propertytype?.length ||
      sel.investmenttype?.length ||
      sel.country?.length;

    console.log('🟡 SLIDER DEBUG ----------------------');
    console.log('Route:', currentEntity.route);
    console.log('Query:', req.query);
    console.log('hasSliderFilter:', hasSliderFilter);
    console.log('sliderRows BEFORE rule:', sliderRows.length);

    // ❗ FALL 1: Filter aktiv UND ≤5 → KEIN Slider, KEIN Fallback
    if (hasSliderFilter && sliderRows.length <= 5) {
      console.log('🔴 Slider deaktiviert (≤5 bei aktivem Filter)');
      sliderRows = [];
    }

    // ❗ FALL 2: KEIN Filter UND nichts gefunden → Fallback
if (!hasSliderFilter) {
  console.log('🟥 SLIDER AUS catalog_ads !!!');

  const [adsSlider] = await db.query(`
    SELECT ${sliderSelectCols}
    FROM advert_inserat ca
    JOIN ${db.escapeId(currentEntity.table_name)} t
      ON t.id = ca.advert_id
    WHERE ca.entitie_id = ?
      AND CURDATE() BETWEEN ca.start_date AND ca.end_date
      AND ${BASE_SLIDER_WHERE}
    ORDER BY ca.start_date DESC
    LIMIT ?
  `, [currentEntity.id, SLIDER_LIMIT]);

  sliderRows = adsSlider;
}


    console.log('🟢 sliderRows FINAL:', sliderRows.length);
    console.log('🟡 SLIDER DEBUG END ------------------');



    // -----------------------------------------------------
    // Titel-Übersetzungen laden
    // -----------------------------------------------------
    const sliderIdList = sliderRows.map(r => r.id);
    const sliderTitleMap = new Map();

    if (sliderIdList.length) {
      const idPh   = sliderIdList.map(() => '?').join(',');
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

    // -----------------------------------------------------
    // Slider mappen (Bilder + Preis + Extras)
    // -----------------------------------------------------
    const slider = sliderRows.map(r => {
      const raw  = tryUnserialize(r.pictures || 'a:0:{}') || [];
      const pics = Array.isArray(raw) ? raw : Object.values(raw);

      let filename = null;

      // Hauptbild bevorzugen
      if (r.mainpicture) {
        try {
          const mp = tryUnserialize(r.mainpicture);
          if (mp?.image) filename = mp.image;
        } catch {
          if (typeof r.mainpicture === 'string' && r.mainpicture !== 'Array') {
            filename = r.mainpicture;
          }
        }
      }

      // Fallback: erstes Bild
      if (!filename && pics.length) {
        const first = pics[0];
        filename = typeof first === 'string' ? first : first?.image;
      }

      if (!filename) filename = 'herando-weblogo.png';

      const price = r.price != null ? Number(r.price) : null;

      return {
        id: r.id,
        title: sliderTitleMap.get(r.id) || r.title,
        mainPic: filename,
        imageUrl: `/images/${currentEntity.route}/${r.id}/${encodeURIComponent(filename)}`,
        price,
        priceFormatted: price
          ? res.locals.convertPrice(price, res.locals.currency)
          : null,
        ...Object.fromEntries(sliderExtraColsArr.map(f => [f, r[f] ?? null]))
      };
    });

    console.log(`🟣 Slider geladen: ${slider.length}/12 | Route: ${currentEntity.route}`);





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

        console.log('PAGE DEBUG:', {
      page: req.query.page,
      hp: req.query.hp,
      currentPage,
      totalPages
    });


        // 9) Render
        res.render('pages/templates/category', {
          pageTitle, 
          entieties: entities,
          currentEntity,
          req,
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
            query: req.query,
          sort: req.query.sort || 'newest' ,
          user,
          currency: res.locals.currency, 
        });

      } catch (err) {
        console.error('🚨 Fehler in GET /:entityRoute:', err);
        next(err);
      }
    });  
  
  router.get('/api/lifestyle-subcategories', async (req, res) => {
    const brandId = req.query.brand_id;
    if (!brandId) return res.json([]);

    const [rows] = await db.query(
      `SELECT id, name FROM models WHERE brand_id = ? ORDER BY name`,
      [brandId]
    );

    res.json(rows);
  });

  router.get('/api/lifestyle/subcategories', async (req, res) => {
    try {
      const typeId = req.query.typeId;
      if (!typeId) return res.json([]);

      const [rows] = await db.query(`
        SELECT id, name 
        FROM models
        WHERE brand_id = ?
        ORDER BY name
      `, [typeId]);

      res.json(rows);
    } catch (err) {
      console.error("API SUB ERROR:", err);
      res.status(500).json([]);
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
    brand: q.brand, model: q.model, yearMin: q.yearMin, yearMax: q.yearMax,
    priceMin: q.priceMin, priceMax: q.priceMax,
    location: q.location, country: q.country,
    cartype: q.cartype, fuel: q.fuel, gearbox: q.gearbox, drivetrain: q.drivetrain,

    // cars
    registrationYearMin: q.registrationYearMin,
    registrationYearMax: q.registrationYearMax,
    body_color: q.body_color,
    parking_aid: q.parking_aid,
    cruise_control: q.cruise_control,
    trailer_coupling_type: q.trailer_coupling_type,
    //registrationYear: q.registrationYear,
    nextHuYear: q.nextHuYear,
    paymentType: q.paymentType,
    mileageMin: q.mileageMin, 
    mileageMax: q.mileageMax,
    horsepower_min: q.horsepower_min,
    horsepower_max: q.horsepower_max,
    capacity_min: q.capacity_min,
    capacity_max: q.capacity_max,
    consumptionMin: q.consumptionMin,
    consumptionMax: q.consumptionMax,
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
    watchtype: q.watchtype,
    gender: q.gender,
    case_material: q.case_material,
    strap_material: q.strap_material,
    strap_color: q.strap_color,
    bezel_material: q.bezel_material,
    dial_shape: q.dial_shape,
    dial_numbers: q.dial_numbers,
    dial_color: q.dial_color,        // ❗
    waterproof: q.waterproof,
    movement: q.movement,
    clasp_material: q.clasp_material, // ❗
    clasp_type: q.clasp_type,         // ❗
    crystal: q.crystal,               // ❗
    reference: q.reference,           // ❗
    diameterMin: q.diameterMin,       // ❗
    diameterMax: q.diameterMax,       // ❗
    heightMin: q.heightMin,           // ❗
    heightMax: q.heightMax,           // ❗
    functions: q.functions,
    delivery: q.delivery,


    // yachts
// yachts (vollständig)
yachttype: q.yachttype,

used: q.used,                   // DB: used (falls du es als Filter hast)
shape: q.shape,                 // DB: shape (falls du es als Filter hast)

fuel: q.fuel,                   // DB: fuel (falls Filter vorhanden)
hull_material: q.hull_material, // UI/Filtername -> DB-mapping über yc()

// Abmessungen
width_min: q.width_min,
width_max: q.width_max,
length_min: q.length_min,
length_max: q.length_max,
draft_min: q.draft_min,
draft_max: q.draft_max,

// Kabinen / Layout
cabins_min: q.cabins_min,
cabins_max: q.cabins_max,

berths_min: q.berths_min,       // DB: berths
berths_max: q.berths_max,

crew_min: q.crew_min,           // DB: crew
crew_max: q.crew_max,

// Motoren
engines_count_min: q.engines_count_min, // -> DB: engines
engines_count_max: q.engines_count_max,
engines_count: q.engines_count,         // falls du auch Select dafür hast (optional)

// Leistung
power_kw_min: q.power_kw_min,           // -> DB: power
power_kw_max: q.power_kw_max,
horsepower_min: q.horsepower_min,       // DB: horsepower (falls du es als Filter hast)
horsepower_max: q.horsepower_max,

// Betriebsstunden
hours_run_min: q.hours_run_min,         // -> DB: engine_hours
hours_run_max: q.hours_run_max,

// Geschwindigkeit (km/h + kn)
cruising_speed_min: q.cruising_speed_min,       // -> DB: cruising_speed
cruising_speed_max: q.cruising_speed_max,
cruising_speed_kn_min: q.cruising_speed_kn_min, // DB: cruising_speed_kn
cruising_speed_kn_max: q.cruising_speed_kn_max,

max_speed_min: q.max_speed_min,               // DB: max_speed
max_speed_max: q.max_speed_max,
max_speed_kn_min: q.max_speed_kn_min,         // DB: max_speed_kn
max_speed_kn_max: q.max_speed_kn_max,

// Tank (diesel/wasser)
tank_volume_min: q.tank_volume_min,      // -> DB: fuel_tankage (über yc)
tank_volume_max: q.tank_volume_max,

water_tankage_min: q.water_tankage_min,  // DB: water_tankage
water_tankage_max: q.water_tankage_max,

// Verdrängung
displacement_min: q.displacement_min,    // DB: displacement
displacement_max: q.displacement_max,



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

      // 💎 Besonderheiten (feature_*)
      Object.keys(q).forEach(k => {
        if (k.startsWith('feature_')) {
          acc[k] = toArray(q[k]).map(v => (v == '1' || v === 1 ? 1 : 0));
        }
      });

    return acc;
  }, {});
}

// -------------------------------------------------------------
// 2) buildWhere
// -------------------------------------------------------------
function buildWhere(entityRoute, tableName, sel, userCurrency) {
  const where = ['status=3', 'visible=1', 'pictures IS NOT NULL'];
  const params = [];
  const add = (cond, ...vals) => { where.push(cond); params.push(...vals); };

  // ===== LIVE CURRENCY CONVERSION (Frankfurter) =====
  const rates = global.exchangeRates?.rates || {};
  const userRate = rates[userCurrency] || 1;


  const rateCaseSQL = Object.entries(rates)
    .map(([cur, rate]) => `WHEN '${cur}' THEN ${rate}`)
    .join(' ');


  // --- General ---
  if (Array.isArray(sel.brand) && sel.brand.length)
    add(`brand_id IN (${IN(sel.brand)})`, ...sel.brand);

  if (Array.isArray(sel.model) && sel.model.length)
    add(`model_id IN (${IN(sel.model)})`, ...sel.model);

  if (Array.isArray(sel.yearMin) && sel.yearMin.length)
    add(`year >= ?`, Math.min(...sel.yearMin));

  if (Array.isArray(sel.yearMax) && sel.yearMax.length)
    add(`year <= ?`, Math.max(...sel.yearMax));

  if (Array.isArray(sel.priceMin) && sel.priceMin.length) {
    add(`
      (price * (? / (CASE currency ${rateCaseSQL} ELSE 1 END))) >= ?
    `,
    userRate,
    Math.max(...sel.priceMin)
    );
  }

  if (Array.isArray(sel.priceMax) && sel.priceMax.length) {
    add(`
      (price * (? / (CASE currency ${rateCaseSQL} ELSE 1 END))) <= ?
    `,
    userRate,
    Math.min(...sel.priceMax)
    );
  }


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

    if (Array.isArray(sel.mileageMin) && sel.mileageMin.length)
  add(`mileage >= ?`, Math.max(...sel.mileageMin));

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

    // Erstzulassung von – bis
    if (Array.isArray(sel.registrationYearMin) && sel.registrationYearMin.length)
      add(`firstregistration >= ?`, Math.min(...sel.registrationYearMin));

    if (Array.isArray(sel.registrationYearMax) && sel.registrationYearMax.length)
      add(`firstregistration <= ?`, Math.max(...sel.registrationYearMax));

/*
    if (Array.isArray(sel.registrationYear) && sel.registrationYear.length)
      add(`firstregistration IN (${IN(sel.registrationYear)})`, ...sel.registrationYear);*/

    if (Array.isArray(sel.nextHuYear) && sel.nextHuYear.length)
      add(`maininspection IN (${IN(sel.nextHuYear)})`, ...sel.nextHuYear);

    const unit = (Array.isArray(sel.powerUnit) && sel.powerUnit[0] ? sel.powerUnit[0] : 'PS').toString().toLowerCase();
      // === Leistung (PS / kW) ===
      if (Array.isArray(sel.horsepower_min) && sel.horsepower_min.length)
        add(`horsepower >= ?`, Math.min(...sel.horsepower_min));

      if (Array.isArray(sel.horsepower_max) && sel.horsepower_max.length)
        add(`horsepower <= ?`, Math.min(...sel.horsepower_max));

      if (Array.isArray(sel.power_min) && sel.power_min.length)
        add(`power >= ?`, Math.min(...sel.power_min));

      if (Array.isArray(sel.power_max) && sel.power_max.length)
        add(`power <= ?`, Math.min(...sel.power_max));

      // === Hubraum (cm³) ===
      if (Array.isArray(sel.capacity_min) && sel.capacity_min.length)
        add(`capacity >= ?`, Math.min(...sel.capacity_min));

      if (Array.isArray(sel.capacity_max) && sel.capacity_max.length)
        add(`capacity <= ?`, Math.min(...sel.capacity_max));

      // === Verbrauch (kombiniert) ===
      if (Array.isArray(sel.consumptionMin) && sel.consumptionMin.length)
        add(`consumption_combined >= ?`, Math.min(...sel.consumptionMin));

      if (Array.isArray(sel.consumptionMax) && sel.consumptionMax.length)
        add(`consumption_combined <= ?`, Math.min(...sel.consumptionMax));


    if (Array.isArray(sel.pollution_class) && sel.pollution_class.length)
      add(`pollution_class IN (${IN(sel.pollution_class)})`, ...sel.pollution_class);

    if (Array.isArray(sel.emission_class) && sel.emission_class.length)
      add(`emission_class IN (${IN(sel.emission_class)})`, ...sel.emission_class);

    if (
      Array.isArray(sel.particulate_filter) && 
      sel.particulate_filter.length && 
      sel.particulate_filter[0] === 1
    ) {
      try {
        if (typeof db !== 'undefined' && db.escapeId) {
          console.log('⚠️ Warnung: Spalte particulate_filter nicht vorhanden – Filter übersprungen');
        }
      } catch (e) {
        console.log('⚠️ particulate_filter übersprungen:', e.message);
      }
    }


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

    // ===== UI → echte DB Spalten Mapping =====

    // body_color (UI) = color (DB)
    if (Array.isArray(sel.body_color) && sel.body_color.length)
      add(`color IN (${IN(sel.body_color)})`, ...sel.body_color);

    // parking_aid (UI) = 4 echte Spalten
    if (Array.isArray(sel.parking_aid) && sel.parking_aid.length && sel.parking_aid[0] == 1) {
      where.push(`(parking_front = 1 OR parking_rear = 1 OR parking_camera = 1 OR parking_self = 1)`);
    }

    // cruise_control (UI) = 2 echte Spalten
    if (Array.isArray(sel.cruise_control) && sel.cruise_control.length && sel.cruise_control[0] == 1) {
      where.push(`(cruise_control = 1 OR adaptive_cruise_control = 1)`);
    }

    // trailer_coupling_type (UI) = trailer_coupling (DB)
    if (Array.isArray(sel.trailer_coupling_type) && sel.trailer_coupling_type.length && sel.trailer_coupling_type[0] == 1) {
      where.push(`trailer_coupling = 1`);
    }


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

if (entityRoute === 'watches') {
  const inC = (k) =>
    Array.isArray(sel[k]) && sel[k].length
      ? add(`${k} IN (${IN(sel[k])})`, ...sel[k])
      : null;

  [
    'watchtype',
    'gender',
    'case_material',
    'strap_material',
    'strap_color',
    'bezel_material',
    'dial_shape',
    'dial_numbers',
    'dial_color',      // ❗ fehlt
    'waterproof',
    'movement',
    'clasp_material',  // ❗ fehlt
    'clasp_type',      // ❗ fehlt
    'crystal'          // ❗ fehlt
  ].forEach(inC);

  // Referenz (LIKE)
  if (Array.isArray(sel.reference) && sel.reference.length) {
    add(`reference LIKE ?`, `%${sel.reference[0]}%`);
  }

  // Durchmesser (varchar → CAST)
  if (Array.isArray(sel.diameterMin) && sel.diameterMin.length)
    add(`CAST(diameter AS DECIMAL(10,2)) >= ?`, Math.min(...sel.diameterMin));

  if (Array.isArray(sel.diameterMax) && sel.diameterMax.length)
    add(`CAST(diameter AS DECIMAL(10,2)) <= ?`, Math.max(...sel.diameterMax));

  // Höhe (varchar → CAST)
  if (Array.isArray(sel.heightMin) && sel.heightMin.length)
    add(`CAST(height AS DECIMAL(10,2)) >= ?`, Math.min(...sel.heightMin));

  if (Array.isArray(sel.heightMax) && sel.heightMax.length)
    add(`CAST(height AS DECIMAL(10,2)) <= ?`, Math.max(...sel.heightMax));

  // Baujahr
  if (Array.isArray(sel.yearMin) && sel.yearMin.length)
    add(`year >= ?`, Math.min(...sel.yearMin));

  if (Array.isArray(sel.yearMax) && sel.yearMax.length)
    add(`year <= ?`, Math.max(...sel.yearMax));

  // Functions
  if (Array.isArray(sel.functions) && sel.functions.length) {
    const sub = sel.functions.map(f => `function_${f} = 1`);
    where.push(`(${sub.join(' OR ')})`);
  }

// Delivery (Lieferumfang)
    if (Array.isArray(sel.delivery) && sel.delivery.length) {
      const map = {
        papers: 'authenticity_papers',
        box: 'authenticity_box',
        warranty: 'authenticity_warranty'
      };

      const sub = [];

      for (const d of sel.delivery) {
        const key = String(d).replace('authenticity_', '').toLowerCase().trim();
        const col = map[key];
        if (col) sub.push(`${db.escapeId(col)} = 1`);
      }

      if (sub.length) where.push(`(${sub.join(' OR ')})`);
    }


  // feature_*
Object.keys(WATCH_BOOLEAN_LABELS).forEach(col => {
  if (Array.isArray(sel[col]) && sel[col][0] == 1) {
    where.push(`${db.escapeId(col)} = 1`);
  }
});

}






  // --- Yachts ---
    if (entityRoute === 'yachts') {

      const col = (key) => db.escapeId(yc(key));

      const min = (key, column) => {
        if (Array.isArray(sel[key]) && sel[key].length)
          add(`${column} >= ?`, Math.min(...sel[key]));
      };

      const max = (key, column) => {
        if (Array.isArray(sel[key]) && sel[key].length)
          add(`${column} <= ?`, Math.max(...sel[key]));
      };

      const inList = (key) => {
        const c = yc(key);
        if (c && Array.isArray(sel[key]) && sel[key].length)
          add(`${db.escapeId(c)} IN (${IN(sel[key])})`, ...sel[key]);
      };

      // ===== Basis =====
      inList('yachttype');

      // ===== Motoren =====
      min('engines_count_min', col('engines_count'));
      max('engines_count_max', col('engines_count'));

      // ===== Leistung =====
      min('power_kw_min', col('power_kw'));
      max('power_kw_max', col('power_kw'));

      // ===== Betriebsstunden =====
      min('hours_run_min', col('hours_run'));
      max('hours_run_max', col('hours_run'));

      // ===== Geschwindigkeit km/h =====
      min('cruising_speed_min', col('cruise_speed'));
      max('cruising_speed_max', col('cruise_speed'));

      min('max_speed_min', col('max_speed'));
      max('max_speed_max', col('max_speed'));

      // ===== Geschwindigkeit kn =====
      min('cruising_speed_kn_min', 'cruising_speed_kn');
      max('cruising_speed_kn_max', 'cruising_speed_kn');

      min('max_speed_kn_min', 'max_speed_kn');
      max('max_speed_kn_max', 'max_speed_kn');

      // ===== Tank & Verdrängung =====
      min('tank_volume_min', col('tank_volume'));
      max('tank_volume_max', col('tank_volume'));

      min('water_tankage_min', 'water_tankage');
      max('water_tankage_max', 'water_tankage');

      min('displacement_min', col('displacement'));
      max('displacement_max', col('displacement'));

      // ===== Abmessungen =====
      min('width_min', 'beam');
      max('width_max', 'beam');

      min('length_min', 'length');
      max('length_max', 'length');

      min('draft_min', 'draft');
      max('draft_max', 'draft');

      // ===== Kabinen =====
      min('cabins_min', 'berths');
      max('cabins_max', 'berths');

      // ===== Material & Flagge =====
      inList('hull_material');

      if (Array.isArray(sel.country) && sel.country.length)
        add(`country_id IN (${IN(sel.country)})`, ...sel.country);
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

    if (Array.isArray(sel.stage) && sel.stage.length)
      add(`stage IN (${IN(sel.stage)})`, ...sel.stage);

  }
console.log('KM FILTER:', sel.mileageMin, sel.mileageMax);

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
    ORDER BY 
      ao.sort_order,
      CAST(ao.option_value AS UNSIGNED),
      ao.option_value,
      name COLLATE utf8mb4_german2_ci ASC`,
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
      claspMaterials=[], claspTypes=[], dialColors=[],
      yachtTypes=[], prices=[], boatTypes=[], categories=[], tankVolumes=[], crewCounts=[], displacements=[], berths=[],
      enginesCount=[], powerKw=[], hoursRun=[], cruiseSpeed=[], maxSpeed=[], hullMaterials=[], beamWidths=[], lengths=[],
      drafts=[], cabins=[], flags=[],
      cartypes=[], fuels=[], gearboxes=[], drivetrains=[], transmissions=[], colors=[], interiors=[],
      emissionClasses=[], pollutionClasses=[], badges=[], airbags=[], climatisations=[],
      propertyTypes=[], heatingTypes=[], plotSizes=[], livingAreas=[], floors=[], rooms=[], bathrooms=[],
      investmentTypes=[], qualities=[], propertyShapes=[], energySources=[], energyPasses=[], energyPassTypes=[],
      lifestyleTypes=[], lifestyleSubcategories=[], features=[], stages=[];

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
    claspMaterials = opts('clasp_material');
    claspTypes     = opts('clasp_type');
    dialColors     = opts('dial_color');

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
    stages            = opts('stage');

    // optionale „bereichs“-Listen (wenn du sie in attribute_options pflegst)
    plotSizes         = opts('plot_size');
    livingAreas       = opts('living_area');
    floors            = opts('floors');
    rooms             = opts('rooms');
    bathrooms         = opts('bathrooms');
  }

if (entityRoute === 'lifestyles') {
  const [lt] = await db.query(`
    SELECT id, name
    FROM brands
    WHERE type = 5
    ORDER BY name
  `);
  lifestyleTypes = lt;

  if (lt.length) {
    const ids = lt.map(b => b.id);
    const ph  = ids.map(() => '?').join(',');
    const [subs] = await db.query(`
      SELECT id, name, brand_id AS parentId
      FROM models
      WHERE brand_id IN (${ph})
      ORDER BY name
    `, ids);

    lifestyleSubcategories = subs;
  }
}



  return {
    // common
    brands, models, years, countries, registrationYears, nextHuYears,
    // watches
    watchTypes, genders, caseMaterials, strapMaterials, strapColors, bezelMaterials, dialShapes, dialNumbers, waterproofs, movements, functions, deliveries, features, claspMaterials, claspTypes, dialColors,
    // cars
    cartypes, fuels, gearboxes, drivetrains, transmissions, colors, interiors, airbags, climatisations, emissionClasses, pollutionClasses, badges,
    // yachts
    yachtTypes, prices, boatTypes, categories, tankVolumes, crewCounts, displacements, berths,
    enginesCount, powerKw, hoursRun, cruiseSpeed, maxSpeed, hullMaterials, beamWidths, lengths, drafts, cabins, flags,
    // properties
    propertyTypes, investmentTypes, heating: heatingTypes, plotSize: plotSizes, livingArea: livingAreas,
    floors, rooms, bathrooms, qualities, propertyShapes, energySources, energyPasses, energyPassTypes, stages,
    // lifestyles
    lifestyleTypes, lifestyleSubcategories,
    // extras (falls global vorhanden)
    extras: (typeof CAR_EXTRAS !== 'undefined' ? CAR_EXTRAS : [])
  };
}

// ================= ROUTES ==============================

router.get('/:entityRoute/filters', ensureAdmin, async (req, res, next) => {
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
    const pageTitle = (() => {
      const q = req.query;

      if (q.model) return q.model;
      if (q.brand) return q.brand;
      if (q.search) return q.search;

      switch (entityRoute) {
        case 'cars':       return 'Premiumautos, Sportwagen & Oldtimer';
        case 'watches':    return 'Premiumuhren';
        case 'properties': return 'Premiumimmobilien';
        case 'yachts':     return 'Boote & Yachten';
        case 'lifestyles': return 'Lifestyle';
        default:           return '';
      }
    })();


    const [entities] = await db.query(`
      SELECT id, name, route, table_name, description
      FROM ententies
      ORDER BY id
    `);
    const currentEntity = entities.find(e => e.route === entityRoute);
    if (!currentEntity) return res.status(404).send('Kategorie nicht gefunden');

    const tableName = db.escapeId(currentEntity.table_name);
    const categoryTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles:5 };
    const type = categoryTypeMap[entityRoute] || null;

    const baseWhere  = 'status=3 AND visible=1 AND pictures IS NOT NULL';
    const baseParams = [];

    // 👉 Hilfsfunktion für Arrays
    const normalizeFilter = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value.map(String);
      return [String(value)];
    };

    // Alle Filter in Arrays umwandeln (wie in Haupt-Route)
    const selectedFilters = {};
    for (const key in req.query) {
      selectedFilters[key] = normalizeFilter(req.query[key]);
    }

    // Extras speziell filtern
    if (Array.isArray(selectedFilters.extras)) {
      selectedFilters.extras = selectedFilters.extras.filter(v =>
        (CAR_EXTRAS || []).some(e => String(e.field) === String(v))
      );
    }


    // 👉 Debug-Ausgabe
    console.log("DEBUG sel vor buildWhere:", JSON.stringify(selectedFilters, null, 2));

    // sel an buildWhere übergeben
    const sel = { ...selectedFilters };
    const { where: finalWhere, params: finalParams } =   buildWhere(entityRoute, tableName, sel, req.session.currency);

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
      req,
      currentEntity,
      filters,
      selectedFilters,
      footerColumns,
      user,
      activeLang, 
      pageTitle,
    });
  } catch (err) {
    console.error('🚨 Fehler in GET /:entityRoute/filters:', err);
    next(err);
  }
});

// GENERISCHER COUNT (für alle Entities)
router.get('/api/:entityRoute/count', async (req, res, next) => {
  try {
    const entityRoute = req.params.entityRoute;

    console.log('🟢 [COUNT-API] Aufruf erhalten für:', entityRoute);
    console.log('🟢 Query Params:', req.query);

    // Tabelle ermitteln
    const [rows] = await db.query(
      `SELECT table_name FROM ententies WHERE route=? LIMIT 1`,
      [entityRoute]
    );

    const tableRow = rows && rows[0];
    if (!tableRow || !tableRow.table_name) {
      return res.json({ count: 0 });
    }

    const tableName = db.escapeId(tableRow.table_name);

    // Filter normalisieren
    const sel = normalizeFilters(req.query);

    // WHERE aus buildWhere
    let { where, params } =
      buildWhere(entityRoute, tableName, sel, req.session.currency);

    // 🔥 WICHTIGER FIX – exakt wie in deiner Listing-Route
    if (entityRoute === 'properties' && !sel.investmenttype.length) {
      where += ' AND (investmenttype IS NULL OR investmenttype = 0)';
    }

    console.log('🟢 [COUNT-API] FINAL WHERE:', where);
    console.log('🟢 [COUNT-API] Params:', params);

    // Count ausführen
    const [[{ cnt }]] = await db.query(
      `SELECT COUNT(*) AS cnt FROM ${tableName} WHERE ${where}`,
      params
    );

    console.log('✅ [COUNT-API] Ergebnis count =', cnt);
    res.json({ count: cnt });

  } catch (e) {
    console.error('❌ [COUNT-API] Fehler:', e);
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
router.get('/:entityRoute/:brandSeo', ensureAdmin, async (req, res) => {
  const { entityRoute, brandSeo } = req.params;

  const entityTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles:5 };
  const categoryType  = entityTypeMap[entityRoute];
  if (!categoryType) return res.status(404).send('Kategorie nicht gefunden');

  const [[brand]] = await db.query(`
    SELECT id FROM brands
    WHERE type = ? AND LOWER(seoname) = ?
    LIMIT 1
  `, [categoryType, brandSeo.toLowerCase()]);

  if (!brand) return res.status(404).send('Marke nicht gefunden');

  // Alle bestehenden Filter behalten!
  const params = new URLSearchParams(req.query);
  params.set('brand', brand.id);

  return res.redirect(`/${entityRoute}?${params.toString()}`);
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


router.get('/:entityRoute/:id/:slug', ensureAdmin, async (req, res, next) => {
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

    // 4) Bilder (DB & Ordner)
    let rawPics;
    try { rawPics = unserialize(itemRow.pictures || 'a:0:{}') || []; } catch { rawPics = []; }
    const pics = Array.isArray(rawPics) ? rawPics : Object.values(rawPics);
    console.log('[DETAIL][pics] from DB:', pics.length);

    const folder = path.join(imagesBase, entityRoute, String(id));
    let allImgs = [];
    try {
      allImgs = fs.readdirSync(folder).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
    } catch { allImgs = []; }
    console.log('[DETAIL][pics] from folder:', allImgs.length, folder);

    function getFilteredImages(images) {
      if (!images.length) return [];
      const cleaned = images.filter(filename => {
        const n = path.basename(filename, path.extname(filename));
        return !/-Square\d+$/i.test(n);
      });
      if (!cleaned.length) return [];
      const groups = {};
      cleaned.forEach(filename => {
        const ext = path.extname(filename);
        const n = path.basename(filename, ext);
        let baseName;
        if (/_(?:large|largex2|medium|mediumx2|small|smallx2)$/i.test(n)) {
          const withoutSize = n.replace(/_(large|largex2|medium|mediumx2|small|smallx2)$/i, '');
          const i = withoutSize.lastIndexOf('-');
          baseName = i !== -1 ? withoutSize.substring(0, i) : withoutSize;
        } else {
          const i = n.lastIndexOf('-');
          baseName = i !== -1 ? n.substring(0, i) : n;
        }
        (groups[baseName] ||= []).push(filename);
      });
      const out = [];
      Object.values(groups).forEach(group => {
        if (group.length === 1) { out.push(group[0]); return; }
        const withoutSize = group.filter(f => {
          const n = path.basename(f, path.extname(f));
          return !/_(?:large|largex2|medium|mediumx2|small|smallx2)$/i.test(n);
        });
        if (withoutSize.length) out.push(withoutSize[0]);
        else {
          const x2 = group.find(f => /_largex2\./i.test(f));
          const l  = group.find(f => /_large\./i.test(f) && !/_largex2\./i.test(f));
          out.push(x2 || l || group[0]);
        }
      });
      return out.sort();
    }


    const filteredImages = allImgs.length
      ? getFilteredImages(allImgs)
      : pics.map(pic => typeof pic === 'string' ? pic : (pic.image || 'placeholder.jpg'));
    console.log('[DETAIL][pics] filtered:', filteredImages.length);

    // ⭐ NEUE MASTER-BILDLOGIK ⭐
    const mainFilename = extractMainImage(itemRow.mainpicture, pics);

    // Thumbnails: wenn Ordner-Bilder existieren → diese; sonst fallback
    const thumbnailFilenames = filteredImages.length
      ? filteredImages
      : pics.map(p => (typeof p === "string" ? p : p?.image)).filter(Boolean);

    if (!thumbnailFilenames.length) {
      thumbnailFilenames.push("placeholder.jpg");
    }

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
        ? res.locals.convertPrice(priceNum)
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
    if (item.imageUrl && Array.isArray(item.thumbnailUrls)) {
      const main = item.imageUrl;
      item.thumbnailUrls = [ main, ...item.thumbnailUrls.filter(u => u !== main) ];
    }

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
        priceFormatted: num != null
          ? res.locals.convertPrice(num)
          : '–'
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

let seller = null;
let isPrivateSeller = false;  // ✅ existiert immer

if (itemRow.user_id) {

  // ✅ User laden
  const [[u]] = await db.query(`
    SELECT id, firstname, lastname, company,
           street, housenumber, postcode, city, country_id,
           phone, mobile, email, logo, website, imprint,
           details_phone_hidden, details_email_hidden
    FROM users
    WHERE id = ? AND blacklist = 0 AND confirmed = 1
  `, [itemRow.user_id]);

  // ✅ Pakettyp laden (private / commercial)
  const [[pkg]] = await db.query(`
    SELECT p.registration_type
    FROM selected_packages sp
    JOIN packages p ON p.id = sp.package_id
    WHERE sp.user_id = ?
    ORDER BY sp.end_date DESC
    LIMIT 1
  `, [itemRow.user_id]);

  isPrivateSeller = (pkg?.registration_type === 'private'); // ✅ jetzt safe

  if (u) {
    const [[c2]]  = await db.query('SELECT de FROM countries WHERE id = ?', [u.country_id]);
    const sellerCountry = c2?.de || '–';

    seller = {
      id: u.id,
      slug: makeSlug(u),   // ✅ HINZUFÜGEN
      logo: u.logo,
      company: u.company || null,
      street: isPrivateSeller ? null : u.street,
      housenumber: isPrivateSeller ? null : u.housenumber,
      postcode: u.postcode,
      city: u.city,
      country: sellerCountry,
      website: u.website,
      imprint: u.imprint,
      firstname: u.firstname,
      lastname: u.lastname,
      phone: !u.details_phone_hidden ? (u.phone || u.mobile) : null,
      email: !u.details_email_hidden ? u.email : null
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

// NEW MASTER IMAGE LOGIC
const rpics = safeParsePictures(r.pictures);
const img = extractMainImage(r.mainpicture, rpics);

r.mainpicture = `/images/${r.entity}/${r.id}/${encodeURIComponent(img)}`;
console.log(`➡ Neuer finaler Bildpfad (URL): ${r.mainpicture}`);

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
// =============================================
// 🔧 IMMOBILIEN-ÜBERSETZUNGEN (Backend-Loader)
// =============================================

let propertyMaps = {
  investment: {},
  quality: {},
  properties: {},
  shape: {},
  stage: {},
  heating: {},
  energy: {},
  energy_pass: {},
  energy_pass_type: {}
};

try {
  const [propertyTranslations] = await db.query(`
    SELECT 
      \`key\`,
      COALESCE(NULLIF(${langCol}, ''), NULLIF(en, ''), NULLIF(de, '')) AS text
    FROM ui_translations
    WHERE \`key\` LIKE 'filters.properties.%'
  `);

  propertyMaps = propertyTranslations.reduce((acc, row) => {
    const parts = row.key.split('.'); // filters.properties.<group>.<id>
    if (parts.length < 4) return acc;

    const group = parts[2]; // e.g. investment, quality, heating
    const id = parts[3];    // numeric ID
    if (!acc[group]) acc[group] = {};
    acc[group][id] = row.text;
    return acc;
  }, {
    investment: {},
    quality: {},
    properties: {},
    shape: {},
    stage: {},
    heating: {},
    energy: {},
    energy_pass: {},
    energy_pass_type: {}
  });

  console.log(`[PROPERTIES][i18n] ${propertyTranslations.length} Übersetzungen geladen.`);
} catch (err) {
  console.warn('[PROPERTIES][i18n] Fehler beim Laden der Übersetzungen:', err);
}

// ============================
// ✅ Fallback + Integritätsprüfung
// ============================

// Hilfsfunktion: Prüft, ob Map wirklich gültige Texte enthält
const isValidMap = (obj) =>
  obj &&
  Object.keys(obj).length > 0 &&
  Object.values(obj).some((v) => typeof v === 'string' && v.trim() !== '' && isNaN(v));

// === Investmenttypen ===
const investmentTypeMap = isValidMap(propertyMaps.investment)
  ? Object.fromEntries(
      Object.entries(propertyMaps.investment).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Wohnimmobilien",
      2: "Hotels & Gastronomie",
      3: "Gewerbe",
      4: "Grundstücke",
      5: "Pflegeimmobilien",
      6: "Wohn-/Geschäftshaus"
    };

// === Qualitätsstufen ===
const qualityMap = isValidMap(propertyMaps.quality)
  ? Object.fromEntries(
      Object.entries(propertyMaps.quality).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Einfach",
      2: "Normal",
      3: "Gehoben",
      4: "Luxus",
      5: "Erstbezug"
    };

// === Immobilientypen ===
const propertyTypeFallback = {
  4: "Wohnung",
  5: "Penthouse",
  6: "Villa/Haus",
  8: "Maisonette",
  10: "Finca",
  11: "Privatinsel",
  12: "Schloss/Herrenhaus",
  255: "Sonstige"
};

const propertyTypeMap = Object.fromEntries(
  Object.entries(propertyTypeFallback).map(([k, fallback]) => {
    const dbValue = propertyMaps.properties?.[k];
    return [parseInt(k), dbValue && dbValue.trim() !== "" ? dbValue : fallback];
  })
);


// === Objektzustand / Form ===
const propertyShapeMap = isValidMap(propertyMaps.shape)
  ? Object.fromEntries(
      Object.entries(propertyMaps.shape).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Erstbezug",
      2: "Erstbezug nach Sanierung",
      3: "Wie neu",
      4: "Renoviert",
      5: "Modernisiert",
      6: "Saniert",
      7: "Gepflegt"
    };

// === Bauphase ===
const stageMap = isValidMap(propertyMaps.stage)
  ? Object.fromEntries(
      Object.entries(propertyMaps.stage).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Geplant",
      2: "Im Bau",
      3: "Fertiggestellt"
    };

// === Heizungsarten ===
const heatingMap = isValidMap(propertyMaps.heating)
  ? Object.fromEntries(
      Object.entries(propertyMaps.heating).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Elektroheizung",
      2: "Stoffheizung",
      3: "Zentralheizung",
      4: "Blockheizkraftwerk",
      5: "Elektroheizung",
      6: "Fernwärme",
      7: "Fußbodenheizung",
      8: "Gasheizung",
      9: "Pelletheizung",
      10: "Nachtspeicherheizung",
      11: "Ölheizung",
      12: "Solarheizung",
      13: "Wärmepumpe"
    };

// === Energiequellen ===
const energySourceMap = isValidMap(propertyMaps.energy)
  ? Object.fromEntries(
      Object.entries(propertyMaps.energy).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Holz",
      2: "Öl",
      3: "Gas",
      4: "Strom",
      5: "Solar",
      6: "Erdwärme",
      7: "Alternative"
    };

// === Energieausweis (Verfügbarkeit) ===
const energyPassMap = isValidMap(propertyMaps.energy_pass)
  ? Object.fromEntries(
      Object.entries(propertyMaps.energy_pass).map(([k, v]) => [parseInt(k), v])
    )
  : {
      0: "Nicht verfügbar",
      1: "Verfügbar",
      2: "Nicht notwendig"
    };

// === Energieausweis Typ ===
const energyPassTypeMap = isValidMap(propertyMaps.energy_pass_type)
  ? Object.fromEntries(
      Object.entries(propertyMaps.energy_pass_type).map(([k, v]) => [parseInt(k), v])
    )
  : {
      1: "Verbrauchsausweis",
      2: "Bedarfsausweis"
    };

let yachtMaps = { category: {}, yachttype: {}, hull: {}, shape: {} };

try {
  const [yachtTranslations] = await db.query(`
    SELECT 
      \`key\`,
      COALESCE(NULLIF(${langCol}, ''), NULLIF(en,''), NULLIF(de,'')) AS text
    FROM ui_translations
    WHERE \`key\` LIKE 'filters.yachts.%'
  `);

  yachtMaps = yachtTranslations.reduce((acc, row) => {
    const parts = row.key.split('.');
    if (parts.length < 4) return acc;
    const group = parts[2];  // yachttype / category / hull / shape
    const value = parts[3];
    if (!acc[group]) acc[group] = {};
    acc[group][value] = row.text;
    return acc;
  }, { category: {}, yachttype: {}, hull: {}, shape: {} });

  console.log('[YACHT][i18n] Dynamische Yacht-Übersetzungen geladen:', yachtTranslations.length);
} catch (err) {
  console.warn('[YACHT][i18n] Fehler beim Laden der Übersetzungen:', err);
}

// Fallback: wenn DB leer ist → deutsche Defaultwerte
const categoryMap = yachtMaps.category || {
  1: "Motorschiff",
  2: "Segelboot"
};

const yachtTypeMap = yachtMaps.yachttype || {
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

const hullMap = yachtMaps.hull || {
  1: "GFK",
  2: "Stahl",
  3: "Aluminium",
  4: "Polyester",
  5: "GRP",
  6: "Verbundwerkstoff",
  7: "Holz",
  8: "Kevlar/Carbon"
};

const shapeMap = yachtMaps.shape || {
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

    // 🧹 HTML Entities aus item und recommendedItems bereinigen
function deepDecodeHTML(str) {
  if (!str) return '';
  let decoded = String(str);
  for (let i = 0; i < 3; i++) {
    decoded = decoded
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#160;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\u00a0/g, ' ');
  }
  return decoded.trim();
}

// Anwenden auf item (Details)
item.title = deepDecodeHTML(item.title);
item.description = deepDecodeHTML(item.description);

// Anwenden auf Empfehlungen (falls vorhanden)
if (Array.isArray(recommendedItems)) {
  for (const rec of recommendedItems) {
    rec.title = deepDecodeHTML(rec.title);
  }
}

// Anwenden auf "moreItems" falls vorhanden (mehr vom Verkäufer)
if (Array.isArray(moreItems)) {
  for (const group of moreItems) {
    if (Array.isArray(group.items)) {
      for (const prod of group.items) {
        prod.name = deepDecodeHTML(prod.name);
        prod.subtitle = deepDecodeHTML(prod.subtitle);
      }
    }
  }
}

console.log("===== [SIMILAR] START =====");
console.log("Entity:", currentEntity.route);
console.log("Item ID:", item.id);
console.log("Raw ItemRow brand/model/city/category:", {
  brand_id: itemRow.brand_id,
  model_id: itemRow.model_id,
  city: itemRow.city,
  property_type: itemRow.property_type,
  country_id: itemRow.country_id,
  category: itemRow.category,
  yachttype: itemRow.yachttype,
  user_id: itemRow.user_id
});

let similarItems = [];

try {

  //
  // ==========================
  //  WATCHES
  // ==========================
  //
  if (currentEntity.route === 'watches') {
    console.log("Running SIMILAR query for WATCHES…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, user_id
      FROM watches
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
             (brand_id = ? AND model_id = ?)
          OR (brand_id = ?)
        )
      ORDER BY
        (brand_id = ?) DESC,
        (model_id = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.brand_id, itemRow.model_id,
      itemRow.brand_id,
      itemRow.brand_id, itemRow.model_id
    ]);

    console.log("[SIMILAR][WATCHES] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  CARS
  // ==========================
  //
  else if (currentEntity.route === 'cars') {
    console.log("Running SIMILAR query for CARS…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, user_id
      FROM cars
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
          (brand_id = ? AND model_id = ?)
          OR (brand_id = ?)
        )
      ORDER BY
        (brand_id = ?) DESC,
        (model_id = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.brand_id, itemRow.model_id,
      itemRow.brand_id,
      itemRow.brand_id, itemRow.model_id
    ]);

    console.log("[SIMILAR][CARS] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  PROPERTIES
  // ==========================
  //
  else if (currentEntity.route === 'properties') {
    console.log("Running SIMILAR query for PROPERTIES…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, mainpicture, user_id
      FROM properties
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
          (city = ?)
          OR (country_id = ?)
          OR (propertytype = ?)
        )
      ORDER BY
        (city = ?) DESC,
        (country_id = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.city,
      itemRow.country_id,
      itemRow.propertytype,
      itemRow.city,
      itemRow.country_id
    ]);

    console.log("[SIMILAR][PROPERTIES] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  YACHTS
  // ==========================
  //
  else if (currentEntity.route === 'yachts') {
    console.log("Running SIMILAR query for YACHTS…");

    const [rows] = await db.query(`
      SELECT id, name, price, pictures, user_id
      FROM yachts
      WHERE visible = 1
        AND status = 3
        AND id != ?
        AND user_id != ?
        AND (
          (category = ?)
          OR (yachttype = ?)
        )
      ORDER BY
        (category = ?) DESC,
        (yachttype = ?) DESC,
        RAND()
      LIMIT 20
    `, [
      item.id,
      itemRow.user_id,
      itemRow.category,
      itemRow.yachttype,
      itemRow.category,
      itemRow.yachttype
    ]);

    console.log("[SIMILAR][YACHTS] rows:", rows.length);
    similarItems = rows;
  }

  //
  // ==========================
  //  LIFESTYLES  (FIXED – part of correct chain)
  // ==========================
  //
else if (currentEntity.route === 'lifestyles') {
  console.log("Running SIMILAR query for LIFESTYLES (simplified)…");

  const [rows] = await db.query(`
    SELECT id, name, price, pictures, mainpicture, brand_id, model_id, user_id
    FROM lifestyles
    WHERE visible = 1
      AND status = 3
      AND id != ?
      AND user_id != ?
      AND (
           (brand_id = ? AND model_id = ?)
        OR (brand_id = ?)
      )
    ORDER BY
      (brand_id = ?) DESC,
      (model_id = ?) DESC,
      RAND()
    LIMIT 20
  `, [
    item.id,
    itemRow.user_id,
    itemRow.brand_id, itemRow.model_id,
    itemRow.brand_id,
    itemRow.brand_id, itemRow.model_id
  ]);

  console.log("[SIMILAR][LIFESTYLES] rows:", rows.length);
  similarItems = rows;
}


  //
  // ==========================
  //  NO OTHER CATEGORIES → EMPTY
  // ==========================
  //
  else {
    console.log("[SIMILAR] No matching entity, clearing similarItems");
    similarItems = [];
  }

} catch (err) {
  console.warn("[DETAIL][SIMILAR] error:", err);
}

console.log("[SIMILAR] Before map(), items:", similarItems.length);

//
// ==========================
// 🔥 Mapping + Bild-Logik
// ==========================
//

similarItems = similarItems.map(r => {
  console.log("[SIMILAR][MAP] Processing item:", r.id, r.name);

  const rpics = safeParsePictures(r.pictures);
  const img = extractMainImage(r.mainpicture, rpics);

  const out = {
    id: r.id,
    title: r.name,
    slug: slugify(r.name, { lower: true, strict: true }),
    imageUrl: `/images/${currentEntity.route}/${r.id}/${encodeURIComponent(img)}`,
    price: r.price,
    priceFormatted: r.price ? res.locals.convertPrice(r.price) : "Preis auf Anfrage"
  };

  console.log("[SIMILAR][MAP] FINAL ITEM:", out.imageUrl);
  return out;
});


console.log("[SIMILAR] FINAL similarItems:", similarItems.length);
console.log("===== [SIMILAR] END =====");



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
        yachtTypeMap: yachtMaps.yachttype || {},
        hullMap:      yachtMaps.hull || {},
        shapeMap:     yachtMaps.shape || {},
        categoryMap, 
        slider: [],
        isPrivateSeller,
        similarItems,
        convertPrice: res.locals.convertPrice 
      });


  } catch (err) {
    console.error('[DETAIL][ERROR]', err);
    next(err);
  }
}); 

// ============================================================================
// 1) Kategorie / Brand / Model (Liste)
// Beispiel: /cars/bmw/m3
// ============================================================================
// Kategorie-Route mit Brand/Model-Filter
router.get('/:entityRoute/:brandSlug/:modelSlug', ensureAdmin, async (req, res) => {
  try {
    const { entityRoute, brandSlug, modelSlug } = req.params;

    const entityTypeMap = { properties:1, watches:2, cars:3, yachts:4, lifestyles:5 };
    const type = entityTypeMap[entityRoute];
    if (!type) return res.status(404).send('Kategorie nicht gefunden');

    // -------------------------
    // BRAND über seoname finden
    // -------------------------
    const [[brand]] = await db.query(`
      SELECT id
      FROM brands
      WHERE type = ?
        AND LOWER(seoname) = ?
      LIMIT 1
    `, [type, String(brandSlug).toLowerCase()]);

    if (!brand) return res.status(404).send('Marke nicht gefunden');

    // -------------------------
    // MODEL über slugify(name) finden
    // -------------------------
    const cleanedModelSlug = slugify(
      decodeURIComponent(modelSlug),
      { lower: true, strict: true }
    );

    const [models] = await db.query(`
      SELECT id, name
      FROM models
      WHERE brand_id = ?
    `, [brand.id]);

    let modelId = null;

    for (const m of models) {
      if (slugify(m.name, { lower: true, strict: true }) === cleanedModelSlug) {
        modelId = m.id;
        break;
      }
    }

    if (!modelId) return res.status(404).send('Modell nicht gefunden');

    // -------------------------
    // Query-Parameter übernehmen (sort, limit, hp, filter, etc.)
    // -------------------------
    const params = new URLSearchParams(req.query);
    params.set('brand', brand.id);
    params.set('model', modelId);

    // 🔥 WICHTIG: 301 für SEO
    return res.redirect(301, `/${entityRoute}?${params.toString()}`);

  } catch (err) {
    console.error('SEO Brand+Model Redirect Fehler:', err);
    res.status(500).send('Serverfehler');
  }
});


function safeParsePictures(pics) {
  if (!pics) return [];

  // Bereits ein Objekt oder Array?
  if (typeof pics === "object") {
    return Array.isArray(pics)
      ? pics
      : Object.values(pics);
  }

  // JSON versuchen
  if (typeof pics === "string") {

    // JSON?
    if (pics.trim().startsWith("{") || pics.trim().startsWith("[")) {
      try {
        const jsonParsed = JSON.parse(pics);
        return Array.isArray(jsonParsed)
          ? jsonParsed
          : Object.values(jsonParsed);
      } catch (e) {
        console.log("[safeParsePictures] JSON failed:", e.message);
      }
    }

    // PHP Serialization?
    if (pics.includes("a:") && pics.includes("{") && pics.includes(";")) {
      try {
        const php = unserialize(pics);
        return Array.isArray(php)
          ? php
          : Object.values(php);
      } catch (e) {
        console.log("[safeParsePictures] PHP unserialize failed:", e.message);
      }
    }
  }

  // Wenn alles fehlschlägt: Leeres Array
  return [];
}


// ============================================================================
// 2) Produktdetail (Detailseite)
// Beispiel: /cars/12345/bmw-m3
// ============================================================================




const contactRateLimit = {}; 

function extractListingId(url) {
  try {
    const parts = url.split("/");
    const id = parts.find(p => /^\d+$/.test(p));
    return id ? Number(id) : null;
  } catch {
    return null;
  }
}

function parseListingUrl(url) {
  try {
    const parts = url.split("/");

    const entity = parts[3]; // cars, watches, properties, yachts, lifestyles
    const id = parseInt(parts[4], 10);

    if (!entity || !id) return null;

    return { entity, id };
  } catch {
    return null;
  }
}



router.post('/send-contact', async (req, res) => {
  try {
    // 🔹 FORM-DATEN
    const { firstName, lastName, email, phone, message, listingUrl, hp_field, gender  } = req.body;
    console.log('📨 /send-contact payload received:', {
      firstName: firstName ? '[ok]' : '[missing]',
      lastName: lastName ? '[ok]' : '[missing]',
      email: email ? '[ok]' : '[missing]',
      phone: phone ? '[ok]' : '[empty]',
      hasMessage: Boolean(message),
      listingUrl,
      hasHoneypot: Boolean(hp_field)
    });

    // 🕵️ 1) Honeypot-Check
    if (hp_field) {
      console.warn('Spam/Honeypot ausgelöst von IP:', req.ip);
      return res.status(200).json({ success: true });
    }

    // 🛡 2) Rate-Limit
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const maxRequests = 5;

    if (!contactRateLimit[ip]) {
      contactRateLimit[ip] = { count: 1, firstTime: now };
    } else {
      const entry = contactRateLimit[ip];

      if (now - entry.firstTime > windowMs) {
        entry.count = 1;
        entry.firstTime = now;
      } else {
        entry.count++;
      }

      if (entry.count > maxRequests) {
        console.warn('Rate Limit überschritten von IP:', ip);
        return res.status(429).json({
          success: false,
          error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.'
        });
      }
    }

    // ✔ Pflichtfelder
    if (!firstName || !lastName || !email || !message || !listingUrl) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    // ✉️ SMTP
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    // 🧹 Daten bereinigen
    const safeFirstName = String(firstName).trim();
    const safeLastName  = String(lastName).trim();
    const safeEmail     = String(email).trim();
    const safePhone     = String(phone || '').trim();
    const safeMessage   = String(message || '').trim().replace(/\n/g, '<br>');
    const listing       = String(listingUrl).trim();
    const baseUrl       = process.env.BASE_URL || 'https://herando.at';

    // ------------------------------------------------------------------------------------------------------------------
    // 💌 1) CUSTOMER EMAIL (Bestätigung)
    // ------------------------------------------------------------------------------------------------------------------

    const customerHtml = `
    <table bgcolor="#CCCCCC" border="0" cellpadding="0" cellspacing="0" 
          style="border-collapse:separate;width:100%;background-color:#cccccc" width="100%">
      <tr>
        <td>&nbsp;</td>

        <td style="display:block;margin:0 auto!important;max-width:580px;padding:10px;width:580px">

          <div style="max-width:580px;padding:10px">

            <table width="100%" 
                  style="border-collapse:separate;width:100%;background:#ffffff;border-radius:3px">

              <tr>
                <td style="padding:20px">

                  <table width="100%" style="border-collapse:separate;width:100%">
                    <tr>
                      <td>

    <p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
      Guten Tag ${safeFirstName} ${safeLastName},
    </p>

    <p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
      vielen Dank für Ihre Anfrage über <strong>Herando</strong>.<br>
      Wir haben Ihre Nachricht erhalten und an den Verkäufer weitergeleitet.
    </p>

    <p style="font-family:sans-serif;font-size:14px;font-weight:bold;margin:0 0 10px 0">
      Ihre Nachricht:
    </p>

    <p style="font-style:italic;margin:0 0 15px 0">
      "${safeMessage}"
    </p>

    <!-- BUTTON BLOCK -->
    <table width="100%" style="width:100%;border-collapse:separate;box-sizing:border-box">
      <tr>
        <td align="left" style="padding-bottom:15px">

          <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:auto">
            <tr>
              <td align="center" bgcolor="#c39052" 
                  style="background-color:#c39052;text-align:center">

                <a href="${listingUrl}" 
                  target="_blank"
                  style="display:inline-block;color:#ffffff;background-color:#c39052;
                  border:none;text-decoration:none;font-size:16px;font-weight:400;
                  margin:0;padding:10px;">
                  Inserat öffnen
                </a>

              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>

    <p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
      Mit freundlichen Grüßen<br>
      Ihr Herando-Team
    </p>

    <p style="font-family:sans-serif;font-size:12px;color:#777;margin:0 0 15px 0">
      <a href="${baseUrl}" style="color:#9c7240;text-decoration:none;">${baseUrl}</a>
    </p>

                      </td>
                    </tr>
                  </table>

                </td>
              </tr>
            </table>

            <!-- FOOTER -->
            <div style="padding-top:10px;text-align:center;width:100%;background-color:#eeeeee">

              <table width="100%">
                <tr>
                  <td style="text-align:left;padding-left:20px;padding-top:20px">
                    <img src="${baseUrl}/assets/herando-weblogo.png" 
                        alt="Herando Logo" style="width:150px;">
                  </td>
                </tr>

                <tr>
                  <td style="font-family:sans-serif;font-size:12px;text-align:left;padding:10px 20px;color:#000">
                    Aktiengesellschaft Herando (a.s.)<br>
                    V Jámě 1/699<br>
                    110 00 Prag 1<br><br>

                    E-Mail: info(at)<a href="https://www.herando.com">herando.com</a><br>
                    Home: <a href="https://www.herando.com">www.herando.com</a><br><br>

                    Umsatzsteuer IdNr.: CZ 050 90 733<br>
                    Handelsregisternummer: C 258212<br>
                    Registergericht der Stadt Prag<br><br>

                    CEO: Kfm. Frank Müller<br>
                    COB: Prof. Dr. mult. Christian M. Marmandiu<br>
                    COB: Dipl.-Wirtsch.-Inf. Robert Wauer<br><br>

                    <p>Diese E-Mail enthält vertrauliche und/oder rechtlich geschützte Informationen...</p>
                    <p>This e-mail may contain confidential and/or privileged information...</p>
                  </td>
                </tr>

              </table>

            </div>

          </div>

        </td>

        <td>&nbsp;</td>
      </tr>
    </table>
    `;


    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: safeEmail,
      subject: "Ihre Anfrage wurde über Herando gesendet",
      html: customerHtml
    });

    // ------------------------------------------------------------------------------------------------------------------
    // 💌 2) PLATFORM EMAIL (interne Info)
    // ------------------------------------------------------------------------------------------------------------------

const platformHtml = `
<table bgcolor="#CCCCCC" border="0" cellpadding="0" cellspacing="0" 
       style="border-collapse:separate;width:100%;background-color:#cccccc" width="100%">
  <tr>
    <td>&nbsp;</td>

    <td style="display:block;margin:0 auto!important;max-width:580px;padding:10px;width:580px">

      <div style="max-width:580px;padding:10px">

        <table width="100%" 
               style="border-collapse:separate;width:100%;background:#ffffff;border-radius:3px">

          <tr>
            <td style="padding:20px">

              <table width="100%" style="border-collapse:separate;width:100%">
                <tr>
                  <td>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  Neue Anfrage über <strong>Herando.com</strong> erhalten:
</p>

<p style="font-style:italic;margin:0 0 15px 0">
  "${safeMessage}"
</p>

<p style="margin:0 0 10px 0">
  <strong>Name:</strong> ${safeFirstName} ${safeLastName}
</p>

<p style="margin:0 0 10px 0">
  <strong>E-Mail:</strong> <a href="mailto:${safeEmail}">${safeEmail}</a>
</p>

<p style="margin:0 0 15px 0">
  <strong>Telefon:</strong> ${safePhone || 'Keine Angabe'}
</p>

<p style="margin:0 0 15px 0">
  <strong>IP-Adresse:</strong> ${ip}
</p>

<!-- BUTTON BLOCK -->
<table width="100%" style="width:100%;border-collapse:separate;box-sizing:border-box">
  <tr>
    <td align="left" style="padding-bottom:15px">

      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:auto">
        <tr>
          <td align="center" bgcolor="#c39052" 
              style="background-color:#c39052;text-align:center">

            <a href="${listingUrl}" 
               target="_blank"
               style="display:inline-block;color:#ffffff;background-color:#c39052;
               border:none;text-decoration:none;font-size:16px;font-weight:400;
               margin:0;padding:10px;">
              Inserat ansehen
            </a>

          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  Nachricht intern zur Dokumentation weitergeleitet.
</p>

                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>

        <!-- FOOTER -->
        <div style="padding-top:10px;text-align:center;width:100%;background-color:#eeeeee">

          <table width="100%">
            <tr>
              <td style="text-align:left;padding-left:20px;padding-top:20px">
                <img src="${baseUrl}/assets/herando-weblogo.png" 
                     alt="Herando Logo" style="width:150px;">
              </td>
            </tr>

            <tr>
              <td style="font-family:sans-serif;font-size:12px;text-align:left;padding:10px 20px;color:#000">
                Aktiengesellschaft Herando (a.s.)<br>
                V Jámě 1/699<br>
                110 00 Prag 1<br><br>

                E-Mail: info(at)<a href="https://www.herando.com">herando.com</a><br>
                Home: <a href="https://www.herando.com">www.herando.com</a><br><br>

                Umsatzsteuer IdNr.: CZ 050 90 733<br>
                Handelsregisternummer: C 258212<br>
                Registergericht der Stadt Prag<br><br>

                CEO: Kfm. Frank Müller<br>
                COB: Prof. Dr. mult. Christian M. Marmandiu<br>
                COB: Dipl.-Wirtsch.-Inf. Robert Wauer<br><br>

                <p>Diese E-Mail enthält vertrauliche und/oder rechtlich geschützte Informationen...</p>
                <p>This e-mail may contain confidential and/or privileged information...</p>
              </td>
            </tr>

          </table>

        </div>

      </div>

    </td>

    <td>&nbsp;</td>
  </tr>
</table>
`;

    const parsed = parseListingUrl(listingUrl);

    if (!parsed) {
      console.error("❌ Konnte Entität/ID nicht parsen aus listingUrl:", listingUrl);
    }

    const table = parsed.entity;  // z.B. "cars"
    const listingId = parsed.id;
    console.log('🧩 Parsed listing:', { table, listingId });

    const [sellerRows] = await db.query(`
        SELECT u.firstname, u.lastname, u.gender
        FROM ${table} AS t
        JOIN users AS u ON u.id = t.user_id
        WHERE t.id = ?
    `, [listingId]);

    const sellerData = sellerRows[0] || {};
    console.log('👤 Seller data found:', {
      hasSeller: Boolean(sellerRows[0]),
      gender: sellerData.gender ?? null
    });

const sellerFirstName = sellerData.firstname || "";
const sellerLastName  = sellerData.lastname  || "";
const sellerGender    = sellerData.gender    || 0;

let anrede;

if (sellerGender == 2) {
    anrede = `Sehr geehrter Herr ${sellerFirstName} ${sellerLastName}`;
} else if (sellerGender == 3) {
    anrede = `Sehr geehrte Frau ${sellerFirstName} ${sellerLastName}`;
} else {
    anrede = `Sehr geehrte Frau/Herr ${sellerFirstName} ${sellerLastName}`;
}



    await transporter.sendMail({
      from: `"Herando Plattform" <${process.env.SMTP_USER}>`,
      to: "peter.gerguis@gmail.com",
      subject: `Neue Anfrage über Herando von ${safeFirstName} ${safeLastName}`,
      html: platformHtml
    });
    console.log('✅ Platform email sent to sales-license-partner@herando.com');

    // ------------------------------------------------------------------------------------------------------------------
    // 💌 3) SELLER EMAIL (an Peter)
    // ------------------------------------------------------------------------------------------------------------------

const sellerHtml = `
<table bgcolor="#CCCCCC" border="0" cellpadding="0" cellspacing="0" 
       style="border-collapse:separate;width:100%;background-color:#cccccc" width="100%">
<tr>
  <td>&nbsp;</td>

  <td style="display:block;margin:0 auto!important;max-width:580px;padding:10px;width:580px">

    <div style="max-width:580px;padding:10px">

      <table width="100%" 
             style="border-collapse:separate;width:100%;background:#ffffff;border-radius:3px">

        <tr>
          <td style="padding:20px">

            <table width="100%" style="border-collapse:separate;width:100%">
              <tr>
                <td>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  ${anrede},
</p>


<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  Sie haben eine Nachricht über 
  <a href="${baseUrl}" target="_blank">www.herando.com</a> erhalten:
</p>

<p style="font-style:italic">
  "${safeMessage}"
</p>

<p>Name: ${safeFirstName} ${safeLastName}</p>
<p>E-Mail: <a href="mailto:${safeEmail}">${safeEmail}</a></p>
<p>Telefon: ${safePhone || 'Keine Angabe'}</p>

<!-- BUTTON BLOCK -->
<table width="100%" style="width:100%;border-collapse:separate;box-sizing:border-box">
  <tr>
    <td align="left" style="padding-bottom:15px">

      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:auto">
        <tr>
          <td align="center" bgcolor="#c39052" 
              style="background-color:#c39052;text-align:center">

            <a href="${listingUrl}" 
               target="_blank"
               style="display:inline-block;color:#ffffff;background-color:#c39052;
               border:none;text-decoration:none;font-size:16px;font-weight:400;
               margin:0;padding:10px;">
              Inserat anschauen
            </a>

          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  Antworten Sie dem Interessenten direkt per E-Mail.
</p>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  Mit freundlichen Grüßen
</p>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  Ihr Herando-Team
</p>

                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>

      <!-- FOOTER -->
      <div style="padding-top:10px;text-align:center;width:100%;background-color:#eeeeee">

        <table width="100%">
          <tr>
            <td style="text-align:left;padding-left:20px;padding-top:20px">
              <img src="${baseUrl}/assets/herando-weblogo.png" alt="Herando Logo" style="width:150px;">
            </td>
          </tr>

          <tr>
            <td style="font-family:sans-serif;font-size:12px;text-align:left;padding:10px 20px;color:#000">

              Aktiengesellschaft Herando (a.s.)<br>
              V Jámě 1/699<br>
              110 00 Prag 1<br><br>

              E-Mail: info(at)<a href="https://www.herando.com">herando.com</a><br>
              Home: <a href="https://www.herando.com">www.herando.com</a><br><br>

              Umsatzsteuer IdNr.: CZ 050 90 733<br>
              Handelsregisternummer: C 258212<br>
              Registergericht der Stadt Prag<br><br>

              CEO: Kfm. Frank Müller<br>
              COB: Prof. Dr. mult. Christian M. Marmandiu<br>
              COB: Dipl.-Wirtsch.-Inf. Robert Wauer<br><br>

              <p>Diese E-Mail enthält vertrauliche und/oder rechtlich geschützte Informationen...</p>
              <p>This e-mail may contain confidential and/or privileged information...</p>

            </td>
          </tr>

        </table>

      </div>

    </div>

  </td>

  <td>&nbsp;</td>
</tr>
</table>
`;


    await transporter.sendMail({
      from: `"Herando" <${process.env.SMTP_USER}>`,
      to: "peter.gerguis@gmail.com",
      subject: "Sie haben eine Anfrage zu Ihrem Inserat",
      html: sellerHtml
    });
    console.log('✅ Seller email sent to peter.gerguis@gmail.com');

    return res.json({ success: true });

  } catch (err) {
    console.error("❌ Send Contact Error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});


router.post('/report-listing', async (req, res) => {
  try {
    const { firstName, lastName, email, reason, message, itemTitle, itemId, itemUrl, hp_report } = req.body;

    if (hp_report) return res.json({ success: true });

    if (!firstName || !lastName || !email || !reason) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const safeFirstName = String(firstName).trim();
    const safeLastName  = String(lastName).trim();
    const safeEmail     = String(email).trim();
    const safeReason    = String(reason).trim();
    const safeMessage   = String(message || '').trim().replace(/\n/g, '<br>');

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const htmlMail = `
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Inserat wurde gemeldet</title>
</head>
<body style="font-family:Arial;background:#f5f5f5;padding:20px;">
<table style="max-width:600px;margin:auto;background:white;border-radius:8px;border:1px solid #ddd;overflow:hidden;">
<tr>
  <td style="background:#9c7240;color:white;padding:18px;font-size:18px;font-weight:bold;">
    Meldung eines Inserats
  </td>
</tr>
<tr>
<td style="padding:20px;color:#333;">

<p><strong>Vorname:</strong> ${safeFirstName}</p>
<p><strong>Nachname:</strong> ${safeLastName}</p>
<p><strong>E-Mail:</strong> ${safeEmail}</p>

<p><strong>Grund:</strong> ${safeReason}</p>

${safeMessage ? `
<p><strong>Nachricht:</strong><br>
${safeMessage}</p>
` : ""}

<p><strong>Inserat:</strong><br>
${itemTitle}<br>
<a href="${itemUrl}" style="color:#9c7240">${itemUrl}</a>
</p>

</td>
</tr>
</table>
</body>
</html>
`;

    await transporter.sendMail({
      from: `"Herando Meldung" <${process.env.SMTP_USER}>`,
      to: "peter.gerguis@gmail.com",
      subject: "Neue Meldung eines Inserats",
      html: htmlMail
    });

    return res.json({ success: true });

  } catch (err) {
    console.log("Meldung Fehler:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});



module.exports = router;

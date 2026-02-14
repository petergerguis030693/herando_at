// src/routes/admin/index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcrypt');
const moment  = require('moment');
const db      = require('../../db');
const router  = express.Router();
const unserialize   = require('php-unserialize').unserialize; 
const path    = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: '/tmp' });
const stateFilters = {
  all:       { where: [] },
  active: { where: ['visible = 1', 'status = 3', '(published IS NULL OR published <= NOW())'] },
  inactive:  { where: ['visible = 0'] },
toapprove: {
  where: [
    'status IN (1,2)',
    // '(stopdate > NOW() OR stopdate IS NULL)',
    '(modified >= DATE_SUB(NOW(), INTERVAL 365 DAY) OR created >= DATE_SUB(NOW(), INTERVAL 365 DAY))'
  ]
},  
  pending:   { where: ['status = 7'] },
  stopped:   { where: ['status = 3', 'visible = 0'] },
  ended:     { where: ['stopdate <= NOW()'] },
  deleted:   { where: ['status = 9'] }
};
const states = [
  'all',
  'active',
  'inactive',
  'toapprove',   // Neue Position
  'pending',
  'stopped',
  'ended',
  'deleted'
];

const stateLabels = {
  active:    'LAUFENDE',
  toapprove: 'FREIZUGEBENDE',    // Neues Label
  pending:   'WARTENDE',
  stopped:   'ANGEHALTENE',
  ended:     'BEENDETE',
  deleted:   'GELÖSCHTE'
};

// Welche Felder pro Route erlaubt sind
const allowedFieldsByRoute = {
 cars: [
    'country_id','city','brand_id','model_id','model','cartype','mileage',
    'gearbox','fuel','consumption_city','consumption_country','consumption_combined',
    'emission_co2','emission_class','pollution_class','environmental_badge',
    'color','metallic','interior','interior_color','drive','engine',
    'capacity','power','horsepower','drivetrain',
    // alle Boolean-Flags
    'abs','esp','asr','airbags','isofix','xenon','bixenon','led','laser',
    'foglamp','daytime_lights','adaptive_lights','glare_free',
    'highbeam_assistant','headlight_washer','immobilizer','electric_windows',
    'electric_adjusted_seats','electric_heated_seats','ventilated_seats',
    'electric_mirrors','electric_tailgate','assisted_steering','light_sensor',
    'cruise_control','adaptive_cruise_control','collision_avoidance',
    'blind_spot_monitor','lane_departure_warning','aux_heating','central_locking',
    'keyless_central_locking','rain_sensor','head_up_display','climatisation',
    'parking_front','parking_rear','parking_camera','parking_self','tuner_radio',
    'radio_dab','mp3interface','navigation','tv','soundsystem','touchscreen',
    'voice_control','usb','apple_car_play','android_auto','wifi_hotspot',
    'music_streaming','inductive_charging','digital_cockpit',
    'multifunction_steeringwheel','cdplayer','bluetooth','onboard_computer',
    'handsfree_kit','alloy_wheels','sports_suspension','sports_package',
    'sports_seats','trailer_coupling','sunroof','panoramic_roof','roof_rack',
    'skibag','disabled_accessible','taxi','summer_tires','winter_tires',
    'all_season_tires','tire_pressure_monitoring','winter_package',
    'smokers_package','air_suspension','startstop_system','rental','hill_climb',
    'fatigue','dimming_mirror','nightvision','emergency_call','traffic_signs',
    'speed_limiter','distance_warning','heated_windshield',
    'heated_steering_wheel','arm_rest','lumbar_support','massage_seats',
    'fold_flat_passenger_seat','ambient_lighting','leather_steering_wheel',
    'shape','used','name','base_price','price','currency','vat','taxrate',
    'checkbook','accident_free','non_smoking','firstregistration',
    'firstregistration_month','maininspection','maininspection_month',
    'year','description','video'
  ],
  yachts:     [
    'brand_id','model','city','length','beam','engine','berths',
    'year','price','currency','description'
  ],
  properties: [
    'country_id','city','propertytype','investmenttype','heating',
    'energysource','energypass','energypass_type','energypass_value',
    'landarea','livingarea','floors','bedrooms','bathrooms',
    'quality','propertyshape','year','price','currency','description'
  ],
  watches:    [
    'brand_id','model_id','model','watchtype','diameter',
    'year','price','currency','description'
  ], 
  lifestyles: [
      'brand_id','model_id','used','name','base_price','price','currency','vat',
      'year','description','video','sliderpicture','mainpicture','pictures'
    ]
};

// Human-readable Labels
const labelMap = {
  // ─── Gemeinsame Felder ─────────────────────────────────────────
  brand_id:    'Marke',
  model_id:    'Modell',
  model:       'Modell (frei)',
  name:        'Titel',
  city:        'Ort',
  country_id:  'Land',
  price:       'Preis',
  base_price:  'Listenpreis',
  currency:    'Währung',
  vat:         'inkl. MwSt.',
  description: 'Beschreibung',
  video:       'Video-URL',
  year:        'Baujahr',

  // ─── Cars ───────────────────────────────────────────────────────
  cartype:             'Karosserie',
  mileage:             'Kilometerstand',
  gearbox:             'Getriebe',
  fuel:                'Treibstoff',
  consumption_city:    'Verbrauch Stadt (l/100 km)',
  consumption_country: 'Verbrauch Land (l/100 km)',
  consumption_combined:'Verbrauch kombiniert (l/100 km)',
  emission_co2:        'CO₂-Emission (g/km)',
  emission_class:      'Emissionsklasse',
  pollution_class:     'Abgasnorm',
  environmental_badge: 'Umweltplakette',
  color:               'Farbe',
  metallic:            'Metallic-Lack',
  interior:            'Innenausstattung',
  interior_color:      'Innenfarbe',
  drive:               'Antrieb',
  engine:              'Zylinderanzahl',
  capacity:            'Hubraum (ccm)',
  power:               'Leistung (kW)',
  horsepower:          'Leistung (PS)',
  drivetrain:          'Antriebsart',
  // Boolean-Flags (jeweils Ja/Nein)
  abs:                   'ABS',
  esp:                   'ESP',
  asr:                   'ASR',
  airbags:               'Airbags',
  isofix:                'Isofix',
  xenon:                 'Xenon-Licht',
  bixenon:               'Bi-Xenon-Licht',
  led:                   'LED-Scheinwerfer',
  laser:                 'Laserlicht',
  foglamp:               'Nebelscheinwerfer',
  daytime_lights:        'Tagfahrlicht',
  adaptive_lights:       'Adaptive Scheinwerfer',
  glare_free:            'Blendfreies Licht',
  highbeam_assistant:    'Fernlichtassistent',
  headlight_washer:      'Scheinwerfer-Reinigung',
  immobilizer:           'Diebstahlschutz',
  electric_windows:      'Elektr. Fensterheber',
  electric_adjusted_seats:'Elektr. Sitzeinstellung',
  electric_heated_seats: 'Elektr. Sitzheizung',
  ventilated_seats:      'Belüftete Sitze',
  electric_mirrors:      'Elektr. Spiegel',
  electric_tailgate:     'Elektr. Heckklappe',
  assisted_steering:     'Servolenkung',
  light_sensor:          'Lichtsensor',
  cruise_control:        'Tempomat',
  adaptive_cruise_control:'Abstandsregel-Tempomat',
  collision_avoidance:   'Kollisionswarnung',
  blind_spot_monitor:    'Totwinkelwarnung',
  lane_departure_warning:'Spurhalteassistent',
  aux_heating:           'Zusatzheizung',
  central_locking:       'Zentralverriegelung',
  keyless_central_locking:'Keyless Entry',
  rain_sensor:           'Regensensor',
  head_up_display:       'Head-Up-Display',
  climatisation:         'Klimaanlage',
  parking_front:         'Parksensor vorne',
  parking_rear:          'Parksensor hinten',
  parking_camera:        'Rückfahrkamera',
  parking_self:          'Einparkhilfe automatisch',
  tuner_radio:           'UKW-Radio',
  radio_dab:             'DAB+',
  mp3interface:          'MP3-Schnittstelle',
  navigation:            'Navigationssystem',
  tv:                    'TV',
  soundsystem:           'Soundsystem',
  touchscreen:           'Touchscreen',
  voice_control:         'Sprachsteuerung',
  usb:                   'USB-Anschluss',
  apple_car_play:        'Apple CarPlay',
  android_auto:          'Android Auto',
  wifi_hotspot:          'WLAN-Hotspot',
  music_streaming:       'Musik-Streaming',
  inductive_charging:    'Induktives Laden',
  digital_cockpit:       'Digitales Cockpit',
  multifunction_steeringwheel:'Multifunktionslenkrad',
  cdplayer:              'CD-Player',
  bluetooth:             'Bluetooth',
  onboard_computer:      'On-board Computer',
  handsfree_kit:         'Freisprecheinrichtung',
  alloy_wheels:          'Leichtmetallfelgen',
  sports_suspension:     'Sportfahrwerk',
  sports_package:        'Sportpaket',
  sports_seats:          'Sportsitze',
  trailer_coupling:      'Anhängerkupplung',
  sunroof:               'Schiebedach',
  panoramic_roof:        'Panoramadach',
  roof_rack:             'Dachgepäckträger',
  skibag:                'Skitaschenhalter',
  disabled_accessible:   'Rollstuhlgerecht',
  taxi:                  'Taxi-Ausstattung',
  summer_tires:          'Sommerreifen',
  winter_tires:          'Winterreifen',
  all_season_tires:      'Ganzjahresreifen',
  tire_pressure_monitoring:'Reifendruckkontrolle',
  winter_package:        'Winterpaket',
  smokers_package:       'Nichtraucher-Paket',
  air_suspension:        'Luftfederung',
  startstop_system:      'Start-Stopp-Automatik',
  rental:                'Vermietfähig',
  hill_climb:            'Berganfahrhilfe',
  fatigue:               'Müdigkeitserkennung',
  dimming_mirror:        'Abblendender Spiegel',
  nightvision:           'Nachtsichtassistent',
  emergency_call:        'Notruffunktion',
  traffic_signs:         'Verkehrsschilderkennung',
  speed_limiter:         'Geschwindigkeitsbegrenzer',
  distance_warning:      'Abstandswarnung',
  heated_windshield:     'Heizbare Frontscheibe',
  heated_steering_wheel: 'Beheiztes Lenkrad',
  arm_rest:              'Armlehne',
  lumbar_support:        'Lendenwirbelstütze',
  massage_seats:         'Massagesitze',
  fold_flat_passenger_seat:'Umklappbarer Beifahrersitz',
  ambient_lighting:      'Ambientebeleuchtung',
  leather_steering_wheel:'Lederlenkrad',
  shape:                 'Zustand',
  used:                  'Gebraucht/New',
  checkbook:             'Scheckheft gepflegt',
  accident_free:         'Unfallfrei',
  non_smoking:           'Nichtraucherfahrzeug',
  firstregistration:     'EZ Jahr',
  firstregistration_month:'EZ Monat',
  maininspection:        'TÜV Jahr',
  maininspection_month:  'TÜV Monat',

  // ─── Properties ─────────────────────────────────────────────────
  propertytype:    'Immobilientyp',
  investmenttype:  'Investmenttyp',
  heating:         'Heizung',
  energysource:    'Energiequelle',
  energypass:      'Energypass vorhanden',
  energypass_type: 'Pass-Typ',
  energypass_value:'Pass-Wert',
  landarea:        'Grundstück (m²)',
  livingarea:      'Wohnfläche (m²)',
  floors:          'Etagen',
  bedrooms:        'Schlafzimmer',
  bathrooms:       'Badezimmer',
  quality:         'Qualität',
  propertyshape:   'Zustand',
  monument_protection:'Denkmalschutz',
  stage:           'Bauphase',

  // ─── Yachts ───────────────────────────────────────────────────────
  category:         'Kategorie',
  yachttype:        'Yachttyp',
  hull:             'Rumpfmaterial',
  beam:             'Breite (m)',
  length:           'Länge (m)',
  engine:           'Motor',
  berths:           'Kojen',
  displacement:     'Verdrängung (t)',
  draft:            'Tiefgang (m)',
  engines:          'Anzahl Motoren',
  power:            'Leistung (kW)',
  horsepower:       'Leistung (PS)',
  engine_hours:     'Motorstunden',
  cruising_speed:   'Reisegeschwindigkeit (kn)',
  cruising_speed_kn:'Reisegeschwindigkeit (kn)',
  max_speed:        'Höchstgeschwindigkeit (kn)',
  max_speed_kn:     'Höchstgeschwindigkeit (kn)',
  fuel_tankage:     'Tankvol.',  
  water_tankage:    'Wassertank',
  naval_architect:  'Schiffarchitekt',
  interior_designer:'Innenarchitekt',
  crew:             'Crewplätze',

  // ─── Watches ─────────────────────────────────────────────────────
  watchtype:                 'Uhrentyp',
  gender:                    'Geschlecht',
  case_material:             'Gehäusematerial',
  strap_material:            'Armbandmaterial',
  strap_color:               'Armbandfarbe',
  dial_color:                'Zifferblattfarbe',
  dial_shape:                'Zifferblattform',
  dial_numbers:              'Zifferblattnummern',
  movement:                  'Werktyp',
  movement_caliber:          'Kaliber',
  caliber:                   'Kaliber (frei)',
  power_reserve:             'Gangreserve (h)',
  jewels_number:             'Anzahl Steine',
  frequency:                 'Frequenz (Hz)',
  crystal:                   'Glas',
  diameter:                  'Durchmesser (mm)',
  height:                    'Höhe (mm)',
  clasp_type:                'Schließe',
  clasp_material:            'Schließenmaterial',
  bezel_material:            'Lünettenmaterial',
  waterproof:                'Wasserdichtigkeit',
  authenticity_papers:       'Echtheitszertifikat',
  authenticity_box:          'Originalbox',
  authenticity_warranty:     'Garantie',
  function_alarm:            'Alarmfunktion',
  function_chronograph:      'Chronograph',
  function_date:             'Datumsfunktion',
  function_day:              'Tagesanzeige',
  function_month:            'Monatsanzeige',
  function_year:             'Jahresanzeige',
  function_4year:            'Schaltjahresanzeige',
  function_perpetual_calendar:'Ewiger Kalender',
  function_gmt:              'GMT',
  function_timeequation:     'Zeitunterschied',
  function_minuterepeater:   'Minutenrepetition',
  function_repetition:       'Repetition',
  function_jumping_hour:     'Springende Stunde',
  function_double_chronograph:'Rattrapante',
  function_panorama:         'Panorama-Anzeige',
  function_calendar:         'Kalenderfunktion',
  function_moonphase:        'Mondphase',
  function_smallseconds:     'Kleine Sekunde',
  function_tachymeter:       'Tachymeter',
  function_centralseconds:   'Zentrale Sekunde',
  function_flyback:          'Flyback',
  function_striking_mechanism:'Schlagwerk',
  // Features
  feature_heliumvalve:       'Heliumventil',
  feature_tourbillon:        'Tourbillon',
  feature_diamondsbezel:     'Diamant-Lünette',
  feature_chronometer:       'Chronometer',
  feature_master_chronometer:'Master Chronometer',
  feature_rotatingbezel:     'Drehbare Lünette',
  feature_powerreserve:      'Gangreserve-Anzeige',
  feature_luminescenthands:  'Leuchtzeiger',
  feature_pocketwatch:       'Taschenuhr',
  feature_luminescentnumerals:'Leuchtziffern',
  feature_luminous_indexes:  'Leuchtindizes',
  feature_waterresistant:    'Wasserfest',
  feature_screwedcrone:      'Verschraubte Krone',
  feature_screwed_pushers:   'Verschraubte Drücker',
  feature_crown_left:        'Krone links',
  feature_skeletonized:      'Skelettiert',
  feature_guilloched:        'Guillochierung',
  feature_hand_guilloched:   'Handguillochierung',
  feature_gemsetting:        'Edelsteinbesatz',
  feature_geneva_seal:       'Genfer Siegel',
  feature_limited_edition:   'Limitierte Edition',
  feature_quickset_mechanism:'Schnelleinstellung',
  feature_original:          'Original',
  feature_pvd:               'PVD-Beschichtung',
  feature_solar:             'Solarbetrieb',
  feature_display_back:      'Sichtboden',
  feature_bluedsteel_hands:  'Blaustahlzeiger',
  feature_worldtime_clock:   'Weltzeituhr',
  feature_smartwatch:        'Smartwatch',
  feature_onehand_watch:     'Einzeigeruhr',
  reference:                 'Referenz',
  adnumber:                  'Anzeigen-Nr.'
};

const renderNotFound = (req, res) =>
  res.status(404).render('errors/404', { currentUrl: req.originalUrl, seo: '404 Error', });



router.use(async (req, res, next) => {
    try {
      const [entieties] = await db.query(`
        SELECT id, name, route, table_name
        FROM ententies
        ORDER BY name
      `);
      res.locals.entieties = entieties;
      next();
    } catch (err) {
      next(err);
    }
  });

// ——————————————————————————
// LOGIN
// ——————————————————————————
router.get('/login', (req, res) => {
  if (req.session?.userId) {
    if (Number(req.session.role) === 9) return res.redirect('/admin');
    return renderNotFound(req, res);
  }
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [[user]] = await db.query(
      `SELECT id, email, password, confirmed, role
         FROM users
         WHERE email = ? AND confirmed = 1
         LIMIT 1`,
      [username]
    );

    if (!user) return renderNotFound(req, res);

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return renderNotFound(req, res);
    }

    if (Number(user.role) !== 9) {
      return renderNotFound(req, res);
    }

    // ✅ Session setzen
    req.session.userId = user.id;
    req.session.role   = user.role;

    console.log("✅ Login erfolgreich, Session gesetzt:", req.session);

    // ✅ Session speichern und erst dann redirecten
    req.session.save(err => {
      if (err) {
        console.error("❌ Session konnte nicht gespeichert werden:", err);
        return res.render('admin/login', { error: 'Fehler beim Speichern der Session.' });
      }
      return res.redirect('/admin');
    });

  } catch (err) {
    console.error(err);
    return res.render('admin/login', { error: 'Fehler beim Einloggen. Bitte später erneut.' });
  }
});


// ——————————————————————————
// LOGOUT & AUTHENTICATION
// ——————————————————————————
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// Alle Routen ab hier benötigen einen eingelogten User
router.use((req, res, next) => {
  if (req.path.startsWith('/login')) return next();
  if (!req.session.userId) return res.redirect('/admin/login');
  if (Number(req.session.role) !== 9) return renderNotFound(req, res);
  next();
});

// ——————————————————————————
// DASHBOARD
// ——————————————————————————
router.get('/', async (req, res, next) => {
  try {
    // 1) Admin-Daten inkl. Rolle für Begrüßung
    const [[admin]] = await db.query(
      'SELECT firstname, lastname, gender, role FROM users WHERE id = ?',
      [req.session.userId]
    );

    req.session.role = admin?.role || 0;

    const userName = admin
      ? `${admin.firstname} ${admin.lastname}`.trim()
      : 'Unbekannt';
    const gender = admin?.gender ?? 0;

    // 2) Filter-Query fürs Users‐Listing
    const filter = req.query.filter?.trim() || '';

    // 3) Users aus der DB holen (mit optionalem LIKE-Filter)
    let sqlUsers = `
      SELECT 
        id, firstname, lastname, gender, company,
        phone, mobile,
        street, housenumber, city, postcode,
        email, fax, created, confirmed, role
      FROM users
      WHERE street IS NOT NULL AND street <> ''
    `;
    const userParams = [];
    if (filter) {
      sqlUsers += ` AND (
          firstname LIKE ? OR
          lastname  LIKE ? OR
          email     LIKE ?
        )`;
      const like = `%${filter}%`;
      userParams.push(like, like, like);
    }
    sqlUsers += ' ORDER BY created DESC';
    const [users] = await db.query(sqlUsers, userParams);

    // 4a) Neue User pro Tag (letzte 7 Tage)
    const [usersRaw] = await db.query(`
      SELECT DATE(created) AS date, COUNT(*) AS count
      FROM users
      WHERE created >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY date
      ORDER BY date
    `);
    const userMap = new Map(
      usersRaw.map(r => [ moment(r.date).format('YYYY-MM-DD'), r.count ])
    );
    const usersPerDay = [];
    for (let i = 6; i >= 0; i--) {
      const d = moment().subtract(i, 'days').format('YYYY-MM-DD');
      usersPerDay.push({ date: d, count: userMap.get(d) || 0 });
    }

    // 4b) Listings pro Entität zählen
    const listingsByType = {};
    for (const ent of res.locals.entieties) {
      const table = ent.table_name;
      const label = ent.name;

      // Prüfen, ob stopdate-Spalte existiert
      const [[{ has_stopdate }]] = await db.query(
        `SELECT COUNT(*) AS has_stopdate
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME   = ?
           AND COLUMN_NAME  = 'stopdate'`,
        [table]
      );

      // Dynamische WHERE-Klausel
      let where = '`visible` = 1';
      if (has_stopdate) {
        where += ' AND (`stopdate` > NOW() OR `stopdate` IS NULL)';
      }

      const [[{ cnt }]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE ${where}`
      );
      listingsByType[label] = cnt;
    }

    // 4c) Umsatz pro Monat (letzte 6 Monate)
    const [revenueRaw] = await db.query(`
      SELECT DATE_FORMAT(created, '%Y-%m') AS month, SUM(amount) AS revenue
      FROM bills
      WHERE created >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY month
      ORDER BY month
    `);
    const revenuePerMonth = [];
    for (let i = 5; i >= 0; i--) {
      const m = moment().subtract(i, 'months').format('YYYY-MM');
      const rec = revenueRaw.find(r => r.month === m);
      revenuePerMonth.push({ month: m, revenue: rec?.revenue || 0 });
    }

    // 4d) Entitäten laden
    const [entieties] = await db.query(`
      SELECT id, name, route, table_name
      FROM ententies
      ORDER BY name
    `);

    // 5) Rendern
    res.render('admin/dashboard', {
      userName,
      gender,
      role: req.session.role,   // <- Rolle weitergeben
      active: 'dashboard',

      // Users-Listing
      users,
      filter,

      // Charts
      usersPerDay,
      listingsByType,
      revenuePerMonth, 
      entieties
    });
  } catch (err) {
    next(err);
  }
});



 
// ——————————————————————————
// API: Stats für Chart.js
// ——————————————————————————
router.get('/api/stats', async (req, res, next) => {
  if (req.session.role !== 9) return res.status(403).end();
  try {
    // Dieselben Abfragen wie im Dashboard – hier nur JSON-Ausgabe
    // (siehe oben unter 4a–4c)
    // … du kannst den Code kopieren oder hier DRY refactoren …
    const [usersRaw] = await db.query(`
      SELECT DATE(created) AS date, COUNT(*) AS count
      FROM users
      WHERE created >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY date
      ORDER BY date
    `);
    const userMap = new Map(usersRaw.map(r => [ moment(r.date).format('YYYY-MM-DD'), r.count ]));
    const usersPerDay = [];
    for (let i = 6; i >= 0; i--) {
      const d = moment().subtract(i, 'days').format('YYYY-MM-DD');
      usersPerDay.push({ date: d, count: userMap.get(d) || 0 });
    }

    const listingsByType = {};
    for (const [label, table] of Object.entries({
      Autos:      'cars',
      Uhren:      'watches',
      Yachten:    'yachts',
      Immobilien: 'properties'
    })) {
      const [[{ cnt }]] = await db.query(
        `SELECT COUNT(*) AS cnt
         FROM ${table}
         WHERE visible = 1 AND (stopdate > NOW() OR stopdate IS NULL)`
      );
      listingsByType[label] = cnt;
    }

    const [revenueRaw] = await db.query(`
      SELECT DATE_FORMAT(created, '%Y-%m') AS month, SUM(amount) AS revenue
      FROM bills
      WHERE created >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY month
      ORDER BY month
    `);
    const revenuePerMonth = [];
    for (let i = 5; i >= 0; i--) {
      const m = moment().subtract(i, 'months').format('YYYY-MM');
      const rec = revenueRaw.find(r => r.month === m);
      revenuePerMonth.push({ month: m, revenue: rec?.revenue || 0 });
    }

    res.json({ usersPerDay, listingsByType, revenuePerMonth });
  } catch (err) {
    next(err);
  }
});

router.get('/listings', async (req, res, next) => {
  try {
    // 0) Query-Parameter (inkl. neu: adType)
    const {
      category,
      state     = 'active',
      adType    = '',       // '', 'slider', 'catalog', 'inserat', 'katalog_slider'
      page      = '1',
      search    = '',
      mode      = '',
      priceMin  = '',
      priceMax  = '',
      sort      = ''
    } = req.query;

    // 1) Aktuelles Entity ermitteln
    const ent = res.locals.entieties.find(e => e.route === category);
    if (!ent) {
      return res.redirect(
        '/admin/listings?category=' + res.locals.entieties[0].route
      );
    }

    // 2) Counts pro State (Alias t.) inkl. Ads-Filter
    const counts = {};
    for (const st of Object.keys(stateFilters)) {
      const rawWheres = stateFilters[st].where || [];
      const clausesCount = rawWheres.map(cond =>
        cond
          .replace(/\bmodified\b/g,  't.modified')
          .replace(/\bcreated\b/g,   't.created')
          .replace(/\bpublished\b/g, 't.published')
          .replace(/\bid\b/g,        't.id')
      );
      clausesCount.push('(t.published IS NULL OR t.published <= NOW())');
      const whereCount = clausesCount.length
        ? 'WHERE ' + clausesCount.join(' AND ')
        : '';

      let adsCountJoin = '';
      let countParams = [];
      if (adType === 'slider') {
        adsCountJoin = ` JOIN slider_ads sa
                          ON sa.advert_id = t.id
                         AND sa.entitie_id = ?
                         AND sa.start_date <= NOW()
                         AND sa.end_date   >= NOW()`;
        countParams.push(ent.id);
      } else if (adType === 'catalog') {
        adsCountJoin = ` JOIN catalog_ads ca
                          ON ca.advert_id = t.id
                         AND ca.entitie_id = ?
                         AND ca.start_date <= NOW()
                         AND ca.end_date   >= NOW()`;
        countParams.push(ent.id);
      } else if (adType === 'inserat') {
        adsCountJoin = ` JOIN advert_inserat ai
                          ON ai.advert_id = t.id
                         AND ai.entitie_id = ?
                         AND ai.start_date <= NOW()
                         AND ai.end_date   >= NOW()`;
        countParams.push(ent.id);
      } else if (adType === 'katalog_slider') {
        adsCountJoin = ` JOIN katalog_slider ks
                          ON ks.advert_id = t.id
                         AND ks.entitie_id = ?
                         AND ks.start_date <= NOW()
                         AND ks.end_date   >= NOW()`;
        countParams.push(ent.id);
      }

      const sqlCount = `
        SELECT COUNT(*) AS cnt
          FROM \`${ent.table_name}\` t
          ${adsCountJoin}
          ${whereCount}
      `;
      const [[{ cnt }]] = await db.query(sqlCount, countParams);
      counts[st] = cnt;
    }

    // 3) Pagination vorbereiten
    const perPage     = 300;
    const currentPage = Math.max(parseInt(page, 10), 1);
    const offset      = (currentPage - 1) * perPage;

    // 4) Schema-Spalten einlesen
    const [schemaCols] = await db.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = ?`,
      [ent.table_name]
    );
    const cols = schemaCols.map(r => r.COLUMN_NAME);
    let selectCols = cols.map(col => `t.\`${col}\``).join(', ');

    // 5) Dynamischer JOIN auf companies (direkt oder über users)
    let joinSql       = '';
    const companyCols = [];
    if (cols.includes('company_id')) {
      joinSql       = ' LEFT JOIN companies c ON t.company_id = c.id';
      selectCols   += ', c.name AS company_name';
      companyCols.push('c.name');
    } else if (cols.includes('user_id')) {
      joinSql       =
        ' LEFT JOIN users u ON t.user_id = u.id' +
        ' LEFT JOIN companies c ON u.company_id = c.id';
      selectCols   += ', COALESCE(c.name, u.company) AS company_name';
      selectCols   += ', u.firstname AS user_firstname, u.lastname AS user_lastname';
      companyCols.push('c.name', 'u.company');
    }

    // 6) WHERE-Clauses bauen
    const filter    = stateFilters[state] || stateFilters.all;
    const rawWheres = filter.where || [];
    const clauses   = rawWheres.map(cond =>
      cond
        .replace(/\bmodified\b/g,  't.modified')
        .replace(/\bcreated\b/g,   't.created')
        .replace(/\bpublished\b/g, 't.published')
        .replace(/\bid\b/g,        't.id')
    );
    const params = [];

    if (search) {
      const likeClauses = cols.map(col => `t.\`${col}\` LIKE ?`);
      companyCols.forEach(c => likeClauses.push(`${c} LIKE ?`));
      if (/^\d+$/.test(search)) likeClauses.push('t.id = ?');
      clauses.push(`(${likeClauses.join(' OR ')})`);

      const lp = `%${search}%`;
      params.push(
        ...cols.map(() => lp),
        ...companyCols.map(() => lp),
        ...(/^\d+$/.test(search) ? [search] : [])
      );
    }

    const minVal = parseFloat(priceMin);
    if (!isNaN(minVal)) {
      clauses.push('t.`price` >= ?');
      params.push(minVal);
    }
    const maxVal = parseFloat(priceMax);
    if (!isNaN(maxVal)) {
      clauses.push('t.`price` <= ?');
      params.push(maxVal);
    }

    clauses.push('(t.published IS NULL OR t.published <= NOW())');
    const whereSql = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    // 6d) Ads-JOIN ins Haupt-Query
    let adsJoin = '';
    let adParam = null;
    if (adType === 'slider') {
      adsJoin = ` JOIN slider_ads sa
                   ON sa.advert_id = t.id
                  AND sa.entitie_id = ?
                  AND sa.start_date <= NOW()
                  AND sa.end_date   >= NOW()`;
      adParam = ent.id;
    } else if (adType === 'catalog') {
      adsJoin = ` JOIN catalog_ads ca
                   ON ca.advert_id = t.id
                  AND ca.entitie_id = ?
                  AND ca.start_date <= NOW()
                  AND ca.end_date   >= NOW()`;
      adParam = ent.id;
    } else if (adType === 'inserat') {
      adsJoin = ` JOIN advert_inserat ai
                   ON ai.advert_id = t.id
                  AND ai.entitie_id = ?
                  AND ai.start_date <= NOW()
                  AND ai.end_date   >= NOW()`;
      adParam = ent.id;
    } else if (adType === 'katalog_slider') {
      adsJoin = ` JOIN katalog_slider ks
                   ON ks.advert_id = t.id
                  AND ks.entitie_id = ?
                  AND ks.start_date <= NOW()
                  AND ks.end_date   >= NOW()`;
      adParam = ent.id;
    }

    // 7) Total für Pagination
    const totalSql = `
      SELECT COUNT(*) AS total
        FROM \`${ent.table_name}\` t
        ${joinSql}
        ${adsJoin}
        ${whereSql}
    `;
    const totalParams = adParam != null
      ? [adParam, ...params]
      : params;
    const [[{ total }]] = await db.query(totalSql, totalParams);
    const totalPages   = Math.ceil(total / perPage);

    // 8) Sortierung
    let orderClause;
    switch (sort) {
      case 'price_asc':  orderClause = 't.`price` ASC';  break;
      case 'price_desc': orderClause = 't.`price` DESC'; break;
      default:
        orderClause =
          'GREATEST(COALESCE(t.published, t.created), COALESCE(t.modified, t.created)) DESC';
    }

    // 9) Datensätze laden
    const rowsSql = `
      SELECT ${selectCols}
        FROM \`${ent.table_name}\` t
        ${joinSql}
        ${adsJoin}
        ${whereSql}
        ORDER BY ${orderClause}
        LIMIT ? OFFSET ?
    `;
    const rowParams = adParam != null
      ? [adParam, ...params, perPage, offset]
      : [...params, perPage, offset];
    const [rows] = await db.query(rowsSql, rowParams);

    // 10) Thumb-URL parsen
    rows.forEach(row => {
      const raw = row.mainpicture || '';
      let filename = '';
      if (/^a:\d+:{/.test(raw)) {
        try { filename = unserialize(raw).image || ''; } catch {}
      } else if (/^[\[\{]/.test(raw)) {
        try {
          const parsed = JSON.parse(raw);
          filename = Array.isArray(parsed) ? parsed[0] : parsed.image || '';
        } catch {}
      } else {
        filename = raw.split(',')[0].trim() || '';
      }
      row.thumbUrl = filename
        ? `/images/${category}/${row.id}/${filename}`
        : null;
    });

    // 11) States & Extra-Options
    const states = Object.keys(stateFilters).filter(st => st !== 'inactive');
    const extraOptions = { watchTypes: [], investmentTypes: [], propertyTypes: [] };
    if (category === 'watches') {
      const [wt] = await db.query(
        `SELECT option_value AS id, option_label AS label
           FROM attribute_options
          WHERE entitie_route = 'watches'
            AND column_name = 'watchtype'
          ORDER BY sort_order`
      );
      extraOptions.watchTypes = wt;
    }
    if (category === 'properties') {
      const [it] = await db.query(
        `SELECT option_value AS id, option_label AS label
           FROM attribute_options
          WHERE entitie_route = 'properties'
            AND column_name = 'investmenttype'
          ORDER BY sort_order`
      );
      const [pt] = await db.query(
        `SELECT option_value AS id, option_label AS label
           FROM attribute_options
          WHERE entitie_route = 'properties'
            AND column_name = 'propertytype'
          ORDER BY sort_order`
      );
      extraOptions.investmentTypes = it;
      extraOptions.propertyTypes   = pt;
    }

    // 12) Rendering
    res.render('admin/list', {
      entieties:    res.locals.entieties,
      active:       'listings',
      category,
      state,
      adType,
      search,
      priceMin,
      priceMax,
      sort,
      rows,
      columns:      cols,
      states,
      currentPage,
      totalPages,
      stateLabels,
      counts,
      mode,
      currentEnt:   ent,
      extraOptions
    });

  } catch (err) {
    next(err);
  }
});


router.post(
  '/listings/:category/:id/insert',
  express.json(),
  async (req, res, next) => {
    try {
      const { category, id: advertId } = req.params;
      const { adType } = req.body; // jetzt kommt das aus dem Fetch
      const ent = res.locals.entieties.find(e => e.route === category);
      if (!ent) return res.status(400).send('Ungültige Kategorie');

      const startDate = moment().format('YYYY-MM-DD');
      const endDate   = moment().add(1, 'year').format('YYYY-MM-DD');

      let sql;
      if (adType === 'slider') {
        sql = `INSERT INTO slider_ads    (entitie_id, advert_id, start_date, end_date)
               VALUES (?, ?, ?, ?)`;
      } else if (adType === 'catalog') {
        sql = `INSERT INTO catalog_ads   (entitie_id, advert_id, start_date, end_date)
               VALUES (?, ?, ?, ?)`;
      } else if (adType === 'inserat') {
        sql = `INSERT INTO advert_inserat (entitie_id, advert_id, start_date, end_date)
               VALUES (?, ?, ?, ?)`;
      } else if (adType === 'katalog_slider') {
              sql = `INSERT INTO katalog_slider
               (entitie_id, advert_id, start_date, end_date)
             VALUES (?, ?, ?, ?)`;
      } else {
        return res.status(400).send('Ungültiger Werbetyp');
      }

      await db.query(sql, [ent.id, advertId, startDate, endDate]);
      res.sendStatus(200);
    } catch (err) { next(err); }
  }
);

router.get('/listings/:category/:id/edit', async (req, res, next) => {
  try {
    const { category, id } = req.params;
    const ent = res.locals.entieties.find(e =>
      e.route === category || String(e.id) === category
    );
    if (!ent) return res.status(404).send('Kategorie nicht gefunden');

    const categoryTypeMap = {
      properties: 1,
      watches: 2,
      cars: 3,
      yachts: 4,
      lifestyles: 5
    };

    // Admin-User laden (für optionale Anzeige wie MwSt.)
    const [[adminUser]] = await db.query(
      'SELECT id, role, firstname, lastname, email, phone FROM users WHERE id = ?',
      [req.session.userId]
    );
    const user = adminUser
      ? {
          ...adminUser,
          registration_type:
            adminUser.role === 1 || adminUser.role === 9
              ? 'commercial'
              : adminUser.role === 2
              ? 'private'
              : null
        }
      : null;

    // 1) Datensatz laden
    const [[item]] = await db.query(
      `SELECT * FROM \`${ent.table_name}\` WHERE id = ?`,
      [id]
    );
    if (!item) return res.status(404).send('Inserat nicht gefunden');

    // 2) Dynamische Attribute (Admin-Editor)
    const allowed = allowedFieldsByRoute[ent.route] || [];
    const attrs = await Promise.all(allowed.map(async col => {
      const attr = {
        column_name: col,
        label:       labelMap[col] || col,
        field_type:  'text',
        options:     []
      };

      // a) Optionen aus attribute_options
      const [opts] = await db.query(
        `SELECT option_value AS id, option_label AS label
           FROM attribute_options
          WHERE entitie_route = ? AND column_name = ?
          ORDER BY sort_order`,
        [ent.route, col]
      );
      if (opts.length) {
        attr.field_type = 'select';
        attr.options    = opts;
        return attr;
      }

      // b) tinyint(1) → boolean
      const [[colDef]] = await db.query(
        `SELECT DATA_TYPE, COLUMN_TYPE
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME   = ?
            AND COLUMN_NAME  = ?`,
        [ent.table_name, col]
      );
      if (colDef?.DATA_TYPE === 'tinyint' && colDef.COLUMN_TYPE === 'tinyint(1)') {
        attr.field_type = 'boolean';
        return attr;
      }

      // c) textarea / number
      if (col === 'description') attr.field_type = 'textarea';
      if ([
        'price','mileage','year','length','beam','berths',
        'energypass_value','livingarea','landarea','floors',
        'bedrooms','bathrooms'
      ].includes(col)) {
        attr.field_type = 'number';
      }

      return attr;
    }));

    // 3) Bilder parsen (PHP-serialize, JSON oder CSV)
    let pics = [];
    const raw = item.pictures || '';

    if (/^a:\d+:{/.test(raw)) {
      // PHP-serialized Array
      try {
        const obj = unserialize(raw);
        pics = Object.values(obj);
      } catch (e) {
        console.warn('Unserialize failed', e);
      }

    } else if (/^[\[\{]/.test(raw)) {
      // JSON
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          if (parsed.length && parsed[0] && parsed[0].image) {
            pics = parsed.map(p => p.image);
          } else {
            pics = parsed;
          }
        }
      } catch (e) {
        console.warn('JSON.parse failed', e);
      }

    } else {
      // CSV-Liste
      pics = raw.split(',').map(s => s.trim()).filter(Boolean);
    }

    item.pictures = pics;

    // 4) Extras laden (für buyer edit template)
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

    // Checkbox-Gruppen (für cars)
    const checkboxGroupsRaw = {
      'Sicherheit': ['abs', 'esp', 'asr', 'isofix'],
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

    // Länder + Filterdaten
    const [countries] = await db.query(
      `SELECT id, de AS name FROM countries WHERE visible = 1 ORDER BY name`
    );

    let brands = [], models = [], lifestyleTypes = [], lifestyleSubcategories = [];
    let years = [], registrationYears = [], nextHuYears = [];

    if (['cars', 'watches', 'yachts'].includes(ent.route)) {
      [brands] = await db.query(
        `SELECT id, name FROM brands WHERE type = ? ORDER BY name`,
        [categoryTypeMap[ent.route]]
      );

      if (brands.length) {
        [models] = await db.query(
          `SELECT id, name, brand_id
           FROM models
           WHERE brand_id = ?
           ORDER BY name`,
          [item.brand_id]
        );
      }
    }

    if (ent.route === 'lifestyles') {
      [lifestyleTypes] = await db.query(
        `SELECT id, name FROM brands WHERE type = 5 ORDER BY name`
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

    let watchCheckboxGroups = {};
    if (ent.route === 'watches') {
      watchCheckboxGroups = {
        'Funktionen': extras.functions || [],
        'Komplikationen': extras.complications || []
      };
    }

    // 5) Rendern
    res.render('pages/templates/edit-listing', {
      active:        'listings',
      currentEntity: ent,
      item,
      attrs, 
      seo: 'Adminpanel',
      currentPage: 'Adminpanel',
      ent,
      user,
      extras,
      filters,
      checkboxGroups,
      watchCheckboxGroups,
      gallery: Array.isArray(pics) ? pics : []
    });

  } catch (err) {
    next(err);
  }
});


router.post('/listings/:category/:id/action', async (req, res, next) => {
  try {
    const { category, id } = req.params;
    const { action }       = req.body;
    const ent = res.locals.entieties.find(e => e.route === category);
    if (!ent) return res.redirect('back');

    let status, visible;
    switch (action) {
      case 'approve':  status = 3; visible = 1; break;
      case 'pend':     status = 7; visible = 0; break;
      case 'stop':     status = 3; visible = 0; break;
      case 'delete':   status = 9; visible = 0; break;
      case 'restore':  status = 1; visible = 0; break;
      default:         return res.redirect('back');
    }

    await db.query(
      `UPDATE \`${ent.table_name}\` SET status = ?, visible = ? WHERE id = ?`,
      [status, visible, id]
    );

    res.redirect(req.get('referer') || '/admin/listings');
  } catch (err) {
    next(err);
  }
});

// Deaktiviert eine Werbung (löscht aus der passenden Ads-Tabelle)
router.post(
  '/listings/:category/:id/ad/disable',
  express.json(),
  async (req, res, next) => {
    try {
      const { category, id } = req.params;
      const { adType } = req.body || {};

      // 1) Validierung adType
      const tableMap = {
        slider:         'slider_ads',
        catalog:        'catalog_ads',
        inserat:        'advert_inserat',
        katalog_slider: 'katalog_slider',
      };
      const table = tableMap[adType];
      if (!table) {
        return res.status(400).json({ ok: false, message: 'Ungültiger adType' });
      }

      // 2) Entität per category ermitteln
      const [[ent]] = await db.query(
        'SELECT id, route FROM ententies WHERE route = ? LIMIT 1',
        [category]
      );
      if (!ent) {
        return res.status(400).json({ ok: false, message: 'Ungültige Kategorie' });
      }

      // 3) Löschen (alle Einträge für diese entitie_id + advert_id)
      const [result] = await db.query(
        `DELETE FROM \`${table}\`
          WHERE entitie_id = ? AND advert_id = ?`,
        [ent.id, id]
      );

      return res.json({ ok: true, deleted: result.affectedRows });
    } catch (err) {
      next(err);
    }
  }
);





router.get('/contacts', async (req, res, next) => {
  try {
    const [contacts] = await db.query(`
      SELECT id, first_name, last_name, email, created_at
        FROM contacts
       ORDER BY created_at DESC
    `);
    // hier das active‑Flag hinzufügen:
    res.render('admin/contacts-list', {
      contacts,
      active: 'contacts'      // <–– NAME der Sidebar‑Sektion, z.B. 'contacts'
    });
  } catch (err) {
    next(err);
  }
});

// 2) Detail
// GET /admin/contacts/:id
router.get('/contacts/:id', async (req, res, next) => {
  try {
    const [[contact]] = await db.query(
      `SELECT * FROM contacts WHERE id = ?`,
      [req.params.id]
    );
    if (!contact) return res.status(404).send('Anfrage nicht gefunden');

    res.render('admin/contacts-detail', {
      contact,
      active: 'contacts'    // <— hier hinzufügen
    });
  } catch (err) {
    next(err);
  }
});


// === ENTITIES (vormals categories) CRUD ===

// 1) Übersicht: alle Entities anzeigen
router.get('/ententies', async (req, res, next) => {
    try {
      const [rows] = await db.query(`
        SELECT id, name, route, table_name, created
        FROM ententies
        ORDER BY created DESC
      `);
      res.render('admin/ententies/list', {
        active:    'ententies',
        ententies: rows,
        userName:  req.session.userName,
        role:      req.session.role
      });
    } catch (err) {
      next(err);
    }
  });
  
  // 2) Formular zum Anlegen
  router.get('/ententies/new', (req, res) => {
    res.render('admin/ententies/form', {
      active:   'ententies',
      entitie:  {},      // leerer Datensatz
      isNew:    true
    });
  });
  
  // 3) Anlegen verarbeiten
  router.post('/ententies/new', async (req, res, next) => {
    try {
      // req.body sollte { name, route, table_name } liefern
      await db.query(`INSERT INTO ententies SET ?`, [req.body]);
      res.redirect('/admin/ententies');
    } catch (err) {
      next(err);
    }
  });
  
  // 4) Formular zum Bearbeiten
  router.get('/ententies/:id/edit', async (req, res, next) => {
    try {
      const [[entitie]] = await db.query(
        `SELECT * FROM ententies WHERE id = ?`,
        [req.params.id]
      );
      res.render('admin/ententies/form', {
        active:   'ententies',
        entitie,
        isNew:    false
      });
    } catch (err) {
      next(err);
    }
  });
  
  // 5) Update verarbeiten
  router.post('/ententies/:id/edit', async (req, res, next) => {
    try {
      await db.query(
        `UPDATE ententies SET ? WHERE id = ?`,
        [req.body, req.params.id]
      );
      res.redirect('/admin/ententies');
    } catch (err) {
      next(err);
    }
  });
  
  // 6) Löschen
  router.post('/ententies/:id/delete', async (req, res, next) => {
    try {
      await db.query(`DELETE FROM ententies WHERE id = ?`, [req.params.id]);
      res.redirect('/admin/ententies');
    } catch (err) {
      next(err);
    }
  });

router.get('/pages',  async (req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT id, slug, title, created, modified FROM pages ORDER BY slug`);
    res.render('admin/pages/list', { pages: rows, active: 'pages' });
  } catch (err) { next(err); }
});

router.get('/pages/new', (req, res) => {
  res.render('admin/pages/edit', {
    page:   {},        // leere Seite
    action: 'new',
    active:'pages'
  });
});

router.post('/pages/new', async (req, res, next) => {
  try {
    const { slug, title, content } = req.body;
    await db.query(
      `INSERT INTO pages (slug, title, content) VALUES (?, ?, ?)`,
      [slug.trim(), title.trim(), content]
    );
    req.flash('success', 'Seite angelegt.');
    res.redirect('/admin/pages');
  } catch (err) { next(err); }
});

router.get('/pages/:slug/edit',  async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const [[page]] = await db.query(`SELECT * FROM pages WHERE slug = ?`, [slug]);
    if (!page) return res.status(404).send('Seite nicht gefunden');
    res.render('admin/pages/edit', { page, action: 'edit', active: 'pages' });
  } catch (err) { next(err); }
});

router.post('/pages/:slug/edit', async (req, res, next) => {
  try {
    const oldSlug = req.params.slug;
    const { slug, title, content } = req.body;
    await db.query(
      `UPDATE pages SET slug = ?, title = ?, content = ? WHERE slug = ?`,
      [ slug.trim(), title.trim(), content, oldSlug ]
    );
    req.flash('success', 'Seite aktualisiert.');
    res.redirect('/admin/pages');
  } catch (err) { next(err); }
});

router.post('/pages/:slug/delete',  async (req, res, next) => {
  try {
    await db.query(`DELETE FROM pages WHERE slug = ?`, [req.params.slug]);
    req.flash('success', 'Seite gelöscht.');
    res.redirect('/admin/pages');
  } catch (err) { next(err); }
});



router.use('/entieties', require('./entieties'));
router.use('/listings', require('./listings'));
router.use('/users', require('./users'));
router.use('/packages', require('./packages'));
router.use('/ads', require('./ads'));
router.use('/news', require('./news'));
router.use('/modbrand', require('./modbrand'));
router.use('/landing', require('./landing'));
router.use('/footer', require('./footer'));
router.use('/postings', require('./postings'));
router.use('/newsletter', require('./newsletter'));
const analyticsRouter = require('./analytics');
router.use('/analytics', analyticsRouter);
router.use('/seo', require('./seo'));
router.use('/ui', require('./ui'));













module.exports = router;

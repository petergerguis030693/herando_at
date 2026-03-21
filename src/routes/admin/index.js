// src/routes/admin/index.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const moment  = require('moment');
const nodemailer = require('nodemailer');
const db      = require('../../db');
const router  = express.Router();
const { generateInvoice } = require('../../service/invoiceService');
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
  rejected:  { where: ['status = 8'] },
  stopped:   { where: ['status = 3', 'visible = 0'] },
  ended:     { where: ['status = 4', 'visible = 0'] },
  deleted:   { where: ['status = 9'] }
};
const states = [
  'all',
  'active',
  'inactive',
  'toapprove', 
  'pending',
  'rejected',
  'stopped',
  'ended',
  'deleted'
];

const stateLabels = {
  active:    'LAUFENDE',
  toapprove: 'FREIZUGEBENDE',   
  pending:   'WARTENDE',
  rejected:  'ABLEHNEN',
  stopped:   'ANGEHALTENE',
  ended:     'BEENDETE',
  deleted:   'GELÖSCHTE'
};

const PLACEMENT_TABLE_BY_ADTYPE = {
  slider: 'slider_ads',
  catalog: 'catalog_ads',
  inserat: 'advert_inserat',
  katalog_slider: 'katalog_slider'
};
const AD_PLACEMENTS = [
  { adType: 'catalog', table: 'catalog_ads', label: 'Slidershow-Startseite' },
  { adType: 'inserat', table: 'advert_inserat', label: 'Top-Slidershow' },
  { adType: 'slider', table: 'slider_ads', label: 'Katalog' },
  { adType: 'katalog_slider', table: 'katalog_slider', label: 'Katalog-Slider' }
];

let placementSortColumnsCache = null;

async function getPlacementSortColumns() {
  if (placementSortColumnsCache) return placementSortColumnsCache;
  const placementTables = Object.values(PLACEMENT_TABLE_BY_ADTYPE);
  const placeholders = placementTables.map(() => '?').join(', ');
  const [rows] = await db.query(
    `SELECT TABLE_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND COLUMN_NAME = 'sort_order'
        AND TABLE_NAME IN (${placeholders})`,
    placementTables
  );
  placementSortColumnsCache = new Set(rows.map(r => String(r.TABLE_NAME || r.table_name || '')));
  return placementSortColumnsCache;
}

async function ensurePlacementSortOrderColumn(table) {
  if (!table) return false;
  const cache = await getPlacementSortColumns();
  if (cache.has(table)) return true;
  await db.query(
    `ALTER TABLE \`${table}\`
       ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER advert_id`
  );
  cache.add(table);
  placementSortColumnsCache = cache;
  return true;
}

function placementOrderSql(alias) {
  const a = alias ? `${alias}.` : '';
  return `CASE WHEN COALESCE(${a}sort_order, 0) > 0 THEN 0 ELSE 1 END, COALESCE(${a}sort_order, 0) ASC, ${a}start_date DESC, ${a}id DESC`;
}

const INVOICE_PDF_DIR = path.join(__dirname, '../../public/assets/pdf/invoices');
const ACCOUNTING_SUCCESS_PAYMENT_STATUSES = ['succeeded', 'paid', 'simulated'];

function paidOrderExistsSql(orderAlias = 'o') {
  const a = /^[a-z_][a-z0-9_]*$/i.test(orderAlias) ? orderAlias : 'o';
  const statuses = ACCOUNTING_SUCCESS_PAYMENT_STATUSES.map(s => `'${s}'`).join(', ');
  return `EXISTS (
    SELECT 1
      FROM payments pm
     WHERE pm.order_id = ${a}.id
       AND pm.status IN (${statuses})
  )`;
}

function getInvoicePdfFileSet() {
  try {
    const files = fs.readdirSync(INVOICE_PDF_DIR);
    return new Set(files);
  } catch {
    return new Set();
  }
}

function invoiceOutputDir() {
  const rel = (process.env.INVOICE_OUTPUT_DIR || 'public/assets/pdf/invoices').trim();
  return path.resolve(process.cwd(), rel);
}

function invoicePdfFilenamesForOrder(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) return [];
  return [`invoice_${id}.pdf`, `rechnung_${id}.pdf`];
}

async function generateInvoicePdfBytes(orderData) {
  return new Promise((resolve, reject) => {
    generateInvoice(orderData, (err, pdfBytes) => {
      if (err) return reject(err);
      resolve(pdfBytes);
    });
  });
}

async function loadAdminOrderInvoiceData(orderId) {
  const [[orderData]] = await db.query(
    `
    SELECT
      o.*,
      p.name AS product,
      COALESCE(p.price, 0) AS amount,
      COALESCE(ctr.tax_rate, 0) AS taxPercentage,

      -- Partnerdaten
      u.id AS partner_partnerident,
      u.firstname AS partner_first_name,
      u.lastname AS partner_last_name,
      u.street AS partner_street,
      u.housenumber AS partner_housenumber,
      u.postcode AS partner_postcode,
      CONCAT(COALESCE(u.street,''),' ',COALESCE(u.housenumber,'')) AS partner_address,
      CONCAT(COALESCE(u.postcode,''),' ',COALESCE(u.city,'')) AS partner_city,
      u.company AS partner_firmenname,
      u.vatid AS partner_atu_nummer,
      u.email AS partner_email,
      c.de AS partner_country,
      COALESCE(ctr.abbreviation, c.code, 'DE') AS partner_abbreviation,
      c.code AS partner_country_code,

      -- Paket/Zeitraum
      sp.start_date,
      sp.end_date,
      DATE_FORMAT(sp.end_date, '%d.%m.%Y') AS package_end_formatted,
      sp.max_listings,
      sp.used_listings,

      -- Entität
      e.name AS entity_name,
      e.route AS entity_route,
      e.description AS entity_description,

      o.id AS order_number,
      (
        SELECT pm.status
        FROM payments pm
        WHERE pm.order_id = o.id
        ORDER BY pm.id DESC
        LIMIT 1
      ) AS payment_status
    FROM orders o
    LEFT JOIN packages p ON p.id = o.package_id
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN countries c ON c.id = o.country_id
    LEFT JOIN country_tax_rates ctr ON ctr.country_id = o.country_id
    LEFT JOIN selected_packages sp
      ON sp.order_id = o.id
     AND sp.user_id = o.user_id
     AND sp.package_id = o.package_id
     AND sp.category_id = o.category_id
    LEFT JOIN ententies e ON e.id = o.category_id
    WHERE o.id = ?
      AND ${paidOrderExistsSql('o')}
    LIMIT 1
    `,
    [orderId]
  );

  if (!orderData) return null;

  const locale = 'de';
  orderData.locale = locale;
  orderData.entity_key = `entity.${orderData.entity_route || 'default'}`;
  orderData.package_key = `package.${String(orderData.product || '')
    .toLowerCase()
    .replace(/ /g, '_')
    .replace(/-/g, '_')}`;
  orderData.ad_key = 'invoice.ad';
  orderData.invoice_code = `${orderData.partner_abbreviation || orderData.partner_country_code || 'DE'}-${orderData.order_number}`;
  orderData.order_id_txt = `${orderData.order_number}`;
  orderData.original_net = Number(orderData.amount || 0);
  orderData.discount_percent = 0;
  orderData.discount_amount = 0;
  orderData.net_after_discount = Number(orderData.amount || 0);
  orderData.payment_status = orderData.payment_status || 'paid';

  return orderData;
}

async function ensureOrderInvoicePdf(orderId) {
  const id = parseInt(orderId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const outDir = invoiceOutputDir();
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  for (const name of invoicePdfFilenamesForOrder(id)) {
    const abs = path.join(outDir, name);
    if (fs.existsSync(abs)) return { filename: name, absPath: abs, generated: false };
  }

  const orderData = await loadAdminOrderInvoiceData(id);
  if (!orderData) return null;

  const pdfBytes = await generateInvoicePdfBytes(orderData);
  const filename = `invoice_${id}.pdf`;
  const absPath = path.join(outDir, filename);
  fs.writeFileSync(absPath, pdfBytes);
  return { filename, absPath, generated: true };
}

function adminNormalizeText(value, maxLen = 255) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function adminEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adminMessageToHtml(value, maxLen = 3000) {
  const normalized = String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLen);
  return adminEscapeHtml(normalized).replace(/\n/g, '<br>');
}

function adminNormalizeLang(value, fallback = 'de') {
  const raw = String(value || '').toLowerCase().split(/[-_]/)[0];
  const allowed = new Set(['de', 'nl', 'en']);
  if (allowed.has(raw)) return raw;
  return fallback;
}

function adminGetContactMailCopy(langInput = 'de') {
  const lang = adminNormalizeLang(langInput, 'de');
  const map = {
    de: {
      sellerIntro: 'Sie haben eine Nachricht über',
      sellerReceivedSuffix: 'erhalten:',
      nameLabel: 'Name:',
      emailLabel: 'E-Mail:',
      phoneLabel: 'Telefon:',
      noPhone: 'Keine Angabe',
      sellerViewListing: 'Inserat anschauen',
      sellerReplyHint: 'Antworten Sie dem Interessenten direkt per E-Mail.',
      regards: 'Mit freundlichen Grüßen',
      team: 'Ihr Herando-Team',
      sellerSubject: 'Sie haben eine Anfrage zu Ihrem Inserat'
    },
    nl: {
      sellerIntro: 'U heeft een bericht ontvangen via',
      sellerReceivedSuffix: ':',
      nameLabel: 'Naam:',
      emailLabel: 'E-mail:',
      phoneLabel: 'Telefoon:',
      noPhone: 'Niet opgegeven',
      sellerViewListing: 'Advertentie bekijken',
      sellerReplyHint: 'Beantwoord de geïnteresseerde direct per e-mail.',
      regards: 'Met vriendelijke groet',
      team: 'Uw Herando-team',
      sellerSubject: 'U heeft een aanvraag voor uw advertentie ontvangen'
    },
    en: {
      sellerIntro: 'You have received a message via',
      sellerReceivedSuffix: ':',
      nameLabel: 'Name:',
      emailLabel: 'Email:',
      phoneLabel: 'Phone:',
      noPhone: 'Not provided',
      sellerViewListing: 'View listing',
      sellerReplyHint: 'Please reply to the interested buyer directly by email.',
      regards: 'Kind regards',
      team: 'Your Herando Team',
      sellerSubject: 'You have received an inquiry for your listing'
    }
  };
  return map[lang] || map.de;
}

function buildSellerGreeting({ lang, gender, firstName, lastName, fallbackName }) {
  const first = adminNormalizeText(firstName, 120);
  const last = adminNormalizeText(lastName, 120);
  const full = `${first} ${last}`.trim();
  const name = full || adminNormalizeText(fallbackName, 255);
  const suffix = name ? ` ${adminEscapeHtml(name)}` : '';
  const language = adminNormalizeLang(lang, 'de');
  const g = Number(gender || 0);
  const isMale = g === 1 || g === 2;
  const isFemale = g === 3;
  if (language === 'nl') {
    if (isMale) return `Geachte heer${suffix}`;
    if (isFemale) return `Geachte mevrouw${suffix}`;
    return `Geachte heer/mevrouw${suffix}`;
  }
  if (language === 'en') {
    if (isMale) return `Dear Mr.${suffix}`;
    if (isFemale) return `Dear Ms.${suffix}`;
    return `Dear Sir or Madam${suffix}`;
  }
  if (isMale) return `Sehr geehrter Herr${suffix}`;
  if (isFemale) return `Sehr geehrte Frau${suffix}`;
  return `Sehr geehrte Frau/Herr${suffix}`;
}

function buildRequestListingUrl(baseUrl, entity, advertId) {
  const base = String(baseUrl || 'https://www.herando.at').replace(/\/+$/g, '');
  const route = String(entity || '').trim().replace(/^\/+|\/+$/g, '');
  const id = Number(advertId);
  if (!route || !Number.isInteger(id) || id <= 0) return base;
  return `${base}/${encodeURIComponent(route)}/${id}`;
}

function buildSellerRequestEmailHtml({
  anrede,
  copy,
  baseUrl,
  safeMessageHtml,
  safeBuyerName,
  safeBuyerEmail,
  safeBuyerPhone,
  safeListingUrl
}) {
  return `
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
  ${copy.sellerIntro}
  <a href="${safeListingUrl}" target="_blank">www.herando.com</a> ${copy.sellerReceivedSuffix}
</p>

<p style="font-style:italic">
  "${safeMessageHtml}"
</p>

<p>${copy.nameLabel} ${safeBuyerName}</p>
<p>${copy.emailLabel} <a href="mailto:${safeBuyerEmail}">${safeBuyerEmail}</a></p>
<p>${copy.phoneLabel} ${safeBuyerPhone || copy.noPhone}</p>

<table width="100%" style="width:100%;border-collapse:separate;box-sizing:border-box">
  <tr>
    <td align="left" style="padding-bottom:15px">

      <table border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:auto">
        <tr>
          <td align="center" bgcolor="#c39052"
              style="background-color:#c39052;text-align:center">

            <a href="${safeListingUrl}"
               target="_blank"
               style="display:inline-block;color:#ffffff;background-color:#c39052;
               border:none;text-decoration:none;font-size:16px;font-weight:400;
               margin:0;padding:10px;">
              ${copy.sellerViewListing}
            </a>

          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  ${copy.sellerReplyHint}
</p>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  ${copy.regards}
</p>

<p style="font-family:sans-serif;font-size:14px;margin:0 0 15px 0">
  ${copy.team}
</p>

                </td>
              </tr>
            </table>

          </td>
        </tr>
      </table>

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
}

function parseAdminReturnTo(value, fallback = '/admin/seller-requests') {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/admin/seller-requests')) return fallback;
  return raw;
}

function appendRedirectParam(url, key, value) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

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

const ALLOWED_ADMIN_ROLES = new Set([7, 8, 9]);
const ALLOWED_ADMIN_ROLE_LIST = [...ALLOWED_ADMIN_ROLES];
const ALLOWED_ADMIN_ROLE_SQL = ALLOWED_ADMIN_ROLE_LIST.map(() => '?').join(', ');

function getBaseUrl(req) {
  const configured = String(process.env.BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function createSmtpTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function getAdminHomeForRole(role) {
  if (role === 7 || role === 8) return '/admin/listings';
  return '/admin';
}

function isAllowedPathForRole(role, path) {
  const p = typeof path === 'string' ? path : '/';

  if (role === 9) return true;

  if (role === 8) {
    if (p === '/' || p === '/api/stats') return true;
    if (p === '/logout') return true;
    return (
      p === '/listings' || p.startsWith('/listings/') ||
      p === '/jobs' || p.startsWith('/jobs/') ||
      p === '/users' || p.startsWith('/users/') ||
      p === '/modbrand' || p.startsWith('/modbrand/') ||
      p === '/bund' || p.startsWith('/bund/') ||
      p === '/analytics' || p.startsWith('/analytics/') ||
      p === '/accounting' || p.startsWith('/accounting/') ||
      p === '/seo' || p.startsWith('/seo/') ||
      p === '/sitemap' || p.startsWith('/sitemap/')
    );
  }

  if (role === 7) {
    if (p === '/') return true;
    if (p === '/logout') return true;
    return (
      p === '/listings' || p.startsWith('/listings/') ||
      p === '/jobs' || p.startsWith('/jobs/') ||
      p === '/entieties' || p.startsWith('/entieties/') ||
      p === '/bund' || p.startsWith('/bund/') ||
      p === '/ui' || p.startsWith('/ui/') ||
      p === '/seo' || p.startsWith('/seo/') ||
      p === '/sitemap' || p.startsWith('/sitemap/')
    );
  }

  return false;
}



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
    const role = Number(req.session.role);
    if (ALLOWED_ADMIN_ROLES.has(role)) {
      return res.redirect(getAdminHomeForRole(role));
    }
    return res.redirect('/buyer');
  }
  const message = req.query?.message ? String(req.query.message) : null;
  res.render('admin/login', { error: null, message });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [[user]] = await db.query(
      `SELECT id, email, password, confirmed, role,
              COALESCE(admin_login_failed_attempts, 0) AS admin_login_failed_attempts,
              COALESCE(admin_login_locked, 0) AS admin_login_locked
         FROM users
         WHERE email = ?
         LIMIT 1`,
      [username]
    );

    if (!user || Number(user.confirmed) !== 1) return renderNotFound(req, res);
    const isAdminUser = ALLOWED_ADMIN_ROLES.has(Number(user.role));

    if (Number(user.admin_login_locked) === 1) {
      if (isAdminUser) {
        return res.render('admin/login', {
          error: 'Konto temporär gesperrt. Bitte Passwort zurücksetzen (gleiches oder neues Passwort) oder im Admin entsperren.',
          message: null
        });
      }
      return renderNotFound(req, res);
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
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

      if (shouldLock) {
        console.warn(`🚫 Login temporär gesperrt für User #${user.id} (${user.email}) nach ${nextAttempts} Fehlversuchen.`);
      }
      return renderNotFound(req, res);
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

    if (!isAdminUser) {
      return res.redirect('/buyer');
    }

    // ✅ Session setzen
    req.session.userId = user.id;
    req.session.role   = user.role;

    console.log("✅ Login erfolgreich, Session gesetzt:", req.session);

    // ✅ Session speichern und erst dann redirecten
    req.session.save(err => {
      if (err) {
        console.error("❌ Session konnte nicht gespeichert werden:", err);
        return res.render('admin/login', { error: 'Fehler beim Speichern der Session.', message: null });
      }
      return res.redirect(getAdminHomeForRole(Number(user.role)));
    });

  } catch (err) {
    console.error(err);
    return res.render('admin/login', { error: 'Fehler beim Einloggen. Bitte später erneut.', message: null });
  }
});

router.get('/forgot-password', (req, res) => {
  if (req.session?.userId) {
    const role = Number(req.session.role);
    if (ALLOWED_ADMIN_ROLES.has(role)) {
      return res.redirect(getAdminHomeForRole(role));
    }
    return res.redirect('/buyer');
  }

  const error = req.query?.error ? String(req.query.error) : null;
  const message = req.query?.message ? String(req.query.message) : null;
  const redirectHome = String(req.query?.redirectHome || '') === '1';
  return res.render('admin/forgot-password', { error, message, redirectHome });
});

router.post('/forgot-password', async (req, res) => {
  const successMessage = 'Reset-Link wurde gesendet.';
  const successRedirect = `/admin/forgot-password?message=${encodeURIComponent(successMessage)}`;
  const notTeamMessage = 'Sie gehören nicht zum Team deswegen werden Sie weitergeleitet zu der Startseite! Danke!';
  const notTeamRedirect = `/admin/forgot-password?error=${encodeURIComponent(notTeamMessage)}&redirectHome=1`;

  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.redirect(notTeamRedirect);

    const [[user]] = await db.query(
      `SELECT id, firstname, email, role
         FROM users
        WHERE email = ?
          AND confirmed = 1
        LIMIT 1`,
      [email]
    );

    if (!user || !ALLOWED_ADMIN_ROLES.has(Number(user.role))) {
      return res.redirect(notTeamRedirect);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await db.query('DELETE FROM email_verifications WHERE user_id = ?', [user.id]);
    await db.query(
      `INSERT INTO email_verifications (user_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [user.id, token, expiresAt]
    );

    const resetLink = `${getBaseUrl(req)}/admin/reset-password?token=${encodeURIComponent(token)}`;
    const transporter = createSmtpTransporter();

    await transporter.sendMail({
      from: `"Herando Admin" <${process.env.SMTP_USER}>`,
      to: user.email,
      subject: 'Admin-Passwort zurücksetzen',
      html: `
        <p>Hallo ${user.firstname || ''},</p>
        <p>du hast eine Zurücksetzung für dein Admin-Passwort angefordert.</p>
        <p>
          <a href="${resetLink}"
             style="display:inline-block;background:#111827;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px;">
            Passwort zurücksetzen
          </a>
        </p>
        <p>Der Link ist 1 Stunde gültig.</p>
      `
    });

    return res.redirect(successRedirect);
  } catch (err) {
    console.error('POST /admin/forgot-password error:', err);
    return res.redirect(`/admin/forgot-password?error=${encodeURIComponent('Reset-Link konnte nicht gesendet werden. Bitte später erneut versuchen.')}`);
  }
});

router.get('/reset-password', async (req, res) => {
  if (req.session?.userId) {
    const role = Number(req.session.role);
    if (ALLOWED_ADMIN_ROLES.has(role)) {
      return res.redirect(getAdminHomeForRole(role));
    }
    return res.redirect('/buyer');
  }

  const token = String(req.query?.token || '').trim();
  if (!token) {
    return res.redirect(`/admin/forgot-password?error=${encodeURIComponent('Ungültiger Reset-Link.')}`);
  }

  try {
    const [[row]] = await db.query(
      `SELECT ev.user_id
         FROM email_verifications ev
         JOIN users u ON u.id = ev.user_id
        WHERE ev.token = ?
          AND ev.expires_at >= NOW()
          AND u.confirmed = 1
          AND u.role IN (${ALLOWED_ADMIN_ROLE_SQL})
        LIMIT 1`,
      [token, ...ALLOWED_ADMIN_ROLE_LIST]
    );

    if (!row) {
      return res.redirect(`/admin/forgot-password?error=${encodeURIComponent('Reset-Link ist ungültig oder abgelaufen.')}`);
    }

    return res.render('admin/reset-password', { token, error: null });
  } catch (err) {
    console.error('GET /admin/reset-password error:', err);
    return res.redirect(`/admin/forgot-password?error=${encodeURIComponent('Reset-Link konnte nicht geprüft werden.')}`);
  }
});

router.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');
  const passwordRepeat = String(req.body?.passwordRepeat || '');

  if (!token) {
    return res.redirect(`/admin/forgot-password?error=${encodeURIComponent('Ungültiger Reset-Link.')}`);
  }

  if (password.length < 8) {
    return res.render('admin/reset-password', { token, error: 'Passwort muss mindestens 8 Zeichen haben.' });
  }
  if (password !== passwordRepeat) {
    return res.render('admin/reset-password', { token, error: 'Passwörter stimmen nicht überein.' });
  }

  try {
    const [[row]] = await db.query(
      `SELECT ev.user_id
         FROM email_verifications ev
         JOIN users u ON u.id = ev.user_id
        WHERE ev.token = ?
          AND ev.expires_at >= NOW()
          AND u.confirmed = 1
          AND u.role IN (${ALLOWED_ADMIN_ROLE_SQL})
        LIMIT 1`,
      [token, ...ALLOWED_ADMIN_ROLE_LIST]
    );

    if (!row) {
      return res.render('admin/reset-password', { token, error: 'Reset-Link ist ungültig oder abgelaufen.' });
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
    await db.query('DELETE FROM email_verifications WHERE token = ?', [token]);

    return res.redirect(`/admin/login?message=${encodeURIComponent('Passwort erfolgreich geändert. Bitte einloggen.')}`);
  } catch (err) {
    console.error('POST /admin/reset-password error:', err);
    return res.render('admin/reset-password', { token, error: 'Serverfehler. Bitte später erneut versuchen.' });
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
  const role = Number(req.session.role);
  if (!ALLOWED_ADMIN_ROLES.has(role)) return res.redirect('/buyer');
  if (!isAllowedPathForRole(role, req.path)) return res.redirect('/buyer');
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
    if ([7, 8].includes(Number(req.session.role))) {
      return res.redirect('/admin/listings');
    }

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

    // 4b) Entitäten laden
    let entieties = Array.isArray(res.locals.entieties) ? res.locals.entieties : [];
    if (!entieties.length) {
      const [rows] = await db.query(`
        SELECT id, name, route, table_name
        FROM ententies
        ORDER BY name
      `);
      entieties = rows;
    }

    // 4c) Listings pro Entität zählen + neue Inserate (24h)
    const listingsByType = {};
    const listingsCreatedLast24ByType = {};
    let listingsCreatedLast24Total = 0;

    for (const ent of entieties) {
      const table = ent.table_name;
      const label = ent.name;

      const [[flags]] = await db.query(
        `SELECT
           SUM(CASE WHEN COLUMN_NAME='stopdate' THEN 1 ELSE 0 END) AS has_stopdate,
           SUM(CASE WHEN COLUMN_NAME='visible'  THEN 1 ELSE 0 END) AS has_visible,
           SUM(CASE WHEN COLUMN_NAME='status'   THEN 1 ELSE 0 END) AS has_status,
           SUM(CASE WHEN COLUMN_NAME='created'  THEN 1 ELSE 0 END) AS has_created
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME IN ('stopdate','visible','status','created')`,
        [table]
      );

      let whereActive = '1=1';
      if (Number(flags?.has_status || 0) > 0) whereActive += ' AND `status` = 3';
      if (Number(flags?.has_visible || 0) > 0) whereActive += ' AND `visible` = 1';

      const [[{ cnt }]] = await db.query(
        `SELECT COUNT(*) AS cnt FROM \`${table}\` WHERE ${whereActive}`
      );
      listingsByType[label] = Number(cnt || 0);

      let newCnt = 0;
      if (Number(flags?.has_created || 0) > 0) {
        const [[rowNew]] = await db.query(
          `SELECT COUNT(*) AS cnt
             FROM \`${table}\`
            WHERE created >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
        );
        newCnt = Number(rowNew?.cnt || 0);
      }
      listingsCreatedLast24ByType[label] = newCnt;
      listingsCreatedLast24Total += newCnt;
    }

    // 4d) Umsatz pro Monat (letzte 6 Monate)
    const [revenueRaw] = await db.query(`
      SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month,
             COALESCE(SUM(p.price), 0) AS revenue
      FROM orders o
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
        AND ${paidOrderExistsSql('o')}
      GROUP BY month
      ORDER BY month
    `);
    const revenuePerMonth = [];
    for (let i = 5; i >= 0; i--) {
      const m = moment().subtract(i, 'months').format('YYYY-MM');
      const rec = revenueRaw.find(r => r.month === m);
      revenuePerMonth.push({ month: m, revenue: rec?.revenue || 0 });
    }

    // 4e) Dashboard-Snapshot (24h)
    const [[snapshot24h]] = await db.query(`
      SELECT
        (SELECT COUNT(*)
           FROM users
          WHERE created >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND COALESCE(role, 0) NOT IN (7,8,9)) AS new_customers_24h,
        (SELECT COUNT(*)
           FROM selected_packages sp
           JOIN orders o ON o.id = sp.order_id
          WHERE sp.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND ${paidOrderExistsSql('o')}) AS new_listing_packages_24h,
        (SELECT COUNT(*)
           FROM user_package_orders
          WHERE start_date >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND status = 'paid') AS new_marketing_packages_24h,
        (SELECT COUNT(*)
           FROM visit_sessions
          WHERE last_seen >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS visitors_24h,
        (SELECT COUNT(*)
           FROM visit_sessions
          WHERE user_id IS NOT NULL
            AND last_seen >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS known_visitors_24h,
        (SELECT COUNT(*)
           FROM visit_pageviews
          WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS pageviews_24h,
        (SELECT COUNT(*)
           FROM visit_events
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS events_24h,
        (SELECT COUNT(*)
           FROM orders o
          WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND ${paidOrderExistsSql('o')}) AS invoices_24h,
        (SELECT COALESCE(SUM(p.price),0)
           FROM orders o
           LEFT JOIN packages p ON p.id = o.package_id
          WHERE o.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
            AND ${paidOrderExistsSql('o')}) AS revenue_24h
    `);

    // 4f) Neue Kunden (letzte 10) inkl. letzter Aktivität
    const [recentCustomers] = await db.query(`
      SELECT
        u.id,
        u.role,
        u.email,
        u.company,
        u.firstname,
        u.lastname,
        DATE_FORMAT(u.created, '%Y-%m-%d %H:%i:%s') AS created,
        DATE_FORMAT(MAX(vs.last_seen), '%Y-%m-%d %H:%i:%s') AS last_online,
        COUNT(vs.id) AS analytics_sessions
      FROM users u
      LEFT JOIN visit_sessions vs ON vs.user_id = u.id
      WHERE COALESCE(u.role, 0) NOT IN (7,8,9)
      GROUP BY u.id, u.role, u.email, u.company, u.firstname, u.lastname, u.created
      ORDER BY u.created DESC
      LIMIT 10
    `);

    // 4g) Neu gebuchte Listing-Pakete (letzte 10)
    const [recentPackageBookings] = await db.query(`
      SELECT
        sp.id,
        sp.user_id,
        sp.package_id,
        sp.order_id,
        DATE_FORMAT(sp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(sp.start_date, '%Y-%m-%d %H:%i:%s') AS start_date,
        DATE_FORMAT(sp.end_date, '%Y-%m-%d %H:%i:%s') AS end_date,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.firstname,''), ' ', COALESCE(u.lastname,''))), ''), NULLIF(u.company,''), u.email, CONCAT('#', u.id)) AS customer_name,
        u.email,
        COALESCE(p.name, o.product, sp.package_id) AS package_name,
        e.name AS category_name
      FROM selected_packages sp
      LEFT JOIN users u ON u.id = sp.user_id
      LEFT JOIN packages p ON p.id = sp.package_id
      LEFT JOIN orders o ON o.id = sp.order_id
      LEFT JOIN ententies e ON e.id = sp.category_id
      WHERE o.id IS NOT NULL
        AND ${paidOrderExistsSql('o')}
      ORDER BY sp.created_at DESC
      LIMIT 10
    `);

    // 4h) Neu gebuchte Werbe-/Userpackages (letzte 10)
    const [recentUserPackageOrders] = await db.query(`
      SELECT
        up.id,
        up.user_id,
        up.item_id,
        up.status,
        DATE_FORMAT(up.start_date, '%Y-%m-%d %H:%i:%s') AS start_date,
        DATE_FORMAT(up.end_date, '%Y-%m-%d %H:%i:%s') AS end_date,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.firstname,''), ' ', COALESCE(u.lastname,''))), ''), NULLIF(u.company,''), u.email, CONCAT('#', u.id)) AS customer_name,
        u.email,
        COALESCE(pkg.name, CONCAT('Userpackage #', up.users_package_id)) AS package_name
      FROM user_package_orders up
      LEFT JOIN users u ON u.id = up.user_id
      LEFT JOIN users_packages pkg ON pkg.id = up.users_package_id
      WHERE up.status = 'paid'
      ORDER BY up.start_date DESC, up.id DESC
      LIMIT 10
    `);

    // 4i) Top Seiten/Referrer (24h) aus Analytics
    const [topPages24h] = await db.query(`
      SELECT path, COUNT(*) AS views, ROUND(AVG(duration_ms)/1000, 1) AS avg_time_s
      FROM visit_pageviews
      WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY path
      ORDER BY views DESC
      LIMIT 10
    `);

    const [topReferrers24h] = await db.query(`
      SELECT referer, COUNT(*) AS hits
      FROM visit_pageviews
      WHERE started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND referer IS NOT NULL AND referer <> ''
      GROUP BY referer
      ORDER BY hits DESC
      LIMIT 10
    `);

    // 4j) Buchhaltungs-Kurzwerte + letzte Rechnungen
    const [[accountingSummary]] = await db.query(`
      SELECT
        COUNT(*) AS total_invoices,
        COALESCE(SUM(p.price), 0) AS total_revenue,
        SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS invoices_30d,
        COALESCE(SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN p.price ELSE 0 END), 0) AS revenue_30d,
        SUM(CASE WHEN DATE(o.created_at) = CURDATE() THEN 1 ELSE 0 END) AS invoices_today,
        COALESCE(SUM(CASE WHEN DATE(o.created_at) = CURDATE() THEN p.price ELSE 0 END), 0) AS revenue_today
      FROM orders o
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE ${paidOrderExistsSql('o')}
    `);

    const [recentInvoices] = await db.query(`
      SELECT
        o.id,
        CONCAT('Order #', o.id) AS document,
        COALESCE(p.price, 0) AS amount,
        o.user_id,
        DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') AS created,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.firstname,''), ' ', COALESCE(u.lastname,''))), ''), NULLIF(u.company,''), u.email, CONCAT('#', o.user_id)) AS customer_name,
        u.email
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE ${paidOrderExistsSql('o')}
      ORDER BY o.created_at DESC
      LIMIT 8
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
      entieties,

      snapshot24h: {
        ...(snapshot24h || {}),
        listings_created_24h_total: listingsCreatedLast24Total
      },
      listingsCreatedLast24ByType,
      recentCustomers,
      recentPackageBookings,
      recentUserPackageOrders,
      topPages24h,
      topReferrers24h,
      accountingSummary: accountingSummary || {},
      recentInvoices
    });
  } catch (err) {
    next(err);
  }
});



 
// ——————————————————————————
// API: Stats für Chart.js
// ——————————————————————————
router.get('/api/stats', async (req, res, next) => {
  if (![8, 9].includes(Number(req.session.role))) return res.status(403).end();
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
         WHERE status = 3
           AND visible = 1`
      );
      listingsByType[label] = cnt;
    }

    const [revenueRaw] = await db.query(`
      SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month,
             COALESCE(SUM(p.price), 0) AS revenue
      FROM orders o
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
        AND ${paidOrderExistsSql('o')}
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

// ——————————————————————————
// BUCHHALTUNG (Rechnungen / Umsatz)
// ——————————————————————————
router.get('/accounting', async (req, res, next) => {
  if (![8, 9].includes(Number(req.session.role))) return res.status(403).end();

  try {
    const [[summary]] = await db.query(`
      SELECT
        COUNT(*) AS total_invoices,
        COALESCE(SUM(p.price), 0) AS total_revenue,
        COUNT(DISTINCT o.user_id) AS billed_customers,
        SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS invoices_24h,
        COALESCE(SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN p.price ELSE 0 END), 0) AS revenue_24h,
        SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS invoices_30d,
        COALESCE(SUM(CASE WHEN o.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN p.price ELSE 0 END), 0) AS revenue_30d,
        SUM(CASE WHEN YEAR(o.created_at)=YEAR(CURDATE()) AND MONTH(o.created_at)=MONTH(CURDATE()) THEN 1 ELSE 0 END) AS invoices_mtd,
        COALESCE(SUM(CASE WHEN YEAR(o.created_at)=YEAR(CURDATE()) AND MONTH(o.created_at)=MONTH(CURDATE()) THEN p.price ELSE 0 END), 0) AS revenue_mtd
      FROM orders o
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE ${paidOrderExistsSql('o')}
    `);

    const [invoiceRows] = await db.query(
      `
      SELECT
        o.id,
        CONCAT('Order #', o.id) AS document,
        COALESCE(p.price, 0) AS amount,
        o.user_id,
        DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') AS created,
        NULL AS modified,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.firstname,''), ' ', COALESCE(u.lastname,''))), ''), NULLIF(u.company,''), u.email, CONCAT('#', o.user_id)) AS customer_name,
        u.email
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE ${paidOrderExistsSql('o')}
      ORDER BY o.created_at DESC, o.id DESC
      `,
      []
    );

    const invoiceFiles = getInvoicePdfFileSet();
    for (const row of invoiceRows) {
      const candidates = invoicePdfFilenamesForOrder(row.id);
      const filename = candidates.find((f) => invoiceFiles.has(f)) || null;
      row.pdf_filename = filename || null;
      row.pdf_exists = !!filename;
      row.pdf_url = filename ? `/assets/pdf/invoices/${encodeURIComponent(filename)}` : null;
      row.pdf_download_url = `/admin/accounting/orders/${row.id}/invoice`;
    }

    const [revenueRaw] = await db.query(`
      SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month, COALESCE(SUM(p.price),0) AS revenue
      FROM orders o
      LEFT JOIN packages p ON p.id = o.package_id
      WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
        AND ${paidOrderExistsSql('o')}
      GROUP BY month
      ORDER BY month
    `);
    const revenueByMonth12 = [];
    for (let i = 11; i >= 0; i--) {
      const m = moment().subtract(i, 'months').format('YYYY-MM');
      const rec = revenueRaw.find(r => r.month === m);
      revenueByMonth12.push({ month: m, revenue: Number(rec?.revenue || 0) });
    }

    const [recentListingPackages] = await db.query(`
      SELECT
        sp.id,
        sp.order_id,
        sp.user_id,
        DATE_FORMAT(sp.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
        DATE_FORMAT(sp.start_date, '%Y-%m-%d %H:%i:%s') AS start_date,
        DATE_FORMAT(sp.end_date, '%Y-%m-%d %H:%i:%s') AS end_date,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.firstname,''), ' ', COALESCE(u.lastname,''))), ''), NULLIF(u.company,''), u.email, CONCAT('#', u.id)) AS customer_name,
        u.email,
        COALESCE(p.name, o.product, sp.package_id) AS package_name,
        e.name AS category_name
      FROM selected_packages sp
      LEFT JOIN users u ON u.id = sp.user_id
      LEFT JOIN packages p ON p.id = sp.package_id
      LEFT JOIN orders o ON o.id = sp.order_id
      LEFT JOIN ententies e ON e.id = sp.category_id
      WHERE o.id IS NOT NULL
        AND ${paidOrderExistsSql('o')}
      ORDER BY sp.created_at DESC
      LIMIT 20
    `);

    const [recentAdPackages] = await db.query(`
      SELECT
        up.id,
        up.user_id,
        up.item_id,
        up.status,
        DATE_FORMAT(up.start_date, '%Y-%m-%d %H:%i:%s') AS start_date,
        DATE_FORMAT(up.end_date, '%Y-%m-%d %H:%i:%s') AS end_date,
        COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.firstname,''), ' ', COALESCE(u.lastname,''))), ''), NULLIF(u.company,''), u.email, CONCAT('#', u.id)) AS customer_name,
        u.email,
        COALESCE(pkg.name, CONCAT('Userpackage #', up.users_package_id)) AS package_name
      FROM user_package_orders up
      LEFT JOIN users u ON u.id = up.user_id
      LEFT JOIN users_packages pkg ON pkg.id = up.users_package_id
      WHERE up.status = 'paid'
      ORDER BY up.start_date DESC, up.id DESC
      LIMIT 20
    `);

    res.render('admin/accounting', {
      active: 'accounting',
      role: req.session.role,
      summary: summary || {},
      invoiceRows,
      revenueByMonth12,
      recentListingPackages,
      recentAdPackages,
      pagination: {
        page: 1,
        perPage: invoiceRows.length,
        totalRows: invoiceRows.length,
        totalPages: 1
      }
    });
  } catch (err) {
    next(err);
  }
});

router.get('/accounting/orders/:id/invoice', async (req, res, next) => {
  if (![8, 9].includes(Number(req.session.role))) return res.status(403).end();

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Ungültige Order-ID.');

    const [[order]] = await db.query(
      `SELECT id, product FROM orders WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!order) return res.status(404).send('Bestellung nicht gefunden.');

    const ensured = await ensureOrderInvoicePdf(id);
    if (!ensured?.filename || !ensured?.absPath || !fs.existsSync(ensured.absPath)) {
      return res.status(404).send('Rechnungs-PDF zur Bestellung konnte nicht gefunden oder erstellt werden.');
    }

    const safeProduct = String(order.product || 'order').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
    const downloadName = `rechnung_order_${id}_${safeProduct || 'order'}.pdf`;

    return res.download(ensured.absPath, downloadName);
  } catch (err) {
    console.error('Admin invoice download/generate error:', err);
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
      searchId  = '',
      searchUserId = '',
      searchTitle = '',
      searchName = '',
      searchCompany = '',
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
        SELECT COUNT(DISTINCT t.id) AS cnt
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

    const searchIdRaw = String(searchId || '').trim();
    const searchUserIdRaw = String(searchUserId || '').trim();
    const searchTitleRaw = String(searchTitle || '').trim();
    const searchNameRaw = String(searchName || '').trim();
    const searchCompanyRaw = String(searchCompany || '').trim();
    const hasSeparatedSearch = Boolean(searchIdRaw || searchUserIdRaw || searchTitleRaw || searchNameRaw || searchCompanyRaw);

    if (searchIdRaw) {
      if (/^\d+$/.test(searchIdRaw)) {
        clauses.push('t.id = ?');
        params.push(Number(searchIdRaw));
      } else {
        clauses.push('1 = 0');
      }
    }

    if (searchUserIdRaw) {
      const userIdColumn = cols.includes('user_id')
        ? 't.`user_id`'
        : (cols.includes('userid') ? 't.`userid`' : null);

      if (!userIdColumn) {
        clauses.push('1 = 0');
      } else if (/^\d+$/.test(searchUserIdRaw)) {
        clauses.push(`${userIdColumn} = ?`);
        params.push(Number(searchUserIdRaw));
      } else {
        clauses.push('1 = 0');
      }
    }

    if (searchTitleRaw) {
      const titleCols = ['name', 'title', 'headline'].filter(col => cols.includes(col));
      if (!titleCols.length) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`(${titleCols.map(col => `t.\`${col}\` LIKE ?`).join(' OR ')})`);
        params.push(...titleCols.map(() => `%${searchTitleRaw}%`));
      }
    }

    if (searchNameRaw) {
      const nameClauses = [];
      if (cols.includes('user_id')) {
        nameClauses.push(`CONCAT_WS(' ', COALESCE(u.firstname, ''), COALESCE(u.lastname, '')) LIKE ?`);
      }
      if (cols.includes('firstname') || cols.includes('lastname')) {
        nameClauses.push(`CONCAT_WS(' ', COALESCE(t.\`firstname\`, ''), COALESCE(t.\`lastname\`, '')) LIKE ?`);
      }

      if (!nameClauses.length) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`(${nameClauses.join(' OR ')})`);
        params.push(...nameClauses.map(() => `%${searchNameRaw}%`));
      }
    }

    if (searchCompanyRaw) {
      const companySearchCols = [...new Set([
        ...companyCols,
        ...(cols.includes('company') ? ['t.`company`'] : [])
      ])];

      if (!companySearchCols.length) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`(${companySearchCols.map(col => `${col} LIKE ?`).join(' OR ')})`);
        params.push(...companySearchCols.map(() => `%${searchCompanyRaw}%`));
      }
    }

    if (!hasSeparatedSearch && search) {
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
    let adOrderAlias = null;
    let adOrderTable = null;
    if (adType === 'slider') {
      adsJoin = ` JOIN slider_ads sa
                   ON sa.advert_id = t.id
                  AND sa.entitie_id = ?
                  AND sa.start_date <= NOW()
                  AND sa.end_date   >= NOW()`;
      adParam = ent.id;
      adOrderAlias = 'sa';
      adOrderTable = 'slider_ads';
    } else if (adType === 'catalog') {
      adsJoin = ` JOIN catalog_ads ca
                   ON ca.advert_id = t.id
                  AND ca.entitie_id = ?
                  AND ca.start_date <= NOW()
                  AND ca.end_date   >= NOW()`;
      adParam = ent.id;
      adOrderAlias = 'ca';
      adOrderTable = 'catalog_ads';
    } else if (adType === 'inserat') {
      adsJoin = ` JOIN advert_inserat ai
                   ON ai.advert_id = t.id
                  AND ai.entitie_id = ?
                  AND ai.start_date <= NOW()
                  AND ai.end_date   >= NOW()`;
      adParam = ent.id;
      adOrderAlias = 'ai';
      adOrderTable = 'advert_inserat';
    } else if (adType === 'katalog_slider') {
      adsJoin = ` JOIN katalog_slider ks
                   ON ks.advert_id = t.id
                  AND ks.entitie_id = ?
                  AND ks.start_date <= NOW()
                  AND ks.end_date   >= NOW()`;
      adParam = ent.id;
      adOrderAlias = 'ks';
      adOrderTable = 'katalog_slider';
    }

    const hasPlacementOrder = Boolean(adOrderTable && await ensurePlacementSortOrderColumn(adOrderTable));

    // 7) Total für Pagination
    const totalSql = `
      SELECT COUNT(DISTINCT t.id) AS total
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
      case 'created_asc': orderClause = 'COALESCE(t.created, t.modified) ASC'; break;
      case 'created_desc': orderClause = 'COALESCE(t.created, t.modified) DESC'; break;
      case 'modified_asc': orderClause = 'COALESCE(t.modified, t.created) ASC'; break;
      case 'modified_desc': orderClause = 'COALESCE(t.modified, t.created) DESC'; break;
      default:
        orderClause = hasPlacementOrder && adOrderAlias
          ? `${placementOrderSql(adOrderAlias)}, GREATEST(COALESCE(t.published, t.created), COALESCE(t.modified, t.created)) DESC`
          : 'GREATEST(COALESCE(t.published, t.created), COALESCE(t.modified, t.created)) DESC';
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
    const [rawRows] = await db.query(rowsSql, rowParams);
    const rows = !adType
      ? rawRows
      : rawRows.filter((row, idx, arr) =>
          arr.findIndex((r) => Number(r.id) === Number(row.id)) === idx
        );

    // 9a) Aktive Werbe-Platzierungen pro Inserat ermitteln (für Anzeige im Laufend-Tab)
    const rowIds = rows
      .map((row) => Number(row.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const activeAdsById = new Map();

    if (rowIds.length) {
      const placementTables = AD_PLACEMENTS.map((p) => p.table);
      const tablePh = placementTables.map(() => '?').join(', ');
      const [placementRows] = await db.query(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (${tablePh})`,
        placementTables
      );
      const existingTables = new Set(placementRows.map((r) => String(r.table_name || r.TABLE_NAME || '')));
      const idsPh = rowIds.map(() => '?').join(', ');

      for (const placement of AD_PLACEMENTS) {
        if (!existingTables.has(placement.table)) continue;
        const [adRows] = await db.query(
          `SELECT advert_id,
                  MIN(start_date) AS start_date,
                  MAX(end_date)   AS end_date
             FROM \`${placement.table}\`
            WHERE entitie_id = ?
              AND advert_id IN (${idsPh})
              AND start_date <= NOW()
              AND end_date   >= NOW()
            GROUP BY advert_id`,
          [ent.id, ...rowIds]
        );

        adRows.forEach((adRow) => {
          const advertId = Number(adRow.advert_id);
          if (!Number.isInteger(advertId) || advertId <= 0) return;
          const existing = activeAdsById.get(advertId) || [];
          existing.push({
            adType: placement.adType,
            label: placement.label,
            startDate: adRow.start_date,
            endDate: adRow.end_date
          });
          activeAdsById.set(advertId, existing);
        });
      }
    }

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

      const placements = activeAdsById.get(Number(row.id)) || [];
      row.activeAdPlacements = placements;
      row.isAdActive = placements.length > 0;
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
      searchId: searchIdRaw,
      searchUserId: searchUserIdRaw,
      searchTitle: searchTitleRaw,
      searchName: searchNameRaw,
      searchCompany: searchCompanyRaw,
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
      const advertIdNum = Number(advertId);
      if (!Number.isInteger(advertIdNum) || advertIdNum <= 0) {
        return res.status(400).send('Ungültige Inserat-ID');
      }

      const startDate = moment().format('YYYY-MM-DD');
      const endDate   = moment().add(1, 'year').format('YYYY-MM-DD');

      let sql;
      let tableName;
      if (adType === 'slider') {
        tableName = 'slider_ads';
        sql = `INSERT INTO slider_ads    (entitie_id, advert_id, sort_order, start_date, end_date)
               VALUES (?, ?, ?, ?, ?)`;
      } else if (adType === 'catalog') {
        tableName = 'catalog_ads';
        sql = `INSERT INTO catalog_ads   (entitie_id, advert_id, sort_order, start_date, end_date)
               VALUES (?, ?, ?, ?, ?)`;
      } else if (adType === 'inserat') {
        tableName = 'advert_inserat';
        sql = `INSERT INTO advert_inserat (entitie_id, advert_id, sort_order, start_date, end_date)
               VALUES (?, ?, ?, ?, ?)`;
      } else if (adType === 'katalog_slider') {
        tableName = 'katalog_slider';
        sql = `INSERT INTO katalog_slider
               (entitie_id, advert_id, sort_order, start_date, end_date)
             VALUES (?, ?, ?, ?, ?)`;
      } else {
        return res.status(400).send('Ungültiger Werbetyp');
      }

      await ensurePlacementSortOrderColumn(tableName);

      const [[existingPlacement]] = await db.query(
        `SELECT id
           FROM \`${tableName}\`
          WHERE entitie_id = ?
            AND advert_id = ?
          ORDER BY id DESC
          LIMIT 1`,
        [ent.id, advertIdNum]
      );

      // Bereits vorhandene Placement-Zeile aktualisieren statt Duplikat anzulegen.
      if (existingPlacement?.id) {
        await db.query(
          `UPDATE \`${tableName}\`
              SET start_date = ?, end_date = ?
            WHERE id = ?`,
          [startDate, endDate, existingPlacement.id]
        );
        await db.query(
          `DELETE FROM \`${tableName}\`
            WHERE entitie_id = ?
              AND advert_id = ?
              AND id <> ?`,
          [ent.id, advertIdNum, existingPlacement.id]
        );
        return res.sendStatus(200);
      }

      const [[{ maxSort }]] = await db.query(
        `SELECT COALESCE(MAX(p.sort_order), 0) AS maxSort
           FROM \`${tableName}\` p
           JOIN \`${ent.table_name}\` t
             ON t.id = p.advert_id
          WHERE p.entitie_id = ?
            AND COALESCE(t.status, 0) = 3
            AND COALESCE(t.visible, 0) = 1`,
        [ent.id]
      );
      const nextSort = Number(maxSort) + 1;

      await db.query(sql, [ent.id, advertIdNum, nextSort, startDate, endDate]);
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
      lifestyles: 6
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

    // Admin-Edit wird über das gemeinsame buyer-Formular gespeichert.
    // Wir legen daher einen kurzlebigen Session-Grant für genau dieses Inserat ab.
    req.session.adminListingEditGrant = {
      listingId: Number(item.id),
      table: String(ent.table_name),
      ownerUserId: Number(item.user_id || 0),
      adminUserId: Number(req.session.userId || 0),
      expiresAt: Date.now() + (15 * 60 * 1000),
      returnTo: req.originalUrl
    };

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
    let keepVisible = false;
    switch (action) {
      case 'approve':  status = 3; visible = 1; break;
      case 'pend':     status = 7; visible = 0; break;
      case 'reject':   status = 8; visible = 0; break;
      case 'stop':     status = 3; visible = 0; break;
      case 'delete':   status = 9; visible = 0; break;
      case 'restore':  status = 1; visible = 0; break;
      default:         return res.redirect('back');
    }

    if (keepVisible) {
      await db.query(
        `UPDATE \`${ent.table_name}\` SET status = ? WHERE id = ?`,
        [status, id]
      );
    } else if (action === 'approve') {
      await db.query(
        `UPDATE \`${ent.table_name}\`
            SET status = ?, visible = ?, published = COALESCE(published, NOW())
          WHERE id = ?`,
        [status, visible, id]
      );
    } else {
      await db.query(
        `UPDATE \`${ent.table_name}\` SET status = ?, visible = ? WHERE id = ?`,
        [status, visible, id]
      );
    }

    res.redirect(req.get('referer') || '/admin/listings');
  } catch (err) {
    next(err);
  }
});

// Deaktiviert eine Werbung (löscht aus der passenden Ads-Tabelle)
router.post(
  '/listings/:category/:id/ad/move',
  express.json(),
  async (req, res, next) => {
    let conn;
    try {
      const { category, id } = req.params;
      const { adType, direction } = req.body || {};
      const dir = String(direction || '').toLowerCase();

      if (!['up', 'down'].includes(dir)) {
        return res.status(400).json({ ok: false, message: 'Ungültige Richtung' });
      }

      const table = PLACEMENT_TABLE_BY_ADTYPE[adType];
      if (!table) {
        return res.status(400).json({ ok: false, message: 'Ungültiger adType' });
      }

      const [[ent]] = await db.query(
        'SELECT id, route, table_name FROM ententies WHERE route = ? LIMIT 1',
        [category]
      );
      if (!ent || !ent.table_name) {
        return res.status(400).json({ ok: false, message: 'Ungültige Kategorie' });
      }

      await ensurePlacementSortOrderColumn(table);

      conn = await db.getConnection();
      await conn.beginTransaction();

      const [rows] = await conn.query(
        `SELECT p.id, p.advert_id, p.entitie_id, p.start_date, p.end_date, COALESCE(p.sort_order, 0) AS sort_order
           FROM \`${table}\` p
           JOIN \`${ent.table_name}\` t
             ON t.id = p.advert_id
          WHERE p.entitie_id = ?
            AND p.start_date <= CURDATE()
            AND p.end_date   >= CURDATE()
            AND COALESCE(t.status, 0) = 3
            AND COALESCE(t.visible, 0) = 1
          ORDER BY ${placementOrderSql('p')}`,
        [ent.id]
      );

      const normalizedRows = rows.map(r => ({
        id: Number(r.id),
        advert_id: Number(r.advert_id),
        sort_order: Number(r.sort_order) || 0
      }));

      const targetIndex = normalizedRows.findIndex(r => r.advert_id === Number(id));
      if (targetIndex === -1) {
        await conn.rollback();
        return res.status(404).json({ ok: false, message: 'Placement für dieses Inserat nicht gefunden.' });
      }

      const swapIndex = dir === 'up' ? targetIndex - 1 : targetIndex + 1;
      if (swapIndex < 0 || swapIndex >= normalizedRows.length) {
        await conn.rollback();
        return res.json({ ok: true, moved: false, edge: true, message: 'Bereits am Rand.' });
      }

      const orderedIds = normalizedRows.map(r => r.id);
      [orderedIds[targetIndex], orderedIds[swapIndex]] = [orderedIds[swapIndex], orderedIds[targetIndex]];

      for (let i = 0; i < orderedIds.length; i += 1) {
        await conn.query(
          `UPDATE \`${table}\`
              SET sort_order = ?
            WHERE id = ?`,
          [i + 1, orderedIds[i]]
        );
      }

      const newPosition = orderedIds.indexOf(normalizedRows[targetIndex].id) + 1;
      await conn.commit();

      return res.json({
        ok: true,
        moved: true,
        position: newPosition,
        total: orderedIds.length
      });
    } catch (err) {
      if (conn) {
        try { await conn.rollback(); } catch {}
      }
      next(err);
    } finally {
      if (conn) conn.release();
    }
  }
);

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

router.get('/seller-requests', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const requestedPerPage = parseInt(req.query.perPage, 10);
    const perPageOptions = [300, 400, 500, 600];
    const perPage = perPageOptions.includes(requestedPerPage) ? requestedPerPage : 300;
    const filter = String(req.query.filter || 'pending').toLowerCase();
    const requestedEntity = String(req.query.entity || 'all').trim().toLowerCase();
    const searchBuyer = adminNormalizeText(req.query.searchBuyer || '', 180);
    const searchSeller = adminNormalizeText(req.query.searchSeller || '', 180);
    const baseUrl = (process.env.BASE_URL || 'https://herando.at').replace(/\/+$/g, '');
    const excludeInvestmentSql = "LOWER(COALESCE(r.entity, '')) NOT IN ('investment', 'investments')";

    const statusWhereClauses = [excludeInvestmentSql];
    if (filter === 'pending') statusWhereClauses.push('r.status = 0');
    if (filter === 'sent') statusWhereClauses.push('r.status = 1');
    const statusWhereSql = statusWhereClauses.join(' AND ');

    const [statusRows] = await db.query(
      `
      SELECT status, COUNT(*) AS cnt
      FROM requests r
      WHERE ${excludeInvestmentSql}
      GROUP BY status
      `
    );
    const statusCounts = { pending: 0, sent: 0, all: 0 };
    for (const row of statusRows) {
      const status = Number(row.status);
      const cnt = Number(row.cnt || 0);
      if (status === 0) statusCounts.pending += cnt;
      if (status === 1) statusCounts.sent += cnt;
      statusCounts.all += cnt;
    }

    const [entityMetaRows] = await db.query(
      `
      SELECT LOWER(TRIM(route)) AS route_key, name
      FROM ententies
      WHERE route IS NOT NULL AND TRIM(route) <> ''
      `
    );
    const entityLabelByRoute = new Map(
      entityMetaRows.map((row) => [
        String(row.route_key || '').toLowerCase(),
        adminNormalizeText(row.name || row.route_key || '', 80)
      ])
    );

    const [entityCountRows] = await db.query(
      `
      SELECT LOWER(TRIM(COALESCE(r.entity, ''))) AS entity_key, COUNT(*) AS cnt
      FROM requests r
      WHERE ${statusWhereSql}
        AND TRIM(COALESCE(r.entity, '')) <> ''
      GROUP BY LOWER(TRIM(COALESCE(r.entity, '')))
      ORDER BY entity_key ASC
      `
    );
    const entityOptions = entityCountRows.map((row) => {
      const value = String(row.entity_key || '').toLowerCase();
      const count = Number(row.cnt || 0);
      const fallbackLabel = value
        .split(/[-_]/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
      const label = entityLabelByRoute.get(value) || fallbackLabel || value;
      return { value, label, count };
    });
    const allowedEntityValues = new Set(entityOptions.map((opt) => opt.value));
    const selectedEntity = requestedEntity !== 'all' && allowedEntityValues.has(requestedEntity)
      ? requestedEntity
      : 'all';

    const whereClauses = [...statusWhereClauses];
    const whereParams = [];
    if (selectedEntity !== 'all') {
      whereClauses.push("LOWER(TRIM(COALESCE(r.entity, ''))) = ?");
      whereParams.push(selectedEntity);
    }
    if (searchBuyer) {
      const buyerNeedle = `%${searchBuyer.toLowerCase()}%`;
      whereClauses.push("(LOWER(COALESCE(r.name, '')) LIKE ? OR LOWER(COALESCE(r.email, '')) LIKE ?)");
      whereParams.push(buyerNeedle, buyerNeedle);
    }
    if (searchSeller) {
      const sellerNeedle = `%${searchSeller.toLowerCase()}%`;
      whereClauses.push("(LOWER(COALESCE(r.seller_name, '')) LIKE ? OR LOWER(COALESCE(r.seller_email, '')) LIKE ?)");
      whereParams.push(sellerNeedle, sellerNeedle);
    }
    const whereSql = whereClauses.join(' AND ');

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total
         FROM requests r
        WHERE ${whereSql}`,
      whereParams
    );
    const total = Number(countRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const currentPage = Math.min(page, totalPages);
    const currentOffset = (currentPage - 1) * perPage;

    const [rows] = await db.query(
      `
      SELECT
        r.*,
        u.gender AS seller_gender,
        u.firstname AS seller_firstname,
        u.lastname AS seller_lastname
      FROM requests r
      LEFT JOIN users u ON u.id = r.seller_id
      WHERE ${whereSql}
      ORDER BY r.id DESC
      LIMIT ? OFFSET ?
      `,
      [...whereParams, perPage, currentOffset]
    );

    const requests = rows.map((row) => {
      const requestLang = adminNormalizeLang(row.lang, 'de');
      const copy = adminGetContactMailCopy(requestLang);
      const buyerNameRaw = adminNormalizeText(row.name, 255) || 'Unbekannt';
      const buyerEmailRaw = adminNormalizeText(row.email, 255);
      const buyerPhoneRaw = adminNormalizeText(row.phone, 255);
      const sellerNameFallback = adminNormalizeText(row.seller_name, 255);
      const sellerEmailRaw = adminNormalizeText(row.seller_email, 255);
      const safeBuyerName = adminEscapeHtml(buyerNameRaw);
      const safeBuyerEmail = adminEscapeHtml(buyerEmailRaw);
      const safeBuyerPhone = adminEscapeHtml(buyerPhoneRaw);
      const listingUrl = buildRequestListingUrl(baseUrl, row.entity, row.advert_id);
      const safeListingUrl = adminEscapeHtml(listingUrl);
      const safeMessageHtml = adminMessageToHtml(row.message, 3000);
      const anrede = buildSellerGreeting({
        lang: requestLang,
        gender: row.seller_gender,
        firstName: row.seller_firstname,
        lastName: row.seller_lastname,
        fallbackName: sellerNameFallback
      });
      const previewHtml = buildSellerRequestEmailHtml({
        anrede,
        copy,
        baseUrl,
        safeMessageHtml,
        safeBuyerName,
        safeBuyerEmail,
        safeBuyerPhone,
        safeListingUrl
      });
      const snippet = adminNormalizeText(String(row.message || '').replace(/\s+/g, ' '), 130);
      return {
        ...row,
        buyerNameRaw,
        buyerEmailRaw,
        buyerPhoneRaw,
        requestLang,
        sellerNameRaw: sellerNameFallback,
        sellerEmailRaw,
        listingUrl,
        snippet,
        previewHtml
      };
    });

    const maxPageButtons = 7;
    const startPage = Math.max(1, currentPage - Math.floor(maxPageButtons / 2));
    const endPage = Math.min(totalPages, startPage + maxPageButtons - 1);
    const pages = [];
    for (let p = startPage; p <= endPage; p += 1) pages.push(p);

    const returnTo = `/admin/seller-requests?filter=${encodeURIComponent(filter)}&entity=${encodeURIComponent(selectedEntity)}&searchBuyer=${encodeURIComponent(searchBuyer)}&searchSeller=${encodeURIComponent(searchSeller)}&perPage=${perPage}&page=${currentPage}`;

    res.render('admin/seller-requests', {
      active: 'seller-requests',
      requests,
      filter,
      selectedEntity,
      searchBuyer,
      searchSeller,
      entityOptions,
      perPage,
      perPageOptions,
/*  */      currentPage,
      totalPages,
      pages,
      total,
      statusCounts,
      returnTo,
      notice: req.query.notice || '',
      error: req.query.error || ''
    });
  } catch (err) {
    next(err);
  }
});

router.post('/seller-requests/:id/send', async (req, res, next) => {
  try {
    const requestId = parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.redirect('/admin/seller-requests?error=invalid_id');
    }

    const fallbackReturn = '/admin/seller-requests?filter=pending&page=1';
    const returnTo = parseAdminReturnTo(req.body.returnTo || req.query.returnTo, fallbackReturn);

    const [[row]] = await db.query(
      `
      SELECT
        r.*,
        u.gender AS seller_gender,
        u.firstname AS seller_firstname,
        u.lastname AS seller_lastname
      FROM requests r
      LEFT JOIN users u ON u.id = r.seller_id
      WHERE r.id = ?
      LIMIT 1
      `,
      [requestId]
    );

    if (!row) {
      return res.redirect(appendRedirectParam(returnTo, 'error', 'not_found'));
    }

    const sellerEmailRaw = adminNormalizeText(row.seller_email, 255);
    if (!sellerEmailRaw) {
      return res.redirect(appendRedirectParam(returnTo, 'error', 'no_seller_email'));
    }

    const baseUrl = (process.env.BASE_URL || 'https://herando.at').replace(/\/+$/g, '');
    const requestLang = adminNormalizeLang(row.lang, 'de');
    const copy = adminGetContactMailCopy(requestLang);
    const buyerNameRaw = adminNormalizeText(row.name, 255) || 'Unbekannt';
    const buyerEmailRaw = adminNormalizeText(row.email, 255);
    const buyerPhoneRaw = adminNormalizeText(row.phone, 255);
    const safeBuyerName = adminEscapeHtml(buyerNameRaw);
    const safeBuyerEmail = adminEscapeHtml(buyerEmailRaw);
    const safeBuyerPhone = adminEscapeHtml(buyerPhoneRaw);
    const safeMessageHtml = adminMessageToHtml(row.message, 3000);
    const listingUrl = buildRequestListingUrl(baseUrl, row.entity, row.advert_id);
    const safeListingUrl = adminEscapeHtml(listingUrl);

    const anrede = buildSellerGreeting({
      lang: requestLang,
      gender: row.seller_gender,
      firstName: row.seller_firstname,
      lastName: row.seller_lastname,
      fallbackName: row.seller_name
    });

    const sellerHtml = buildSellerRequestEmailHtml({
      anrede,
      copy,
      baseUrl,
      safeMessageHtml,
      safeBuyerName,
      safeBuyerEmail,
      safeBuyerPhone,
      safeListingUrl
    });

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    try {
      await transporter.sendMail({
        from: `"Herando A.S." <info@herando.com>`,
        to: sellerEmailRaw,
        subject: copy.sellerSubject,
        html: sellerHtml
      });
    } catch (mailErr) {
      console.error('❌ seller-requests send failed:', mailErr?.message || mailErr);
      return res.redirect(appendRedirectParam(returnTo, 'error', 'send_failed'));
    }

    await db.query(
      `UPDATE requests
          SET status = 1,
              seller_cc = 1,
              modified = NOW()
        WHERE id = ?`,
      [requestId]
    );

    return res.redirect(appendRedirectParam(returnTo, 'notice', 'sent'));
  } catch (err) {
    next(err);
  }
});

router.post('/seller-requests/:id/delete', async (req, res, next) => {
  try {
    const requestId = parseInt(req.params.id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return res.redirect('/admin/seller-requests?error=invalid_id');
    }

    const fallbackReturn = '/admin/seller-requests?filter=pending&page=1';
    const returnTo = parseAdminReturnTo(req.body.returnTo || req.query.returnTo, fallbackReturn);

    await db.query(`DELETE FROM requests WHERE id = ? LIMIT 1`, [requestId]);
    return res.redirect(appendRedirectParam(returnTo, 'notice', 'deleted'));
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

const PAGE_I18N_LANGS = ['en', 'fr', 'it', 'tr', 'ja', 'cs', 'ru', 'es', 'nl', 'pl'];
const MANUAL_SALES_PAYMENT_CODE_KEY = 'manual_sales_payment_code';

async function getManualSalesPaymentCodeSetting() {
  const [[row]] = await db.query(
    `SELECT de
       FROM ui_translations
      WHERE \`key\` = ?
      LIMIT 1`,
    [MANUAL_SALES_PAYMENT_CODE_KEY]
  );
  return String(row?.de || '').trim();
}

function parseManualSalesPaymentCodes(raw) {
  return Array.from(
    new Set(
      String(raw || '')
        .split(/\r?\n|,|;/)
        .map((part) => String(part || '').trim())
        .filter(Boolean)
    )
  );
}

async function saveManualSalesPaymentCodeSetting(code) {
  const value = String(code || '').trim();
  await db.query(
    `INSERT INTO ui_translations
      (\`key\`, de, en, fr, it, tr, ja, cs, ru, es, nl, pl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      de = VALUES(de),
      en = VALUES(en),
      fr = VALUES(fr),
      it = VALUES(it),
      tr = VALUES(tr),
      ja = VALUES(ja),
      cs = VALUES(cs),
      ru = VALUES(ru),
      es = VALUES(es),
      nl = VALUES(nl),
      pl = VALUES(pl)`,
    [MANUAL_SALES_PAYMENT_CODE_KEY, value, value, value, value, value, value, value, value, value, value, value]
  );
}

function getPageI18nPayload(body = {}) {
  const payload = {
    slug: String(body.slug || '').trim(),
    title: String(body.title || '').trim(),
    content: String(body.content || '')
  };

  for (const lang of PAGE_I18N_LANGS) {
    payload[`title_${lang}`] = String(body[`title_${lang}`] || '').trim();
    payload[`content_${lang}`] = String(body[`content_${lang}`] || '');
  }

  return payload;
}

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
    const data = getPageI18nPayload(req.body);
    await db.query(
      `INSERT INTO pages (
         slug, title, content,
         title_en, content_en,
         title_fr, content_fr,
         title_it, content_it,
         title_tr, content_tr,
         title_ja, content_ja,
         title_cs, content_cs,
         title_ru, content_ru,
         title_es, content_es,
         title_nl, content_nl,
         title_pl, content_pl
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.slug, data.title, data.content,
        data.title_en, data.content_en,
        data.title_fr, data.content_fr,
        data.title_it, data.content_it,
        data.title_tr, data.content_tr,
        data.title_ja, data.content_ja,
        data.title_cs, data.content_cs,
        data.title_ru, data.content_ru,
        data.title_es, data.content_es,
        data.title_nl, data.content_nl,
        data.title_pl, data.content_pl
      ]
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
    const data = getPageI18nPayload(req.body);
    await db.query(
      `UPDATE pages SET
         slug = ?, title = ?, content = ?,
         title_en = ?, content_en = ?,
         title_fr = ?, content_fr = ?,
         title_it = ?, content_it = ?,
         title_tr = ?, content_tr = ?,
         title_ja = ?, content_ja = ?,
         title_cs = ?, content_cs = ?,
         title_ru = ?, content_ru = ?,
         title_es = ?, content_es = ?,
         title_nl = ?, content_nl = ?,
         title_pl = ?, content_pl = ?
       WHERE slug = ?`,
      [
        data.slug, data.title, data.content,
        data.title_en, data.content_en,
        data.title_fr, data.content_fr,
        data.title_it, data.content_it,
        data.title_tr, data.content_tr,
        data.title_ja, data.content_ja,
        data.title_cs, data.content_cs,
        data.title_ru, data.content_ru,
        data.title_es, data.content_es,
        data.title_nl, data.content_nl,
        data.title_pl, data.content_pl,
        oldSlug
      ]
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

router.get('/sales-direct-payment', async (req, res, next) => {
  try {
    const currentCode = await getManualSalesPaymentCodeSetting();
    const codes = parseManualSalesPaymentCodes(currentCode);
    res.render('admin/settings/sales-direct-payment', {
      active: 'sales-direct-payment',
      role: req.session.role,
      currentCode,
      codes,
      saved: req.query.saved === '1'
    });
  } catch (err) {
    next(err);
  }
});

router.post('/sales-direct-payment', async (req, res, next) => {
  try {
    const rawInput = String(
      req.body?.manual_sales_payment_codes ??
      req.body?.manual_sales_payment_code ??
      ''
    );
    const codes = Array.from(
      new Set(
        rawInput
          .split(/\r?\n|,|;/)
          .map((part) => String(part || '').trim())
          .filter(Boolean)
      )
    );
    const normalized = codes.slice(0, 50).map((c) => c.slice(0, 120)).join('\n');
    await saveManualSalesPaymentCodeSetting(normalized);
    res.redirect('/admin/sales-direct-payment?saved=1');
  } catch (err) {
    next(err);
  }
});

router.post('/sales-direct-payment/add', async (req, res, next) => {
  try {
    const newCode = String(req.body?.code || '').trim().slice(0, 120);
    if (!newCode) {
      return res.redirect('/admin/sales-direct-payment');
    }

    const existingRaw = await getManualSalesPaymentCodeSetting();
    const codes = parseManualSalesPaymentCodes(existingRaw);
    if (!codes.includes(newCode)) {
      codes.push(newCode);
      await saveManualSalesPaymentCodeSetting(codes.join('\n'));
    }
    res.redirect('/admin/sales-direct-payment?saved=1');
  } catch (err) {
    next(err);
  }
});

router.post('/sales-direct-payment/delete', async (req, res, next) => {
  try {
    const codeToDelete = String(req.body?.code || '').trim();
    const existingRaw = await getManualSalesPaymentCodeSetting();
    const codes = parseManualSalesPaymentCodes(existingRaw);
    const filtered = codes.filter((code) => code !== codeToDelete);
    await saveManualSalesPaymentCodeSetting(filtered.join('\n'));
    res.redirect('/admin/sales-direct-payment?saved=1');
  } catch (err) {
    next(err);
  }
});



router.use('/entieties', require('./entieties'));
router.use('/listings', require('./listings'));
router.use('/users', require('./users'));
router.use('/packages', require('./packages'));
router.use('/ads', require('./ads'));
router.use('/news', require('./news'));
router.use('/modbrand', require('./modbrand'));
router.use('/bund', require('./bund'));
router.use('/landing', require('./landing'));
router.use('/footer', require('./footer'));
router.use('/postings', require('./postings'));
router.use('/newsletter', require('./newsletter'));
router.use('/jobs', require('./jobs'));
const analyticsRouter = require('./analytics');
router.use('/analytics', analyticsRouter);
router.use('/seo', require('./seo'));
router.use('/ui', require('./ui'));
router.use('/sitemap', require('./sitemap'));













module.exports = router;

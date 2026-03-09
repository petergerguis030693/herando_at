const express   = require('express');
const bcrypt    = require('bcrypt');
const { body, validationResult } = require('express-validator');
const crypto    = require('crypto');
const db        = require('../../db');
const { ensureActivityLogTable } = require('../../service/activity-log');
const path      = require('path');
const fs        = require('fs').promises;
const { unserialize } = require('php-unserialize');
const router    = express.Router();

// multer für Upload im Memory
const multer = require('multer');
const uploadMemory = multer();
 
// Middleware: nur Admins dürfen
async function requireAdmin(req, res, next) {
  console.log('requireAdmin: userId =', req.session.userId);
  try {
    const userId = req.session.userId;
    if (!userId) {
      console.log('requireAdmin: nicht eingeloggt');
      return res.status(403).send('Forbidden: not logged in');
    }
    const [[user]] = await db.query(
      'SELECT role FROM users WHERE id = ?',
      [userId]
    );
    console.log('requireAdmin: Rolle aus DB =', user && user.role);
    if (!user || ![8, 9].includes(Number(user.role))) {
      console.log('requireAdmin: keine Admin-Rechte');
      return res.status(403).send('Forbidden: admin only');
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('requireAdmin Error:', err);
    next(err);
  }
}

// --- liest Spaltennamen einer Tabelle aus
async function getTableColumns(tableName) {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME 
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = ?
      ORDER BY ORDINAL_POSITION`,
    [tableName]
  );
  return cols.map(c => c.COLUMN_NAME);
}

// --- wählt sinnvolle Felder (title, thumb, preis, datum, status, visits) falls vorhanden
function buildSelectParts(columns) {
  const titleCol = ['name', 'title', 'model', 'subtitle'].find(c => columns.includes(c)) || null;
  const thumbCol = ['mainpicture', 'sliderpicture', 'picture', 'image', 'thumbnail', 'pictures']
    .find(c => columns.includes(c)) || null;

  const priceCol     = columns.includes('price')     ? 'price'     : null;
  const createdCol   = columns.includes('created')   ? 'created'   : null;
  const modifiedCol  = columns.includes('modified')  ? 'modified'  : null;
  const publishedCol = columns.includes('published') ? 'published' : null;
  const stopdateCol  = columns.includes('stopdate')  ? 'stopdate'  : null;
  const statusCol    = columns.includes('status')    ? 'status'    : null;
  const visibleCol   = columns.includes('visible')   ? 'visible'   : null;
  const visitsCol    = ['visits', 'views'].find(c => columns.includes(c)) || null; // 👈 NEU

  const selectBits = ['id'];
  if (titleCol)     selectBits.push(`${titleCol} AS title`);
  if (priceCol)     selectBits.push(`${priceCol} AS price`);
  if (statusCol)    selectBits.push(`${statusCol} AS status`);
  if (visibleCol)   selectBits.push(`${visibleCol} AS visible`);
  if (visitsCol)    selectBits.push(`${visitsCol} AS visits`); // 👈 NEU
  if (createdCol)   selectBits.push(`${createdCol} AS created`);
  if (modifiedCol)  selectBits.push(`${modifiedCol} AS modified`);
  if (publishedCol) selectBits.push(`${publishedCol} AS published`);
  if (stopdateCol)  selectBits.push(`${stopdateCol} AS stopdate`);
  if (thumbCol)     selectBits.push(`${thumbCol} AS thumb`);

  const orderBy =
    (modifiedCol && `\`${modifiedCol}\` DESC`) ||
    (createdCol  && `\`${createdCol}\` DESC`) ||
    'id DESC';

  return { selectBits, orderBy };
}

function isSafeSqlIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]+$/.test(value);
}

function formatDateLikeAdminListings(value) {
  if (!value) return null;
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}

function clampInt(value, { min = 1, max = 200 } = {}) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(parsed, min), max);
}

function parseActivityRange(query = {}) {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

  let from = query.from ? new Date(query.from) : defaultFrom;
  let to = query.to ? new Date(query.to) : now;

  if (Number.isNaN(from.getTime())) from = defaultFrom;
  if (Number.isNaN(to.getTime())) to = now;

  if (to.getTime() < from.getTime()) {
    const swap = from;
    from = to;
    to = swap;
  }

  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);

  const maxRangeMs = 180 * 24 * 60 * 60 * 1000;
  if ((to.getTime() - from.getTime()) > maxRangeMs) {
    from = new Date(to.getTime() - maxRangeMs);
    from.setHours(0, 0, 0, 0);
  }

  return { from, to };
}

function toSqlDateTime(dateValue) {
  return dateValue.toISOString().slice(0, 19).replace('T', ' ');
}

function parseJsonSafe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function truncateText(value, max = 120) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function detectAreaLabel(pathValue) {
  const p = String(pathValue || '').toLowerCase();
  if (p.startsWith('/admin/users')) return 'Benutzerverwaltung';
  if (p.startsWith('/admin/listings')) return 'Inseratsverwaltung';
  if (p.startsWith('/admin/analytics')) return 'Analytics';
  if (p.startsWith('/admin')) return 'Adminbereich';
  if (p.startsWith('/buyer')) return 'Kundenkonto';
  return 'Website';
}

function buildRequestActionLabel(method, statusCode) {
  const m = String(method || '').toUpperCase();
  const baseLabel = (
    m === 'GET' ? 'Seite aufgerufen' :
    m === 'POST' ? 'Formular abgesendet / Daten gespeichert' :
    m === 'PUT' ? 'Datensatz ersetzt' :
    m === 'PATCH' ? 'Datensatz aktualisiert' :
    m === 'DELETE' ? 'Datensatz geloescht' :
    'Aktion ausgefuehrt'
  );
  const code = Number(statusCode || 0);
  if (code >= 400) return `${baseLabel} (Fehler ${code})`;
  return baseLabel;
}

function summarizeRequestDetails(payloadJson, method) {
  const payload = parseJsonSafe(payloadJson);
  if (!payload || typeof payload !== 'object') return '';

  const queryKeys = Object.keys(payload.query || {});
  const bodyKeys = Object.keys(payload.body || {});
  const shortQuery = queryKeys.slice(0, 6).join(', ');
  const shortBody = bodyKeys.slice(0, 6).join(', ');
  const upperMethod = String(method || '').toUpperCase();

  if (upperMethod === 'GET' && shortQuery) return `Filter/Parameter: ${shortQuery}`;
  if (shortBody) return `Formularfelder: ${shortBody}`;
  if (shortQuery) return `Parameter: ${shortQuery}`;
  return '';
}

function buildClickActionLabel(row) {
  const meta = parseJsonSafe(row.detail_json);
  const label = truncateText(
    row.element_text ||
    meta?.data_action ||
    meta?.action ||
    meta?.name ||
    meta?.id ||
    row.target_url ||
    row.element
  );

  if (!label) return 'Button/Link geklickt';
  return `Button/Link geklickt: ${label}`;
}

function summarizeClickDetails(row) {
  const meta = parseJsonSafe(row.detail_json);
  const bits = [];

  if (row.target_url) bits.push(`Ziel: ${truncateText(row.target_url, 90)}`);
  if (meta?.form_action) bits.push(`Formular: ${truncateText(meta.form_action, 80)}`);
  if (meta?.form_method) bits.push(`Methode: ${String(meta.form_method).toUpperCase()}`);
  if (meta?.data_action) bits.push(`Aktion: ${truncateText(meta.data_action, 60)}`);

  return bits.join(' | ');
}

function mapUserActivityRows(rows) {
  return (rows || []).map((row) => {
    const pathValue = String(row.path || '').trim() || '/';
    const areaText = detectAreaLabel(pathValue);

    if (row.source_type === 'click') {
      return {
        ...row,
        source_label: 'Klick',
        path: pathValue,
        area_text: areaText,
        action_text: buildClickActionLabel(row),
        detail_text: summarizeClickDetails(row)
      };
    }

    return {
      ...row,
      source_label: 'Seite/Formular',
      path: pathValue,
      area_text: areaText,
      action_text: buildRequestActionLabel(row.method, row.status_code),
      detail_text: summarizeRequestDetails(row.detail_json, row.method)
    };
  });
}

// --- lädt alle Inserate eines Users quer über alle Entitäten
async function loadUserListingsAcrossEntities(userId) {
  const [entities] = await db.query(
    `SELECT id, name, route, table_name
       FROM ententies
      ORDER BY name`
  );

  const result = [];

  for (const ent of entities) {
    const table = ent.table_name;
    const columns = await getTableColumns(table);

    // nur Tabellen, die user_id besitzen (Ownership über user_id)
    if (!columns.includes('user_id')) continue;

    const { selectBits, orderBy } = buildSelectParts(columns);
    const sql = `
      SELECT ${selectBits.map(s => (s.includes(' AS ') ? s : `\`${s}\``)).join(', ')}
        FROM \`${table}\`
       WHERE user_id = ?
       ORDER BY ${orderBy}
       LIMIT 500
    `;
    const [rows] = await db.query(sql, [userId]);

    // einfache Normalisierung
    for (const r of rows) {
      if (r.title == null) r.title = `#${r.id}`;
      if (r.thumb && typeof r.thumb === 'string') {
        if (/^[\[\{]/.test(r.thumb)) {
          try {
            const parsed = JSON.parse(r.thumb);
            if (Array.isArray(parsed) && parsed.length) {
              r.thumb = parsed[0]?.image || parsed[0] || r.thumb;
            } else if (parsed && parsed.image) {
              r.thumb = parsed.image;
            }
          } catch {}
        }
        if (typeof r.thumb === 'string' && r.thumb.includes(',')) {
          r.thumb = r.thumb.split(',')[0].trim();
        }
      }
    }

    result.push({
      entitie_id: ent.id,
      entitie_name: ent.name,
      route: ent.route,
      table: table,
      count: rows.length,
      rows
    });
  }

  return result;
}

async function loadUserListingChoicesForEdit(userId, options = {}) {
  const { onlyOnlineVisible = true } = options;
  const listingsByEntity = await loadUserListingsAcrossEntities(userId);
  const listings = [];

  for (const ent of listingsByEntity) {
    for (const r of ent.rows || []) {
      // Für die Zusatzleistungs-Zuordnung standardmäßig nur aktive/sichtbare Inserate anzeigen
      if (onlyOnlineVisible && (Number(r.status) !== 3 || Number(r.visible) !== 1)) {
        continue;
      }

      let thumb = normalizeThumb(r.thumb);
      if (thumb && !/^https?:\/\//i.test(thumb) && !thumb.startsWith('/')) {
        thumb = `/images/${ent.route}/${r.id}/${thumb}`;
      }

      listings.push({
        key: `${ent.entitie_id}:${r.id}`,
        entitie_id: ent.entitie_id,
        entitie_name: ent.entitie_name,
        route: ent.route,
        type: ent.entitie_name,
        id: r.id,
        title: r.title || `#${r.id}`,
        thumb: thumb || null,
        status: r.status,
        visible: r.visible
      });
    }
  }

  return listings;
}

async function loadUserAddonEditorContext(userId) {
  const [[user]] = await db.query(
    `SELECT id, firstname, lastname, email, company
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [userId]
  );

  if (!user) return null;

  const [usersPackages] = await db.query(`
    SELECT id, name, category, placement_table, duration_weeks, price_cents
    FROM users_packages
    ORDER BY name
  `);

  const listings = await loadUserListingChoicesForEdit(Number(userId), { onlyOnlineVisible: true });
  const addonAssignmentsByListing = {};
  const placementLabels = {
    catalog_ads: 'Katalog-Werbeanzeige',
    advert_inserat: 'Top-Listing-Werbeanzeige',
    slider_ads: 'Slider-Werbeanzeige'
  };

  if (Array.isArray(listings) && listings.length) {
    const listKeySet = new Set(listings.map(l => `${Number(l.entitie_id)}:${Number(l.id)}`));
    const entIds = [...new Set(listings.map(l => Number(l.entitie_id)).filter(Number.isFinite))];
    const advertIds = [...new Set(listings.map(l => Number(l.id)).filter(Number.isFinite))];
    const entPlaceholders = entIds.map(() => '?').join(', ');
    const advertPlaceholders = advertIds.map(() => '?').join(', ');
    const today = formatDateLikeAdminListings(new Date());

    const placementTables = ['catalog_ads', 'advert_inserat', 'slider_ads'];

    for (const table of placementTables) {
      const [rows] = await db.query(
        `SELECT id, entitie_id, advert_id, start_date, end_date
           FROM \`${table}\`
          WHERE entitie_id IN (${entPlaceholders})
            AND advert_id  IN (${advertPlaceholders})
          ORDER BY id DESC`,
        [...entIds, ...advertIds]
      );

      for (const row of rows) {
        const key = `${Number(row.entitie_id)}:${Number(row.advert_id)}`;
        if (!listKeySet.has(key)) continue;

        const startDisplay = formatDateLikeAdminListings(row.start_date);
        const endDisplay = formatDateLikeAdminListings(row.end_date);
        const isActive = Boolean(
          today &&
          (!startDisplay || startDisplay <= today) &&
          (!endDisplay || endDisplay >= today)
        );

        const candidate = {
          id: row.id,
          users_package_id: null,
          package_name: placementLabels[table] || table,
          placement_table: table,
          status: isActive ? 'paid' : 'ended',
          examination_status: null,
          start_date: row.start_date || null,
          end_date: row.end_date || null,
          start_date_display: startDisplay,
          end_date_display: endDisplay,
          is_active: isActive
        };

        const current = addonAssignmentsByListing[key];
        if (!current) {
          addonAssignmentsByListing[key] = candidate;
          continue;
        }

        if (candidate.is_active && !current.is_active) {
          addonAssignmentsByListing[key] = candidate;
          continue;
        }

        if (candidate.is_active === current.is_active) {
          const curEnd = current.end_date_display || '';
          const candEnd = candidate.end_date_display || '';
          if (candEnd > curEnd || (candEnd === curEnd && Number(candidate.id) > Number(current.id))) {
            addonAssignmentsByListing[key] = candidate;
          }
        }
      }
    }
  }

  return {
    user,
    usersPackages,
    listings,
    currentAddon: null,
    addonAssignmentsByListing,
    currentAddonDisplay: null,
    formData: {
      users_package_id: '',
      selected_listing: ''
    }
  };
}

async function loadUserListingStateTotalsByUser(userIds, entities) {
  const normalizedUserIds = [...new Set(
    userIds.map(id => Number(id)).filter(Number.isFinite)
  )];
  const totalsByUser = new Map(
    normalizedUserIds.map(id => [id, { drafts: 0, online: 0, paused: 0 }])
  );

  if (!normalizedUserIds.length || !Array.isArray(entities) || !entities.length) {
    return totalsByUser;
  }

  const placeholders = normalizedUserIds.map(() => '?').join(', ');

  for (const ent of entities) {
    const table = ent?.table_name;
    if (!isSafeSqlIdentifier(table)) continue;

    let columns = [];
    try {
      columns = await getTableColumns(table);
    } catch (err) {
      console.warn(`Skipping table ${table}: unable to read columns`, err.message);
      continue;
    }

    if (!columns.includes('user_id') || !columns.includes('status') || !columns.includes('visible')) {
      continue;
    }

    const [rows] = await db.query(
      `SELECT
         user_id,
         SUM(CASE WHEN status = 0 AND visible = 0 THEN 1 ELSE 0 END) AS drafts,
         SUM(CASE WHEN status = 3 AND visible = 1 THEN 1 ELSE 0 END) AS online,
         SUM(CASE WHEN status = 4 AND visible = 0 THEN 1 ELSE 0 END) AS paused
       FROM \`${table}\`
       WHERE user_id IN (${placeholders})
       GROUP BY user_id`,
      normalizedUserIds
    );

    for (const row of rows) {
      const userId = Number(row.user_id);
      if (!totalsByUser.has(userId)) continue;

      const current = totalsByUser.get(userId);
      current.drafts += Number(row.drafts) || 0;
      current.online += Number(row.online) || 0;
      current.paused += Number(row.paused) || 0;
    }
  }

  return totalsByUser;
}


router.get('/', requireAdmin, async (req, res, next) => {
  console.log('GET /admin/users/ list start');
  try {
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 30;
    const offset  = (page - 1) * perPage;
    const legacySearch = (req.query.search || '').trim();
    const searchName = (req.query.search_name || '').trim();
    const searchCompany = (req.query.search_company || '').trim();
    const searchEmail = (req.query.search_email || '').trim();
    const searchId = (req.query.search_id || '').trim();
    const searchAddress = (req.query.search_address || '').trim();
    const status  = (req.query.status || 'all').trim();
    const packageFilter = (req.query.package || '').trim();
    const entityFilter = (req.query.entity || '').trim();
    const sortRaw = (req.query.sort || 'registered_desc').trim();
    const allowedSorts = {
      registered_desc: 'u.created DESC, u.id DESC',
      registered_asc: 'u.created ASC, u.id ASC',
      id_desc: 'u.id DESC',
      id_asc: 'u.id ASC'
    };
    const sort = Object.prototype.hasOwnProperty.call(allowedSorts, sortRaw)
      ? sortRaw
      : 'registered_desc';
    const orderBy = allowedSorts[sort];

    console.log({
      page,
      perPage,
      offset,
      legacySearch,
      searchName,
      searchCompany,
      searchEmail,
      searchId,
      searchAddress,
      status,
      packageFilter,
      entityFilter,
      sort
    });

    // Grund-Filter
    const where  = [
      'u.blacklist = 0',
      '( (u.firstname IS NOT NULL AND u.firstname <> "") OR (u.lastname IS NOT NULL AND u.lastname <> "") )'
    ];
    const params = [];

    // Such-Filter (neu: getrennte Felder)
    if (searchName) {
      where.push(`CONCAT_WS(' ', u.firstname, u.lastname) LIKE ?`);
      params.push(`%${searchName}%`);
    }
    if (searchCompany) {
      where.push(`u.company LIKE ?`);
      params.push(`%${searchCompany}%`);
    }
    if (searchEmail) {
      where.push(`u.email LIKE ?`);
      params.push(`%${searchEmail}%`);
    }
    if (searchId) {
      if (/^\d+$/.test(searchId)) {
        where.push('u.id = ?');
        params.push(Number(searchId));
      } else {
        // Ungültige ID-Suche soll keine Treffer liefern
        where.push('1 = 0');
      }
    }
    if (searchAddress) {
      where.push(`CONCAT_WS(' ', u.street, u.housenumber, u.postcode, u.city) LIKE ?`);
      params.push(`%${searchAddress}%`);
    }

    // Rückwärtskompatibilität: alter globaler Suchparameter bleibt optional nutzbar
    if (legacySearch && !searchName && !searchCompany && !searchEmail && !searchId && !searchAddress) {
      where.push(`CONCAT_WS(' ',
        u.id, u.role, u.logging, u.gender, u.contact,
        u.company, u.vatid, u.firstname, u.lastname,
        u.street, u.housenumber, u.postcode, u.city,
        u.email
      ) LIKE ?`);
      params.push(`%${legacySearch}%`);
    }

    // Status-Filter: Aktiv/Inaktiv über E-Mail-Verifizierung (confirmed)
    const expirationExpr = `
      DATE_ADD(
        IFNULL(u.modified, u.created),
        INTERVAL 1 YEAR
      )
    `;
    if (status === 'active') {
      where.push('IFNULL(u.confirmed, 0) = 1');
    } else if (status === 'inactive' || status === 'expired') {
      // "expired" als Rückwärtskompatibilität für alte Links/Bookmarks
      where.push('IFNULL(u.confirmed, 0) <> 1');
    }

    // Paket-Filter
    if (packageFilter) {
      where.push(`EXISTS (
        SELECT 1
        FROM selected_packages sp
        WHERE sp.user_id = u.id AND sp.package_id = ?
      )`);
      params.push(packageFilter);
    }
    if (entityFilter) {
      where.push(`EXISTS (
        SELECT 1
        FROM selected_packages sp
        WHERE sp.user_id = u.id AND sp.category_id = ?
      )`);
      params.push(entityFilter);
    }

    // Flatrate-Ausdruck → nur prüfen ob irgendein Feld NICHT NULL ist
    const flatrateExpr = `
      (
        u.flatrate_all IS NOT NULL
        OR u.flatrate_cars IS NOT NULL
        OR u.flatrate_properties IS NOT NULL
        OR u.flatrate_watches IS NOT NULL
        OR u.flatrate_yachts IS NOT NULL
        OR u.flatrate_investments IS NOT NULL
      )
    `;

    const whereSQL = where.join(' AND ');
    console.log('WHERE:', whereSQL, params);

    // Gesamtanzahl für Pagination
    const [[{ count }]] = await db.query(
      `SELECT COUNT(*) AS count
       FROM users u
       WHERE ${whereSQL}`,
      params
    );
    const totalPages = Math.ceil(count / perPage);

    // Alle verfügbaren Entitäten (für Filter + Inserat-Statistik)
    const [allEntities] = await db.query(`
      SELECT id, name, route, table_name
      FROM ententies
      ORDER BY name ASC
    `);

    // Userliste laden
    const [users] = await db.query(
      `SELECT
         u.id,
         u.confirmed,
         COALESCE(u.logging, 1) AS logging,
         u.gender,
         u.company,
         u.firstname,
         u.lastname,
         u.phone,
         u.mobile,
         u.street,
         u.housenumber,
         u.city,
         u.postcode,
         u.email,
         u.fax,
         IFNULL(u.modified, u.created) AS letzter_vertragstermin,
         ${expirationExpr} AS ablaufdatum,
         ${flatrateExpr} AS has_flatrate,
         (
           SELECT GROUP_CONCAT(DISTINCT sp.package_id SEPARATOR ', ')
           FROM selected_packages sp
           WHERE sp.user_id = u.id
         ) AS packages_taken,
         (
           SELECT GROUP_CONCAT(
             DISTINCT COALESCE(p.name, CONCAT('ID ', sp.package_id))
             ORDER BY COALESCE(p.name, CONCAT('ID ', sp.package_id))
             SEPARATOR ', '
           )
           FROM selected_packages sp
           LEFT JOIN packages p ON p.id = sp.package_id
           WHERE sp.user_id = u.id
         ) AS package_names,
         (
           SELECT COUNT(DISTINCT sp.package_id)
           FROM selected_packages sp
           WHERE sp.user_id = u.id
             AND sp.package_id IS NOT NULL
         ) AS ordered_packages_count,
         (
           SELECT COUNT(DISTINCT sp.category_id)
           FROM selected_packages sp
           WHERE sp.user_id = u.id
             AND sp.category_id IS NOT NULL
         ) AS ordered_entities_count,
         (
           SELECT GROUP_CONCAT(DISTINCT e.name ORDER BY e.name SEPARATOR ', ')
           FROM selected_packages sp
           JOIN ententies e ON e.id = sp.category_id
           WHERE sp.user_id = u.id
             AND sp.category_id IS NOT NULL
         ) AS ordered_entity_names
       FROM users u
       WHERE ${whereSQL}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );

    console.log('Loaded users:', users.length);

    const listingStateTotals = await loadUserListingStateTotalsByUser(
      users.map(u => u.id),
      allEntities
    );

    for (const user of users) {
      const state = listingStateTotals.get(Number(user.id)) || { drafts: 0, online: 0, paused: 0 };
      user.listings_drafts = state.drafts;
      user.listings_online = state.online;
      user.listings_paused = state.paused;
    }

    // Alle verfügbaren Pakete für Filter-Buttons laden
    const [allPackages] = await db.query(`
      SELECT DISTINCT package_id
      FROM selected_packages
      ORDER BY package_id ASC
    `);

    // Erneuerungen diesen Monat: nur Marketing-Pakete (users_packages/user_package_orders)
    const [renewals] = await db.query(`
      SELECT
        u.id,
        u.firstname,
        u.lastname,
        MIN(upo.end_date) AS ablaufdatum
      FROM user_package_orders upo
      JOIN users u ON u.id = upo.user_id
      JOIN users_packages upkg ON upkg.id = upo.users_package_id
      WHERE IFNULL(upo.status, '') = 'paid'
        AND upo.end_date IS NOT NULL
        AND upo.end_date >= CURDATE()
        AND YEAR(upo.end_date) = YEAR(CURDATE())
        AND MONTH(upo.end_date) = MONTH(CURDATE())
        AND (
          upkg.placement_table IN ('catalog_ads', 'advert_inserat', 'slider_ads')
          OR upkg.category IN ('slideshow', 'top_listing', 'sonstiges', 'catalog', 'inserat', 'slider', 'katalog_slider')
        )
      GROUP BY u.id, u.firstname, u.lastname
      ORDER BY u.lastname, u.firstname
    `);

    // Rendern
    res.render('admin/users/list', {
      active: 'users-list',
      users,
      renewals,
      page,
      totalPages,
      search: legacySearch,
      searchName,
      searchCompany,
      searchEmail,
      searchId,
      searchAddress,
      status,
      packageFilter,
      entityFilter,
      sort,
      allPackages,
      allEntities
    });

  } catch (err) {
    console.error('GET /admin/users/ Error:', err);
    next(err);
  }
});

router.get('/without-package', requireAdmin, async (req, res, next) => {
  try {
    const [entityRows] = await db.query(
      `SELECT id, name, table_name
         FROM ententies
        WHERE table_name IN ('cars', 'watches', 'properties', 'yachts', 'lifestyles')
        ORDER BY id ASC`
    );
    const entityByTable = new Map(
      (entityRows || []).map((row) => [String(row.table_name), { id: Number(row.id), name: String(row.name || '') }])
    );

    const [packages] = await db.query(
      `SELECT id, name, price, duration_unit, duration_amt
         FROM packages
        ORDER BY sort_order ASC, name ASC`
    );

    const firstname = String(req.query.firstname || '').trim();
    const lastname = String(req.query.lastname || '').trim();
    const email = String(req.query.email || '').trim();
    const company = String(req.query.company || '').trim();
    const entityConfig = {
      all: { key: 'all', label: 'Alle Entitäten', whereExpr: null, entitieId: null },
      cars: {
        key: 'cars',
        label: entityByTable.get('cars')?.name || 'Autos',
        whereExpr: 'COALESCE(c.cars_online, 0) > 0',
        entitieId: entityByTable.get('cars')?.id || 1
      },
      watches: {
        key: 'watches',
        label: entityByTable.get('watches')?.name || 'Watches',
        whereExpr: 'COALESCE(w.watches_online, 0) > 0',
        entitieId: entityByTable.get('watches')?.id || 2
      },
      properties: {
        key: 'properties',
        label: entityByTable.get('properties')?.name || 'Properties',
        whereExpr: 'COALESCE(p.properties_online, 0) > 0',
        entitieId: entityByTable.get('properties')?.id || 4
      },
      yachts: {
        key: 'yachts',
        label: entityByTable.get('yachts')?.name || 'Yachts',
        whereExpr: 'COALESCE(y.yachts_online, 0) > 0',
        entitieId: entityByTable.get('yachts')?.id || 3
      },
      lifestyles: {
        key: 'lifestyles',
        label: entityByTable.get('lifestyles')?.name || 'Lifestyles',
        whereExpr: 'COALESCE(l.lifestyles_online, 0) > 0',
        entitieId: entityByTable.get('lifestyles')?.id || 5
      }
    };
    const rawEntity = String(req.query.entity || 'all').trim().toLowerCase();
    const entity = Object.prototype.hasOwnProperty.call(entityConfig, rawEntity)
      ? rawEntity
      : 'all';

    const where = [
      'u.blacklist = 0',
      '( (u.firstname IS NOT NULL AND u.firstname <> "") OR (u.lastname IS NOT NULL AND u.lastname <> "") )',
      'COALESCE(sp.package_count, 0) = 0'
    ];
    const params = [];

    if (firstname) {
      where.push('u.firstname LIKE ?');
      params.push(`%${firstname}%`);
    }
    if (lastname) {
      where.push('u.lastname LIKE ?');
      params.push(`%${lastname}%`);
    }
    if (email) {
      where.push('IFNULL(u.email, \'\') LIKE ?');
      params.push(`%${email}%`);
    }
    if (company) {
      where.push('IFNULL(u.company, \'\') LIKE ?');
      params.push(`%${company}%`);
    }

    if (entityConfig[entity].whereExpr) {
      where.push(entityConfig[entity].whereExpr);
    } else {
      where.push(`(COALESCE(c.cars_online, 0)
        + COALESCE(w.watches_online, 0)
        + COALESCE(p.properties_online, 0)
        + COALESCE(y.yachts_online, 0)
        + COALESCE(l.lifestyles_online, 0)) > 0`);
    }

    const [users] = await db.query(
      `SELECT
         u.id,
         u.firstname,
         u.lastname,
         u.company,
         u.email,
         COALESCE(c.cars_online, 0) AS cars_online,
         COALESCE(w.watches_online, 0) AS watches_online,
         COALESCE(p.properties_online, 0) AS properties_online,
         COALESCE(y.yachts_online, 0) AS yachts_online,
         COALESCE(l.lifestyles_online, 0) AS lifestyles_online,
         (
           COALESCE(c.cars_online, 0)
           + COALESCE(w.watches_online, 0)
           + COALESCE(p.properties_online, 0)
           + COALESCE(y.yachts_online, 0)
           + COALESCE(l.lifestyles_online, 0)
         ) AS total_online
       FROM users u
       LEFT JOIN (
         SELECT user_id, COUNT(DISTINCT package_id) AS package_count
         FROM selected_packages
         WHERE package_id IS NOT NULL
         GROUP BY user_id
       ) sp ON sp.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS cars_online
         FROM cars
         WHERE status = 3 AND visible = 1
         GROUP BY user_id
       ) c ON c.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS watches_online
         FROM watches
         WHERE status = 3 AND visible = 1
         GROUP BY user_id
       ) w ON w.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS properties_online
         FROM properties
         WHERE status = 3 AND visible = 1
         GROUP BY user_id
       ) p ON p.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS yachts_online
         FROM yachts
         WHERE status = 3 AND visible = 1
         GROUP BY user_id
       ) y ON y.user_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS lifestyles_online
         FROM lifestyles
         WHERE status = 3 AND visible = 1
         GROUP BY user_id
       ) l ON l.user_id = u.id
       WHERE ${where.join(' AND ')}
       ORDER BY total_online DESC, u.id DESC`,
      params
    );

    const entityFields = {
      cars: 'cars_online',
      watches: 'watches_online',
      properties: 'properties_online',
      yachts: 'yachts_online',
      lifestyles: 'lifestyles_online'
    };

    for (const user of users) {
      user.available_entities = Object.keys(entityFields)
        .map((key) => {
          const field = entityFields[key];
          const count = Number(user[field] || 0);
          if (count <= 0) return null;
          return {
            key,
            label: entityConfig[key].label,
            entitie_id: Number(entityConfig[key].entitieId),
            count
          };
        })
        .filter(Boolean);
    }

    res.render('admin/users/without-package', {
      active: 'users-without-package',
      users,
      packages,
      successMessage: (req.flash('success') || [])[0] || null,
      errorMessage: (req.flash('error') || [])[0] || null,
      filters: {
        firstname,
        lastname,
        email,
        company,
        entity
      },
      entityOptions: Object.values(entityConfig).map((cfg) => ({
        key: cfg.key,
        label: cfg.label
      }))
    });
  } catch (err) {
    console.error('GET /admin/users/without-package Error:', err);
    next(err);
  }
});

router.post('/without-package/assign', requireAdmin, async (req, res, next) => {
  try {
    const referer = req.get('Referer') || '/admin/users/without-package';
    const userId = Number.parseInt(String(req.body?.user_id || ''), 10);
    const categoryId = Number.parseInt(String(req.body?.category_id || ''), 10);
    const packageId = String(req.body?.package_id || '').trim();

    if (!Number.isFinite(userId) || userId <= 0) {
      req.flash('error', 'Ungültiger Benutzer.');
      return res.redirect(referer);
    }
    if (!Number.isFinite(categoryId) || categoryId <= 0) {
      req.flash('error', 'Bitte eine Entität auswählen.');
      return res.redirect(referer);
    }
    if (!packageId) {
      req.flash('error', 'Bitte ein Paket auswählen.');
      return res.redirect(referer);
    }

    const [[pkg]] = await db.query(
      `SELECT id, name
         FROM packages
        WHERE id = ?
        LIMIT 1`,
      [packageId]
    );
    if (!pkg) {
      req.flash('error', 'Paket nicht gefunden.');
      return res.redirect(referer);
    }

    const [[entityRow]] = await db.query(
      `SELECT id, name, table_name
         FROM ententies
        WHERE id = ?
        LIMIT 1`,
      [categoryId]
    );
    if (!entityRow || !isSafeSqlIdentifier(entityRow.table_name)) {
      req.flash('error', 'Entität nicht gefunden.');
      return res.redirect(referer);
    }

    const [[user]] = await db.query(
      `SELECT id, firstname, lastname, company, vatid, street, housenumber, postcode, city, phone, email, country_id
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userId]
    );
    if (!user) {
      req.flash('error', 'Benutzer nicht gefunden.');
      return res.redirect(referer);
    }

    if (!user.country_id) {
      req.flash('error', 'Land fehlt beim Benutzer. Bitte zuerst im Profil setzen.');
      return res.redirect(`/admin/users/${userId}/edit`);
    }

    const [[alreadyHasPackage]] = await db.query(
      `SELECT id
         FROM selected_packages
        WHERE user_id = ?
          AND package_id IS NOT NULL
        LIMIT 1`,
      [userId]
    );
    if (alreadyHasPackage) {
      req.flash('error', 'Benutzer hat bereits ein Paket.');
      return res.redirect(referer);
    }

    const [onlineRows] = await db.query(
      `SELECT COUNT(*) AS cnt
         FROM \`${entityRow.table_name}\`
        WHERE user_id = ?
          AND status = 3
          AND visible = 1`,
      [userId]
    );
    const onlineCount = Number(onlineRows?.[0]?.cnt || 0);
    if (onlineCount <= 0) {
      req.flash('error', 'Für die gewählte Entität gibt es keine online Inserate.');
      return res.redirect(referer);
    }

    const [orderRes] = await db.query(
      `INSERT INTO orders
         (user_id, package_id, product, category_id, country_id,
          firstname, lastname, company, vatid, street, housenumber,
          postcode, city, phone, email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        userId,
        packageId,
        packageId,
        categoryId,
        Number(user.country_id),
        String(user.firstname || ''),
        String(user.lastname || ''),
        user.company || null,
        user.vatid || null,
        String(user.street || ''),
        String(user.housenumber || ''),
        String(user.postcode || ''),
        String(user.city || ''),
        user.phone || null,
        String(user.email || '')
      ]
    );

    const orderId = Number(orderRes.insertId);
    await db.query(
      `INSERT INTO selected_packages
         (user_id, package_id, category_id, country_id,
          start_date, end_date, max_listings, used_listings, order_id)
       VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 YEAR), 0, 0, ?)`,
      [userId, packageId, categoryId, Number(user.country_id), orderId]
    );

    req.flash('success', `Paket "${pkg.name || pkg.id}" wurde zugewiesen (${entityRow.name}).`);
    return res.redirect(referer);
  } catch (err) {
    console.error('POST /admin/users/without-package/assign Error:', err);
    req.flash('error', 'Paketzuweisung fehlgeschlagen.');
    return res.redirect(req.get('Referer') || '/admin/users/without-package');
  }
});






// POST /admin/users: leitet Suche & Status-Filter an GET weiter
router.post('/', requireAdmin, (req, res) => {
  const {
    search = '',
    search_name = '',
    search_company = '',
    search_email = '',
    search_id = '',
    search_address = '',
    status = 'all',
    package: packageFilter = '',
    entity: entityFilter = '',
    sort = ''
  } = req.body;

  const params = new URLSearchParams();
  if (search) params.set('search', String(search));
  if (search_name) params.set('search_name', String(search_name));
  if (search_company) params.set('search_company', String(search_company));
  if (search_email) params.set('search_email', String(search_email));
  if (search_id) params.set('search_id', String(search_id));
  if (search_address) params.set('search_address', String(search_address));
  if (status) params.set('status', String(status));
  if (packageFilter) params.set('package', String(packageFilter));
  if (entityFilter) params.set('entity', String(entityFilter));
  if (sort) params.set('sort', String(sort));

  res.redirect(`/admin/users?${params.toString()}`);
});

router.post('/:id/extend', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    await db.query(
      `UPDATE users
         SET modified = NOW()
       WHERE id = ?`,
      [id]
    );
    res.redirect(req.get('Referer') || '/admin/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/expire', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const wantsJson =
      req.xhr || (req.get('x-requested-with') === 'XMLHttpRequest') || ((req.get('accept') || '').includes('application/json'));
    await db.query(
      `UPDATE users
         SET logging = 0,
             modified = DATE_SUB(
           DATE_SUB(NOW(), INTERVAL 1 YEAR),
           INTERVAL 1 DAY
         )
       WHERE id = ?`,
      [id]
    );
    if (wantsJson) {
      return res.json({
        success: true,
        userId: Number(id),
        action: 'expired',
        confirmed: 1,
        logging: 0,
        canLogin: false,
        message: 'Benutzer wurde gestoppt (Login gesperrt).'
      });
    }
    res.redirect(req.get('Referer') || '/admin/users');
  } catch (err) {
    if (req.xhr || (req.get('accept') || '').includes('application/json')) {
      return res.status(500).json({ success: false, error: 'Fehler beim Stoppen des Benutzers.' });
    }
    next(err);
  }
});

router.post('/:id/activate', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const wantsJson =
      req.xhr || (req.get('x-requested-with') === 'XMLHttpRequest') || ((req.get('accept') || '').includes('application/json'));
    await db.query(
      'UPDATE users SET confirmed = 1, logging = 1 WHERE id = ?',
      [id]
    );
    await db.query('DELETE FROM email_verifications WHERE user_id = ?', [id]);

    if (wantsJson) {
      return res.json({
        success: true,
        userId: Number(id),
        action: 'activated',
        confirmed: 1,
        logging: 1,
        canLogin: true,
        message: 'Benutzer freigeschaltet (E-Mail bestätigt / Login entsperrt).'
      });
    }

    req.flash('success', 'Benutzer freigeschaltet (E-Mail bestätigt / Login entsperrt).');
    res.redirect(req.get('Referer') || '/admin/users');
  } catch (err) {
    console.error('POST /admin/users/:id/activate Error:', err);
    if (req.xhr || (req.get('accept') || '').includes('application/json')) {
      return res.status(500).json({ success: false, error: 'Fehler beim Freischalten des Benutzers.' });
    }
    next(err);
  }
});

router.post('/:id/unlock-admin-login', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const wantsJson =
      req.xhr || (req.get('x-requested-with') === 'XMLHttpRequest') || ((req.get('accept') || '').includes('application/json'));

    const [[user]] = await db.query(
      `SELECT id, role,
              COALESCE(admin_login_failed_attempts, 0) AS admin_login_failed_attempts,
              COALESCE(admin_login_locked, 0) AS admin_login_locked
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [id]
    );

    if (!user) {
      if (wantsJson) return res.status(404).json({ success: false, error: 'Benutzer nicht gefunden.' });
      req.flash('error', 'Benutzer nicht gefunden.');
      return res.redirect(req.get('Referer') || '/admin/users');
    }

    await db.query(
      `UPDATE users
          SET admin_login_failed_attempts = 0,
              admin_login_locked = 0,
              modified = NOW()
        WHERE id = ?`,
      [id]
    );

    if (wantsJson) {
      return res.json({
        success: true,
        userId: Number(id),
        action: 'admin_login_unlocked',
        admin_login_failed_attempts: 0,
        admin_login_locked: 0,
        message: 'Login-Sperre wurde aufgehoben.'
      });
    }

    req.flash('success', 'Login-Sperre wurde aufgehoben.');
    return res.redirect(req.get('Referer') || `/admin/users/${id}/edit`);
  } catch (err) {
    console.error('POST /admin/users/:id/unlock-admin-login Error:', err);
    if (req.xhr || (req.get('accept') || '').includes('application/json')) {
      return res.status(500).json({ success: false, error: 'Fehler beim Entsperren des Admin-Logins.' });
    }
    next(err);
  }
});


function generateFakeStripeId() {
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `sk_perrechnung${rand}`;
}

// GET: User bearbeiten
router.get('/:id/edit', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;

    // 1) User laden
    const [[user]] = await db.query(
      `SELECT * FROM users WHERE id = ?`,
      [id]
    );
    if (!user) return res.status(404).send('User nicht gefunden');

    // 2) Länder & Firmen laden
    const [countries] = await db.query(
      `SELECT id, de AS name FROM countries WHERE visible=1 ORDER BY de`
    );
    const [companies] = await db.query(
      `SELECT id, name FROM companies ORDER BY name`
    );

    // 3) Aktuelles Paket/Kategorie aus selected_packages holen
    const [[sel]] = await db.query(
      `SELECT package_id, category_id
         FROM selected_packages
        WHERE user_id = ?
          AND (end_date IS NULL OR end_date > NOW())
        ORDER BY created_at DESC
        LIMIT 1`,
      [id]
    );
    const currentPackage  = sel?.package_id   || null;
    const currentCategory = sel?.category_id  || null;

    // 4) Alle Pakete mit Flag selected
    const [packages] = await db.query(
      `SELECT
         p.id,
         p.name,
         p.price,
         CASE WHEN p.id = ? THEN 1 ELSE 0 END AS selected
       FROM packages p
       ORDER BY p.name`,
      [currentPackage]
    );

    // 5) Alle Kategorien (ententies) mit Flag selected
    const [categories] = await db.query(
      `SELECT
         e.id,
         e.name,
         CASE WHEN e.id = ? THEN 1 ELSE 0 END AS selected
       FROM ententies e
       ORDER BY e.name`,
      [currentCategory]
    );

    // 6) Zusatzleistungen laden
    const [usersPackages] = await db.query(`
      SELECT id, name, category, duration_weeks, price_cents
      FROM users_packages
      ORDER BY name
    `);

    const [[currentAddon]] = await db.query(
      `SELECT users_package_id, entitie_id, item_id
         FROM user_package_orders
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 1`,
      [id]
    );

    if (currentAddon) {
      user.users_package_id = currentAddon.users_package_id || null;
      user.item_id = currentAddon.item_id || null;
      user.item_entitie_id = currentAddon.entitie_id || null;
      user.selected_listing = (
        currentAddon.entitie_id != null && currentAddon.item_id != null
      ) ? `${currentAddon.entitie_id}:${currentAddon.item_id}` : '';
    }

    const listings = await loadUserListingChoicesForEdit(Number(id));


    // Rendern
    res.render('admin/users/edit-user', {
      active:     'users-list',
      data:       user,
      countries,
      companies,
      packages,
      categories,
      usersPackages,
      listings,
      errors: []
    });

  } catch (err) {
    next(err);
  }
});

// POST: User bearbeiten
router.post(
  '/:id/edit',
  requireAdmin,
  uploadMemory.single('logo'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const {
        gender,
        firstname,
        lastname,
        contact,
        company,
        vatid,
        company_id,
        street,
        housenumber,
        postcode,
        city,
        country_id,
        phone,
        mobile,
        fax,
        email,
        website,
        showAddress,
        showCompany,
        showPhone,
        showEmail,
        showWebsite,
        imprint,
        package_id,
        category_id,
        users_package_id,
        selected_listing
      } = req.body;
      const logo = req.file ? req.file.buffer : null;

      // Basis-Validierung
      const errors = [];
      if (!gender)    errors.push({ msg: 'Anrede ist erforderlich.' });
      if (!firstname) errors.push({ msg: 'Vorname ist erforderlich.' });
      if (!lastname)  errors.push({ msg: 'Nachname ist erforderlich.' });
      if (!email)     errors.push({ msg: 'E-Mail ist erforderlich.' });
      if ((package_id || category_id) && !country_id) {
        errors.push({ msg: 'Land erforderlich bei Paket/Kategorie.' });
      }

      let listingChoices = [];
      let selectedListing = null;
      if (users_package_id || selected_listing) {
        listingChoices = await loadUserListingChoicesForEdit(Number(id));

        if (selected_listing) {
          selectedListing = listingChoices.find(l => l.key === String(selected_listing));
        }

        if (users_package_id && !selectedListing) {
          errors.push({ msg: 'Für Zusatzleistungen bitte ein Inserat auswählen.' });
        }
      }

      if (errors.length) {
        // Dropdowns neu laden
        const [countries]  = await db.query(`SELECT id, de AS name FROM countries WHERE visible=1 ORDER BY de`);
        const [companies]  = await db.query(`SELECT id, name FROM companies ORDER BY name`);
        const [packages]   = await db.query(`SELECT id,name,price FROM packages ORDER BY name`);
        const [categories] = await db.query(`SELECT id,name FROM ententies ORDER BY name`);
        const [usersPackages] = await db.query(`
          SELECT id, name, category, duration_weeks, price_cents
          FROM users_packages
          ORDER BY name
        `);

        return res.render('admin/users/edit-user', {
          active:     'users-list',
          data:       {
            id, gender, firstname, lastname, contact, company, vatid, company_id,
            street, housenumber, postcode, city, country_id,
            phone, mobile, fax, email, website,
            showAddress, showCompany, showPhone, showEmail, showWebsite,
            imprint, package_id, category_id, users_package_id,
            selected_listing
          },
          countries,
          companies,
          packages,
          categories,
          usersPackages,
          listings: listingChoices,
          errors
        });
      }

      // User-Tabelle updaten
      await db.query(
        `UPDATE users
           SET gender                 = ?,
               firstname              = ?,
               lastname               = ?,
               contact                = ?,
               company                = ?,
               vatid                  = ?,
               company_id             = ?,
               street                 = ?,
               housenumber            = ?,
               postcode               = ?,
               city                   = ?,
               country_id             = ?,
               phone                  = ?,
               mobile                 = ?,
               fax                    = ?,
               email                  = ?,
               website                = ?,
               details_address_hidden = ?,
               details_name_hidden    = ?,
               details_phone_hidden   = ?,
               details_email_hidden   = ?,
               imprint                = ?,
               logo                   = ?
         WHERE id = ?`,
        [
          gender,
          firstname,
          lastname,
          contact   ? 1 : 0,
          company   || null,
          vatid     || null,
          company_id|| null,
          street    || null,
          housenumber|| null,
          postcode  || null,
          city      || null,
          country_id|| null,
          phone     || null,
          mobile    || null,
          fax       || null,
          email,
          website   || null,
          showAddress ? 0 : 1,
          showCompany ? 0 : 1,
          showPhone   ? 0 : 1,
          showEmail   ? 1 : 0,
          imprint   || null,
          logo,
          id
        ]
      );

      // Alte Package-Zuordnungen löschen
      await db.query(`DELETE FROM selected_packages WHERE user_id = ?`, [id]);

      // Neues Paket + Order
      if (package_id || category_id) {
        const [orderRes] = await db.query(
          `INSERT INTO orders
             (user_id, package_id, product, category_id, country_id,
              firstname, lastname, company, vatid, street, housenumber,
              postcode, city, phone, email, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            id,
            package_id   || null,
            package_id   || null,
            category_id  || null,
            country_id   || null,
            firstname,
            lastname,
            company      || null,
            vatid        || null,
            street       || null,
            housenumber  || null,
            postcode     || null,
            city         || null,
            phone        || null,
            email
          ]
        );
        const orderId = orderRes.insertId;

        await db.query(
          `INSERT INTO selected_packages
             (user_id, package_id, category_id, country_id,
              start_date, end_date, max_listings, used_listings, order_id)
           VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 1 YEAR), 0, 0, ?)`,
          [
            id,
            package_id   || null,
            category_id  || null,
            country_id   || null,
            orderId
          ]
        );
      }

      // Zusatzleistungen prüfen (Update oder Insert)
      if (users_package_id && selectedListing) {
        const [[up]] = await db.query(
          `SELECT duration_weeks, price_cents FROM users_packages WHERE id = ?`,
          [users_package_id]
        );

        if (up) {
          const [[existing]] = await db.query(
            `SELECT id FROM user_package_orders WHERE user_id = ? AND users_package_id = ?`,
            [id, users_package_id]
          );

          // Fake Stripe-ID Generator
          function generateFakeStripeId() {
            const rand = Math.floor(100000 + Math.random() * 900000);
            return `sk_perrechnung${rand}`;
          }

          const itemId = Number(selectedListing.id);
          const entitieId = Number(selectedListing.entitie_id) || null;

          if (existing) {
            // UPDATE
            await db.query(
              `UPDATE user_package_orders
                 SET entitie_id = ?,
                     item_id    = ?,
                     start_date = NOW(),
                     end_date   = DATE_ADD(NOW(), INTERVAL ? WEEK),
                     status     = 'pending',
                     examination_status = 1
               WHERE id = ?`,
              [
                entitieId || category_id || null,
                itemId,
                up.duration_weeks,
                existing.id
              ]
            );
            console.log("✔ user_package_orders geupdatet:", existing.id, "mit item_id:", itemId);
          } else {
            // INSERT
            const fakeStripeId = generateFakeStripeId();

            await db.query(
              `INSERT INTO user_package_orders
                 (user_id, entitie_id, item_id, users_package_id,
                  start_date, end_date, stripe_session_id, status, examination_status)
               VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? WEEK),
                       ?, 'pending', 1)`,
              [
                id,
                entitieId || category_id || null,
                itemId,
                users_package_id,
                up.duration_weeks,
                fakeStripeId
              ]
            );
            console.log("✔ user_package_orders neu angelegt für user_id:", id, "mit item_id:", itemId, "und stripe_session_id:", fakeStripeId);
          }
        }
      }

      


      // Redirect zurück zur Liste
      res.redirect('/admin/users');
    } catch (err) {
      next(err);
    }
  }
);


// GET: Zusatzleistungen & Inserat-Zuordnung separat bearbeiten
router.get('/:id/addons', requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const ctx = await loadUserAddonEditorContext(userId);
    if (!ctx) return res.status(404).send('User nicht gefunden');

    res.render('admin/users/addons', {
      active: 'users-list',
      user: ctx.user,
      usersPackages: ctx.usersPackages,
      listings: ctx.listings,
      addonAssignmentsByListing: ctx.addonAssignmentsByListing,
      currentAddonDisplay: ctx.currentAddonDisplay,
      data: ctx.formData,
      errors: []
    });
  } catch (err) {
    next(err);
  }
});

// POST: Zusatzleistungen & Inserat-Zuordnung separat speichern
router.post('/:id/addons', requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const usersPackageId = String(req.body?.users_package_id || '').trim();
    const selectedListingKey = String(req.body?.selected_listing || '').trim();

    const ctx = await loadUserAddonEditorContext(userId);
    if (!ctx) return res.status(404).send('User nicht gefunden');

    const errors = [];
    const selectedListing = selectedListingKey
      ? ctx.listings.find(l => l.key === selectedListingKey)
      : null;

    if (usersPackageId && !selectedListing) {
      errors.push({ msg: 'Für Zusatzleistungen bitte ein Inserat auswählen.' });
    }

    if (!ctx.listings.length && usersPackageId) {
      errors.push({ msg: 'Keine Inserate vorhanden. Zusatzleistungen können noch nicht zugeordnet werden.' });
    }

    if (errors.length) {
      return res.render('admin/users/addons', {
        active: 'users-list',
        user: ctx.user,
        usersPackages: ctx.usersPackages,
        listings: ctx.listings,
        addonAssignmentsByListing: ctx.addonAssignmentsByListing,
        currentAddonDisplay: ctx.currentAddonDisplay,
        data: {
          users_package_id: usersPackageId,
          selected_listing: selectedListingKey
        },
        errors
      });
    }

    // Optional: keine Auswahl = nichts ändern, aber sauber zurück
    if (!usersPackageId) {
      req.flash('success', 'Keine Zusatzleistung ausgewählt.');
      return res.redirect(`/admin/users/${userId}/addons`);
    }

    const [[up]] = await db.query(
      `SELECT id, name, category, placement_table, duration_weeks, price_cents
         FROM users_packages
        WHERE id = ?`,
      [usersPackageId]
    );

    if (!up) {
      return res.render('admin/users/addons', {
        active: 'users-list',
        user: ctx.user,
        usersPackages: ctx.usersPackages,
        listings: ctx.listings,
        addonAssignmentsByListing: ctx.addonAssignmentsByListing,
        currentAddonDisplay: ctx.currentAddonDisplay,
        data: {
          users_package_id: usersPackageId,
          selected_listing: selectedListingKey
        },
        errors: [{ msg: 'Ungültige Zusatzleistung.' }]
      });
    }

    const itemId = Number(selectedListing.id);
    const entitieId = Number(selectedListing.entitie_id) || null;

    const placementTableMap = {
      slideshow: 'slider_ads',
      top_listing: 'advert_inserat',
      sonstiges: 'catalog_ads',
      catalog: 'catalog_ads',
      inserat: 'advert_inserat',
      slider: 'slider_ads',
      katalog_slider: 'slider_ads'
    };
    const placementTable = String(up.placement_table || '').trim() || placementTableMap[String(up.category || '').trim()] || null;
    const allowedPlacementTables = new Set(['catalog_ads', 'advert_inserat', 'slider_ads']);

    if (!placementTable || !allowedPlacementTables.has(placementTable)) {
      return res.render('admin/users/addons', {
        active: 'users-list',
        user: ctx.user,
        usersPackages: ctx.usersPackages,
        listings: ctx.listings,
        addonAssignmentsByListing: ctx.addonAssignmentsByListing,
        currentAddonDisplay: ctx.currentAddonDisplay,
        data: {
          users_package_id: usersPackageId,
          selected_listing: selectedListingKey
        },
        errors: [{ msg: 'Für diese Zusatzleistung konnte keine gültige Placement-Tabelle gefunden werden.' }]
      });
    }

    const startDate = formatDateLikeAdminListings(new Date());
    const endDateObj = new Date();
    endDateObj.setDate(endDateObj.getDate() + ((Number(up.duration_weeks) || 0) * 7));
    const endDate = formatDateLikeAdminListings(endDateObj);

    if (!startDate || !endDate) {
      return res.render('admin/users/addons', {
        active: 'users-list',
        user: ctx.user,
        usersPackages: ctx.usersPackages,
        listings: ctx.listings,
        addonAssignmentsByListing: ctx.addonAssignmentsByListing,
        currentAddonDisplay: ctx.currentAddonDisplay,
        data: {
          users_package_id: usersPackageId,
          selected_listing: selectedListingKey
        },
        errors: [{ msg: 'Datumswerte konnten nicht erzeugt werden.' }]
      });
    }

    const [[existingPlacement]] = await db.query(
      `SELECT id
         FROM \`${placementTable}\`
        WHERE entitie_id = ?
          AND advert_id = ?
        ORDER BY id DESC
        LIMIT 1`,
      [entitieId, itemId]
    );

    if (existingPlacement) {
      await db.query(
        `UPDATE \`${placementTable}\`
            SET start_date = ?, end_date = ?
          WHERE id = ?`,
        [startDate, endDate, existingPlacement.id]
      );
    } else {
      await db.query(
        `INSERT INTO \`${placementTable}\`
          (entitie_id, advert_id, start_date, end_date)
         VALUES (?, ?, ?, ?)`,
        [entitieId, itemId, startDate, endDate]
      );
    }

    req.flash('success', `Werbeanzeige direkt in ${placementTable} gespeichert.`);
    res.redirect(`/admin/users/${userId}/addons`);
  } catch (err) {
    next(err);
  }
});

// POST: Zusatzleistung manuell aktivieren (pending -> paid)
router.post('/:id/addons/:addonOrderId/activate', requireAdmin, async (req, res, next) => {
  try {
    const userId = Number(req.params.id);
    const addonOrderId = Number(req.params.addonOrderId);

    if (!Number.isFinite(userId) || !Number.isFinite(addonOrderId)) {
      req.flash('error', 'Ungültige Anfrage.');
      return res.redirect('/admin/users');
    }

    const [[placementColRow]] = await db.query(
      `SELECT 1
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'users_packages'
          AND COLUMN_NAME = 'placement_table'
        LIMIT 1`
    );
    const hasPlacementColumn = Boolean(placementColRow);

    const placementSelect = hasPlacementColumn
      ? 'pkg.placement_table AS placement_table,'
      : 'NULL AS placement_table,';

    const [[order]] = await db.query(
      `SELECT
         upo.id,
         upo.user_id,
         upo.status,
         upo.entitie_id,
         upo.item_id,
         upo.start_date,
         upo.end_date,
         upo.users_package_id,
         pkg.category AS package_category,
         ${placementSelect}
         pkg.name AS package_name
       FROM user_package_orders upo
       LEFT JOIN users_packages pkg ON pkg.id = upo.users_package_id
       WHERE upo.id = ? AND upo.user_id = ?
       LIMIT 1`,
      [addonOrderId, userId]
    );

    if (!order) {
      req.flash('error', 'Zusatzleistung nicht gefunden.');
      return res.redirect(`/admin/users/${userId}/addons`);
    }

    if (!order.entitie_id || !order.item_id || !order.start_date || !order.end_date) {
      req.flash('error', 'Zusatzleistung hat keine vollständige Inserat-/Datumszuordnung.');
      return res.redirect(`/admin/users/${userId}/addons`);
    }

    if (String(order.status || '').toLowerCase() !== 'paid') {
      await db.query(
        `UPDATE user_package_orders
            SET status = 'paid'
          WHERE id = ? AND user_id = ?`,
        [addonOrderId, userId]
      );
    }

    const placementTableMap = {
      slideshow: 'slider_ads',
      top_listing: 'advert_inserat',
      sonstiges: 'catalog_ads'
    };
    const placementTable = order.placement_table || placementTableMap[order.package_category] || null;
    const allowedPlacementTables = new Set(['catalog_ads', 'advert_inserat', 'slider_ads']);

    let placementMsg = 'Keine Placement-Tabelle konfiguriert.';

    if (placementTable && allowedPlacementTables.has(placementTable)) {
      const placementStart = formatDateLikeAdminListings(order.start_date);
      const placementEnd = formatDateLikeAdminListings(order.end_date);

      if (!placementStart || !placementEnd) {
        placementMsg = 'Placement konnte nicht geschrieben werden (Datumsformat ungültig).';
      } else {
        const [[exists]] = await db.query(
          `SELECT id
             FROM \`${placementTable}\`
            WHERE entitie_id = ?
              AND advert_id  = ?
              AND start_date = ?
              AND end_date   = ?
            LIMIT 1`,
          [order.entitie_id, order.item_id, placementStart, placementEnd]
        );

        if (!exists) {
          await db.query(
            `INSERT INTO \`${placementTable}\`
              (entitie_id, advert_id, start_date, end_date)
             VALUES (?,?,?,?)`,
            [order.entitie_id, order.item_id, placementStart, placementEnd]
          );
          placementMsg = `Placement in ${placementTable} angelegt.`;
        } else {
          placementMsg = `Placement in ${placementTable} existiert bereits.`;
        }
      }
    } else if (placementTable) {
      placementMsg = `Placement-Tabelle ${placementTable} ist nicht freigegeben.`;
    }

    req.flash('success', `Zusatzleistung manuell aktiviert (Status = paid). ${placementMsg}`);
    return res.redirect(`/admin/users/${userId}/addons`);
  } catch (err) {
    next(err);
  }
});




// GET /admin/users/new – Formular anzeigen
router.get('/new', requireAdmin, async (req, res, next) => {
  console.log('GET /admin/users/new – form anzeigen');
  try {
    const [countries]  = await db.query(`SELECT id, en AS label FROM countries ORDER BY en`);
    const [companies]  = await db.query(`SELECT id, name FROM companies ORDER BY name`);
    const [packages]   = await db.query(`
      SELECT id, name, description, price, duration_unit, duration_amt
        FROM packages
       ORDER BY sort_order
    `);
    const [categories] = await db.query(`SELECT id, name FROM ententies ORDER BY id`);

    console.log('Dropdown-Daten geladen:', {
      countries: countries.length,
      companies: companies.length,
      packages:  packages.length,
      categories: categories.length,

    });

    res.render('admin/users/new-user', {
      active:     'users-new',
      data:       req.session.userDraft || {},
      errors:     [],
      countries,
      companies,
      packages,
      categories, 
    });
  } catch (err) {
    console.error('GET /admin/users/new Error:', err);
    next(err);
  }
});

router.post(
  '/new',
  requireAdmin,
  uploadMemory.single('logo'),
  body('firstname').trim().notEmpty().withMessage('Vorname ist Pflicht.'),
  body('lastname').trim().notEmpty().withMessage('Nachname ist Pflicht.'),
  body('email')    .isEmail().withMessage('Bitte gültige E-Mail eingeben.'),
  async (req, res, next) => {
    console.log('POST /admin/users/new – Data empfangen:', {
      body: req.body,
      file: req.file && req.file.originalname
    });
    const errors = validationResult(req);
    console.log('ValidationErrors:', errors.array());

    const data = {
      gender:      req.body.gender,
      contact:     req.body.contact === 'on' ? 1 : 0,
      company:     req.body.company || null,
      vatid:       req.body.vatid || null,
      firstname:   req.body.firstname,
      lastname:    req.body.lastname,
      company_id:  req.body.company_id || null,
      street:      req.body.street || null,
      housenumber: req.body.housenumber || null,
      postcode:    req.body.postcode || null,
      city:        req.body.city || null,
      country_id:  req.body.country_id || null,
      phone:       req.body.phone || null,
      mobile:      req.body.mobile || null,
      fax:         req.body.fax || null,
      email:       req.body.email,
      blacklist:   req.body.blacklist === 'on' ? 1 : 0,
      website:     req.body.website || null,
      imprint:     req.body.imprint || null,
      details:     req.body.details || 0,
      package_id:  req.body.package_id || null,
      category_id: req.body.category_id || null,
      users_package_id: req.body.users_package_id || null   // bleibt im data, wird aber nicht genutzt
    };

    // ➜ Validierungsfehler → Formular zurückrendern
    if (!errors.isEmpty()) {
      console.log('Re-render form wegen Errors');
      const [countries]     = await db.query(`SELECT id, en AS label FROM countries ORDER BY en`);
      const [companies]     = await db.query(`SELECT id, name FROM companies ORDER BY name`);
      const [packages]      = await db.query(`
        SELECT id, name, description, price, duration_unit, duration_amt
          FROM packages
         ORDER BY sort_order
      `);
      const [categories]    = await db.query(`SELECT id, name FROM ententies ORDER BY id`);
      const [usersPackages] = await db.query(`
        SELECT id, name, category, duration_weeks, price_cents
          FROM users_packages
         ORDER BY name
      `);
      return res.render('admin/users/new-user', {
        active:     'users-new',
        data,
        errors:     errors.array(),
        countries,
        companies,
        packages,
        categories,
        usersPackages
      });
    }

    try {
      console.log('1) Generiere Passwort & hash');
      const passwordPlain = crypto.randomBytes(6).toString('hex');
      const passwordHash  = await bcrypt.hash(passwordPlain, 10);

      console.log('2) INSERT INTO users');
      const [result] = await db.query(
        `INSERT INTO users
           (
             gender, contact, company, vatid, firstname, lastname,
             company_id, street, housenumber, postcode, city,
             country_id, phone, mobile, fax, email, password,
             blacklist, website, imprint, details,
             created, modified
           )
         VALUES
           (
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW()
           )`,
        [
          data.gender,
          data.contact,
          data.company,
          data.vatid,
          data.firstname,
          data.lastname,
          data.company_id,
          data.street,
          data.housenumber,
          data.postcode,
          data.city,
          data.country_id,
          data.phone,
          data.mobile,
          data.fax,
          data.email,
          passwordHash,
          data.blacklist,
          data.website,
          data.imprint,
          data.details
        ]
      );
      console.log('Neuer User ID:', result.insertId);
      const newUserId = result.insertId;

      // 3) Logo speichern, falls hochgeladen
      if (req.file) {
        console.log('3) Logo hochgeladen, speichere...');
        const destDir = path.join(
          '/media/herando/images/users',
          String(newUserId)
        );
        console.log('Destination Dir:', destDir);
        await fs.mkdir(destDir, { recursive: true });
        const ext = path.extname(req.file.originalname);
        const filename = `logo${ext}`;
        const fullPath = path.join(destDir, filename);
        console.log('Schreibe Datei nach:', fullPath);
        await fs.writeFile(fullPath, req.file.buffer);
        const dbPath = `/users/${newUserId}/${filename}`;
        console.log('UPDATE users SET logo =', dbPath);
        await db.query(
          `UPDATE users SET logo = ? WHERE id = ?`,
          [ dbPath, newUserId ]
        );
      }

      // 4) Paket-Infos & selected_packages
      if (data.package_id) {
        console.log('4) Paket-Infos auslesen & selected_packages einfügen');
        const [[pkgInfo]] = await db.query(
          `SELECT duration_unit, duration_amt, inseratenanzahl
             FROM packages
            WHERE id = ?`,
          [ data.package_id ]
        );
        console.log('pkgInfo:', pkgInfo);

        // 4a) Neuen Auftrag in orders anlegen
        console.log('4a) Neuen Auftrag in orders anlegen');
        const [orderResult] = await db.query(
          `INSERT INTO orders
             (user_id, package_id, product, category_id, country_id,
              firstname, lastname, company, vatid,
              street, housenumber, postcode, city,
              phone, email, created_at)
           VALUES
             (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            newUserId,
            data.package_id,
            data.package_id,    // oder ein anderer Produkt-String
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
        console.log('→ orders.insertId =', orderResult.insertId);

        // 4b) Laufzeit-Expression berechnen
        let endDateExpr;
        if (pkgInfo.duration_unit === 'months') {
          endDateExpr = `DATE_ADD(NOW(), INTERVAL ${pkgInfo.duration_amt} MONTH)`;
        } else {
          endDateExpr = `DATE_ADD(NOW(), INTERVAL ${pkgInfo.duration_amt} DAY)`;
        }
        console.log('endDateExpr =', endDateExpr);

        // 4c) Nun selected_packages anlegen
        console.log('4c) selected_packages anlegen');
        await db.query(
          `INSERT INTO selected_packages
             (user_id, package_id, category_id, country_id,
              start_date, end_date,
              max_listings, used_listings,
              order_id, created_at)
           VALUES
             (?, ?, ?, ?, NOW(), ${endDateExpr}, ?, 0, ?, NOW())`,
          [
            newUserId,
            data.package_id,
            data.category_id,
            data.country_id,
            pkgInfo.inseratenanzahl,
            /* order_id */ orderResult.insertId
          ]
        );
        console.log('✔ selected_packages erfolgreich angelegt');
      }

      // KEIN INSERT mehr in user_package_orders hier!

      delete req.session.userDraft;
      req.flash('success', `Neuer Benutzer #${newUserId} angelegt. Passwort: ${passwordPlain}`);
      res.redirect('/admin/users');
    } catch (err) {
      console.error('POST /admin/users/new Error:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        console.log('E-Mail duplicate, re-render form');
        const [countries]     = await db.query(`SELECT id, en AS label FROM countries ORDER BY en`);
        const [companies]     = await db.query(`SELECT id, name FROM companies ORDER BY name`);
        const [packages]      = await db.query(`
          SELECT id, name, description, price, duration_unit, duration_amt
            FROM packages
           ORDER BY sort_order
        `);
        const [categories]    = await db.query(`SELECT id, name FROM ententies ORDER BY id`);
        const [usersPackages] = await db.query(`
          SELECT id, name, category, duration_weeks, price_cents
            FROM users_packages
           ORDER BY name
        `);
        return res.render('admin/users/new-user', {
          active:     'users-new',
          data,
          errors:     [{ msg: 'Diese E-Mail ist bereits vergeben.' }],
          countries,
          companies,
          packages,
          categories,
          usersPackages
        });
      }
      next(err);
    }
  }
);





/** Hilfsfunktion: zieht einen brauchbaren Bildpfad/URL aus allen möglichen Formaten */
function normalizeThumb(raw) {
  if (raw == null) return null;

  if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');

  // Wenn schon Array/Objekt
  if (typeof raw !== 'string') {
    if (Array.isArray(raw) && raw.length) {
      const first = raw[0];
      return typeof first === 'string' ? first : (first?.image || first?.url || first?.src || null);
    }
    if (raw && typeof raw === 'object') {
      return raw.image || raw.file || raw.url || raw.src || null;
    }
    return null;
  }

  const s = raw.trim();

  // bereits URL oder klarer Dateiname
  if (/^https?:\/\//i.test(s)) return s;
  if (/\.(jpg|jpeg|png|gif|webp|avif)(\?.*)?$/i.test(s) && !/^a:\d+:\{/.test(s)) return s;

  // JSON
  if (/^[\[\{]/.test(s)) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed) && parsed.length) {
        const first = parsed[0];
        return typeof first === 'string' ? first : (first?.image || first?.url || first?.src || null);
      }
      if (parsed && typeof parsed === 'object') {
        return parsed.image || parsed.file || parsed.url || parsed.src || null;
      }
    } catch {}
  }

  // PHP-serialized (z.B. a:2:{s:5:"image";s:...})
  if (/^[aObis]:\d+:/.test(s) || /^a:\d+:\{/.test(s)) {
    try {
      const parsed = unserialize(s);
      if (Array.isArray(parsed) && parsed.length) {
        const first = parsed[0];
        return typeof first === 'string' ? first : (first?.image || first?.url || first?.src || null);
      }
      if (parsed && typeof parsed === 'object') {
        return parsed.image || parsed.file || parsed.url || parsed.src || null;
      }
    } catch {}
  }

  // CSV / Pipes
  if (s.includes(',') || s.includes('|')) {
    const token = s.split(/[,\|]/)[0].trim();
    if (token) return token;
  }

  // <img src="...">
  const imgMatch = s.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  // Fallback: Dateiname am Ende extrahieren
  const fileMatch = s.match(/([A-Za-z0-9_\-\/]+?\.(?:jpg|jpeg|png|gif|webp|avif))(?:\?.*)?$/i);
  if (fileMatch) return fileMatch[1];

  return null;
}

router.get('/:id/overview', requireAdmin, async (req, res, next) => { 
  try {
    const userId = Number(req.params.id);
    const { status, visits, minPrice } = req.query; // Filterparameter aus URL

    // 1) User holen
    const [[user]] = await db.query(
      `SELECT 
         id, email, firstname, lastname, company, created, modified, confirmed,
         lastrun AS last_online
       FROM users
       WHERE id = ?`,
      [userId]
    );
    if (!user) return res.status(404).send('User nicht gefunden');

    // 2) Inserate laden
    let listingsByEntity = await loadUserListingsAcrossEntities(userId);

    // Thumbnails normalisieren
    for (const ent of listingsByEntity) {
      for (const r of ent.rows) {
        if (r.title == null) r.title = `#${r.id}`;
        if (r.thumb != null) {
          r.thumb = normalizeThumb(r.thumb);
          if (r.thumb && !/^https?:\/\//i.test(r.thumb) && !r.thumb.startsWith('/')) {
            r.thumb = `/images/${ent.route}/${r.id}/${r.thumb}`;
          }
        }
      }
    }

    // 3) Filter anwenden
    listingsByEntity = listingsByEntity.map(ent => {
      ent.rows = ent.rows.filter(r => {
        let ok = true;

        // Statusfilter
        if (status === 'online') ok = ok && r.status == 3 && r.visible == 1;
        if (status === 'offline') ok = ok && !(r.status == 3 && r.visible == 1);

        // Besucherfilter
        if (visits === '0') ok = ok && (r.visits || 0) === 0;
        if (visits === '10plus') ok = ok && (r.visits || 0) >= 10;
        if (visits === '100plus') ok = ok && (r.visits || 0) >= 100;

        // Preisfilter
        if (minPrice) ok = ok && Number(r.price) >= Number(minPrice);

        return ok;
      });

      // Anzahl nach Filter anpassen
      ent.count = ent.rows.length;
      return ent;
    });

    // Besucher-Daten sammeln
    const visitsData = [];
    listingsByEntity.forEach(ent => {
      ent.rows.forEach(r => {
        visitsData.push({
          title: r.title,
          count: r.visits || 0
        });
      });
    });

    // Statistiken
    const stats = {
      total_listings: listingsByEntity.reduce((sum, ent) => sum + ent.count, 0),
      visible_listings: listingsByEntity.reduce((sum, ent) => sum + ent.rows.filter(r => r.visible == 1).length, 0),
      hidden_listings: listingsByEntity.reduce((sum, ent) => sum + ent.rows.filter(r => r.visible != 1).length, 0),
      messages_sent: 0,
      messages_received: 0
    };

    // Optional JSON
    if ((req.query.format || '').toLowerCase() === 'json') {
      return res.json({
        user,
        last_online: user.last_online,
        entities: listingsByEntity,
        visits: visitsData,
        stats
      });
    }

    // View rendern
    res.render('admin/users/overview', {
      active: 'users-list',
      user,
      last_online: user.last_online,
      listingsByEntity,
      visits: visitsData,
      stats,
      query: req.query // damit die EJS den aktuellen Filter kennt
    });

  } catch (err) {
    next(err);
  }
});

router.get('/:id/activity', requireAdmin, async (req, res, next) => {
  try {
    await ensureActivityLogTable();

    const userId = Number.parseInt(String(req.params.id || ''), 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).send('Ungültige User-ID');
    }

    const [[user]] = await db.query(
      `SELECT id, role, email, firstname, lastname, company, created, lastrun AS last_online
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userId]
    );
    if (!user) return res.status(404).send('User nicht gefunden');

    const { from, to } = parseActivityRange(req.query);
    const fromSql = toSqlDateTime(from);
    const toSql = toSqlDateTime(to);
    const pathLike = String(req.query.path || '').trim().slice(0, 255);
    const perPage = clampInt(req.query.per_page || 50, { min: 20, max: 200 });
    const requestedPage = clampInt(req.query.page || 1, { min: 1, max: 10000 });

    const activityWhere = ['a.actor_user_id = ?', 'a.created_at BETWEEN ? AND ?'];
    const activityParams = [userId, fromSql, toSql];
    if (pathLike) {
      activityWhere.push('a.path LIKE ?');
      activityParams.push(`%${pathLike}%`);
    }

    const clickWhere = [`ve.event_type = 'click'`, 've.user_id = ?', 've.created_at BETWEEN ? AND ?'];
    const clickParams = [userId, fromSql, toSql];
    if (pathLike) {
      clickWhere.push('ve.path LIKE ?');
      clickParams.push(`%${pathLike}%`);
    }

    const [[activityCountRow]] = await db.query(
      `SELECT COUNT(*) AS cnt
         FROM activity_log a
        WHERE ${activityWhere.join(' AND ')}`,
      activityParams
    );

    const [[clickCountRow]] = await db.query(
      `SELECT COUNT(*) AS cnt
         FROM visit_events ve
        WHERE ${clickWhere.join(' AND ')}`,
      clickParams
    );

    const requestCount = Number(activityCountRow?.cnt || 0);
    const clickCount = Number(clickCountRow?.cnt || 0);
    const totalCount = requestCount + clickCount;

    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * perPage;

    let events = [];
    if (totalCount > 0) {
      const [rows] = await db.query(
        `
        SELECT *
          FROM (
            SELECT
              a.id AS row_id,
              a.created_at AS sort_created_at,
              DATE_FORMAT(a.created_at, '%d.%m.%Y %H:%i:%s') AS created_at_label,
              'request' AS source_type,
              a.path,
              a.method,
              a.status_code,
              a.duration_ms,
              NULL AS element,
              NULL AS element_text,
              NULL AS target_url,
              a.payload_json AS detail_json
            FROM activity_log a
            WHERE ${activityWhere.join(' AND ')}
            UNION ALL
            SELECT
              ve.id AS row_id,
              ve.created_at AS sort_created_at,
              DATE_FORMAT(ve.created_at, '%d.%m.%Y %H:%i:%s') AS created_at_label,
              'click' AS source_type,
              ve.path,
              NULL AS method,
              NULL AS status_code,
              NULL AS duration_ms,
              ve.element,
              ve.element_text,
              ve.target_url,
              ve.meta AS detail_json
            FROM visit_events ve
            WHERE ${clickWhere.join(' AND ')}
          ) activity_stream
         ORDER BY sort_created_at DESC
         LIMIT ? OFFSET ?
        `,
        [...activityParams, ...clickParams, perPage, offset]
      );
      events = mapUserActivityRows(rows);
    }

    res.render('admin/users/activity', {
      active: 'users-list',
      user,
      events,
      query: {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        path: pathLike,
        per_page: perPage
      },
      paging: {
        page,
        perPage,
        totalPages,
        totalCount
      },
      stats: {
        requestCount,
        clickCount
      }
    });
  } catch (err) {
    next(err);
  }
});



module.exports = router;

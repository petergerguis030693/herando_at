const express   = require('express');
const bcrypt    = require('bcrypt');
const { body, validationResult } = require('express-validator');
const crypto    = require('crypto');
const db        = require('../../db');
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
    if (!user || Number(user.role) !== 9) {
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


router.get('/', requireAdmin, async (req, res, next) => {
  console.log('GET /admin/users/ list start');
  try {
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 30;
    const offset  = (page - 1) * perPage;
    const search  = (req.query.search || '').trim();
    const status  = (req.query.status || 'all').trim();
    const packageFilter = (req.query.package || '').trim();

    console.log({ page, perPage, offset, search, status, packageFilter });

    // Grund-Filter
    const where  = [
      'u.blacklist = 0',
      '( (u.firstname IS NOT NULL AND u.firstname <> "") OR (u.lastname IS NOT NULL AND u.lastname <> "") )'
    ];
    const params = [];

    // Such-Filter
    if (search) {
      where.push(`CONCAT_WS(' ',
        u.id, u.role, u.logging, u.gender, u.contact,
        u.company, u.vatid, u.firstname, u.lastname,
        u.street, u.housenumber, u.postcode, u.city,
        u.email
      ) LIKE ?`);
      params.push(`%${search}%`);
    }

    // Status-Filter (alte Vertragslogik bleibt)
    const expirationExpr = `
      DATE_ADD(
        IFNULL(u.modified, u.created),
        INTERVAL 1 YEAR
      )
    `;
    if (status === 'active') {
      where.push(`${expirationExpr} >= NOW()`);
    } else if (status === 'expired') {
      where.push(`${expirationExpr} < NOW()`);
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

    // Userliste laden
    const [users] = await db.query(
      `SELECT
         u.id,
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
           SELECT GROUP_CONCAT(sp.package_id SEPARATOR ', ')
           FROM selected_packages sp
           WHERE sp.user_id = u.id
         ) AS packages_taken
       FROM users u
       WHERE ${whereSQL}
       ORDER BY u.lastname, u.firstname
       LIMIT ? OFFSET ?`,
      [...params, perPage, offset]
    );

    console.log('Loaded users:', users.length);

    // Alle verfügbaren Pakete für Filter-Buttons laden
    const [allPackages] = await db.query(`
      SELECT DISTINCT package_id
      FROM selected_packages
      ORDER BY package_id ASC
    `);

    // Erneuerungen diesen Monat (alte Vertragslogik)
    const [renewals] = await db.query(`
      SELECT 
        u.id,
        u.firstname,
        u.lastname,
        DATE_ADD(IFNULL(u.modified, u.created), INTERVAL 1 YEAR) AS ablaufdatum
      FROM users u
      WHERE DATE_ADD(IFNULL(u.modified, u.created), INTERVAL 1 YEAR) >= CURDATE()
        AND YEAR(DATE_ADD(IFNULL(u.modified, u.created), INTERVAL 1 YEAR)) = YEAR(CURDATE())
        AND MONTH(DATE_ADD(IFNULL(u.modified, u.created), INTERVAL 1 YEAR)) = MONTH(CURDATE())
      ORDER BY u.lastname, u.firstname
    `);

    // Rendern
    res.render('admin/users/list', {
      active: 'users-list',
      users,
      renewals,
      page,
      totalPages,
      search,
      status,
      packageFilter,
      allPackages
    });

  } catch (err) {
    console.error('GET /admin/users/ Error:', err);
    next(err);
  }
});






// POST /admin/users: leitet Suche & Status-Filter an GET weiter
router.post('/', requireAdmin, (req, res) => {
  const { search = '', status = 'all' } = req.body;
  res.redirect(
    `/admin/users?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`
  );
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
    await db.query(
      `UPDATE users
         SET modified = DATE_SUB(
           DATE_SUB(NOW(), INTERVAL 1 YEAR),
           INTERVAL 1 DAY
         )
       WHERE id = ?`,
      [id]
    );
    res.redirect(req.get('Referer') || '/admin/users');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/activate', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { flatrateType } = req.body; // z.B. "cars" oder "all"

    const validCols = [
      'flatrate_all',
      'flatrate_cars',
      'flatrate_properties',
      'flatrate_watches',
      'flatrate_yachts',
      'flatrate_investments'
    ];

    if (!validCols.includes(flatrateType)) {
      req.flash('error', 'Ungültige Flatrate-Auswahl.');
      return res.redirect('/admin/users');
    }

    await db.query(
      `UPDATE users SET ${flatrateType} = NOW() WHERE id = ?`,
      [id]
    );

    req.flash('success', `Flatrate (${flatrateType}) erfolgreich aktiviert.`);
    res.redirect('/admin/users');
  } catch (err) {
    console.error('POST /admin/users/:id/activate Error:', err);
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

    // Inserate laden
    const [cars]       = await db.query(`SELECT id, name FROM cars WHERE user_id = ?`, [id]);
    const [properties] = await db.query(`SELECT id, name FROM properties WHERE user_id = ?`, [id]);
    const [lifestyles] = await db.query(`SELECT id, name FROM lifestyles WHERE user_id = ?`, [id]);
    const [watches]    = await db.query(`SELECT id, name FROM watches WHERE user_id = ?`, [id]);
    const [yachts]     = await db.query(`SELECT id, name FROM yachts WHERE user_id = ?`, [id]);

    // Alles in ein Array packen
      const listings = [
        ...cars.map(r => ({ type: 'Car', id: r.id, title: r.name })),
        ...properties.map(r => ({ type: 'Property', id: r.id, title: r.name })),
        ...lifestyles.map(r => ({ type: 'Lifestyle', id: r.id, title: r.name })),
        ...watches.map(r => ({ type: 'Watch', id: r.id, title: r.name })),
        ...yachts.map(r => ({ type: 'Yacht', id: r.id, title: r.name })),
      ];


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
        users_package_id
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
            imprint, package_id, category_id
          },
          countries,
          companies,
          packages,
          categories,
          usersPackages,
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
      if (users_package_id) {
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

          // Item-ID aus Inseraten suchen
          let itemId = null;
          const tables = ["cars", "properties", "lifestyles", "watches", "yachts"];
          for (const tbl of tables) {
            const [[found]] = await db.query(
              `SELECT id FROM ${tbl} WHERE user_id = ? LIMIT 1`,
              [id]
            );
            if (found) {
              itemId = found.id;
              break;
            }
          }

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
                category_id || null,
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
                category_id || null,
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



module.exports = router;

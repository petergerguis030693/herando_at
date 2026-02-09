// src/routes/admin/entieties.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../../db');
const router = express.Router();

// Middleware zum Laden aller Entitäten
router.use(async (req, res, next) => {
  try {
    const [entieties] = await db.query(
      `SELECT id, name, route, table_name, created
         FROM ententies
       ORDER BY created DESC`
    );
    res.locals.entieties = entieties;
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', (req, res) => {
  res.render('admin/entieties/list', {
    active: 'entieties',
    entieties: res.locals.entieties,
    errors: null
  });
});

router.get('/new', (req, res) => {
  res.render('admin/entieties/form', {
    active: 'entieties',
    entitie: {},
    isNew: true,
    errors: null
  });
});

router.post(
  '/new',
  [
    body('name').trim().notEmpty().withMessage('Name darf nicht leer sein.'),
    body('route').trim().notEmpty().withMessage('Route darf nicht leer sein.'),
    body('table_name').trim().notEmpty().withMessage('Tabellenname darf nicht leer sein.')
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('admin/entieties/form', {
        active: 'entieties',
        entitie: req.body,
        isNew: true,
        errors: errors.array()
      });
    }
    try {
      const result = await db.query(
        `INSERT INTO ententies (name, route, table_name, description)
        VALUES (?, ?, ?, ?)`,
        [ req.body.name, req.body.route, req.body.table_name, req.body.description ]
      );
      // Core-Table erzeugen
      const route = req.body.route;
      const coreColumns = `
        id INT AUTO_INCREMENT PRIMARY KEY,
        external VARCHAR(50),
        entitie TINYINT UNSIGNED NOT NULL,
        status TINYINT UNSIGNED DEFAULT 0,
        duration VARCHAR(10),
        visible TINYINT(1) DEFAULT 0,
        mainpicture TEXT,
        sliderpicture TEXT,
        pictures TEXT,
        visits INT DEFAULT 0,
        base_price DECIMAL(10,0),
        price DECIMAL(10,0),
        sorting INT DEFAULT 0,
        created DATETIME,
        modified DATETIME,
        published DATETIME,
        lastchange INT
      `;
      await db.query(`CREATE TABLE \`${route}\` (${coreColumns});`);
      req.flash('success', 'Kategorie und Tabelle erfolgreich angelegt.');
      res.redirect('/admin/entieties');
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id/edit', async (req, res, next) => {
  try {
    const [[entitie]] = await db.query(
      `SELECT id, name, route, table_name, description 
         FROM ententies
       WHERE id = ?`,
      [req.params.id]
    );
    if (!entitie) return res.redirect('/admin/entieties');
    res.render('admin/entieties/form', {
      active: 'entieties',
      entitie,
      isNew: false,
      errors: null
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/:id/edit',
  [
    body('name').trim().notEmpty().withMessage('Name darf nicht leer sein.'),
    body('route').trim().notEmpty().withMessage('Route darf nicht leer sein.'),
    body('table_name').trim().notEmpty().withMessage('Tabellenname darf nicht leer sein.')
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.render('admin/entieties/form', {
        active: 'entieties',
        entitie: { ...req.body, id: req.params.id },
        isNew: false,
        errors: errors.array()
      });
    }
    try {
        await db.query(
          `UPDATE ententies
              SET name        = ?,
                  route       = ?,
                  table_name  = ?,
                  description = ?
            WHERE id = ?`,
          [
            req.body.name,
            req.body.route,
            req.body.table_name,
            req.body.description,
            req.params.id
          ]
        );
      req.flash('success', 'Kategorie erfolgreich aktualisiert.');
      res.redirect('/admin/entieties');
    } catch (err) {
      next(err);
    }
  }
);

router.post('/:id/delete', async (req, res, next) => {
  try {
    // Tabelle löschen
    const [[ent]] = await db.query(`SELECT route FROM ententies WHERE id = ?`, [req.params.id]);
    if (ent) {
      await db.query(`DROP TABLE IF EXISTS \`${ent.route}\``);
    }
    await db.query(`DELETE FROM ententies WHERE id = ?`, [req.params.id]);
    req.flash('success', 'Kategorie und zugehörige Tabelle gelöscht.');
    res.redirect('/admin/entieties');
  } catch (err) {
    next(err);
  }
});

router.get('/:id/attributes', async (req, res, next) => {
  try {
    const entId = req.params.id;
    const [[ent]] = await db.query(
      `SELECT id, route FROM ententies WHERE id = ?`, 
      [entId]
    );

    // 1) Metadaten
    const [attrs] = await db.query(
      `SELECT id, column_name, label, field_type, config_json
         FROM attribute_definitions
       WHERE entitie_id = ?
       ORDER BY id`,
      [entId]
    );

    // 2) Alle Spalten der Tabelle
    const [cols] = await db.query(
      `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [ent.route]
    );

    // 3) Merge
    const columns = cols.map(col => {
      const meta = attrs.find(a => a.column_name === col.column_name);
      return {
        column_name: col.column_name,
        data_type:    col.data_type,
        label:        meta?.label      || col.column_name,
        field_type:   meta?.field_type || 'core',
        config:       meta?.config_json ? JSON.parse(meta.config_json) : null,
        id:           meta?.id || null
      };
    });

    // 4) Rendern
    res.render('admin/entieties/attributes/list', {
      active:  'entieties',
      ent,
      columns
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/attributes/new', async (req, res, next) => {
  const entId = req.params.id;
  const [[ent]] = await db.query(`SELECT route FROM ententies WHERE id = ?`, [entId]);
  res.render('admin/entieties/attributes/form', {
    active: 'entieties',
    ent,
    attribute: {},
    errors: null
  });
});

router.get('/:id/attributes/:columnName/edit', async (req, res, next) => {
  try {
    const entId = req.params.id;
    const columnName = req.params.columnName;
    const [[ent]] = await db.query(
      `SELECT id, route FROM ententies WHERE id = ?`,
      [entId]
    );

    // Metadaten auslesen (falls vorhanden)
    const [[attr]] = await db.query(
      `SELECT id, column_name, label, field_type, config_json
         FROM attribute_definitions
       WHERE entitie_id = ? AND column_name = ?`,
      [entId, columnName]
    );

    // Attribut-Objekt befüllen (bei Core-Feldern ohne Metadaten vorausgefüllt)
    const attribute = attr || {
      column_name,
      label: columnName,
      field_type: 'text',
      config_json: ''
    };

    res.render('admin/entieties/attributes/form', {
      active: 'entieties',
      ent,
      attribute,
      isEdit: true,
      errors: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attributes/:columnName/edit', async (req, res, next) => {
  try {
    const entId = req.params.id;
    const columnName = req.params.columnName;
    const { label, field_type, config_json } = req.body;
    const [[ent]] = await db.query(
      `SELECT route FROM ententies WHERE id = ?`,
      [entId]
    );

    // Metadaten updaten oder neu anlegen
    await db.query(
      `INSERT INTO attribute_definitions
         (entitie_id, column_name, label, field_type, config_json)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         label = VALUES(label),
         field_type = VALUES(field_type),
         config_json = VALUES(config_json)`,
      [entId, columnName, label, field_type, config_json || null]
    );

    req.flash('success', `Attribut „${columnName}“ aktualisiert.`);
    res.redirect(`/admin/entieties/${entId}/attributes`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attributes/new', async (req, res, next) => {
  try {
    const entId = req.params.id;
    const [[ent]] = await db.query(`SELECT route FROM ententies WHERE id = ?`, [entId]);
    const { column_name, label, field_type, config_json } = req.body;
    // Validierung einfachheitshalber minimal
    await db.query(
      `INSERT INTO attribute_definitions
         (entitie_id, column_name, label, field_type, config_json)
       VALUES (?, ?, ?, ?, ?)`,
      [entId, column_name, label, field_type, config_json || null]
    );
    // Spalte hinzufügen
    let alter = `ALTER TABLE \`${ent.route}\` ADD COLUMN \`${column_name}\``;
    switch(field_type) {
      case 'boolean':   alter += ' TINYINT(1) NULL'; break;
      case 'number':    alter += ' INT NULL'; break;
      case 'date':      alter += ' DATE NULL'; break;
      case 'select':    alter += ' VARCHAR(100) NULL'; break;
      case 'relation':  alter += ' INT NULL'; break;
      default:          alter += ' VARCHAR(255) NULL';
    }
    await db.query(alter + ';');
    req.flash('success', 'Attribut hinzugefügt und Tabelle angepasst.');
    res.redirect(`/admin/entieties/${entId}/attributes`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attributes/:columnName/delete', async (req, res, next) => {
  try {
    const entId      = req.params.id;
    const columnName = req.params.columnName;
    const [[ent]]    = await db.query(
      `SELECT route FROM ententies WHERE id = ?`,
      [entId]
    );

    // 1) Spalte aus der Tabelle löschen
    await db.query(`ALTER TABLE \`${ent.route}\` DROP COLUMN \`${columnName}\``);

    // 2) Falls es einen Metadaten-Eintrag gab, diesen ebenfalls entfernen
    await db.query(
      `DELETE FROM attribute_definitions
         WHERE entitie_id = ? AND column_name = ?`,
      [entId, columnName]
    );

    req.flash('success', `Spalte „${columnName}“ gelöscht.`);
    res.redirect(`/admin/entieties/${entId}/attributes`);
  } catch (err) {
    next(err);
  }
});

router.get('/:routeName/options', async (req, res, next) => {
  try {
    const { routeName } = req.params;

    // 1) DESCRIBE ausführen
    const [schema] = await db.query(`DESCRIBE \`${routeName}\``);

    // 2) Rendern – wir übergeben jetzt das komplette schema-Array
    res.render('admin/entieties/records/index', {
      active:      'entieties',
      entityRoute: routeName,
      schema       // neu: enthält Field, Type, Null, Key, Default, Extra
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:routeName/options/:column', async (req, res, next) => {
  try {
    const { routeName, column } = req.params;
    // 1) Datensätze laden, nur die Zeilen für diese Spalte
    const [rows] = await db.query(
      `SELECT id, option_value AS value, option_label AS label, sort_order
         FROM attribute_options
        WHERE entitie_route = ? AND column_name = ?
        ORDER BY sort_order, label`,
      [routeName, column]
    );

    // 2) Spaltennamen (feste Struktur der Options-Tabelle)
    const columns = ['id','value','label','sort_order'];

    // 3) Rendern mit deinem records/list.ejs
    res.render('admin/entieties/records/list', {
      active:      'entieties',
      entityRoute: `${routeName}/options/${column}`,
      columns,
      rows
    });
  } catch (err) { next(err); }
});

router.get('/:routeName/options/:column/new', async (req, res, next) => {
  try {
    const { routeName, column } = req.params;
    // 1) Filter-Metadaten nur für Option-Felder (id, value, label, sort_order)
    const filters = [
      { name:'value',      label:'Wert',  type:'text',   options:null },
      { name:'label',      label:'Label', type:'text',   options:null },
      { name:'sort_order', label:'Sort.', type:'number', options:null }
    ];
    // 2) Leeres record, aber wir wollen column im Template anzeigen können
    const record = { };

    res.render('admin/entieties/records/form', {
      active:      'entieties',
      entityRoute: `${routeName}/options/${column}`,
      isNew:       true,
      filters,
      record,
      errors:      null
    });
  } catch (err) { next(err); }
});

router.post('/:routeName/options/:column/new', async (req, res, next) => {
  try {
    const { routeName, column } = req.params;
    const { value, label, sort_order } = req.body;
    await db.query(
      `INSERT INTO attribute_options
         (entitie_route, column_name, option_value, option_label, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [routeName, column, value, label, sort_order || 0]
    );
    req.flash('success','Option hinzugefügt');
    res.redirect(`/admin/entieties/${routeName}/options/${column}`);
  } catch (err) { next(err); }
});

router.get('/:routeName/options/:column/:id/edit', async (req, res, next) => {
  try {
    const { routeName, column, id } = req.params;
    const [[opt]] = await db.query(
      `SELECT id, option_value AS value, option_label AS label, sort_order
         FROM attribute_options
        WHERE id = ?`,
      [id]
    );
    const filters = [
      { name:'value',      label:'Wert',  type:'text',   options:null },
      { name:'label',      label:'Label', type:'text',   options:null },
      { name:'sort_order', label:'Sort.', type:'number', options:null }
    ];
    res.render('admin/entieties/records/form', {
      active:      'entieties',
      entityRoute: `${routeName}/options/${column}`,
      isNew:       false,
      filters,
      record:      opt,
      errors:      null
    });
  } catch (err) { next(err); }
});

router.post('/:routeName/options/:column/:id/edit', async (req, res, next) => {
  try {
    const { routeName, column, id } = req.params;
    const { value, label, sort_order } = req.body;
    await db.query(
      `UPDATE attribute_options
         SET option_value = ?, option_label = ?, sort_order = ?
       WHERE id = ?`,
      [value, label, sort_order || 0, id]
    );
    req.flash('success','Option aktualisiert');
    res.redirect(`/admin/entieties/${routeName}/options/${column}`);
  } catch (err) { next(err); }
});

router.post('/:routeName/options/:column/:id/delete', async (req, res, next) => {
  try {
    const { routeName, column, id } = req.params;
    await db.query(`DELETE FROM attribute_options WHERE id = ?`, [id]);
    req.flash('success','Option gelöscht');
    res.redirect(`/admin/entieties/${routeName}/options/${column}`);
  } catch (err) { next(err); }
});

module.exports = router;
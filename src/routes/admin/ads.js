const express = require('express');
const db      = require('../../db');
const { unserialize } = require('php-unserialize'); // nur, wenn Ihr später pictures parsen möchtet
const router  = express.Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== 9) return res.status(403).send('Forbidden');
  next();
}

async function loadEntieties(req, res, next) {
  try {
    const [ents] = await db.query(
      `SELECT id, name, table_name
         FROM ententies`
    );
    res.locals.entieties = ents;
    next();
  } catch (err) {
    next(err);
  }
}

// GET /admin/ads/slider
router.get(
  '/slider',
  requireAdmin,
  loadEntieties,
  async (req, res, next) => {
    try {
      const entieties = res.locals.entieties;

      // 1) alle Inserate pro Kategorie (für Modal)
      const advertsMap = {};
        for (const ent of entieties) {
        const [rows] = await db.query(`
            SELECT id, name, pictures
            FROM \`${ent.table_name}\`
            WHERE status = 3
                AND visible = 1
                AND (stopdate > NOW() OR stopdate IS NULL)
        `);

        advertsMap[ent.id] = rows.map(r => {
            // 1) Daten parsen
            let data;
            try {
            data = unserialize(r.pictures);
            } catch (err) {
            console.error(`Fehler beim Unserialisieren von pictures für ID ${r.id}:`, err);
            data = null;
            }

            // 2) Logging
            console.log(`--- Eintrag ${ent.table_name} #${r.id} ---`);
            console.log('Raw pictures-Spalte:', r.pictures);
            console.log('Unserialized data:', data);

            // 3) Array aus data machen (egal ob numerisches Objekt oder schon Array)
            const picsArray = Array.isArray(data)
            ? data
            : (data && typeof data === 'object')
                ? Object.values(data)
                : [];

            console.log('Converted to array:', picsArray);

            // 4) Filename ermitteln (erstes Bild oder undefined)
            const filename = picsArray[0]?.image;
            console.log('Ausgewählter Filename:', filename);

            // 5) Bild-URL bauen (wenn es einen Filename gibt)
            let imageUrl = null;
            if (filename) {
            imageUrl = `/images/${ent.table_name}/${r.id}/${filename}`;
            } else {
            console.warn(`Kein Bild gefunden für ${ent.table_name} ID ${r.id}`);
            }
            console.log('Bild-URL:', imageUrl);

            return {
            id:    r.id,
            name:  r.name,
            image: imageUrl
            };
        });
        }

      // 2) bestehende Slider-Einträge
      const [slides] = await db.query(
        `SELECT id, entitie_id, advert_id, start_date, end_date
           FROM slider_ads`
      );
      const adsMap = {};
      for (const s of slides) {
        const pick = advertsMap[s.entitie_id].find(a => a.id === s.advert_id);
        adsMap[s.entitie_id] = {
          ...s,
          image: pick?.image || null
        };
      }

      res.render('admin/ads/slider-list', {
        active:     'ads-slider',
        entieties,
        advertsMap,
        adsMap
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/ads/slider/new
router.post(
  '/slider/new',
  requireAdmin,
  loadEntieties,
  async (req, res, next) => {
    try {
      const { entitie_id, advert_id, start_date, end_date } = req.body;
      const [result] = await db.query(
        `INSERT INTO slider_ads
           (entitie_id, advert_id, start_date, end_date)
         VALUES (?, ?, ?, ?)`,
        [entitie_id, advert_id, start_date, end_date]
      );
      const newId = result.insertId;

      // Bild-URL ermitteln
      const ent = res.locals.entieties.find(e => e.id === +entitie_id);
      const [[row]] = await db.query(
        `SELECT mainpicture FROM \`${ent.table_name}\` WHERE id = ?`,
        [advert_id]
      );
      const imageUrl = `/media/herando/images/${ent.table_name}/${advert_id}/${row.mainpicture}`;

      if (req.xhr || (req.get('Accept')||'').includes('application/json')) {
        return res.json({
          id:          newId,
          entitie_id:  +entitie_id,
          advert_id:   +advert_id,
          start_date,
          end_date,
          image:       imageUrl
        });
      }

      req.flash('success', 'Slider-Anzeige angelegt.');
      res.redirect('/admin/ads/slider');
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/ads/slider/:id/edit
router.post(
  '/slider/:id/edit',
  requireAdmin,
  loadEntieties,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const { advert_id, start_date, end_date } = req.body;
      await db.query(
        `UPDATE slider_ads
            SET advert_id = ?, start_date = ?, end_date = ?
          WHERE id = ?`,
        [advert_id, start_date, end_date, id]
      );

      // Bild-URL neu holen
      const [[slide]] = await db.query(
        `SELECT entitie_id FROM slider_ads WHERE id = ?`,
        [id]
      );
      const ent = res.locals.entieties.find(e => e.id === slide.entitie_id);
      const [[row]] = await db.query(
        `SELECT mainpicture FROM \`${ent.table_name}\` WHERE id = ?`,
        [advert_id]
      );
      const imageUrl = `/media/herando/images/${ent.table_name}/${advert_id}/${row.mainpicture}`;

      if (req.xhr || (req.get('Accept')||'').includes('application/json')) {
        return res.json({ id, advert_id:+advert_id, start_date, end_date, image:imageUrl });
      }

      req.flash('success', 'Slider-Anzeige aktualisiert.');
      res.redirect('/admin/ads/slider');
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/ads/slider/:id/delete
router.post(
  '/slider/:id/delete',
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      await db.query(`DELETE FROM slider_ads WHERE id = ?`, [id]);

      if (req.xhr || (req.get('Accept')||'').includes('application/json')) {
        return res.json({ id });
      }

      req.flash('success', 'Slider-Anzeige gelöscht.');
      res.redirect('/admin/ads/slider');
    } catch (err) {
      next(err);
    }
  }
);


router.get(
  '/catalog',
  requireAdmin,
  loadEntieties,
  async (req, res, next) => {
    try {
      // 1) alle vorhandenen Katalog-Einträge auslesen
      const [rows] = await db.query(`
        SELECT c.id, c.entitie_id, c.advert_id,
               c.start_date, c.end_date,
               e.name      AS entName,
               e.table_name
          FROM catalog_ads AS c
     LEFT JOIN ententies    AS e ON e.id = c.entitie_id
      `);

      // 2) gruppieren: entitie_id → Array von Einträgen
      const adsMap = {};
      for (const ent of res.locals.entieties) {
        adsMap[ent.id] = [];
      }
      for (const r of rows) {
        adsMap[r.entitie_id].push(r);
      }

      // 3) verfügbare Inserate pro Kategorie (nur status=3 && visible=1)
      const advertsMap = {};
      for (const ent of res.locals.entieties) {
        const [adverts] = await db.query(`
          SELECT id, name, pictures
            FROM \`${ent.table_name}\`
           WHERE status  = 3
             AND visible = 1
           ORDER BY name
        `);

        advertsMap[ent.id] = adverts.map(r => {
          // 1) Bilder aus PHP-Serialisierung holen
          let dataRaw;
          try {
            dataRaw = unserialize(r.pictures) || {};
          } catch (err) {
            console.error(`Unserialize-Fehler bei ID ${r.id}:`, err);
            dataRaw = {};
          }

          // 2) Aus dem Object ein Array machen
          const items = Array.isArray(dataRaw)
            ? dataRaw
            : Object.values(dataRaw);

          // 3) Erstes Objekt-Item nehmen
          const first = items[0] || null;
          const filename = first?.image;

          // 4) URL bauen
          const imageUrl = filename
            ? `/images/${ent.table_name}/${r.id}/${filename}`
            : null;

          return { id: r.id, name: r.name, image: imageUrl };
        });
      }

      // 4) EXISTIERENDE adsMap-Einträge mit Bild-URLs anreichern
      for (const ent of res.locals.entieties) {
        const slots = adsMap[ent.id];
        for (const entry of slots) {
          const advert = advertsMap[ent.id].find(a => a.id === entry.advert_id);
          entry.image = advert?.image || null;
        }
      }

      // 5) rendern
      res.render('admin/ads/catalog-list', {
        active:      'ads-catalog',
        entieties:   res.locals.entieties,
        adsMap,
        advertsMap
      });
    } catch (err) {
      next(err);
    }
  }
);

// Neues Katalog-Ad anlegen
router.post(
  '/catalog/new',
  requireAdmin,
  async (req, res, next) => {
    try {
      const { entitie_id, advert_id, start_date, end_date } = req.body;
      await db.query(`
        INSERT INTO catalog_ads
          (entitie_id, advert_id, start_date, end_date)
        VALUES (?, ?, ?, ?)
      `, [ entitie_id, advert_id, start_date, end_date ]);

      // Redirect statt JSON-Antwort
      res.redirect('/admin/ads/catalog');
    } catch (err) {
      next(err);
    }
  }
);

// Bestehendes Katalog-Ad bearbeiten
router.post(
  '/catalog/:id/edit',
  requireAdmin,
  async (req, res, next) => {
    try {
      const adId = req.params.id;
      const { advert_id, start_date, end_date } = req.body;
      await db.query(`
        UPDATE catalog_ads
           SET advert_id = ?, start_date = ?, end_date = ?
         WHERE id = ?
      `, [ advert_id, start_date, end_date, adId ]);

      // Redirect zurück zur Übersicht
      res.redirect('/admin/ads/catalog');
    } catch (err) {
      next(err);
    }
  }
);

// Katalog-Ad löschen
router.post(
  '/catalog/:id/delete',
  requireAdmin,
  async (req, res, next) => {
    try {
      const adId = req.params.id;
      await db.query(`DELETE FROM catalog_ads WHERE id = ?`, [ adId ]);

      // Redirect nach dem Löschen
      res.redirect('/admin/ads/catalog');
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/advert_inserat',
  requireAdmin,
  loadEntieties,
  async (req, res, next) => {
    try {
      // 1) alle vorhandenen Advert-Inserat-Einträge auslesen
      const [rows] = await db.query(`
        SELECT a.id, a.entitie_id, a.advert_id,
               a.start_date, a.end_date,
               e.name      AS entName,
               e.table_name
          FROM advert_inserat AS a
     LEFT JOIN ententies       AS e ON e.id = a.entitie_id
      `);

      // 2) gruppieren: entitie_id → Array von Einträgen
      const adsMap = {};
      for (const ent of res.locals.entieties) {
        adsMap[ent.id] = [];
      }
      for (const r of rows) {
        adsMap[r.entitie_id].push(r);
      }

      // 3) verfügbare Inserate pro Kategorie (nur status=3 && visible=1)
      const advertsMap = {};
      for (const ent of res.locals.entieties) {
        const [adverts] = await db.query(`
          SELECT id, name, pictures
            FROM \`${ent.table_name}\`
           WHERE status  = 3
             AND visible = 1
           ORDER BY name
        `);

        advertsMap[ent.id] = adverts.map(r => {
          let dataRaw;
          try {
            dataRaw = unserialize(r.pictures) || {};
          } catch (err) {
            console.error(`Unserialize-Fehler bei ID ${r.id}:`, err);
            dataRaw = {};
          }
          const items = Array.isArray(dataRaw)
            ? dataRaw
            : Object.values(dataRaw);
          const first = items[0] || null;
          const filename = first?.image;
          const imageUrl = filename
            ? `/images/${ent.table_name}/${r.id}/${filename}`
            : null;
          return { id: r.id, name: r.name, image: imageUrl };
        });
      }

      // 4) EXISTIERENDE adsMap-Einträge mit Bild-URLs aus advertsMap anreichern
      for (const ent of res.locals.entieties) {
        for (const entry of adsMap[ent.id]) {
          const advert = advertsMap[ent.id].find(a => a.id === entry.advert_id);
          entry.image = advert?.image || null;
        }
      }

      // 5) rendern
      res.render('admin/ads/advert_inserat-list', {
        active:      'ads-inserat',
        entieties:   res.locals.entieties,
        adsMap,
        advertsMap
      });
    } catch (err) {
      next(err);
    }
  }
);

// NEU: Advert-Inserat hinzufügen
router.post(
  '/advert_inserat/new',
  requireAdmin,
  async (req, res, next) => {
    try {
      const { entitie_id, advert_id, start_date, end_date } = req.body;
      await db.query(
        `INSERT INTO advert_inserat
           (entitie_id, advert_id, start_date, end_date)
         VALUES (?, ?, ?, ?)`,
        [entitie_id, advert_id, start_date, end_date]
      );
      // zurück zur Liste
      res.redirect('/admin/ads/advert_inserat');
    } catch (err) {
      next(err);
    }
  }
);

// Bearbeiten eines bestehenden Advert-Inserats
router.post(
  '/advert_inserat/:id/edit',
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      const { advert_id, start_date, end_date } = req.body;
      await db.query(
        `UPDATE advert_inserat
            SET advert_id  = ?,
                start_date = ?,
                end_date   = ?
          WHERE id = ?`,
        [advert_id, start_date, end_date, id]
      );
      res.redirect('/admin/ads/advert_inserat');
    } catch (err) {
      next(err);
    }
  }
);

// Löschen eines Advert-Inserats
router.post(
  '/advert_inserat/:id/delete',
  requireAdmin,
  async (req, res, next) => {
    try {
      const id = req.params.id;
      await db.query(
        `DELETE FROM advert_inserat
           WHERE id = ?`,
        [id]
      );
      res.redirect('/admin/ads/advert_inserat');
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/examination',
  requireAdmin,
  loadEntieties,
  async (req, res, next) => {
    try {
      const entieties = res.locals.entieties;
      const reviewMap = {};

      for (const ent of entieties) {
  const [rows] = await db.query(
    `
    SELECT
      t.id,
      t.name,
      t.pictures,
      t.status,
      t.visible,
      t.stopdate,
      t.user_id,
      u.firstname,
      u.lastname,
      u.company,
      u.contact,
      -- letzten Prüfstatus holen
      (
        SELECT up.examination_status
          FROM user_package_orders AS up
         WHERE up.entitie_id = ?
           AND up.item_id    = t.id
         ORDER BY up.id DESC
         LIMIT 1
      ) AS examination_status,
      -- letzte Prüfnachricht holen
      (
        SELECT up.examination_message
          FROM user_package_orders AS up
         WHERE up.entitie_id = ?
           AND up.item_id    = t.id
         ORDER BY up.id DESC
         LIMIT 1
      ) AS examination_message
    FROM \`${ent.table_name}\` AS t
    LEFT JOIN users AS u
      ON u.id = t.user_id
    WHERE t.status  = 3
      AND t.visible = 1
      AND (t.stopdate > NOW() OR t.stopdate IS NULL)
      -- nur Inserate, die in user_package_orders vorkommen
      AND EXISTS (
        SELECT 1
          FROM user_package_orders AS up2
         WHERE up2.entitie_id = ?
           AND up2.item_id    = t.id
      )
    `,
    // Parameter für die beiden Subqueries und das EXISTS
    [ent.id, ent.id, ent.id]
  );

        reviewMap[ent.id] = rows.map(r => {
          let data;
          try {
            data = unserialize(r.pictures);
          } catch {
            data = null;
          }
          const picsArray = Array.isArray(data)
            ? data
            : data && typeof data === 'object'
              ? Object.values(data)
              : [];
          const filename = picsArray[0]?.image;
          const imageUrl = filename
            ? `/images/${ent.table_name}/${r.id}/${filename}`
            : null;

          return {
            id:                  r.id,
            name:                r.name,
            image:               imageUrl,
            examination_status:  r.examination_status || 0,
            examination_message: r.examination_message || null,
            user: {
              id:        r.user_id,
              firstname: r.firstname,
              lastname:  r.lastname,
              company:   r.company,
              contact:   r.contact
            }
          };
        });
      }

      res.render('admin/ads/examination-list', {
        active:     'ads-examination',
        entieties,
        reviewMap
      });
    } catch (err) {
      next(err);
    }
  }
);


// NEU: Route zum Genehmigen eines Inserats
router.post(
  '/approve',           // kein "/admin/ads" hier, das kommt durch `app.use('/admin/ads', ...)`
  requireAdmin,
  async (req, res, next) => {
    const { adId, entityId } = req.body;
    try {
      await db.query(
        `UPDATE user_package_orders
            SET examination_status = 1
          WHERE item_id    = ?
            AND entitie_id = ?`,
        [adId, entityId]
      );
      res.json({ success: true, message: 'Inserat erfolgreich genehmigt.' });
    } catch (err) {
      console.error('Fehler beim Genehmigen des Inserats:', err);
      next(err);
    }
  }
);

router.post(
  '/reject',
  requireAdmin,
  async (req, res, next) => {
    const { adId, entityId, message } = req.body;
    try {
      await db.query(
        `UPDATE user_package_orders
            SET examination_status  = 2,
                examination_message = ?
          WHERE item_id    = ?
            AND entitie_id = ?`,
        [message, adId, entityId]
      );
      res.json({ success: true, message: 'Inserat erfolgreich abgelehnt.' });
    } catch (err) {
      console.error('Fehler beim Ablehnen des Inserats:', err);
      next(err);
    }
  }
);


module.exports = router;
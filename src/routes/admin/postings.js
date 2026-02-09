const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const slugify = require('slugify');
const db      = require('../../db'); 
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });  

const router = express.Router();

// Zugriffsschutz: Nur Admins dürfen rein
function ensureAdmin(req, res, next) {
  if (req.user?.role === 9) return next();
  res.redirect('/auth/login');
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const slug = req.params.slug || req.body.slug;
    const dir  = path.join(__dirname, '../../../public/uploads/postings', slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// GET: Liste aller Postings
router.get('/', ensureAdmin, async (req, res, next) => {
  try {
    const [rows] = await db.query(
      'SELECT id, title, category, author, location, slug, created FROM postings ORDER BY created DESC'
    );
    res.render('admin/postings/list', {
      postings: rows,
      active: 'postings',
      messages: req.flash()
    });
  } catch (err) {
    next(err);
  }
});

// GET: Formular für neues Posting
router.get('/new', ensureAdmin, (req, res) => {
  res.render('admin/postings/edit', {
    action: 'new',
    posting: {},
    active: 'postings',
    messages: req.flash()
  });
});

// POST: Neues Posting anlegen
router.post(
  '/new',
  ensureAdmin,
  upload.fields([
    { name: 'cover_image', maxCount: 1 },
    { name: 'additional_images', maxCount: 10 }
  ]),
  async (req, res, next) => {
    try {
      const { title, category, author, location, content } = req.body;
      const slug = slugify(title, { lower: true, strict: true });
      const cover = req.files.cover_image?.[0]?.filename || null;
      const extras = JSON.stringify(
        (req.files.additional_images || []).map(f => f.filename)
      );

      // 1) Original-Posting speichern (roh, ohne warten auf KI)
      const [result] = await db.query(
        `INSERT INTO postings 
         (title, category, author, location, slug, cover_image, additional_images, content, created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [title, category, author, location, slug, cover, extras, content]
      );

      const postId = result.insertId;

      // ✅ sofort Rückmeldung an Admin
      req.flash(
        'success',
        'Posting erstellt. Übersetzungen & SEO werden im Hintergrund generiert.'
      );
      res.redirect('/admin/postings');

      // 2) Hintergrund-Job starten (async)
      setImmediate(async () => {
        try {
          const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
          const LANGS = (process.env.TRANSLATION_TARGET_LANGS || 'de,en')
            .split(',')
            .map(l => l.trim());

          for (const lang of LANGS) {
            // Schon vorhanden?
            const [[exists]] = await db.query(
              `SELECT id FROM postings_translations WHERE post_id = ? AND language = ?`,
              [postId, lang]
            );
            if (exists) {
              console.log(`✅ Übersetzung existiert schon: ${lang}`);
              continue;
            }

            console.log(`🌍 Erzeuge Übersetzung + SEO für ${lang}`);

            const resp = await openai.chat.completions.create({
              model: MODEL,
              messages: [
                {
                  role: 'system',
                  content: `Du bist ein professioneller Übersetzer & SEO-Texter.`
                },
                {
                  role: 'user',
                  content: `
Bitte übersetze folgenden Blog-Post vollständig ins ${lang}.

Titel: ${title}

Inhalt: ${content}

Erstelle zusätzlich:
- "seo_title": max 65 Zeichen, klickstark
- "seo_description": max 160 Zeichen, verkaufsstark

Antworte ausschließlich im JSON-Format:
{ "title": "...", "content": "...", "seo_title": "...", "seo_description": "..." }
`
                }
              ],
              response_format: { type: 'json_object' }
            });

            const parsed = JSON.parse(resp.choices[0].message.content);

            await db.query(
              `INSERT INTO postings_translations 
               (post_id, language, title, content, seo_title, seo_description, created)
               VALUES (?, ?, ?, ?, ?, ?, NOW())`,
              [
                postId,
                lang,
                parsed.title,
                parsed.content,
                parsed.seo_title,
                parsed.seo_description
              ]
            );

            console.log(`✅ Übersetzung + SEO gespeichert für ${lang}`);
          }
        } catch (err) {
          console.error(`❌ Fehler beim Hintergrundjob für Post ${postId}:`, err);
        }
      });
    } catch (err) {
      console.error('❌ Fehler beim Anlegen des Postings:', err);
      next(err);
    }
  }
);




// GET: Formular zum Bearbeiten eines Postings
router.get('/:slug/edit', ensureAdmin, async (req, res, next) => {
  try {
    const [[post]] = await db.query(
      'SELECT * FROM postings WHERE slug = ?', [req.params.slug]
    );
    if (!post) return res.status(404).send('Nicht gefunden');
    post.additional_images = JSON.parse(post.additional_images || '[]');
    res.render('admin/postings/edit', {
      action: 'edit',
      posting: post,
      active: 'postings',
      messages: req.flash()
    });
  } catch (err) {
    next(err);
  }
});

// POST: Update eines bestehenden Postings
router.post(
  '/:slug/edit',
  ensureAdmin,
  upload.fields([
    { name: 'cover_image', maxCount: 1 },
    { name: 'additional_images', maxCount: 10 }
  ]),
  async (req, res, next) => {
    try {
      const oldSlug = req.params.slug;
      const { title, category, author, location, content, _old_additional } = req.body;
      const newSlug = slugify(title, { lower: true, strict: true });

      // Cover-Image
      let coverImage;
      if (req.files.cover_image) {
        coverImage = req.files.cover_image[0].filename;
      } else {
        const [[row]] = await db.query(
          'SELECT cover_image FROM postings WHERE slug = ?',
          [oldSlug]
        );
        coverImage = row.cover_image;
      }

      // Zusätzliche Bilder
      const oldExtras = JSON.parse(_old_additional || '[]');
      const newExtras = (req.files.additional_images || []).map(f => f.filename);
      const allExtras = JSON.stringify([...oldExtras, ...newExtras]);

      // Update Haupttabelle
      await db.query(
        `UPDATE postings
           SET title = ?, category = ?, author = ?, location = ?, slug = ?,
               cover_image = ?, additional_images = ?, content = ?, modified = NOW()
         WHERE slug = ?`,
        [
          title,
          category,
          author,
          location,
          newSlug,
          coverImage,
          allExtras,
          content,
          oldSlug
        ]
      );

      // Post-ID holen
      const [[post]] = await db.query(
        'SELECT id FROM postings WHERE slug = ?',
        [newSlug]
      );
      const postId = post.id;

      // ✅ Sofortige Antwort für Admin
      req.flash(
        'success',
        'Posting aktualisiert. Fehlende Übersetzungen & SEO werden im Hintergrund ergänzt.'
      );
      res.redirect('/admin/postings');

      // 🔥 Hintergrundjob für Übersetzungen & SEO
      setImmediate(async () => {
        const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
        const LANGS = (process.env.TRANSLATION_TARGET_LANGS || 'en')
          .split(',')
          .map(l => l.trim());

        for (const lang of LANGS) {
          const [[exists]] = await db.query(
            `SELECT id FROM postings_translations WHERE post_id = ? AND language = ?`,
            [postId, lang]
          );
          if (exists) {
            console.log(`✅ Übersetzung schon vorhanden: ${lang}`);
            continue;
          }

          console.log(`🌍 Erzeuge fehlende Übersetzung + SEO für ${lang}`);

          try {
            const resp = await openai.chat.completions.create({
              model: MODEL,
              messages: [
                {
                  role: 'system',
                  content: `Du bist ein professioneller Übersetzer & SEO-Texter.`
                },
                {
                  role: 'user',
                  content: `
Bitte übersetze folgenden Blog-Post vollständig ins ${lang}.

Titel: ${title}

Inhalt: ${content}

Erstelle zusätzlich:
- "seo_title": max 65 Zeichen, klickstark
- "seo_description": max 160 Zeichen, verkaufsstark

Antworte ausschließlich im JSON-Format:
{ "title": "...", "content": "...", "seo_title": "...", "seo_description": "..." }
`
                }
              ],
              response_format: { type: 'json_object' }
            });

            const parsed = JSON.parse(resp.choices[0].message.content);

            await db.query(
              `INSERT INTO postings_translations 
                 (post_id, language, title, content, seo_title, seo_description, created)
               VALUES (?, ?, ?, ?, ?, ?, NOW())`,
              [
                postId,
                lang,
                parsed.title,
                parsed.content,
                parsed.seo_title,
                parsed.seo_description
              ]
            );

            console.log(`✅ Gespeichert inkl. Titel + SEO: Post ${postId} (${lang})`);
          } catch (err) {
            console.error(
              `❌ Fehler bei Übersetzung/SEO (${lang}) für Post ${postId}:`,
              err.message
            );
          }
        }
      });
    } catch (err) {
      next(err);
    }
  }
);




// POST: Löschen eines Postings
router.post('/:slug/delete', ensureAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM postings WHERE slug = ?', [req.params.slug]);
    // Optional Ordner löschen
    const dir = path.join(process.cwd(), '../../../public/uploads/postings', req.params.slug);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    req.flash('success', 'Posting gelöscht.');
    res.redirect('/admin/postings');
  } catch (err) {
    next(err);
  }
});

module.exports = router;


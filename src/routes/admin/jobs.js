const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const slugify = require('slugify');
const OpenAI = require('openai');
const db = require('../../db');
const { ensureJobsSchema } = require('../../service/jobsSchema');

const router = express.Router();

const JOBS_IMAGE_UPLOAD_DIR = path.join(__dirname, '../../../uploads/jobs/images');
const ALLOWED_STATUSES = new Set(['new', 'in_review', 'interview', 'accepted', 'rejected']);
const AI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const MAX_TRANSLATION_INPUT_CHARS = (() => {
  const n = Number.parseInt(process.env.TRANSLATION_INPUT_MAX_CHARS || '12000', 10);
  return Number.isInteger(n) && n > 0 ? n : 12000;
})();

let aiClient = null;

function getAiClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!aiClient) aiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return aiClient;
}

function normalizeLangCode(value, fallback = '') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0]
    .replace(/[^a-z]/g, '')
    .slice(0, 2);
  if (normalized.length === 2) return normalized;
  return fallback;
}

function getTranslationTargetLangs() {
  const langs = String(process.env.TRANSLATION_TARGET_LANGS || '')
    .split(',')
    .map((lang) => normalizeLangCode(lang))
    .filter(Boolean);
  return Array.from(new Set(langs));
}

function clipTranslationText(value, max = MAX_TRANSLATION_INPUT_CHARS) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function extractFirstJsonObject(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonObjectLoose(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const candidate = extractFirstJsonObject(text);
    if (!candidate || candidate === text) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
}

async function detectJobLanguage(fields) {
  const client = getAiClient();
  if (!client) return 'auto';

  const text = clipTranslationText(
    [
      fields.title || '',
      fields.short_description || '',
      fields.description || '',
      fields.requirements || '',
      fields.benefits || ''
    ].filter(Boolean).join('\n\n'),
    6000
  );
  if (!text) return 'auto';

  const attempts = [
    {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'detected_language',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['lang'],
            properties: {
              lang: { type: 'string' }
            }
          }
        }
      }
    },
    { response_format: { type: 'json_object' } }
  ];

  for (const attempt of attempts) {
    try {
      const resp = await client.chat.completions.create({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: 'Return only JSON {"lang":"xx"} where xx is ISO 639-1.' },
          { role: 'user', content: text }
        ],
        response_format: attempt.response_format
      });
      const out = resp.choices?.[0]?.message?.content || '{}';
      const obj = parseJsonObjectLoose(out);
      const lang = normalizeLangCode(obj?.lang, 'auto');
      if (lang) return lang;
    } catch (err) {
      console.error('[JOBS][AI] Language detection failed:', err.message);
    }
  }
  return 'auto';
}

async function translateJobFields({ sourceLang, targetLang, fields }) {
  const client = getAiClient();
  if (!client) return fields;

  const original = {
    title: String(fields.title || ''),
    short_description: String(fields.short_description || ''),
    description: String(fields.description || ''),
    requirements: String(fields.requirements || ''),
    benefits: String(fields.benefits || '')
  };

  const payload = {
    sourceLang: sourceLang || 'auto',
    targetLang,
    ...Object.fromEntries(
      Object.entries(original).map(([key, value]) => [key, clipTranslationText(value)])
    )
  };

  const system = `Du bist ein professioneller Übersetzer für Stellenanzeigen.
- Quellsprache: ${payload.sourceLang}
- Zielsprache: ${targetLang}
- Behalte Struktur, Ton und fachliche Genauigkeit bei.
- Antworte nur als JSON mit exakt diesen Feldern:
{"title":"...","short_description":"...","description":"...","requirements":"...","benefits":"..."}`;

  const attempts = [
    {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'job_translation',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'short_description', 'description', 'requirements', 'benefits'],
            properties: {
              title: { type: 'string' },
              short_description: { type: 'string' },
              description: { type: 'string' },
              requirements: { type: 'string' },
              benefits: { type: 'string' }
            }
          }
        }
      }
    },
    { response_format: { type: 'json_object' } }
  ];

  for (const attempt of attempts) {
    try {
      const resp = await client.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        response_format: attempt.response_format
      });
      const out = resp.choices?.[0]?.message?.content || '{}';
      const obj = parseJsonObjectLoose(out);
      if (!obj || typeof obj !== 'object') continue;
      return {
        title: typeof obj.title === 'string' ? obj.title : original.title,
        short_description: typeof obj.short_description === 'string'
          ? obj.short_description
          : original.short_description,
        description: typeof obj.description === 'string' ? obj.description : original.description,
        requirements: typeof obj.requirements === 'string' ? obj.requirements : original.requirements,
        benefits: typeof obj.benefits === 'string' ? obj.benefits : original.benefits
      };
    } catch (err) {
      console.error('[JOBS][AI] Translation failed:', err.message);
    }
  }

  return original;
}

async function upsertJobTranslation(jobId, language, fields) {
  const lang = normalizeLangCode(language);
  if (!lang) return;
  await db.query(
    `
    INSERT INTO job_translations (
      job_id,
      language,
      title,
      short_description,
      description,
      requirements,
      benefits
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      short_description = VALUES(short_description),
      description = VALUES(description),
      requirements = VALUES(requirements),
      benefits = VALUES(benefits),
      updated_at = CURRENT_TIMESTAMP
    `,
    [
      jobId,
      lang,
      normalizeText(fields.title, 255),
      normalizeLongText(fields.short_description, 4000) || null,
      normalizeLongText(fields.description) || null,
      normalizeLongText(fields.requirements) || null,
      normalizeLongText(fields.benefits) || null
    ]
  );
}

async function translateJobPosting(jobId) {
  if (!process.env.OPENAI_API_KEY) return false;
  await ensureJobsSchema();

  const [[job]] = await db.query(
    `
    SELECT
      id,
      title,
      short_description,
      description,
      requirements,
      benefits,
      source_lang
    FROM jobs
    WHERE id = ?
    LIMIT 1
    `,
    [jobId]
  );

  if (!job) return false;

  const originalFields = {
    title: String(job.title || ''),
    short_description: String(job.short_description || ''),
    description: String(job.description || ''),
    requirements: String(job.requirements || ''),
    benefits: String(job.benefits || '')
  };

  let sourceLang = normalizeLangCode(job.source_lang);
  if (!sourceLang) {
    sourceLang = await detectJobLanguage(originalFields);
  }
  if (sourceLang && sourceLang !== 'auto' && sourceLang !== normalizeLangCode(job.source_lang)) {
    await db.query('UPDATE jobs SET source_lang = ? WHERE id = ?', [sourceLang, jobId]);
  }

  if (sourceLang && sourceLang !== 'auto') {
    await upsertJobTranslation(jobId, sourceLang, originalFields);
  }

  const targetLangs = getTranslationTargetLangs();
  for (const targetLang of targetLangs) {
    if (!targetLang) continue;
    if (sourceLang && sourceLang !== 'auto' && targetLang === sourceLang) continue;

    const translated = await translateJobFields({
      sourceLang: sourceLang || 'auto',
      targetLang,
      fields: originalFields
    });
    await upsertJobTranslation(jobId, targetLang, translated);
  }

  return true;
}

function enqueueJobTranslation(jobId) {
  if (!Number.isInteger(jobId) || jobId <= 0) return false;
  if (!process.env.OPENAI_API_KEY) return false;
  setImmediate(async () => {
    try {
      await translateJobPosting(jobId);
      console.log('[JOBS][AI] Translation finished for job', jobId);
    } catch (err) {
      console.error('[JOBS][AI] Background translation failed:', err.message);
    }
  });
  return true;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function parseBool(value) {
  const normalized = String(value ?? '').toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function normalizeText(value, maxLen = 255) {
  return String(value ?? '')
    .trim()
    .replace(/\r\n/g, '\n')
    .slice(0, maxLen);
}

function normalizeLongText(value, maxLen = 65000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLen);
}

function buildSlug(value) {
  return slugify(String(value || ''), { lower: true, strict: true, trim: true });
}

function toAbsoluteFromPublicPath(publicPath) {
  if (!publicPath || typeof publicPath !== 'string') return null;
  const trimmed = publicPath.replace(/^\/+/, '');
  if (!trimmed) return null;
  return path.join(__dirname, '../../../', trimmed);
}

async function getUniqueSlug(baseSlug, excludeId = null) {
  let candidate = baseSlug || 'job';
  let suffix = 1;

  while (true) {
    let sql = 'SELECT id FROM jobs WHERE slug = ?';
    const params = [candidate];
    if (excludeId) {
      sql += ' AND id <> ?';
      params.push(excludeId);
    }
    sql += ' LIMIT 1';

    const [[row]] = await db.query(sql, params);
    if (!row) return candidate;
    suffix += 1;
    candidate = `${baseSlug}-${suffix}`;
  }
}

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureDir(JOBS_IMAGE_UPLOAD_DIR);
      cb(null, JOBS_IMAGE_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const base = path
        .basename(file.originalname || 'job-image', ext)
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 80) || 'job-image';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${base}${ext}`);
    }
  }),
  limits: {
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext);
    if (!okExt) return cb(new Error('Nur JPG, PNG oder WEBP sind als Bild erlaubt.'));
    return cb(null, true);
  }
}).single('image');

function handleImageUpload(req, res, next) {
  imageUpload(req, res, (err) => {
    if (!err) return next();
    req.flash('error', err.message || 'Bild-Upload fehlgeschlagen.');
    return res.redirect(req.get('referer') || '/admin/jobs');
  });
}

router.get('/', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const [jobs] = await db.query(`
      SELECT
        j.id,
        j.title,
        j.slug,
        j.location,
        j.department,
        j.employment_type,
        j.workplace_type,
        j.is_active,
        j.sort_order,
        j.created_at,
        COUNT(a.id) AS application_count,
        SUM(CASE WHEN a.status = 'new' THEN 1 ELSE 0 END) AS new_application_count
      FROM jobs j
      LEFT JOIN job_applications a ON a.job_id = j.id
      GROUP BY
        j.id, j.title, j.slug, j.location, j.department, j.employment_type,
        j.workplace_type, j.is_active, j.sort_order, j.created_at
      ORDER BY j.sort_order ASC, j.created_at DESC
    `);

    return res.render('admin/jobs/list', {
      active: 'jobs',
      role: req.session.role,
      jobs,
      messages: {
        success: req.flash('success')[0] || null,
        error: req.flash('error')[0] || null
      }
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    await ensureJobsSchema();
    return res.render('admin/jobs/form', {
      active: 'jobs',
      role: req.session.role,
      action: '/admin/jobs/new',
      job: {
        title: '',
        slug: '',
        location: '',
        department: '',
        employment_type: '',
        workplace_type: '',
        short_description: '',
        description: '',
        requirements: '',
        benefits: '',
        image_url: '',
        is_active: 1,
        sort_order: 0
      },
      messages: {
        success: req.flash('success')[0] || null,
        error: req.flash('error')[0] || null
      }
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/new', handleImageUpload, async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const title = normalizeText(req.body?.title, 255);
    if (!title) {
      req.flash('error', 'Bitte einen Stellentitel eingeben.');
      return res.redirect('/admin/jobs/new');
    }

    const sourceSlug = normalizeText(req.body?.slug, 255) || title;
    const baseSlug = buildSlug(sourceSlug) || buildSlug(title) || 'job';
    const slug = await getUniqueSlug(baseSlug);
    const imageUrl = req.file ? `/uploads/jobs/images/${req.file.filename}` : null;
    const isActive = parseBool(req.body?.is_active) ? 1 : 0;

    const [insertResult] = await db.query(
      `
      INSERT INTO jobs (
        title,
        slug,
        location,
        department,
        employment_type,
        workplace_type,
        short_description,
        description,
        requirements,
        benefits,
        image_url,
        is_active,
        sort_order,
        created_by,
        updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        title,
        slug,
        normalizeText(req.body?.location, 255) || null,
        normalizeText(req.body?.department, 255) || null,
        normalizeText(req.body?.employment_type, 100) || null,
        normalizeText(req.body?.workplace_type, 100) || null,
        normalizeLongText(req.body?.short_description, 4000) || null,
        normalizeLongText(req.body?.description) || null,
        normalizeLongText(req.body?.requirements) || null,
        normalizeLongText(req.body?.benefits) || null,
        imageUrl,
        isActive,
        Number.parseInt(req.body?.sort_order, 10) || 0,
        Number(req.session?.userId) || null,
        Number(req.session?.userId) || null
      ]
    );

    let successMessage = 'Stelle wurde angelegt.';
    if (isActive === 1 && enqueueJobTranslation(Number(insertResult?.insertId))) {
      successMessage += ' KI-Übersetzung wurde im Hintergrund gestartet.';
    }
    req.flash('success', successMessage);
    return res.redirect('/admin/jobs');
  } catch (err) {
    return next(err);
  }
});

router.get('/applications', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const jobId = Number.parseInt(req.query.job_id, 10) || 0;
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim();

    const where = ['1=1'];
    const params = [];

    if (jobId > 0) {
      where.push('a.job_id = ?');
      params.push(jobId);
    }
    if (status && ALLOWED_STATUSES.has(status)) {
      where.push('a.status = ?');
      params.push(status);
    }
    if (q) {
      const like = `%${q}%`;
      where.push('(a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR j.title LIKE ?)');
      params.push(like, like, like, like);
    }

    const [applications] = await db.query(
      `
      SELECT
        a.id,
        a.job_id,
        a.first_name,
        a.last_name,
        a.email,
        a.country_id,
        a.phone_prefix,
        a.phone,
        a.status,
        a.created_at,
        COALESCE(NULLIF(c.de, ''), c.en, c.code) AS country_name,
        j.title AS job_title,
        j.slug AS job_slug
      FROM job_applications a
      INNER JOIN jobs j ON j.id = a.job_id
      LEFT JOIN countries c ON c.id = a.country_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      `,
      params
    );

    const [jobs] = await db.query(`
      SELECT id, title
        FROM jobs
       ORDER BY title ASC
    `);

    return res.render('admin/jobs/applications-list', {
      active: 'jobs-applications',
      role: req.session.role,
      applications,
      jobs,
      filters: { job_id: jobId, status, q },
      messages: {
        success: req.flash('success')[0] || null,
        error: req.flash('error')[0] || null
      }
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/applications/:id', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const applicationId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      req.flash('error', 'Ungültige Bewerbungs-ID.');
      return res.redirect('/admin/jobs/applications');
    }

    const [[application]] = await db.query(
      `
      SELECT
        a.*,
        COALESCE(NULLIF(c.de, ''), c.en, c.code) AS country_name,
        j.title AS job_title,
        j.slug AS job_slug
      FROM job_applications a
      INNER JOIN jobs j ON j.id = a.job_id
      LEFT JOIN countries c ON c.id = a.country_id
      WHERE a.id = ?
      LIMIT 1
      `,
      [applicationId]
    );

    if (!application) {
      req.flash('error', 'Bewerbung wurde nicht gefunden.');
      return res.redirect('/admin/jobs/applications');
    }

    let certificates = [];
    if (application.certificates_json) {
      try {
        const parsed = JSON.parse(application.certificates_json);
        if (Array.isArray(parsed)) certificates = parsed;
      } catch {
        certificates = [];
      }
    }

    const resumePublicPath = application.resume_path
      ? `/uploads/jobs/applications/${path.basename(application.resume_path)}`
      : null;
    const coverPublicPath = application.cover_letter_path
      ? `/uploads/jobs/applications/${path.basename(application.cover_letter_path)}`
      : null;

    return res.render('admin/jobs/application-detail', {
      active: 'jobs-applications',
      role: req.session.role,
      application,
      resumePublicPath,
      coverPublicPath,
      certificates,
      statuses: ['new', 'in_review', 'interview', 'accepted', 'rejected'],
      messages: {
        success: req.flash('success')[0] || null,
        error: req.flash('error')[0] || null
      }
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/applications/:id/status', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const applicationId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(applicationId) || applicationId <= 0) {
      req.flash('error', 'Ungültige Bewerbungs-ID.');
      return res.redirect('/admin/jobs/applications');
    }

    const status = String(req.body?.status || '').trim();
    if (!ALLOWED_STATUSES.has(status)) {
      req.flash('error', 'Ungültiger Bewerbungsstatus.');
      return res.redirect(`/admin/jobs/applications/${applicationId}`);
    }

    await db.query(
      `
      UPDATE job_applications
         SET status = ?,
             admin_notes = ?
       WHERE id = ?
      `,
      [status, normalizeLongText(req.body?.admin_notes, 65000) || null, applicationId]
    );

    req.flash('success', 'Bewerbungsstatus wurde aktualisiert.');
    return res.redirect(`/admin/jobs/applications/${applicationId}`);
  } catch (err) {
    return next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      req.flash('error', 'Ungültige Job-ID.');
      return res.redirect('/admin/jobs');
    }

    const [[job]] = await db.query('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id]);
    if (!job) {
      req.flash('error', 'Stelle nicht gefunden.');
      return res.redirect('/admin/jobs');
    }

    return res.render('admin/jobs/form', {
      active: 'jobs',
      role: req.session.role,
      action: `/admin/jobs/${id}/edit`,
      job,
      messages: {
        success: req.flash('success')[0] || null,
        error: req.flash('error')[0] || null
      }
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/edit', handleImageUpload, async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      req.flash('error', 'Ungültige Job-ID.');
      return res.redirect('/admin/jobs');
    }

    const [[current]] = await db.query('SELECT * FROM jobs WHERE id = ? LIMIT 1', [id]);
    if (!current) {
      req.flash('error', 'Stelle nicht gefunden.');
      return res.redirect('/admin/jobs');
    }

    const title = normalizeText(req.body?.title, 255);
    if (!title) {
      req.flash('error', 'Bitte einen Stellentitel eingeben.');
      return res.redirect(`/admin/jobs/${id}/edit`);
    }

    const sourceSlug = normalizeText(req.body?.slug, 255) || title;
    const baseSlug = buildSlug(sourceSlug) || buildSlug(title) || 'job';
    const slug = await getUniqueSlug(baseSlug, id);
    const isActive = parseBool(req.body?.is_active) ? 1 : 0;

    let imageUrl = current.image_url || null;
    if (req.file) {
      imageUrl = `/uploads/jobs/images/${req.file.filename}`;
      const oldImageAbs = toAbsoluteFromPublicPath(current.image_url);
      if (oldImageAbs && fs.existsSync(oldImageAbs)) {
        try {
          fs.unlinkSync(oldImageAbs);
        } catch {
          // ignore remove errors
        }
      }
    }

    await db.query(
      `
      UPDATE jobs
         SET title = ?,
             slug = ?,
             location = ?,
             department = ?,
             employment_type = ?,
             workplace_type = ?,
             short_description = ?,
             description = ?,
             requirements = ?,
             benefits = ?,
             image_url = ?,
             is_active = ?,
             sort_order = ?,
             updated_by = ?
       WHERE id = ?
      `,
      [
        title,
        slug,
        normalizeText(req.body?.location, 255) || null,
        normalizeText(req.body?.department, 255) || null,
        normalizeText(req.body?.employment_type, 100) || null,
        normalizeText(req.body?.workplace_type, 100) || null,
        normalizeLongText(req.body?.short_description, 4000) || null,
        normalizeLongText(req.body?.description) || null,
        normalizeLongText(req.body?.requirements) || null,
        normalizeLongText(req.body?.benefits) || null,
        imageUrl,
        isActive,
        Number.parseInt(req.body?.sort_order, 10) || 0,
        Number(req.session?.userId) || null,
        id
      ]
    );

    let successMessage = 'Stelle wurde aktualisiert.';
    if (isActive === 1 && enqueueJobTranslation(id)) {
      successMessage += ' KI-Übersetzung wurde im Hintergrund gestartet.';
    }
    req.flash('success', successMessage);
    return res.redirect('/admin/jobs');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/translate', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      req.flash('error', 'Ungültige Job-ID.');
      return res.redirect('/admin/jobs');
    }

    if (!process.env.OPENAI_API_KEY) {
      req.flash('error', 'OPENAI_API_KEY fehlt. KI-Übersetzung ist nicht konfiguriert.');
      return res.redirect('/admin/jobs');
    }

    const [[job]] = await db.query('SELECT id FROM jobs WHERE id = ? LIMIT 1', [id]);
    if (!job) {
      req.flash('error', 'Stelle nicht gefunden.');
      return res.redirect('/admin/jobs');
    }

    if (!enqueueJobTranslation(id)) {
      req.flash('error', 'KI-Übersetzung konnte nicht gestartet werden.');
      return res.redirect('/admin/jobs');
    }

    req.flash('success', 'KI-Übersetzung wurde im Hintergrund gestartet.');
    return res.redirect(req.get('referer') || '/admin/jobs');
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await ensureJobsSchema();

    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      req.flash('error', 'Ungültige Job-ID.');
      return res.redirect('/admin/jobs');
    }

    const [[job]] = await db.query('SELECT image_url FROM jobs WHERE id = ? LIMIT 1', [id]);
    await db.query('DELETE FROM jobs WHERE id = ?', [id]);

    const imageAbs = toAbsoluteFromPublicPath(job?.image_url);
    if (imageAbs && fs.existsSync(imageAbs)) {
      try {
        fs.unlinkSync(imageAbs);
      } catch {
        // ignore remove errors
      }
    }

    req.flash('success', 'Stelle wurde gelöscht.');
    return res.redirect('/admin/jobs');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

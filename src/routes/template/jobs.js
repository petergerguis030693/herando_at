const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('../../db');
const { ensureJobsSchema } = require('../../service/jobsSchema');

const router = express.Router();

const JOBS_UPLOAD_ROOT = path.join(__dirname, '../../../uploads/jobs');
const APPLICATION_UPLOAD_DIR = path.join(JOBS_UPLOAD_ROOT, 'applications');
const UI_LANG_COLS = ['de', 'en', 'fr', 'it', 'tr', 'ja', 'cs', 'ru', 'es', 'nl', 'pl'];

const ALLOWED_FILE_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const ALLOWED_FILE_EXT = new Set(['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp']);

const JOBS_LIST_I18N_KEYS = [
  'jobs.page.eyebrow',
  'jobs.page.title',
  'jobs.page.subtitle',
  'jobs.filter.search_label',
  'jobs.filter.search_placeholder',
  'jobs.filter.location_label',
  'jobs.filter.employment_label',
  'jobs.filter.all',
  'jobs.filter.submit',
  'jobs.filter.reset',
  'jobs.empty.title',
  'jobs.empty.text',
  'jobs.item.read_more',
  'jobs.item.fallback_summary',
  'jobs.seo.list.title',
  'jobs.seo.list.description'
];

const JOBS_DETAIL_I18N_KEYS = [
  'jobs.detail.hero_eyebrow',
  'jobs.detail.section.tasks',
  'jobs.detail.section.requirements',
  'jobs.detail.section.benefits',
  'jobs.apply.title',
  'jobs.apply.subtitle',
  'jobs.apply.label.first_name',
  'jobs.apply.label.last_name',
  'jobs.apply.label.email',
  'jobs.apply.label.country',
  'jobs.apply.label.phone_prefix',
  'jobs.apply.label.phone',
  'jobs.apply.label.message',
  'jobs.apply.label.resume',
  'jobs.apply.label.cover_letter',
  'jobs.apply.label.certificates',
  'jobs.apply.placeholder.country',
  'jobs.apply.placeholder.phone_prefix',
  'jobs.apply.privacy',
  'jobs.apply.submit',
  'jobs.seo.detail.title_tpl',
  'jobs.seo.detail.description_tpl'
];

const JOBS_APPLY_I18N_KEYS = [
  'jobs.apply.error.required',
  'jobs.apply.error.country_required',
  'jobs.apply.error.upload',
  'jobs.apply.error.invalid_file_type',
  'jobs.apply.error.file_too_large',
  'jobs.apply.success',
  'jobs.mail.customer.subject_tpl',
  'jobs.mail.customer.title',
  'jobs.mail.customer.greeting_tpl',
  'jobs.mail.customer.intro_tpl',
  'jobs.mail.customer.review',
  'jobs.mail.customer.cta',
  'jobs.mail.admin.subject_tpl',
  'jobs.mail.admin.title',
  'jobs.mail.admin.position_label',
  'jobs.mail.admin.name_label',
  'jobs.mail.admin.email_label',
  'jobs.mail.admin.country_label',
  'jobs.mail.admin.phone_label',
  'jobs.mail.admin.message_label',
  'jobs.mail.admin.open_admin',
  'jobs.mail.common.country_missing',
  'jobs.mail.common.phone_missing',
  'jobs.mail.common.message_missing'
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value, maxLen = 300) {
  return String(value ?? '')
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, maxLen);
}

function resolveLang(req, res) {
  const raw = String(
    req.session?.lang ||
    res.locals?.lang ||
    req.locale ||
    req.acceptsLanguages?.()?.[0] ||
    'de'
  ).toLowerCase();
  const short = raw.split(/[-_]/)[0];
  return UI_LANG_COLS.includes(short) ? short : 'de';
}

function normalizePhonePrefix(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/[^\d+]/g, '').replace(/^\++/, '');
  if (!cleaned) return '';
  return `+${cleaned}`;
}

function buildPhoneWithPrefix(prefixRaw, phoneRaw) {
  const phone = String(phoneRaw || '').trim();
  const prefix = normalizePhonePrefix(prefixRaw);
  if (!phone) return '';
  if (!prefix) return phone;
  if (phone.startsWith('+')) return phone;
  const digits = phone.replace(/[^\d]/g, '');
  const prefixDigits = prefix.replace(/[^\d]/g, '');
  if (digits && prefixDigits && digits.startsWith(prefixDigits)) return `+${digits}`;
  return `${prefix} ${phone.replace(/^0+/, '')}`.trim();
}

async function loadJobCountries(req, res) {
  const langCol = resolveLang(req, res);
  const [rows] = await db.query(
    `
    SELECT
      id,
      code,
      COALESCE(NULLIF(\`${langCol}\`, ''), NULLIF(en, ''), NULLIF(de, ''), code) AS name,
      prefix
    FROM countries
    WHERE visible = 1
      AND prefix IS NOT NULL
      AND prefix <> ''
    ORDER BY name ASC
    `
  );

  return (rows || []).map((row) => ({
    id: Number(row.id),
    code: String(row.code || '').toUpperCase(),
    name: String(row.name || row.code || '').trim(),
    prefix: normalizePhonePrefix(row.prefix)
  }));
}

async function loadCountryById(req, res, countryId) {
  if (!Number.isInteger(countryId) || countryId <= 0) return null;
  const langCol = resolveLang(req, res);
  const [[row]] = await db.query(
    `
    SELECT
      id,
      code,
      COALESCE(NULLIF(\`${langCol}\`, ''), NULLIF(en, ''), NULLIF(de, ''), code) AS name,
      prefix
    FROM countries
    WHERE id = ?
      AND prefix IS NOT NULL
      AND prefix <> ''
    LIMIT 1
    `,
    [countryId]
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    code: String(row.code || '').toUpperCase(),
    name: String(row.name || row.code || '').trim(),
    prefix: normalizePhonePrefix(row.prefix)
  };
}

async function loadUiTranslationMap(req, res, keys = []) {
  const uniqueKeys = Array.from(new Set((keys || []).filter(Boolean)));
  if (!uniqueKeys.length) return {};

  const langCol = resolveLang(req, res);
  const placeholders = uniqueKeys.map(() => '?').join(',');
  const [rows] = await db.query(
    `
    SELECT
      \`key\`,
      COALESCE(NULLIF(\`${langCol}\`, ''), NULLIF(en, ''), NULLIF(de, '')) AS txt
    FROM ui_translations
    WHERE \`key\` IN (${placeholders})
    `,
    uniqueKeys
  );

  const map = {};
  for (const row of rows) {
    if (row?.key && row?.txt) map[row.key] = row.txt;
  }
  return map;
}

async function createTranslator(req, res, keys = []) {
  const map = await loadUiTranslationMap(req, res, keys);
  return (key, fallback = '') => {
    const value = map[key];
    if (value != null && String(value).trim() !== '') return String(value);
    return fallback || key;
  };
}

function fillTpl(template, vars = {}) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, token) => {
    const value = vars[token];
    return value == null ? '' : String(value);
  });
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase().slice(0, 254);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

function getBaseUrl(req) {
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || 'www.herando.at')
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function buildCanonical(req) {
  const baseUrl = getBaseUrl(req);
  const cleanPath = String(req.originalUrl || req.url || '/').split('?')[0].split('#')[0] || '/';
  return `${baseUrl}${cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`}`;
}

function getApplicationUpload() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        ensureDir(APPLICATION_UPLOAD_DIR);
        cb(null, APPLICATION_UPLOAD_DIR);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const safeBase = path
          .basename(file.originalname || 'upload', ext)
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .slice(0, 80) || 'file';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeBase}${ext}`);
      }
    }),
    limits: {
      fileSize: 12 * 1024 * 1024
    },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const mimeOk = ALLOWED_FILE_MIME.has(String(file.mimetype || '').toLowerCase());
      const extOk = ALLOWED_FILE_EXT.has(ext);
      if (mimeOk || extOk) return cb(null, true);
      return cb(new Error('jobs.apply.error.invalid_file_type'));
    }
  }).fields([
    { name: 'resume', maxCount: 1 },
    { name: 'cover_letter', maxCount: 1 },
    { name: 'certificates', maxCount: 10 }
  ]);
}

function setFlash(req, payload) {
  req.session.jobApplicationFlash = payload;
}

function consumeFlash(req) {
  const flash = req.session.jobApplicationFlash || null;
  delete req.session.jobApplicationFlash;
  return flash;
}

async function cleanupUploadedFiles(fileMap) {
  const all = [];
  if (!fileMap || typeof fileMap !== 'object') return;
  for (const files of Object.values(fileMap)) {
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (file?.path) all.push(file.path);
    }
  }
  await Promise.all(
    all.map(async (absPath) => {
      try {
        await fs.promises.unlink(absPath);
      } catch {
        // ignore cleanup errors
      }
    })
  );
}

async function loadLayoutData() {
  const [entieties] = await db.query(`
    SELECT id, name, route
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

  const footerColumns = cols.map((col) => ({
    id: col.id,
    title: col.title,
    sort_order: col.sort_order,
    phone: null,
    links: []
  }));

  for (const link of links) {
    const col = footerColumns.find((entry) => entry.id === link.column_id);
    if (!col) continue;
    if (link.is_phone) col.phone = link.phone_number;
    else col.links.push({ text: link.link_text, url: link.link_url });
  }

  return { entieties, footerColumns };
}

const handleApplicationUpload = (req, res, next) => {
  const upload = getApplicationUpload();
  upload(req, res, async (err) => {
    if (!err) return next();
    let jt = (key, fallback) => fallback || key;
    try {
      jt = await createTranslator(req, res, [
        'jobs.apply.error.upload',
        'jobs.apply.error.invalid_file_type',
        'jobs.apply.error.file_too_large'
      ]);
    } catch {
      // Fallback below
    }

    let uploadError = err.message || '';
    if (err.code === 'LIMIT_FILE_SIZE') {
      uploadError = jt(
        'jobs.apply.error.file_too_large',
        'Datei zu groß. Maximal 12 MB pro Datei sind erlaubt.'
      );
    } else if (uploadError === 'jobs.apply.error.invalid_file_type') {
      uploadError = jt(
        'jobs.apply.error.invalid_file_type',
        'Ungültiger Dateityp. Erlaubt sind PDF, DOC, DOCX, JPG, PNG, WEBP.'
      );
    } else if (!uploadError) {
      uploadError = jt('jobs.apply.error.upload', 'Datei-Upload fehlgeschlagen.');
    }

    setFlash(req, {
      error: uploadError,
      formData: {
        first_name: req.body?.first_name || '',
        last_name: req.body?.last_name || '',
        email: req.body?.email || '',
        country_id: req.body?.country_id || '',
        phone_prefix: req.body?.phone_prefix || '',
        phone: req.body?.phone || '',
        message: req.body?.message || ''
      }
    });
    return res.redirect(`/jobs/${encodeURIComponent(req.params.slug)}`);
  });
};

router.get('/', async (req, res, next) => {
  try {
    await ensureJobsSchema();
    const jt = await createTranslator(req, res, JOBS_LIST_I18N_KEYS);
    const currentLang = resolveLang(req, res);

    const q = String(req.query.q || '').trim();
    const location = String(req.query.location || '').trim();
    const employmentType = String(req.query.employment_type || '').trim();

    const where = ['j.is_active = 1'];
    const params = [currentLang];

    if (q) {
      const like = `%${q}%`;
      where.push(`(
        COALESCE(NULLIF(jtr.title, ''), j.title) LIKE ?
        OR COALESCE(NULLIF(jtr.short_description, ''), j.short_description) LIKE ?
        OR j.department LIKE ?
      )`);
      params.push(like, like, like);
    }

    if (location) {
      where.push('j.location = ?');
      params.push(location);
    }

    if (employmentType) {
      where.push('j.employment_type = ?');
      params.push(employmentType);
    }

    const [jobs] = await db.query(
      `
      SELECT
        j.id,
        COALESCE(NULLIF(jtr.title, ''), j.title) AS title,
        j.slug,
        j.location,
        j.department,
        j.employment_type,
        j.workplace_type,
        COALESCE(NULLIF(jtr.short_description, ''), j.short_description) AS short_description,
        j.image_url,
        j.created_at
      FROM jobs j
      LEFT JOIN job_translations jtr
        ON jtr.job_id = j.id
       AND jtr.language = ?
      WHERE ${where.join(' AND ')}
      ORDER BY j.sort_order ASC, j.created_at DESC
      `,
      params
    );

    const [locations] = await db.query(`
      SELECT DISTINCT location
        FROM jobs
       WHERE is_active = 1
         AND location IS NOT NULL
         AND location <> ''
       ORDER BY location ASC
    `);

    const [employmentTypes] = await db.query(`
      SELECT DISTINCT employment_type
        FROM jobs
       WHERE is_active = 1
         AND employment_type IS NOT NULL
         AND employment_type <> ''
       ORDER BY employment_type ASC
    `);

    const { entieties, footerColumns } = await loadLayoutData();
    const seo = {
      title: jt('jobs.seo.list.title', 'Jobs bei Herando - Karriere & offene Stellen'),
      meta_description: jt(
        'jobs.seo.list.description',
        'Entdecken Sie offene Stellen bei Herando und bewerben Sie sich direkt online über unsere Plattform.'
      ),
      robots: 'index,follow',
      canonical_url: buildCanonical(req)
    };
    res.locals.seo = seo;

    return res.render('pages/templates/jobs', {
      entieties,
      footerColumns,
      seo,
      jt,
      jobs,
      filters: {
        q,
        location,
        employment_type: employmentType
      },
      filterOptions: {
        locations: locations.map((row) => row.location),
        employmentTypes: employmentTypes.map((row) => row.employment_type)
      },
      active: 'jobs'
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:slug', async (req, res, next) => {
  try {
    await ensureJobsSchema();
    const jt = await createTranslator(req, res, JOBS_DETAIL_I18N_KEYS);
    const currentLang = resolveLang(req, res);

    const slug = String(req.params.slug || '').trim();
    const [[job]] = await db.query(
      `
      SELECT
        j.id,
        COALESCE(NULLIF(jtr.title, ''), j.title) AS title,
        j.slug,
        j.location,
        j.department,
        j.employment_type,
        j.workplace_type,
        COALESCE(NULLIF(jtr.short_description, ''), j.short_description) AS short_description,
        COALESCE(NULLIF(jtr.description, ''), j.description) AS description,
        COALESCE(NULLIF(jtr.requirements, ''), j.requirements) AS requirements,
        COALESCE(NULLIF(jtr.benefits, ''), j.benefits) AS benefits,
        j.image_url,
        j.created_at
      FROM jobs j
      LEFT JOIN job_translations jtr
        ON jtr.job_id = j.id
       AND jtr.language = ?
      WHERE j.slug = ?
        AND j.is_active = 1
      LIMIT 1
      `,
      [currentLang, slug]
    );

    if (!job) return next();

    const { entieties, footerColumns } = await loadLayoutData();
    const flash = consumeFlash(req);
    const countries = await loadJobCountries(req, res);
    const seoTitleTpl = jt('jobs.seo.detail.title_tpl', '{{title}} - Jobs bei Herando');
    const seoDescTpl = jt('jobs.seo.detail.description_tpl', 'Jetzt auf die Stelle {{title}} bei Herando bewerben.');
    const seoTitle = fillTpl(seoTitleTpl, { title: job.title });
    const seoDescription = job.short_description
      ? String(job.short_description).slice(0, 160)
      : fillTpl(seoDescTpl, { title: job.title });
    const seo = {
      title: seoTitle,
      meta_description: seoDescription,
      robots: 'index,follow',
      canonical_url: buildCanonical(req),
      og_title: seoTitle,
      og_description: job.short_description
        ? String(job.short_description).slice(0, 200)
        : fillTpl(seoDescTpl, { title: job.title }),
      og_image: job.image_url || null
    };
    res.locals.seo = seo;

    return res.render('pages/templates/job-detail', {
      entieties,
      footerColumns,
      seo,
      jt,
      job,
      countries,
      formData: flash?.formData || {},
      formError: flash?.error || null,
      formSuccess: flash?.success || null,
      active: 'jobs'
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:slug/apply', handleApplicationUpload, async (req, res, next) => {
  try {
    await ensureJobsSchema();
    const jt = await createTranslator(req, res, JOBS_APPLY_I18N_KEYS);
    const currentLang = resolveLang(req, res);

    const slug = String(req.params.slug || '').trim();
    const [[job]] = await db.query(
      `
      SELECT
        j.id,
        COALESCE(NULLIF(jtr.title, ''), j.title) AS title,
        j.slug
      FROM jobs j
      LEFT JOIN job_translations jtr
        ON jtr.job_id = j.id
       AND jtr.language = ?
      WHERE j.slug = ?
         AND j.is_active = 1
       LIMIT 1
      `,
      [currentLang, slug]
    );

    if (!job) {
      await cleanupUploadedFiles(req.files);
      return next();
    }

    const firstName = normalizeText(req.body?.first_name, 120);
    const lastName = normalizeText(req.body?.last_name, 120);
    const email = normalizeEmail(req.body?.email);
    const countryId = Number.parseInt(String(req.body?.country_id || ''), 10);
    const country = await loadCountryById(req, res, countryId);
    const phonePrefix = normalizePhonePrefix(req.body?.phone_prefix);
    const phone = normalizeText(req.body?.phone, 80);
    const phoneWithPrefix = buildPhoneWithPrefix(phonePrefix, phone);
    const message = normalizeText(req.body?.message, 3000);
    const privacyAccepted = String(req.body?.privacy || '') === '1';

    const resumeFile = req.files?.resume?.[0] || null;
    const coverLetterFile = req.files?.cover_letter?.[0] || null;
    const certificateFiles = Array.isArray(req.files?.certificates) ? req.files.certificates : [];

    if (
      !firstName ||
      !lastName ||
      !email ||
      !isValidEmail(email) ||
      !country ||
      !privacyAccepted ||
      !resumeFile
    ) {
      await cleanupUploadedFiles(req.files);
      setFlash(req, {
        error: !country
          ? jt('jobs.apply.error.country_required', 'Bitte wählen Sie ein Land aus.')
          : jt(
            'jobs.apply.error.required',
            'Bitte füllen Sie alle Pflichtfelder aus. Lebenslauf, Land und Datenschutzzustimmung sind erforderlich.'
          ),
        formData: {
          first_name: firstName,
          last_name: lastName,
          email,
          country_id: Number.isInteger(countryId) && countryId > 0 ? String(countryId) : '',
          phone_prefix: phonePrefix,
          phone,
          message
        }
      });
      return res.redirect(`/jobs/${encodeURIComponent(job.slug)}`);
    }

    const certificates = certificateFiles.map((file) => ({
      path: file.path,
      public_path: `/uploads/jobs/applications/${file.filename}`,
      original_name: file.originalname,
      mime: file.mimetype,
      size: file.size
    }));

    await db.query(
      `
      INSERT INTO job_applications (
        job_id,
        first_name,
        last_name,
        email,
        country_id,
        phone_prefix,
        phone,
        message,
        resume_path,
        resume_name,
        resume_mime,
        resume_size,
        cover_letter_path,
        cover_letter_name,
        cover_letter_mime,
        cover_letter_size,
        certificates_json,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
      `,
      [
        job.id,
        firstName,
        lastName,
        email,
        country.id,
        phonePrefix || null,
        phone || null,
        message || null,
        resumeFile.path,
        resumeFile.originalname,
        resumeFile.mimetype || null,
        resumeFile.size || null,
        coverLetterFile?.path || null,
        coverLetterFile?.originalname || null,
        coverLetterFile?.mimetype || null,
        coverLetterFile?.size || null,
        certificates.length ? JSON.stringify(certificates) : null
      ]
    );

    const baseUrl = getBaseUrl(req);
    const logoUrl = `${baseUrl}/assets/herando-weblogo.png`;
    const jobUrl = `${baseUrl}/jobs/${encodeURIComponent(job.slug)}`;
    const safeName = escapeHtml(`${firstName} ${lastName}`.trim());
    const customerTitle = jt('jobs.mail.customer.title', 'Vielen Dank für Ihre Bewerbung');
    const customerGreeting = fillTpl(jt('jobs.mail.customer.greeting_tpl', 'Hallo {{name}},'), {
      name: `${firstName} ${lastName}`.trim()
    });
    const customerIntro = fillTpl(
      jt(
        'jobs.mail.customer.intro_tpl',
        'Ihre Bewerbung für die Position {{title}} wurde erfolgreich übermittelt.'
      ),
      { title: job.title }
    );
    const customerReview = jt('jobs.mail.customer.review', 'Unser Team prüft Ihre Unterlagen und meldet sich bei Ihnen.');
    const customerCta = jt('jobs.mail.customer.cta', 'Zur Stelle');

    const adminTitle = jt('jobs.mail.admin.title', 'Neue Job-Bewerbung');
    const adminPositionLabel = jt('jobs.mail.admin.position_label', 'Stelle');
    const adminNameLabel = jt('jobs.mail.admin.name_label', 'Name');
    const adminEmailLabel = jt('jobs.mail.admin.email_label', 'E-Mail');
    const adminCountryLabel = jt('jobs.mail.admin.country_label', 'Land');
    const adminPhoneLabel = jt('jobs.mail.admin.phone_label', 'Telefon');
    const adminMessageLabel = jt('jobs.mail.admin.message_label', 'Nachricht');
    const adminOpenLabel = jt('jobs.mail.admin.open_admin', 'Bewerbungen im Adminpanel öffnen');
    const missingCountry = jt('jobs.mail.common.country_missing', '—');
    const missingPhone = jt('jobs.mail.common.phone_missing', '—');
    const missingMessage = jt('jobs.mail.common.message_missing', '—');

    const customerHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f7;padding:24px;font-family:Arial,sans-serif;">
        <tr>
          <td align="center">
            <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e6e7ea;border-radius:12px;overflow:hidden;">
              <tr>
                <td style="padding:22px 24px;background:#101820;">
                  <img src="${logoUrl}" alt="Herando" style="height:34px;display:block;">
                </td>
              </tr>
              <tr>
                <td style="padding:24px;color:#1f2937;font-size:15px;line-height:1.6;">
                  <h2 style="margin:0 0 12px;font-size:22px;color:#101820;">${escapeHtml(customerTitle)}</h2>
                  <p style="margin:0 0 12px;">${escapeHtml(customerGreeting)}</p>
                  <p style="margin:0 0 12px;">${escapeHtml(customerIntro)}</p>
                  <p style="margin:0 0 18px;">${escapeHtml(customerReview)}</p>
                  <a href="${jobUrl}" style="display:inline-block;background:#c99b5d;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">${escapeHtml(customerCta)}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;

    const adminHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f7;padding:24px;font-family:Arial,sans-serif;">
        <tr>
          <td align="center">
            <table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;background:#ffffff;border:1px solid #e6e7ea;border-radius:12px;overflow:hidden;">
              <tr>
                <td style="padding:22px 24px;background:#101820;">
                  <img src="${logoUrl}" alt="Herando" style="height:34px;display:block;">
                </td>
              </tr>
              <tr>
                <td style="padding:24px;color:#1f2937;font-size:15px;line-height:1.6;">
                  <h2 style="margin:0 0 12px;font-size:22px;color:#101820;">${escapeHtml(adminTitle)}</h2>
                  <p style="margin:0 0 6px;"><strong>${escapeHtml(adminPositionLabel)}:</strong> ${escapeHtml(job.title)}</p>
                  <p style="margin:0 0 6px;"><strong>${escapeHtml(adminNameLabel)}:</strong> ${safeName}</p>
                  <p style="margin:0 0 6px;"><strong>${escapeHtml(adminEmailLabel)}:</strong> ${escapeHtml(email)}</p>
                  <p style="margin:0 0 6px;"><strong>${escapeHtml(adminCountryLabel)}:</strong> ${escapeHtml(country?.name || missingCountry)}</p>
                  <p style="margin:0 0 6px;"><strong>${escapeHtml(adminPhoneLabel)}:</strong> ${escapeHtml(phoneWithPrefix || missingPhone)}</p>
                  <p style="margin:0 0 12px;"><strong>${escapeHtml(adminMessageLabel)}:</strong><br>${escapeHtml(message || missingMessage).replace(/\n/g, '<br>')}</p>
                  <p style="margin:0;">
                    <a href="${baseUrl}/admin/jobs/applications" style="color:#c99b5d;text-decoration:none;">${escapeHtml(adminOpenLabel)}</a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;

    const adminTo = process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL || process.env.SMTP_USER;
    const adminCc = process.env.ADMIN_CC || '';
    const transporter = createSmtpTransporter();

    const adminAttachments = [
      {
        filename: resumeFile.originalname,
        path: resumeFile.path
      }
    ];
    if (coverLetterFile?.path) {
      adminAttachments.push({
        filename: coverLetterFile.originalname,
        path: coverLetterFile.path
      });
    }
    for (const cert of certificateFiles) {
      if (!cert?.path) continue;
      adminAttachments.push({
        filename: cert.originalname,
        path: cert.path
      });
    }

    try {
      await Promise.all([
        transporter.sendMail({
          from: `"Herando Jobs" <info@herando.com>`,
          to: email,
          subject: fillTpl(jt('jobs.mail.customer.subject_tpl', 'Ihre Bewerbung bei Herando - {{title}}'), { title: job.title }),
          html: customerHtml
        }),
        transporter.sendMail({
          from: `"Herando Jobs" <info@herando.com>`,
          to: adminTo,
          cc: adminCc || undefined,
          subject: fillTpl(
            jt('jobs.mail.admin.subject_tpl', 'Neue Bewerbung: {{title}} - {{name}}'),
            { title: job.title, name: `${firstName} ${lastName}`.trim() }
          ),
          html: adminHtml,
          attachments: adminAttachments
        })
      ]);
    } catch (mailErr) {
      console.error('Jobs mail error:', mailErr);
    }

    setFlash(req, {
      success: jt('jobs.apply.success', 'Vielen Dank. Ihre Bewerbung wurde erfolgreich gesendet.'),
      formData: {}
    });
    return res.redirect(`/jobs/${encodeURIComponent(job.slug)}`);
  } catch (err) {
    await cleanupUploadedFiles(req.files);
    return next(err);
  }
});

module.exports = router;

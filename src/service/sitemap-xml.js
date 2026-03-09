const db = require('../db');

const CHANGEFREQ_VALUES = new Set([
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never'
]);

let ensureSitemapPagesTablePromise = null;

async function ensureSitemapPagesTable() {
  if (!ensureSitemapPagesTablePromise) {
    ensureSitemapPagesTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS sitemap_pages (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        url VARCHAR(2048) NOT NULL,
        lastmod DATE NULL,
        changefreq ENUM('always','hourly','daily','weekly','monthly','yearly','never') NULL,
        priority DECIMAL(2,1) NULL,
        sort_order INT NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_sitemap_pages_active_sort (is_active, sort_order, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `).catch((err) => {
      ensureSitemapPagesTablePromise = null;
      throw err;
    });
  }

  return ensureSitemapPagesTablePromise;
}

function normalizeSitemapUrlInput(input) {
  let raw = String(input || '').trim();
  if (!raw) return '';
  if (/\s/.test(raw)) return '';

  raw = raw.replace(/#.*$/, '');

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '';
    }
  }

  if (!raw.startsWith('/')) raw = `/${raw}`;
  return raw;
}

function normalizeSitemapLastmodInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;

  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 10);
}

function normalizeSitemapChangefreqInput(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return null;
  return CHANGEFREQ_VALUES.has(raw) ? raw : null;
}

function normalizeSitemapPriorityInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const num = Number.parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(num)) return null;

  const clamped = Math.max(0, Math.min(1, num));
  return clamped.toFixed(1);
}

function normalizeSitemapSortOrderInput(input) {
  const parsed = Number.parseInt(String(input ?? '0'), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSitemapActiveInput(input) {
  if (input === true || input === 1 || input === '1') return 1;
  if (input === 'on') return 1;
  return 0;
}

function formatSitemapDateValue(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function formatSitemapDateTimeValue(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function buildSitemapRequestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim();
  return `${proto || 'https'}://${host}`;
}

function toAbsoluteSitemapUrl(urlValue, origin) {
  const raw = String(urlValue || '').trim();
  if (!raw) return '';

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (!['http:', 'https:'].includes(parsed.protocol)) return '';
      return parsed.toString();
    } catch {
      return '';
    }
  }

  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `${origin}${path}`;
}

function escapeXml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function getSitemapPageRows({ onlyActive = false } = {}) {
  await ensureSitemapPagesTable();

  const whereSql = onlyActive ? 'WHERE is_active = 1' : '';
  const [rows] = await db.query(
    `
      SELECT id, url, lastmod, changefreq, priority, sort_order, is_active, updated_at
      FROM sitemap_pages
      ${whereSql}
      ORDER BY sort_order ASC, id ASC
    `
  );

  return rows;
}

module.exports = {
  ensureSitemapPagesTable,
  normalizeSitemapUrlInput,
  normalizeSitemapLastmodInput,
  normalizeSitemapChangefreqInput,
  normalizeSitemapPriorityInput,
  normalizeSitemapSortOrderInput,
  normalizeSitemapActiveInput,
  formatSitemapDateValue,
  formatSitemapDateTimeValue,
  buildSitemapRequestOrigin,
  toAbsoluteSitemapUrl,
  escapeXml,
  getSitemapPageRows,
  CHANGEFREQ_VALUES
};

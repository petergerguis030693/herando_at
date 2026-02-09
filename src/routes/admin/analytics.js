// src/routes/admin/analytics.js
'use strict';

const express = require('express');
const db = require('../../db');
const router = express.Router();

/* ------------------------ Utils ------------------------ */
function clamp(n, { min = 1, max = 1000 }) {
  n = parseInt(n, 10);
  if (isNaN(n)) n = max;
  return Math.min(Math.max(n, min), max);
}
function toSql(dt) {
  return dt.toISOString().slice(0, 19).replace('T', ' ');
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function parseRange(q) {
  // Default: letzte 7 Tage
  const now = new Date();
  const defFrom = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  let from = q.from ? new Date(q.from) : defFrom;
  let to = q.to ? new Date(q.to) : now;
  if (isNaN(from)) from = defFrom;
  if (isNaN(to)) to = now;
  // Hard cap: max 180 Tage
  if (to - from > 180 * 24 * 3600 * 1000) {
    from = new Date(to.getTime() - 180 * 24 * 3600 * 1000);
  }
  return { from: startOfDay(from), to: endOfDay(to) };
}

/* ------------------------ HTML Dashboard ------------------------ */
// GET /admin/analytics
router.get('/', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);

    const [[kpis]] = await db.query(
      `
      SELECT
        (SELECT COUNT(*)
           FROM visit_pageviews
          WHERE started_at BETWEEN ? AND ?)                                        AS pageviews,
        (SELECT COUNT(DISTINCT session_id)
           FROM visit_pageviews
          WHERE started_at BETWEEN ? AND ?)                                        AS sessions,
        (SELECT ROUND(AVG(duration_ms)/1000,1)
           FROM visit_pageviews
          WHERE started_at BETWEEN ? AND ? AND duration_ms IS NOT NULL)            AS avg_time_s,
        (SELECT ROUND(
           SUM(CASE WHEN x.pv_cnt=1 THEN 1 ELSE 0 END) / COUNT(*) * 100, 1)
           FROM (SELECT session_id, COUNT(*) AS pv_cnt
                   FROM visit_pageviews
                  WHERE started_at BETWEEN ? AND ?
                  GROUP BY session_id) x)                                          AS bounce_rate
      `,
      [fromSql, toSqlStr, fromSql, toSqlStr, fromSql, toSqlStr, fromSql, toSqlStr]
    );

    const [topPages] = await db.query(
      `
      SELECT path, COUNT(*) AS views, ROUND(AVG(duration_ms)/1000,1) AS avg_time_s
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
       GROUP BY path
       ORDER BY views DESC
       LIMIT 50
      `,
      [fromSql, toSqlStr]
    );

    const [topClicks] = await db.query(
      `
      SELECT COALESCE(target_url, CONCAT(path, ' [', element, ']')) AS target,
             COUNT(*) AS clicks
        FROM visit_events
       WHERE event_type='click'
         AND created_at BETWEEN ? AND ?
       GROUP BY COALESCE(target_url, CONCAT(path, ' [', element, ']'))
       ORDER BY clicks DESC
       LIMIT 50
      `,
      [fromSql, toSqlStr]
    );

    const [searches] = await db.query(
      `
      SELECT element_text AS query, COUNT(*) AS cnt
        FROM visit_events
       WHERE event_type='search'
         AND created_at BETWEEN ? AND ?
       GROUP BY element_text
       ORDER BY cnt DESC
       LIMIT 50
      `,
      [fromSql, toSqlStr]
    );

    const [referrers] = await db.query(
      `
      SELECT referer, COUNT(*) AS hits
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
         AND referer IS NOT NULL AND referer <> ''
       GROUP BY referer
       ORDER BY hits DESC
       LIMIT 50
      `,
      [fromSql, toSqlStr]
    );

    res.render('admin/admin-analytics', {
      headerTitle: 'Analytics',
      currentUrl: req.originalUrl,
      active: 'Analytics',
      kpis,
      topPages,
      topClicks,
      searches,
      referrers,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10)
    });
  } catch (err) { next(err); }
});

/* ------------------------ JSON APIs ------------------------ */

// GET /admin/analytics/summary.json
router.get('/summary.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);

    const [[kpis]] = await db.query(
      `
      SELECT
        (SELECT COUNT(*) FROM visit_pageviews WHERE started_at BETWEEN ? AND ?) AS pageviews,
        (SELECT COUNT(DISTINCT session_id) FROM visit_pageviews WHERE started_at BETWEEN ? AND ?) AS sessions,
        (SELECT ROUND(AVG(duration_ms)/1000,1) FROM visit_pageviews WHERE started_at BETWEEN ? AND ? AND duration_ms IS NOT NULL) AS avg_time_s
      `,
      [fromSql, toSqlStr, fromSql, toSqlStr, fromSql, toSqlStr]
    );

    const [series] = await db.query(
      `
      SELECT DATE(started_at) AS day, COUNT(*) AS views
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
       GROUP BY day
       ORDER BY day
      `,
      [fromSql, toSqlStr]
    );

    res.json({ range: { from: fromSql, to: toSqlStr }, kpis, series });
  } catch (err) { next(err); }
});

// GET /admin/analytics/top-pages.json
router.get('/top-pages.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });

    const [rows] = await db.query(
      `
      SELECT path, COUNT(*) AS views, ROUND(AVG(duration_ms)/1000,1) AS avg_time_s
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
       GROUP BY path
       ORDER BY views DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/top-clicks.json
router.get('/top-clicks.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });

    const [rows] = await db.query(
      `
      SELECT COALESCE(target_url, CONCAT(path, ' [', element, ']')) AS target,
             COUNT(*) AS clicks
        FROM visit_events
       WHERE event_type='click'
         AND created_at BETWEEN ? AND ?
       GROUP BY COALESCE(target_url, CONCAT(path, ' [', element, ']'))
       ORDER BY clicks DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/searches.json
router.get('/searches.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });

    const [rows] = await db.query(
      `
      SELECT element_text AS query, COUNT(*) AS cnt
        FROM visit_events
       WHERE event_type='search'
         AND created_at BETWEEN ? AND ?
       GROUP BY element_text
       ORDER BY cnt DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/referrers.json
router.get('/referrers.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });

    const [rows] = await db.query(
      `
      SELECT referer, COUNT(*) AS hits
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
         AND referer IS NOT NULL AND referer <> ''
       GROUP BY referer
       ORDER BY hits DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/sessions.json
router.get('/sessions.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 100, { min: 1, max: 1000 });

    const [rows] = await db.query(
      `
      SELECT s.id, s.session_token, s.user_id,
             DATE_FORMAT(s.first_seen, '%Y-%m-%d %H:%i:%s') AS first_seen,
             DATE_FORMAT(s.last_seen,  '%Y-%m-%d %H:%i:%s') AS last_seen,
             INET6_NTOA(s.ip) AS ip,
             s.utm_source, s.utm_medium, s.utm_campaign,
             (SELECT COUNT(*) FROM visit_pageviews pv WHERE pv.session_id=s.id) AS pv_count
        FROM visit_sessions s
       WHERE s.last_seen BETWEEN ? AND ?
       ORDER BY s.last_seen DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ---- Extra: Geräte/Browser/OS/Countries & Entry/Exit ------------------- */

// GET /admin/analytics/devices.json
router.get('/devices.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const [rows] = await db.query(
      `
      SELECT COALESCE(device_type,'unknown') AS device, COUNT(*) AS sessions
        FROM visit_sessions
       WHERE last_seen BETWEEN ? AND ?
       GROUP BY device_type
       ORDER BY sessions DESC
      `,
      [toSql(from), toSql(to)]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/browsers.json
router.get('/browsers.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const [rows] = await db.query(
      `
      SELECT COALESCE(browser,'unknown') AS browser, COUNT(*) AS sessions
        FROM visit_sessions
       WHERE last_seen BETWEEN ? AND ?
       GROUP BY browser
       ORDER BY sessions DESC
      `,
      [toSql(from), toSql(to)]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/os.json
router.get('/os.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const [rows] = await db.query(
      `
      SELECT COALESCE(os,'unknown') AS os, COUNT(*) AS sessions
        FROM visit_sessions
       WHERE last_seen BETWEEN ? AND ?
       GROUP BY os
       ORDER BY sessions DESC
      `,
      [toSql(from), toSql(to)]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/countries.json
router.get('/countries.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const limit = clamp(req.query.limit || 100, { min: 1, max: 250 });
    const [rows] = await db.query(
      `
      SELECT country_code AS country, COUNT(*) AS sessions
        FROM visit_sessions
       WHERE last_seen BETWEEN ? AND ?
         AND country_code IS NOT NULL AND country_code <> ''
       GROUP BY country_code
       ORDER BY sessions DESC
       LIMIT ?
      `,
      [toSql(from), toSql(to), limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/entry-exit.json
router.get('/entry-exit.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });

    const [entries] = await db.query(
      `
      SELECT path, COUNT(*) AS entries
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
         AND is_entry = 1
       GROUP BY path
       ORDER BY entries DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );

    const [exits] = await db.query(
      `
      SELECT path, COUNT(*) AS exits
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
         AND is_exit = 1
       GROUP BY path
       ORDER BY exits DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );

    res.json({ entries, exits });
  } catch (err) { next(err); }
});

/* ------------------------ CSV Exports ------------------------ */

function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [];
  lines.push(header.map(esc).join(','));
  for (const r of rows) {
    lines.push(header.map((h) => esc(r[h])).join(','));
  }
  res.send(lines.join('\n'));
}

// GET /admin/analytics/export/pageviews.csv
router.get('/export/pageviews.csv', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50000, { min: 1, max: 100000 });

    const [rows] = await db.query(
      `
      SELECT pv.pv_id, pv.session_id, pv.user_id, pv.path, pv.referer,
             DATE_FORMAT(pv.started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
             DATE_FORMAT(pv.ended_at,   '%Y-%m-%d %H:%i:%s') AS ended_at,
             pv.duration_ms
        FROM visit_pageviews pv
       WHERE pv.started_at BETWEEN ? AND ?
       ORDER BY pv.started_at DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );
    const header = ['pv_id','session_id','user_id','path','referer','started_at','ended_at','duration_ms'];
    sendCsv(res, 'pageviews.csv', header, rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/export/events.csv
router.get('/export/events.csv', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50000, { min: 1, max: 100000 });
    const type = (req.query.type || '').trim(); // optional: click|search|custom

    const params = [fromSql, toSqlStr];
    let where = `created_at BETWEEN ? AND ?`;
    if (type) { where += ` AND event_type = ?`; params.push(type); }

    const [rows] = await db.query(
      `
      SELECT event_type, session_id, user_id, pv_id, path, target_url, element, element_id, element_text,
             referer,
             DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
             meta
        FROM visit_events
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT ?
      `,
      [...params, limit]
    );

    const normalized = rows.map(r => ({
      ...r,
      meta: r.meta ? JSON.stringify(r.meta) : ''
    }));

    const header = [
      'event_type','session_id','user_id','pv_id','path','target_url','element','element_id','element_text',
      'referer','created_at','meta'
    ];
    sendCsv(res, 'events.csv', header, normalized);
  } catch (err) { next(err); }
});

module.exports = router;

// src/routes/admin/analytics.js
'use strict';

const express = require('express');
const db = require('../../db');
const { ensureActivityLogTable } = require('../../service/activity-log');
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
function normCountry(v) {
  const s = String(v || '').trim().toUpperCase();
  return s || 'UNKNOWN';
}
function sqlCountryExpr(alias = 's') {
  const a = alias ? `${alias}.` : '';
  return `COALESCE(NULLIF(${a}country_code,''), 'UNKNOWN')`;
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
      SELECT path,
             COALESCE(target_url, CONCAT('[', COALESCE(element,'element'), '] ', COALESCE(element_text,''))) AS target,
             COUNT(*) AS clicks
        FROM visit_events
       WHERE event_type='click'
         AND created_at BETWEEN ? AND ?
       GROUP BY path, COALESCE(target_url, CONCAT('[', COALESCE(element,'element'), '] ', COALESCE(element_text,'')))
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
      active: 'analytics',
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
    const rangeMs = Math.max(1, to.getTime() - from.getTime());
    const prevTo = new Date(from.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - rangeMs);
    const prevFromSql = toSql(prevFrom), prevToSql = toSql(prevTo);

    const [[kpis]] = await db.query(
      `
      SELECT
        (SELECT COUNT(*) FROM visit_pageviews WHERE started_at BETWEEN ? AND ?) AS pageviews,
        (SELECT COUNT(DISTINCT session_id) FROM visit_pageviews WHERE started_at BETWEEN ? AND ?) AS sessions,
        (SELECT ROUND(AVG(duration_ms)/1000,1) FROM visit_pageviews WHERE started_at BETWEEN ? AND ? AND duration_ms IS NOT NULL) AS avg_time_s,
        (SELECT COUNT(*) FROM visit_events WHERE created_at BETWEEN ? AND ?) AS events_total,
        (SELECT ROUND(
           SUM(CASE WHEN x.pv_cnt=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0) * 100, 1)
           FROM (SELECT session_id, COUNT(*) AS pv_cnt
                   FROM visit_pageviews
                  WHERE started_at BETWEEN ? AND ?
                  GROUP BY session_id) x) AS bounce_rate
      `,
      [
        fromSql, toSqlStr,
        fromSql, toSqlStr,
        fromSql, toSqlStr,
        fromSql, toSqlStr,
        fromSql, toSqlStr
      ]
    );

    const [[prevKpis]] = await db.query(
      `
      SELECT
        (SELECT COUNT(*) FROM visit_pageviews WHERE started_at BETWEEN ? AND ?) AS pageviews,
        (SELECT COUNT(DISTINCT session_id) FROM visit_pageviews WHERE started_at BETWEEN ? AND ?) AS sessions,
        (SELECT ROUND(AVG(duration_ms)/1000,1) FROM visit_pageviews WHERE started_at BETWEEN ? AND ? AND duration_ms IS NOT NULL) AS avg_time_s,
        (SELECT COUNT(*) FROM visit_events WHERE created_at BETWEEN ? AND ?) AS events_total,
        (SELECT ROUND(
           SUM(CASE WHEN x.pv_cnt=1 THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0) * 100, 1)
           FROM (SELECT session_id, COUNT(*) AS pv_cnt
                   FROM visit_pageviews
                  WHERE started_at BETWEEN ? AND ?
                  GROUP BY session_id) x) AS bounce_rate
      `,
      [
        prevFromSql, prevToSql,
        prevFromSql, prevToSql,
        prevFromSql, prevToSql,
        prevFromSql, prevToSql,
        prevFromSql, prevToSql
      ]
    );

    const [viewsSeries] = await db.query(
      `
      SELECT DATE(started_at) AS day, COUNT(*) AS views
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
       GROUP BY day
       ORDER BY day
      `,
      [fromSql, toSqlStr]
    );

    const [sessionsSeries] = await db.query(
      `
      SELECT DATE(last_seen) AS day, COUNT(*) AS sessions
        FROM visit_sessions
       WHERE last_seen BETWEEN ? AND ?
       GROUP BY day
       ORDER BY day
      `,
      [fromSql, toSqlStr]
    );

    const normDay = (v) => {
      if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
      const s = String(v || '');
      return s.length >= 10 ? s.slice(0, 10) : s;
    };
    const viewMap = new Map(viewsSeries.map(r => [normDay(r.day), Number(r.views || 0)]));
    const sessionMap = new Map(sessionsSeries.map(r => [normDay(r.day), Number(r.sessions || 0)]));
    const dayList = Array.from(new Set([...viewMap.keys(), ...sessionMap.keys()])).sort();
    const series = dayList.map(day => ({
      day,
      views: viewMap.get(day) || 0,
      sessions: sessionMap.get(day) || 0
    }));

    const current = {
      ...kpis,
      pageviews: Number(kpis?.pageviews || 0),
      sessions: Number(kpis?.sessions || 0),
      avg_time_s: Number(kpis?.avg_time_s || 0),
      events_total: Number(kpis?.events_total || 0),
      bounce_rate: Number(kpis?.bounce_rate || 0)
    };
    current.pages_per_session = current.sessions > 0
      ? Math.round((current.pageviews / current.sessions) * 100) / 100
      : 0;

    const previous = {
      ...prevKpis,
      pageviews: Number(prevKpis?.pageviews || 0),
      sessions: Number(prevKpis?.sessions || 0),
      avg_time_s: Number(prevKpis?.avg_time_s || 0),
      events_total: Number(prevKpis?.events_total || 0),
      bounce_rate: Number(prevKpis?.bounce_rate || 0)
    };
    previous.pages_per_session = previous.sessions > 0
      ? Math.round((previous.pageviews / previous.sessions) * 100) / 100
      : 0;

    res.json({
      range: { from: fromSql, to: toSqlStr },
      previous_range: { from: prevFromSql, to: prevToSql },
      kpis: current,
      previous_kpis: previous,
      series
    });
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
      SELECT path,
             COALESCE(target_url, CONCAT('[', COALESCE(element,'element'), '] ', COALESCE(element_text,''))) AS target,
             COUNT(*) AS clicks
        FROM visit_events
       WHERE event_type='click'
         AND created_at BETWEEN ? AND ?
       GROUP BY path, COALESCE(target_url, CONCAT('[', COALESCE(element,'element'), '] ', COALESCE(element_text,'')))
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
             COALESCE(s.device_type, '') AS device_type,
             COALESCE(s.browser, '') AS browser,
             COALESCE(s.os, '') AS os,
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

// GET /admin/analytics/activity.json
router.get('/activity.json', async (req, res, next) => {
  try {
    await ensureActivityLogTable();
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 100, { min: 1, max: 500 });

    const actorRaw = String(req.query.actor || '').trim().toLowerCase();
    const actor = (actorRaw === 'admin' || actorRaw === 'customer') ? actorRaw : '';
    const userId = Number.parseInt(String(req.query.user_id || ''), 10);
    const role = Number.parseInt(String(req.query.role || ''), 10);
    const method = String(req.query.method || '').trim().toUpperCase();
    const pathLike = String(req.query.path || '').trim();

    const where = ['a.created_at BETWEEN ? AND ?'];
    const params = [fromSql, toSqlStr];

    if (actor) {
      where.push('a.actor_type = ?');
      params.push(actor);
    }
    if (Number.isInteger(userId) && userId > 0) {
      where.push('a.actor_user_id = ?');
      params.push(userId);
    }
    if (Number.isInteger(role)) {
      where.push('a.actor_role = ?');
      params.push(role);
    }
    if (method) {
      where.push('a.method = ?');
      params.push(method);
    }
    if (pathLike) {
      where.push('a.path LIKE ?');
      params.push(`%${pathLike}%`);
    }

    const [rows] = await db.query(
      `
      SELECT a.id,
             DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
             a.actor_type,
             a.actor_user_id,
             a.actor_role,
             a.method,
             a.path,
             a.status_code,
             a.duration_ms,
             a.payload_json,
             COALESCE(CONCAT(u.firstname, ' ', u.lastname), u.email, '') AS actor_name
        FROM activity_log a
   LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT ?
      `,
      [...params, limit]
    );

    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/click-events.json
router.get('/click-events.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 100, { min: 1, max: 500 });

    const actorRaw = String(req.query.actor || '').trim().toLowerCase();
    const actor = (actorRaw === 'admin' || actorRaw === 'customer') ? actorRaw : '';
    const userId = Number.parseInt(String(req.query.user_id || ''), 10);
    const role = Number.parseInt(String(req.query.role || ''), 10);
    const pathLike = String(req.query.path || '').trim();

    const where = ['ve.event_type = \'click\'', 've.created_at BETWEEN ? AND ?'];
    const params = [fromSql, toSqlStr];

    if (actor === 'admin') {
      where.push('u.role IN (7,8,9)');
    } else if (actor === 'customer') {
      where.push('(u.role IS NULL OR u.role NOT IN (7,8,9))');
    }
    if (Number.isInteger(userId) && userId > 0) {
      where.push('ve.user_id = ?');
      params.push(userId);
    }
    if (Number.isInteger(role)) {
      where.push('u.role = ?');
      params.push(role);
    }
    if (pathLike) {
      where.push('ve.path LIKE ?');
      params.push(`%${pathLike}%`);
    }

    const [rows] = await db.query(
      `
      SELECT ve.id,
             DATE_FORMAT(ve.created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
             ve.user_id,
             u.role,
             COALESCE(CONCAT(u.firstname, ' ', u.lastname), u.email, '') AS user_name,
             ve.path,
             ve.target_url,
             ve.element,
             ve.element_id,
             ve.element_text,
             ve.meta
        FROM visit_events ve
   LEFT JOIN users u ON u.id = ve.user_id
       WHERE ${where.join(' AND ')}
       ORDER BY ve.created_at DESC
       LIMIT ?
      `,
      [...params, limit]
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

/* ------------------------ Deep-Dive Auswertung ------------------------ */

// GET /admin/analytics/country-overview.json
router.get('/country-overview.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 100, { min: 1, max: 250 });

    const [sessionRows] = await db.query(
      `
      SELECT ${sqlCountryExpr('s')} AS country, COUNT(*) AS sessions
        FROM visit_sessions s
       WHERE s.last_seen BETWEEN ? AND ?
       GROUP BY ${sqlCountryExpr('s')}
       ORDER BY sessions DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, limit]
    );

    const [pvRows] = await db.query(
      `
      SELECT ${sqlCountryExpr('s')} AS country,
             COUNT(*) AS pageviews,
             ROUND(AVG(pv.duration_ms)/1000, 1) AS avg_time_s
        FROM visit_pageviews pv
        JOIN visit_sessions s ON s.id = pv.session_id
       WHERE pv.started_at BETWEEN ? AND ?
       GROUP BY ${sqlCountryExpr('s')}
      `,
      [fromSql, toSqlStr]
    );

    const [evRows] = await db.query(
      `
      SELECT ${sqlCountryExpr('s')} AS country,
             COUNT(*) AS events
        FROM visit_events ve
        JOIN visit_sessions s ON s.id = ve.session_id
       WHERE ve.created_at BETWEEN ? AND ?
       GROUP BY ${sqlCountryExpr('s')}
      `,
      [fromSql, toSqlStr]
    );

    const pvMap = new Map(pvRows.map(r => [normCountry(r.country), r]));
    const evMap = new Map(evRows.map(r => [normCountry(r.country), r]));

    const rows = sessionRows.map(r => {
      const key = normCountry(r.country);
      const pv = pvMap.get(key) || {};
      const ev = evMap.get(key) || {};
      return {
        country: key,
        sessions: Number(r.sessions || 0),
        pageviews: Number(pv.pageviews || 0),
        events: Number(ev.events || 0),
        avg_time_s: Number(pv.avg_time_s || 0)
      };
    });

    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/country-pages.json?country=AT
router.get('/country-pages.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });
    const country = normCountry(req.query.country);

    if (!country || country === 'UNKNOWN' && !String(req.query.country || '').trim()) {
      return res.json([]);
    }

    const [rows] = await db.query(
      `
      SELECT pv.path,
             COUNT(*) AS views,
             COUNT(DISTINCT pv.session_id) AS sessions,
             ROUND(AVG(pv.duration_ms)/1000, 1) AS avg_time_s
        FROM visit_pageviews pv
        JOIN visit_sessions s ON s.id = pv.session_id
       WHERE pv.started_at BETWEEN ? AND ?
         AND ${sqlCountryExpr('s')} = ?
       GROUP BY pv.path
       ORDER BY views DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, country, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/country-clicks.json?country=AT
router.get('/country-clicks.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 50, { min: 1, max: 200 });
    const country = normCountry(req.query.country);

    if (!country || country === 'UNKNOWN' && !String(req.query.country || '').trim()) {
      return res.json([]);
    }

    const [rows] = await db.query(
      `
      SELECT ve.path,
             COALESCE(ve.target_url, CONCAT('[', COALESCE(ve.element,'element'), '] ', COALESCE(ve.element_text,''))) AS target,
             COUNT(*) AS clicks
        FROM visit_events ve
        JOIN visit_sessions s ON s.id = ve.session_id
       WHERE ve.event_type = 'click'
         AND ve.created_at BETWEEN ? AND ?
         AND ${sqlCountryExpr('s')} = ?
       GROUP BY ve.path, COALESCE(ve.target_url, CONCAT('[', COALESCE(ve.element,'element'), '] ', COALESCE(ve.element_text,'')))
       ORDER BY clicks DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, country, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /admin/analytics/page-drilldown.json?path=/cars
router.get('/page-drilldown.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from), toSqlStr = toSql(to);
    const limit = clamp(req.query.limit || 20, { min: 1, max: 200 });
    const path = String(req.query.path || '').trim();
    if (!path) {
      return res.json({
        path: '',
        summary: { views: 0, sessions: 0, avg_time_s: 0, exits: 0, exit_rate: 0 },
        countries: [],
        clicks: [],
        referrers: []
      });
    }

    const [[summary]] = await db.query(
      `
      SELECT
        COUNT(*) AS views,
        COUNT(DISTINCT pv.session_id) AS sessions,
        ROUND(AVG(pv.duration_ms)/1000, 1) AS avg_time_s,
        SUM(CASE WHEN pv.is_exit = 1 THEN 1 ELSE 0 END) AS exits
      FROM visit_pageviews pv
      WHERE pv.path = ?
        AND pv.started_at BETWEEN ? AND ?
      `,
      [path, fromSql, toSqlStr]
    );

    const [countries] = await db.query(
      `
      SELECT ${sqlCountryExpr('s')} AS country,
             COUNT(*) AS views,
             COUNT(DISTINCT pv.session_id) AS sessions,
             ROUND(AVG(pv.duration_ms)/1000, 1) AS avg_time_s
        FROM visit_pageviews pv
        JOIN visit_sessions s ON s.id = pv.session_id
       WHERE pv.path = ?
         AND pv.started_at BETWEEN ? AND ?
       GROUP BY ${sqlCountryExpr('s')}
       ORDER BY views DESC
       LIMIT ?
      `,
      [path, fromSql, toSqlStr, limit]
    );

    const [clicks] = await db.query(
      `
      SELECT COALESCE(target_url, CONCAT('[', COALESCE(element,'element'), '] ', COALESCE(element_text,''))) AS target,
             COUNT(*) AS clicks
        FROM visit_events
       WHERE event_type = 'click'
         AND path = ?
         AND created_at BETWEEN ? AND ?
       GROUP BY COALESCE(target_url, CONCAT('[', COALESCE(element,'element'), '] ', COALESCE(element_text,'')))
       ORDER BY clicks DESC
       LIMIT ?
      `,
      [path, fromSql, toSqlStr, limit]
    );

    const [referrers] = await db.query(
      `
      SELECT referer, COUNT(*) AS hits
        FROM visit_pageviews
       WHERE path = ?
         AND started_at BETWEEN ? AND ?
         AND referer IS NOT NULL AND referer <> ''
       GROUP BY referer
       ORDER BY hits DESC
       LIMIT ?
      `,
      [path, fromSql, toSqlStr, limit]
    );

    const views = Number(summary?.views || 0);
    const exits = Number(summary?.exits || 0);

    res.json({
      path,
      summary: {
        views,
        sessions: Number(summary?.sessions || 0),
        avg_time_s: Number(summary?.avg_time_s || 0),
        exits,
        exit_rate: views > 0 ? Math.round((exits / views) * 1000) / 10 : 0
      },
      countries: countries.map(r => ({
        country: normCountry(r.country),
        views: Number(r.views || 0),
        sessions: Number(r.sessions || 0),
        avg_time_s: Number(r.avg_time_s || 0)
      })),
      clicks: clicks.map(r => ({ target: r.target || '–', clicks: Number(r.clicks || 0) })),
      referrers: referrers.map(r => ({ referer: r.referer || '–', hits: Number(r.hits || 0) }))
    });
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

'use strict';

const express = require('express');
const db = require('../../db');

const router = express.Router();
const ERROR_REPORT_OWNER_EMAIL = 'peter.gerguis@gmail.com';
const runnerState = {
  running: false,
  startedAt: null,
  stoppedAt: null,
  config: null,
  totalSessions: 0,
  startedSessions: 0,
  finishedSessions: 0,
  failedRequests: 0,
  activeWorkers: 0,
  totalRequests: 0,
  logs: [],
  errors: [],
  stopRequested: false
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addRunnerLog(message) {
  const entry = `[${new Date().toISOString()}] ${message}`;
  runnerState.logs.push(entry);
  if (runnerState.logs.length > 250) runnerState.logs.shift();
  console.log(`[bot-runner] ${message}`);
}

function classifyStatusReason(statusCode, statusText = '') {
  const code = Number(statusCode || 0);
  if (code === 403) return 'Forbidden (Zugriff verweigert)';
  if (code === 404) return 'Not Found (Seite nicht gefunden)';
  if (code === 408) return 'Request Timeout (Zeitüberschreitung)';
  if (code === 429) return 'Too Many Requests (Rate-Limit)';
  if (code >= 500) return 'Serverfehler';
  if (code >= 400) return 'Clientfehler';
  if (code >= 300 && code !== 301) return 'Redirect anders als 301';
  if (code === 0) return 'Keine HTTP-Antwort';
  return statusText || 'Unbekannter Grund';
}

function addRunnerError(payload) {
  const entry = { at: new Date().toISOString(), ...payload };
  runnerState.errors.push(entry);
  if (runnerState.errors.length > 500) runnerState.errors.shift();
  addRunnerLog(`ERROR S${payload.sessionId} ${payload.url} -> ${payload.statusCode || 'no-status'} (${payload.reason})`);
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
  const now = new Date();
  const defFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  let from = q.from ? new Date(q.from) : defFrom;
  let to = q.to ? new Date(q.to) : now;
  if (Number.isNaN(from.getTime())) from = defFrom;
  if (Number.isNaN(to.getTime())) to = now;
  if (to < from) to = new Date(from);
  return { from: startOfDay(from), to: endOfDay(to) };
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch (_) {
    return '';
  }
}

function parseOrigins(input) {
  return String(input || '')
    .split('\n')
    .map((line) => normalizeOrigin(line))
    .filter(Boolean)
    .slice(0, 20);
}

function sanitizeRunnerInput(body) {
  const sessions = clampInt(body?.sessions, 1, 2000, 50);
  const parallel = clampInt(body?.parallel, 1, 60, 10);
  const minSeconds = clampInt(body?.minSeconds, 1, 180, 20);
  const originsFromList = parseOrigins(body?.targetOrigins || '');
  const fallbackOrigin = normalizeOrigin(body?.targetOrigin);
  const targetOrigins = originsFromList.length
    ? originsFromList
    : (fallbackOrigin ? [fallbackOrigin] : []);
  const paths = String(body?.paths || '')
    .split('\n')
    .map(normalizePath)
    .filter(Boolean)
    .slice(0, 300);
  return { sessions, parallel, minSeconds, targetOrigins, paths };
}

async function isErrorReportOwner(req) {
  const userId = Number(req.session?.userId || 0);
  if (!userId) return false;
  try {
    const [[user]] = await db.query('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
    return String(user?.email || '').trim().toLowerCase() === ERROR_REPORT_OWNER_EMAIL;
  } catch (_) {
    return false;
  }
}

function getRunnerStatus() {
  return {
    running: runnerState.running,
    startedAt: runnerState.startedAt,
    stoppedAt: runnerState.stoppedAt,
    config: runnerState.config,
    totalSessions: runnerState.totalSessions,
    startedSessions: runnerState.startedSessions,
    finishedSessions: runnerState.finishedSessions,
    failedRequests: runnerState.failedRequests,
    activeWorkers: runnerState.activeWorkers,
    totalRequests: runnerState.totalRequests,
    errorCount: runnerState.errors.length,
    stopRequested: runnerState.stopRequested,
    logs: [...runnerState.logs]
  };
}

async function runSingleServerSession(sessionId, config) {
  const { targetOrigins, paths, minSeconds } = config;
  const startPath = '/';
  const remainingPaths = paths
    .filter((p) => p && p !== startPath)
    .sort(() => Math.random() - 0.5);
  const visitCount = Math.min(
    remainingPaths.length + 1,
    Math.max(3, Math.floor(Math.random() * remainingPaths.length) + 2)
  );
  const visitPlan = [startPath, ...remainingPaths].slice(0, visitCount);
  const sessionOrigin = targetOrigins[Math.floor(Math.random() * targetOrigins.length)];
  for (let i = 0; i < visitPlan.length; i += 1) {
    if (runnerState.stopRequested) break;
    const path = visitPlan[i];
    const perStepOrigin = targetOrigins[Math.floor(Math.random() * targetOrigins.length)] || sessionOrigin;
    const pageUrl = `${perStepOrigin}${path}${path.includes('?') ? '&' : '?'}bot_sim=1&server_runner=1&session=${sessionId}&step=${i + 1}`;
    const started = Date.now();
    try {
      const response = await fetch(pageUrl, {
        method: 'GET',
        headers: {
          'User-Agent': `HerandoLoadRunner/1.0 (session:${sessionId})`,
          'X-Load-Test': '1',
          'X-Sim-Session': String(sessionId)
        }
      });
      runnerState.totalRequests += 1;
      addRunnerLog(`S${sessionId} GET ${perStepOrigin}${path} -> ${response.status}`);
      if (![200, 301].includes(Number(response.status || 0))) {
        runnerState.failedRequests += 1;
        addRunnerError({
          sessionId,
          url: `${perStepOrigin}${path}`,
          statusCode: Number(response.status || 0),
          statusText: String(response.statusText || ''),
          reason: classifyStatusReason(response.status, response.statusText),
          method: 'GET'
        });
      }
    } catch (err) {
      runnerState.failedRequests += 1;
      addRunnerLog(`S${sessionId} GET ${perStepOrigin}${path} failed: ${err?.message || err}`);
      addRunnerError({
        sessionId,
        url: `${perStepOrigin}${path}`,
        statusCode: 0,
        statusText: '',
        reason: String(err?.message || err || 'Fetch error'),
        method: 'GET'
      });
    }
    const elapsed = Date.now() - started;
    const holdMs = Math.max(0, (minSeconds * 1000) - elapsed);
    if (holdMs > 0) await sleep(holdMs);
  }
}

async function runRunnerInBackground(config) {
  runnerState.running = true;
  runnerState.stopRequested = false;
  runnerState.startedAt = new Date().toISOString();
  runnerState.stoppedAt = null;
  runnerState.config = config;
  runnerState.totalSessions = config.sessions;
  runnerState.startedSessions = 0;
  runnerState.finishedSessions = 0;
  runnerState.failedRequests = 0;
  runnerState.activeWorkers = 0;
  runnerState.totalRequests = 0;
  runnerState.logs = [];
  runnerState.errors = [];

  const workers = [];
  let nextSessionId = 1;
  const workerCount = Math.min(config.parallel, config.sessions);
  addRunnerLog(`runner start sessions=${config.sessions} parallel=${workerCount} minSeconds=${config.minSeconds} origins=${config.targetOrigins.join(',')}`);

  for (let workerIdx = 0; workerIdx < workerCount; workerIdx += 1) {
    workers.push((async () => {
      runnerState.activeWorkers += 1;
      try {
        while (!runnerState.stopRequested && nextSessionId <= config.sessions) {
          const sessionId = nextSessionId;
          nextSessionId += 1;
          runnerState.startedSessions += 1;
          addRunnerLog(`W${workerIdx + 1} start session ${sessionId}`);
          await runSingleServerSession(sessionId, config);
          runnerState.finishedSessions += 1;
          addRunnerLog(`W${workerIdx + 1} finish session ${sessionId}`);
          await sleep(250 + Math.floor(Math.random() * 750));
        }
      } finally {
        runnerState.activeWorkers -= 1;
      }
    })());
  }

  await Promise.allSettled(workers);
  runnerState.running = false;
  runnerState.stoppedAt = new Date().toISOString();
  addRunnerLog(`runner stop requested=${runnerState.stopRequested} done=${runnerState.finishedSessions}/${runnerState.totalSessions}`);
}

router.get('/', async (req, res) => {
  const { from, to } = parseRange(req.query);
  const canViewErrorReports = await isErrorReportOwner(req);
  return res.render('admin/admin-bot-simulator', {
    headerTitle: 'Bot Simulator',
    currentUrl: req.originalUrl,
    active: 'bot-simulator',
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    canViewErrorReports
  });
});

router.get('/runner/live', async (req, res) => {
  const canViewErrorReports = await isErrorReportOwner(req);
  return res.render('admin/admin-bot-simulator-live', {
    headerTitle: 'Bot Runner Live',
    currentUrl: req.originalUrl,
    active: 'bot-simulator',
    canViewErrorReports
  });
});

router.get('/runner/errors-popup', async (req, res) => {
  const canViewErrorReports = await isErrorReportOwner(req);
  if (!canViewErrorReports) return res.status(403).send('Forbidden');
  return res.render('admin/admin-bot-simulator-errors', {
    headerTitle: 'Bot Runner Errors',
    currentUrl: req.originalUrl,
    active: 'bot-simulator'
  });
});

router.get('/stats.json', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const fromSql = toSql(from);
    const toSqlStr = toSql(to);
    const period = String(req.query.period || 'day').toLowerCase();
    const bucketLimit = clampInt(req.query.limit, 1, 400, 120);

    let bucketExpr = 'DATE(started_at)';
    if (period === 'week') {
      bucketExpr = `CONCAT(YEAR(started_at), '-W', LPAD(WEEK(started_at, 1), 2, '0'))`;
    } else if (period === 'month') {
      bucketExpr = `DATE_FORMAT(started_at, '%Y-%m')`;
    }

    const [rows] = await db.query(
      `
      SELECT ${bucketExpr} AS bucket,
             COUNT(*) AS pageviews,
             COUNT(DISTINCT session_id) AS visitors
        FROM visit_pageviews
       WHERE started_at BETWEEN ? AND ?
       GROUP BY bucket
       ORDER BY bucket DESC
       LIMIT ?
      `,
      [fromSql, toSqlStr, bucketLimit]
    );

    const normalized = (rows || []).map((r) => ({
      bucket: String(r.bucket || ''),
      pageviews: Number(r.pageviews || 0),
      visitors: Number(r.visitors || 0)
    }));
    const totalVisitors = normalized.reduce((sum, r) => sum + r.visitors, 0);
    const totalPageviews = normalized.reduce((sum, r) => sum + r.pageviews, 0);
    const bucketCount = normalized.length || 1;

    res.json({
      range: { from: fromSql, to: toSqlStr },
      period,
      bucketCount: normalized.length,
      totals: {
        visitors: totalVisitors,
        pageviews: totalPageviews,
        avgVisitorsPerBucket: Math.round((totalVisitors / bucketCount) * 100) / 100,
        avgPageviewsPerBucket: Math.round((totalPageviews / bucketCount) * 100) / 100
      },
      rows: normalized
    });
  } catch (err) {
    next(err);
  }
});

router.get('/runner/status.json', async (req, res) => {
  res.json(getRunnerStatus());
});

router.get('/runner/errors.json', async (req, res) => {
  const canViewErrorReports = await isErrorReportOwner(req);
  if (!canViewErrorReports) return res.status(403).json({ ok: false, message: 'Forbidden' });
  return res.json({
    ok: true,
    count: runnerState.errors.length,
    errors: [...runnerState.errors].reverse()
  });
});

router.post('/runner/start', async (req, res) => {
  const config = sanitizeRunnerInput(req.body || {});
  if (!config.targetOrigins.length) {
    return res.status(400).json({ ok: false, message: 'Mindestens eine gueltige Ziel-Domain erforderlich.' });
  }
  if (!config.paths.length) {
    return res.status(400).json({ ok: false, message: 'Mindestens ein Pfad erforderlich.' });
  }
  if (runnerState.running) {
    return res.status(409).json({ ok: false, message: 'Runner laeuft bereits.', status: getRunnerStatus() });
  }

  runRunnerInBackground(config).catch((err) => {
    runnerState.running = false;
    runnerState.stoppedAt = new Date().toISOString();
    addRunnerLog(`runner crashed: ${err?.message || err}`);
  });

  return res.json({ ok: true, message: 'Runner gestartet.', status: getRunnerStatus() });
});

router.post('/runner/stop', async (req, res) => {
  if (!runnerState.running) {
    return res.json({ ok: true, message: 'Runner ist bereits gestoppt.', status: getRunnerStatus() });
  }
  runnerState.stopRequested = true;
  addRunnerLog('stop requested by admin');
  return res.json({ ok: true, message: 'Stop wurde angefordert.', status: getRunnerStatus() });
});

module.exports = router;

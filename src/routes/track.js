// src/routes/track.js
'use strict';

const express = require('express');
const db = require('../db');                    // ggf. Pfad prüfen
const { v4: uuidv4 } = require('uuid');
const UAParser = require('ua-parser-js');
const geoip = require('geoip-lite');

const router = express.Router();

/* ------------------------ Helpers ------------------------ */

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || '';
}

function parseLang(req) {
  const h = req.headers['accept-language'] || '';
  return h.split(',')[0].trim() || null;
}

function normalizeDevice(ua) {
  // ua = UAParser(userAgentString)
  const devType = ua.device?.type || 'desktop';
  const map = { mobile: 'mobile', tablet: 'tablet', console: 'unknown', smarttv: 'unknown', wearable: 'unknown', embedded: 'unknown' };
  let type = map[devType] || (devType ? devType : 'desktop');

  // primitive Bot-Erkennung
  const browserName = (ua.browser?.name || '').toLowerCase();
  const deviceVendor = (ua.device?.vendor || '').toLowerCase();
  if (browserName.includes('bot') || deviceVendor.includes('bot')) type = 'bot';

  if (!['desktop','mobile','tablet','bot','unknown'].includes(type)) type = 'unknown';

  return {
    device_type: type,
    os: ua.os?.name || null,
    browser: ua.browser?.name || null
  };
}

// Zählt, ob es die erste Pageview in der Session ist (Entry Flag)
async function isFirstPageview(sessionId) {
  const [[r]] = await db.query(`SELECT COUNT(*) AS c FROM visit_pageviews WHERE session_id = ?`, [sessionId]);
  return (r?.c || 0) === 0;
}

/* ------------------------ Session Handling ------------------------ */

async function ensureSession(req, res) {
  // 1) Cookie lesen/setzen
  let token = req.cookies?.hr_sid;
  if (!token) {
    token = uuidv4();
    // 1 Jahr, httpOnly, SameSite Lax
    res.cookie('hr_sid', token, { httpOnly: true, sameSite: 'Lax', maxAge: 31536000000 });
  }

  // 2) UA/Geo/Lang bestimmen
  const ua = UAParser(req.headers['user-agent'] || '');
  const { device_type, os, browser } = normalizeDevice(ua);
  const ipRaw = clientIp(req);
  const lang = parseLang(req);
  const geo = geoip.lookup(ipRaw); // {country, region, city, ll:[lat,lon]} | null

  // 3) Session finden
  const [[row]] = await db.query(`SELECT id FROM visit_sessions WHERE session_token = ?`, [token]);
  const userId = req.session?.userId || null;

  if (row) {
    // sanft aktualisieren (nur wenn noch NULL)
    await db.query(
      `UPDATE visit_sessions
          SET last_seen   = NOW(),
              user_id     = COALESCE(user_id, ?),
              device_type = COALESCE(device_type, ?),
              os          = COALESCE(os, ?),
              browser     = COALESCE(browser, ?),
              language    = COALESCE(language, ?),
              country_code= COALESCE(country_code, ?),
              region      = COALESCE(region, ?),
              city        = COALESCE(city, ?),
              lat         = COALESCE(lat, ?),
              lon         = COALESCE(lon, ?)
        WHERE id = ?`,
      [
        userId,
        device_type, os, browser, lang,
        geo?.country || null,
        geo?.region  || null,
        geo?.city    || null,
        geo?.ll?.[0] ?? null,
        geo?.ll?.[1] ?? null,
        row.id
      ]
    );
    return row.id;
  }

  // 4) Neu anlegen (UTM nur beim ersten Hit aus Body übernehmen)
  const utm = req.body?.utm || {};
  const [ins] = await db.query(
    `INSERT INTO visit_sessions
       (session_token, user_id, user_agent, ip,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        device_type, os, browser, language, country_code, region, city, lat, lon,
        first_seen, last_seen)
     VALUES (?, ?, ?, INET6_ATON(?),
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?,
             NOW(), NOW())`,
    [
      token,
      userId,
      req.headers['user-agent'] || null,
      ipRaw,
      utm.utm_source || null,
      utm.utm_medium || null,
      utm.utm_campaign || null,
      utm.utm_term || null,
      utm.utm_content || null,
      device_type, os, browser, lang,
      geo?.country || null,
      geo?.region  || null,
      geo?.city    || null,
      geo?.ll?.[0] ?? null,
      geo?.ll?.[1] ?? null
    ]
  );
  return ins.insertId;
}

/* ------------------------ Track Endpoint ------------------------ */

async function handleTrack(req, res) {
  const { kind } = req.body || {};
  if (!kind) return res.sendStatus(204);

  const allowed = new Set(['pageview','pageleave','perf','click','search','custom']);
  if (!allowed.has(kind)) return res.sendStatus(204);

  const sessionId = await ensureSession(req, res);
  const userId = req.session?.userId || null;

  // PAGEVIEW
  if (kind === 'pageview') {
    const { pv_id, path, referer } = req.body;
    if (!pv_id || !path) return res.sendStatus(400);

    const first = await isFirstPageview(sessionId);

    // Wenn eine neue Pageview kommt, war eine zuvor gesetzte Exit-Markierung in der
    // Session nicht die tatsächliche letzte Seite.
    await db.query(
      `UPDATE visit_pageviews
          SET is_exit = 0
        WHERE session_id = ?
          AND is_exit = 1`,
      [sessionId]
    );

    await db.query(
      `INSERT INTO visit_pageviews
         (pv_id, session_id, user_id, path, referer, is_entry, started_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         user_id = COALESCE(visit_pageviews.user_id, VALUES(user_id)),
         referer = COALESCE(visit_pageviews.referer, VALUES(referer))`,
      [pv_id, sessionId, userId, path, referer || null, first ? 1 : 0]
    );
    return res.sendStatus(204);
  }

  // PAGELEAVE
  if (kind === 'pageleave') {
    const { pv_id, duration_ms } = req.body;
    if (!pv_id) return res.sendStatus(204);
    const dur = Math.max(0, parseInt(duration_ms || 0, 10));
    await db.query(
      `UPDATE visit_pageviews
          SET ended_at = NOW(),
              duration_ms = CASE
                WHEN duration_ms IS NULL OR duration_ms < ? THEN ?
                ELSE duration_ms
              END,
              is_exit = 1
        WHERE pv_id = ?`,
      [dur, dur, pv_id]
    );
    return res.sendStatus(204);
  }

  // PERFORMANCE (Web Vitals light)
  if (kind === 'perf') {
    const { pv_id, ttfb_ms, fcp_ms, lcp_ms, fid_ms, cls } = req.body;
    if (!pv_id) return res.sendStatus(204);
    await db.query(
      `UPDATE visit_pageviews
          SET ttfb_ms = ?, fcp_ms = ?, lcp_ms = ?, fid_ms = ?, cls = ?
        WHERE pv_id = ?`,
      [
        ttfb_ms != null ? parseInt(ttfb_ms, 10) : null,
        fcp_ms  != null ? parseInt(fcp_ms, 10)  : null,
        lcp_ms  != null ? parseInt(lcp_ms, 10)  : null,
        fid_ms  != null ? parseInt(fid_ms, 10)  : null,
        cls     != null ? parseFloat(cls)       : null,
        pv_id
      ]
    );
    return res.sendStatus(204);
  }

  // EVENTS: click / search / custom
  if (kind === 'click' || kind === 'search' || kind === 'custom') {
    const {
      pv_id, path, target_url, element, element_id, element_text,
      meta, element_x, element_y, viewport_w, viewport_h
    } = req.body;
    if (!path) return res.sendStatus(400);

    await db.query(
      `INSERT INTO visit_events
         (session_id, user_id, pv_id, event_type, path, target_url,
          element, element_id, element_text, referer,
          element_x, element_y, viewport_w, viewport_h,
          meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId, userId, pv_id || null, kind, path, target_url || null,
        element || null, element_id || null, element_text || null, req.get('referer') || null,
        element_x != null ? parseInt(element_x, 10) : null,
        element_y != null ? parseInt(element_y, 10) : null,
        viewport_w != null ? parseInt(viewport_w, 10) : null,
        viewport_h != null ? parseInt(viewport_h, 10) : null,
        meta ? JSON.stringify(meta) : null
      ]
    );
    return res.sendStatus(204);
  }

  return res.sendStatus(204);
}

/**
 * POST /track (auch kompatibel unter /analytics/track)
 * Body:
 *  - kind: 'pageview' | 'pageleave' | 'perf' | 'click' | 'search' | 'custom'
 *
 *  pageview: { pv_id, path, referer?, utm? }
 *  pageleave:{ pv_id, duration_ms }
 *  perf:     { pv_id, ttfb_ms?, fcp_ms?, lcp_ms?, fid_ms?, cls? }
 *  click:    { pv_id?, path, target_url?, element?, element_id?, element_text?, element_x?, element_y?, viewport_w?, viewport_h?, meta? }
 *  search:   { pv_id?, path, element_text: query, meta? }
 *  custom:   { pv_id?, path, meta: {} }
 */
async function trackHandler(req, res, next) {
  try {
    return await handleTrack(req, res);
  } catch (err) {
    // Keine internen Fehler nach außen – aber sinnvoll loggen
    console.error('Analytics track error:', err);
    return res.sendStatus(204);
  }
}

router.post('/track', trackHandler);
router.post('/analytics/track', trackHandler);

/* ------------------------ Optional: leichte Debug-Route ------------------------ */
// GET /ping oder /analytics/ping  → 200 (zum schnellen Health-Check)
router.get('/ping', (req, res) => res.json({ ok: true }));
router.get('/analytics/ping', (req, res) => res.json({ ok: true }));

module.exports = router;

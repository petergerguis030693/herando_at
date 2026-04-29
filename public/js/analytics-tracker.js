(function () {
  'use strict';

  try {
    var cfgEl = document.getElementById('herando-track-cfg');
    if (cfgEl && cfgEl.textContent) {
      var c = JSON.parse(cfgEl.textContent);
      if (typeof c.force === 'boolean') window.__herandoForceTracking = c.force;
      if (Object.prototype.hasOwnProperty.call(c, 'role')) {
        window.__herandoActorRole = c.role;
      }
    }
  } catch (e) {}

  if (window.__herandoAnalyticsTrackerInit) return;
  window.__herandoAnalyticsTrackerInit = true;

  if (!window.fetch || !window.JSON) return;
  var forceTracking = !!window.__herandoForceTracking;
  if (location.pathname.startsWith('/admin') && !forceTracking) return;

  var CONSENT_KEY = 'cookie.consent';
  var endpoint = '/track';
  var enabled = false;
  var started = false;
  var pageStartEpoch = Date.now();
  var pvId = null;
  var perfMetrics = { ttfb_ms: null, fcp_ms: null, lcp_ms: null, fid_ms: null, cls: null };
  var perfSentOnce = false;
  var lastLeaveDuration = -1;
  var lastLeaveTs = 0;

  function hasStatsConsent() {
    try {
      var raw = localStorage.getItem(CONSENT_KEY);
      if (!raw) return false;
      var c = JSON.parse(raw);
      if (!c || c.stats !== true) return false;
      if (c.expiresAt && Date.now() >= Number(c.expiresAt)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = Math.random() * 16 | 0;
      var v = ch === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function currentPath() {
    return location.pathname + location.search;
  }

  function readUtm() {
    try {
      var params = new URLSearchParams(location.search);
      var utm = {};
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) {
        var v = params.get(k);
        if (v) utm[k] = v;
      });
      return Object.keys(utm).length ? utm : null;
    } catch (_) {
      return null;
    }
  }

  function post(payload, opts) {
    if (!enabled) return;
    opts = opts || {};
    var body = JSON.stringify(payload);

    if (opts.beacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(endpoint, blob)) return;
      } catch (_) {}
    }

    try {
      fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: !!opts.keepalive
      }).catch(function () {});
    } catch (_) {}
  }

  function track(kind, payload, opts) {
    if (!enabled) return;
    var base = payload || {};
    base.kind = kind;
    post(base, opts);
  }

  function safeText(str, maxLen) {
    if (!str) return '';
    var s = String(str).replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > maxLen ? s.slice(0, maxLen) : s;
  }

  function elementClasses(el) {
    try {
      if (!el || !el.classList) return '';
      return Array.from(el.classList).slice(0, 10).join(' ');
    } catch (_) {
      return '';
    }
  }

  function sendPageview() {
    pvId = uuid();
    pageStartEpoch = Date.now();
    lastLeaveDuration = -1;
    track('pageview', {
      pv_id: pvId,
      path: currentPath(),
      referer: document.referrer || null,
      utm: readUtm()
    });
    window.__herandoPvId = pvId;
  }

  function sendPageleave(reason) {
    if (!enabled || !pvId) return;
    var duration = Math.max(0, Date.now() - pageStartEpoch);
    var now = Date.now();
    if (duration === lastLeaveDuration && (now - lastLeaveTs) < 500) return;
    lastLeaveDuration = duration;
    lastLeaveTs = now;

    track('pageleave', {
      pv_id: pvId,
      duration_ms: duration,
      meta: { reason: reason || 'unknown' }
    }, { beacon: true, keepalive: true });
  }

  function schedulePerfSend(delayMs) {
    if (!enabled || !pvId) return;
    window.setTimeout(function () {
      if (!enabled || !pvId) return;
      if (
        perfMetrics.ttfb_ms == null &&
        perfMetrics.fcp_ms == null &&
        perfMetrics.lcp_ms == null &&
        perfMetrics.fid_ms == null &&
        perfMetrics.cls == null
      ) return;

      track('perf', {
        pv_id: pvId,
        ttfb_ms: perfMetrics.ttfb_ms,
        fcp_ms: perfMetrics.fcp_ms,
        lcp_ms: perfMetrics.lcp_ms,
        fid_ms: perfMetrics.fid_ms,
        cls: perfMetrics.cls
      }, { keepalive: true });
      perfSentOnce = true;
    }, delayMs);
  }

  function collectPerf() {
    try {
      var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (nav && typeof nav.responseStart === 'number') {
        perfMetrics.ttfb_ms = Math.max(0, Math.round(nav.responseStart));
      }
    } catch (_) {}

    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (entry.name === 'first-contentful-paint') {
            perfMetrics.fcp_ms = Math.round(entry.startTime);
          }
        });
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}

    try {
      new PerformanceObserver(function (list) {
        var entries = list.getEntries();
        if (entries.length) {
          var last = entries[entries.length - 1];
          perfMetrics.lcp_ms = Math.round(last.startTime || 0);
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}

    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (!entry.hadRecentInput) {
            var next = Number(perfMetrics.cls || 0) + Number(entry.value || 0);
            perfMetrics.cls = Math.round(next * 1000) / 1000;
          }
        });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (_) {}

    try {
      new PerformanceObserver(function (list) {
        var first = list.getEntries()[0];
        if (first && typeof first.processingStart === 'number' && typeof first.startTime === 'number') {
          perfMetrics.fid_ms = Math.max(0, Math.round(first.processingStart - first.startTime));
        }
      }).observe({ type: 'first-input', buffered: true });
    } catch (_) {}

    if (document.readyState === 'complete') {
      schedulePerfSend(1200);
    } else {
      window.addEventListener('load', function () { schedulePerfSend(1200); }, { once: true });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        if (!perfSentOnce) schedulePerfSend(0);
      }
    });
  }

  function findTrackableElement(target) {
    if (!target || !target.closest) return null;
    return target.closest('a, button, [role=\"button\"], input[type=\"submit\"], input[type=\"button\"], .btn');
  }

  function handleClick(ev) {
    if (!enabled) return;
    var el = findTrackableElement(ev.target);
    if (!el) return;

    var tag = (el.tagName || '').toLowerCase();
    var text = safeText(
      el.getAttribute('aria-label') ||
      el.textContent ||
      el.value ||
      el.title,
      240
    );
    var href = null;
    if (tag === 'a') {
      href = el.getAttribute('href') || null;
      if (href && href.length > 500) href = href.slice(0, 500);
    }
    var form = el.closest ? el.closest('form') : null;
    var formAction = form ? (form.getAttribute('action') || null) : null;
    var formMethod = form ? (form.getAttribute('method') || 'GET') : null;
    var formId = form ? (form.id || null) : null;
    var elementType = el.getAttribute('type') || null;
    var elementName = el.getAttribute('name') || null;
    var dataAction = el.getAttribute('data-action') || el.getAttribute('data-bs-toggle') || null;
    var classes = elementClasses(el);
    if (!text) {
      text = safeText(el.placeholder || elementName || classes || (el.id ? ('#' + el.id) : ''), 240);
    }

    track('click', {
      pv_id: pvId,
      path: currentPath(),
      target_url: href,
      element: tag || null,
      element_id: el.id || null,
      element_text: text || null,
      element_x: typeof ev.clientX === 'number' ? ev.clientX : null,
      element_y: typeof ev.clientY === 'number' ? ev.clientY : null,
      viewport_w: window.innerWidth || null,
      viewport_h: window.innerHeight || null,
      meta: {
        classes: classes || null,
        element_type: elementType || null,
        element_name: elementName || null,
        data_action: dataAction || null,
        form_id: formId || null,
        form_action: formAction ? safeText(formAction, 255) : null,
        form_method: formMethod ? String(formMethod).toUpperCase() : null
      }
    }, { keepalive: true });
  }

  function findSearchQuery(form) {
    if (!form || !form.querySelectorAll) return '';
    var selectors = [
      'input[type=\"search\"]',
      'input[name=\"q\"]',
      'input[name=\"query\"]',
      'input[name=\"search\"]',
      'input[name*=\"search\"]',
      'input[type=\"text\"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var input = form.querySelector(selectors[i]);
      if (!input) continue;
      var val = safeText(input.value, 240);
      if (val) return val;
    }
    return '';
  }

  function handleSubmit(ev) {
    if (!enabled) return;
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;

    var query = findSearchQuery(form);
    if (!query) return;

    var action = form.getAttribute('action') || '';
    var looksLikeSearch = /search|suche/i.test(action) ||
      !!form.querySelector('input[type=\"search\"], input[name=\"q\"], input[name=\"query\"], input[name=\"search\"]');
    if (!looksLikeSearch) return;

    track('search', {
      pv_id: pvId,
      path: currentPath(),
      element: 'form',
      element_id: form.id || null,
      element_text: query,
      meta: { action: safeText(action, 255) || null }
    }, { keepalive: true });
  }

  function handleConsentChange(ev) {
    var next = !!(ev && ev.detail && ev.detail.stats);
    enabled = forceTracking || (next && hasStatsConsent());
    if (enabled && !started) {
      startTracking();
    }
  }

  function bindLifecycle() {
    document.addEventListener('click', handleClick, true);
    document.addEventListener('submit', handleSubmit, true);

    window.addEventListener('pagehide', function () {
      sendPageleave('pagehide');
    });

    window.addEventListener('beforeunload', function () {
      sendPageleave('beforeunload');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        sendPageleave('hidden');
      }
    });
  }

  function startTracking() {
    if (started) return;
    started = true;
    enabled = forceTracking || hasStatsConsent();
    if (!enabled) return;
    sendPageview();
    bindLifecycle();
    collectPerf();
  }

  window.herandoAnalyticsTrack = function (kind, payload) {
    if (!enabled || !kind) return;
    var data = payload && typeof payload === 'object' ? payload : {};
    if (!data.path) data.path = currentPath();
    if (!data.pv_id) data.pv_id = pvId;
    track(kind, data, { keepalive: true });
  };

  window.addEventListener('herando:cookie-consent-changed', handleConsentChange);

  if (hasStatsConsent()) {
    startTracking();
  } else if (forceTracking) {
    startTracking();
  }
})();

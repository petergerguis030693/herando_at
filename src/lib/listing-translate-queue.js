/**
 * Globale FIFO-Warteschlange für Listing-KI-Übersetzungen (parallel mit Limit).
 * Zustand nur im RAM; bei mehreren PM2-Instanzen je Prozess eine eigene Queue.
 */

const LISTING_TRANSLATE_CONCURRENCY = (() => {
  const raw = Number.parseInt(String(process.env.LISTING_TRANSLATE_CONCURRENCY || '5'), 10);
  if (!Number.isFinite(raw)) return 5;
  return Math.max(1, Math.min(50, raw));
})();

const listingTranslateWaiting = [];
const listingTranslateRunning = [];
let isDraining = false;

function listingTranslateQueueLine() {
  const running = listingTranslateRunning.length
    ? listingTranslateRunning.map((j) => `id=${j.id} ${j.route || '—'} (${j.source})`).join(', ')
    : '—';
  const ids = listingTranslateWaiting.map((j) => j.id).join(', ') || '—';
  return `running=${listingTranslateRunning.length}/${LISTING_TRANSLATE_CONCURRENCY}: ${running} | backlog=${listingTranslateWaiting.length} | queued: ${ids}`;
}

/** Gleiche Kategorie + Inserat-ID = ein logisches Inserat (IDs können zwischen Tabellen kollidieren). */
function translateJobDedupeKey(job) {
  if (job == null || job.id == null) return null;
  const route = String(job.route || job.category || '—').toLowerCase();
  return `${route}:${Number(job.id)}`;
}

function isDuplicateTranslateJob(meta) {
  const key = translateJobDedupeKey({
    id: meta.id,
    route: meta.route || meta.category
  });
  if (!key) return false;
  if (listingTranslateRunning.some((j) => translateJobDedupeKey(j) === key)) return true;
  return listingTranslateWaiting.some((entry) => translateJobDedupeKey(entry.job) === key);
}

function removeRunningJob(job) {
  const idx = listingTranslateRunning.findIndex((j) => j === job);
  if (idx >= 0) listingTranslateRunning.splice(idx, 1);
}

function drainQueue() {
  if (isDraining) return;
  isDraining = true;

  const loop = () => {
    while (
      listingTranslateRunning.length < LISTING_TRANSLATE_CONCURRENCY
      && listingTranslateWaiting.length > 0
    ) {
      const entry = listingTranslateWaiting.shift();
      if (!entry) continue;

      const { job, fn, resolve, reject } = entry;
      listingTranslateRunning.push(job);
      console.log('[TRANSLATE][QUEUE] start', job, '|', listingTranslateQueueLine());

      Promise.resolve()
        .then(() => fn())
        .then(resolve, reject)
        .catch((err) => {
          console.error('[LISTING-TRANSLATE-QUEUE]', err?.message || err);
        })
        .finally(() => {
          console.log('[TRANSLATE][QUEUE] done', job, '|', listingTranslateQueueLine());
          removeRunningJob(job);
          loop();
        });
    }

    isDraining = false;
  };

  loop();
}

function enqueue(fn, meta = {}) {
  const job = {
    id: meta.id != null ? meta.id : null,
    route: meta.route || meta.category || '—',
    source: meta.source || 'unknown'
  };

  if (isDuplicateTranslateJob(meta)) {
    console.log(
      '[TRANSLATE][QUEUE] skip duplicate (bereits aktiv oder in Warteschlange)',
      { id: job.id, route: job.route, skippedSource: job.source }
    );
    return Promise.resolve();
  }

  const p = new Promise((resolve, reject) => {
    listingTranslateWaiting.push({ job, fn, resolve, reject });
  });
  console.log('[TRANSLATE][QUEUE] queued', job, '|', listingTranslateQueueLine());
  drainQueue();

  return p;
}

function getSnapshot() {
  return {
    current: listingTranslateRunning[0] || null,
    running: listingTranslateRunning.map((j) => ({ ...j })),
    waiting: listingTranslateWaiting.map((entry) => ({ ...entry.job })),
    backlog: listingTranslateWaiting.length,
    concurrency: LISTING_TRANSLATE_CONCURRENCY,
    line: listingTranslateQueueLine(),
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  enqueue,
  getSnapshot
};

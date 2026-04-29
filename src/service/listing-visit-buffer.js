'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../db');

const FLUSH_INTERVAL_MS = Number(process.env.VISIT_BUFFER_FLUSH_MS || 60 * 1000);
const VISIT_TRACKING_ENABLED = String(process.env.VISIT_TRACKING_ENABLED || 'false').trim().toLowerCase() === 'true';
const BUFFER_FILE = path.join(
  process.env.VISIT_BUFFER_DIR || path.join(process.cwd(), 'uploads', 'runtime'),
  'listing-visit-buffer.ndjson'
);

let flushTimer = null;
let isFlushing = false;
const inMemorySeen = new Set();

function escapeNdjsonValue(value) {
  return JSON.stringify(value).replace(/\n/g, '\\n');
}

async function appendBufferLine(payload) {
  const dir = path.dirname(BUFFER_FILE);
  await fs.promises.mkdir(dir, { recursive: true });
  const line = `${escapeNdjsonValue(payload)}\n`;
  await fs.promises.appendFile(BUFFER_FILE, line, 'utf8');
}

function normalizePayload(payload) {
  const listingId = Number(payload?.listingId);
  const advertId = Number(payload?.listingId);
  const entity = String(payload?.entityRoute || '').trim();
  const identityHash = String(payload?.identityHash || '').trim();
  const tableSql = String(payload?.tableSql || '').trim();
  const counterCol = payload?.counterCol ? String(payload.counterCol).trim() : '';
  const visited = String(payload?.visited || '').trim();

  if (!entity || !identityHash || !Number.isFinite(listingId) || listingId <= 0 || !tableSql) {
    return null;
  }

  const visitedDate = /^\d{4}-\d{2}-\d{2}$/.test(visited) ? visited : new Date().toISOString().slice(0, 10);

  return {
    entity,
    advertId,
    identityHash,
    tableSql,
    counterCol: counterCol || null,
    visitedDate
  };
}

async function enqueueListingVisit(payload) {
  if (!VISIT_TRACKING_ENABLED) return;
  const normalized = normalizePayload(payload);
  if (!normalized) return;
  await appendBufferLine(normalized);
}

async function readBatchFile(filePath) {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  if (!raw.trim()) return [];

  const deduped = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const normalized = normalizePayload(parsed);
      if (!normalized) continue;
      const key = `${normalized.entity}|${normalized.advertId}|${normalized.visitedDate}|${normalized.identityHash}`;
      if (inMemorySeen.has(key)) continue;
      inMemorySeen.add(key);
      deduped.set(key, normalized);
    } catch (_) {
      // Ignore malformed lines, keep flush resilient.
    }
  }
  return [...deduped.values()];
}

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

async function flushListingVisitBuffer() {
  if (!VISIT_TRACKING_ENABLED) return;

  if (isFlushing) return;
  isFlushing = true;

  const processingFile = `${BUFFER_FILE}.processing`;
  try {
    await fs.promises.mkdir(path.dirname(BUFFER_FILE), { recursive: true });
    try {
      await fs.promises.rename(BUFFER_FILE, processingFile);
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      throw err;
    }

    const events = await readBatchFile(processingFile);
    if (!events.length) return;

    const batchStamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const batchedRows = chunk(events, 500);

    for (const rows of batchedRows) {
      const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
      const params = [];
      for (const row of rows) {
        params.push(row.entity, row.advertId, row.visitedDate, row.identityHash, batchStamp);
      }
      await db.query(
        `INSERT IGNORE INTO listing_visit_uniques (entity, advert_id, visited, identity_hash, created_at)
         VALUES ${placeholders}`,
        params
      );
    }

    const [insertedGroups] = await db.query(
      `SELECT entity, advert_id, COUNT(*) AS c
         FROM listing_visit_uniques
        WHERE created_at = ?
        GROUP BY entity, advert_id`,
      [batchStamp]
    );

    if (!Array.isArray(insertedGroups) || !insertedGroups.length) return;

    const metaByEntityAdvert = new Map();
    for (const row of events) {
      const key = `${row.entity}|${row.advertId}`;
      if (!metaByEntityAdvert.has(key)) {
        metaByEntityAdvert.set(key, {
          tableSql: row.tableSql,
          counterCol: row.counterCol
        });
      }
    }

    for (const group of insertedGroups) {
      const count = Number(group.c) || 0;
      if (count <= 0) continue;

      await db.query(
        `INSERT INTO visits (entity, advert_id, visits, visits2, visited)
         VALUES (?, ?, ?, ?, CURDATE())
         ON DUPLICATE KEY UPDATE
           visits = visits + VALUES(visits),
           visits2 = visits2 + VALUES(visits2)`,
        [group.entity, Number(group.advert_id), count, count]
      );

      const metaKey = `${group.entity}|${Number(group.advert_id)}`;
      const meta = metaByEntityAdvert.get(metaKey);
      if (!meta?.counterCol || !meta?.tableSql) continue;

      const counterColSql = db.escapeId(meta.counterCol);
      await db.query(
        `UPDATE ${meta.tableSql}
            SET ${counterColSql} = COALESCE(${counterColSql}, 0) + ?
          WHERE id = ?`,
        [count, Number(group.advert_id)]
      );
    }
  } catch (err) {
    console.error('Visit buffer flush failed:', err?.message || err);
  } finally {
    try {
      await fs.promises.unlink(processingFile);
    } catch (_) {
      // noop
    }
    isFlushing = false;
  }
}

function startListingVisitBuffer() {
  if (!VISIT_TRACKING_ENABLED) {
    console.warn('[visits] VISIT_TRACKING_ENABLED=false -> visit buffer disabled');
    return;
  }
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushListingVisitBuffer().catch((err) => {
      console.error('Visit buffer interval flush failed:', err?.message || err);
    });
  }, FLUSH_INTERVAL_MS);
  if (flushTimer.unref) flushTimer.unref();
}

startListingVisitBuffer();

module.exports = {
  enqueueListingVisit,
  flushListingVisitBuffer,
  startListingVisitBuffer
};

const db = require('../db');

let ensureActivityLogTablePromise = null;

async function ensureActivityLogTable() {
  if (!ensureActivityLogTablePromise) {
    ensureActivityLogTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        actor_user_id INT NULL,
        actor_role INT NULL,
        actor_type ENUM('admin','customer') NOT NULL,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(1024) NOT NULL,
        status_code SMALLINT UNSIGNED NOT NULL,
        duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
        ip VARCHAR(64) NULL,
        user_agent VARCHAR(512) NULL,
        payload_json JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_activity_created (created_at),
        KEY idx_activity_actor (actor_type, actor_user_id, created_at),
        KEY idx_activity_method_path (method, path(255))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `).catch((err) => {
      ensureActivityLogTablePromise = null;
      throw err;
    });
  }
  return ensureActivityLogTablePromise;
}

function detectActorType(role) {
  const r = Number(role);
  if ([7, 8, 9].includes(r)) return 'admin';
  return 'customer';
}

function getClientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return xff || req.ip || null;
}

const SECRET_KEYS = new Set([
  'password',
  'passwordrepeat',
  'password_repeat',
  'newpassword',
  'new_password',
  'pass',
  'token',
  'stripe_session_id',
  'session_id',
  'creditcard',
  'cardnumber',
  'cvv',
  'iban',
  'api_key',
  'secret'
]);

function sanitizePayload(input) {
  const seen = new WeakSet();

  function clean(value, depth = 0) {
    if (value == null) return value;
    if (depth > 3) return '[max-depth]';

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((v) => clean(v, depth + 1));
    }

    if (typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
      const out = {};
      Object.keys(value).slice(0, 30).forEach((key) => {
        const lower = String(key || '').toLowerCase();
        if (SECRET_KEYS.has(lower)) {
          out[key] = '[redacted]';
        } else {
          out[key] = clean(value[key], depth + 1);
        }
      });
      return out;
    }

    if (typeof value === 'string') {
      return value.length > 500 ? `${value.slice(0, 500)}...[truncated]` : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return String(value);
  }

  try {
    return clean(input);
  } catch {
    return null;
  }
}

async function writeActivityLog({
  actorUserId,
  actorRole,
  actorType,
  method,
  path,
  statusCode,
  durationMs,
  ip,
  userAgent,
  payload
}) {
  await ensureActivityLogTable();

  await db.query(
    `
      INSERT INTO activity_log
        (actor_user_id, actor_role, actor_type, method, path, status_code, duration_ms, ip, user_agent, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      actorUserId || null,
      Number.isFinite(Number(actorRole)) ? Number(actorRole) : null,
      actorType || 'customer',
      String(method || '').toUpperCase().slice(0, 10) || 'GET',
      String(path || '').slice(0, 1024) || '/',
      Number(statusCode) || 0,
      Math.max(0, Number(durationMs) || 0),
      ip || null,
      userAgent ? String(userAgent).slice(0, 512) : null,
      payload ? JSON.stringify(payload) : null
    ]
  );
}

module.exports = {
  ensureActivityLogTable,
  detectActorType,
  getClientIp,
  sanitizePayload,
  writeActivityLog
};

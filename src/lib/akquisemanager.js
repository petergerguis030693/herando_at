const db = require('../db');
const { serialize } = require('php-serialize');

const ALLOWED_METHODS = new Set([
  'addCustomer',
  'updateCustomer',
  'addAdvert',
  'updateAdvert',
]);

function normalizeScalar(value) {
  if (value === undefined) return null;
  if (value === '' || value === 'undefined' || value === 'null') return null;
  return value;
}

function pickPayload(record, fields) {
  const payload = {};
  for (const field of fields) {
    payload[field] = normalizeScalar(record?.[field]);
  }
  return payload;
}

async function loadRowById({ table, idColumn = 'id', id, fields }) {
  if (!table || !fields?.length || !id) return null;
  const selectColumns = fields.map((f) => `\`${f}\``).join(', ');
  const [[row]] = await db.query(
    `SELECT ${selectColumns} FROM \`${table}\` WHERE \`${idColumn}\` = ? LIMIT 1`,
    [id]
  );
  return row || null;
}

function shouldEnqueueAdvert(state) {
  const status = Number(state?.status);
  const visible = Number(state?.visible);
  return !(status === 0 && visible === 0);
}

async function enqueueAkquise({
  method,
  objectId,
  payload,
}) {
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`Unsupported akquisemanager method: ${method}`);
  }
  const normalizedObjectId = Number(objectId);
  if (!Number.isInteger(normalizedObjectId) || normalizedObjectId <= 0) {
    throw new Error(`Invalid object_id for akquisemanager: ${objectId}`);
  }

  const serializedPayload = serialize(payload || {});
  await db.query(
    `INSERT INTO akquisemanager (method, object_id, data, status, created, synchronized)
     VALUES (?, ?, ?, 1, NOW(), NULL)`,
    [method, normalizedObjectId, serializedPayload]
  );
}

const CUSTOMER_FIELDS = [
  'id',
  'gender',
  'company',
  'vatid',
  'firstname',
  'lastname',
  'street',
  'housenumber',
  'postcode',
  'city',
  'country_id',
  'phone',
  'mobile',
  'fax',
  'email',
  'website',
];

const ADVERT_FIELDS = [
  'id',
  'entity',
  'country_id',
  'name',
  'price',
  'currency',
  'user_id',
];

module.exports = {
  CUSTOMER_FIELDS,
  ADVERT_FIELDS,
  enqueueAkquise,
  loadRowById,
  pickPayload,
  shouldEnqueueAdvert,
};

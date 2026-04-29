#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const mysql = require('mysql2/promise');
const OpenAI = require('openai');

const IDS_RAW = `
396610,396612,396621,400003,410377,410380,429493,432340,433211,433229,433230,433292,437309,437397,437398,437399,437400,437401,437402,437408,437409,437410,437411,437412,437450,437453,437454,437491,437492,437493,437497,437572,437618,437619,437621,437626,437627,437628,437629,437630,437633,437634,437635,437636,437637,437638,437639,437640,437641,437642,437643,437644,437645,437646,437647,437648,437656,437657,437658,437659,437660,437661,437662,437663,437664,437665,437666,437667,437668,437669,437671,437672,437673,437674,437675,437676,437677,437678,437680,437681,437684,437687,437688,437690,437691,437897,437989,438258,438282,438322,438398,438399,438400,438401,438402,438403,438404,438405,438406,438407,438514,438515,438598,438599,438600,438601,438602,438721,438722,438723,438753,438798,438959,438961,438962,438977,438980,438981,438982,439003,439064,439065,439078,439079,439080,439081,439082,439083,439084,439085,439086,439087,439088,439089,439090,439091,439092,439093,439094,439095,439096,439097,439098,439099
`;

const TARGET_LANGS = (process.env.TRANSLATION_TARGET_LANGS || 'de,en,fr,it,tr,ja,cs,ru,es,nl,pl')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-nano';
const IDS = Array.from(new Set(
  IDS_RAW.split(',')
    .map((s) => Number(String(s).trim().replace(/[^\d]/g, '')))
    .filter((n) => Number.isInteger(n) && n > 0)
));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translatePair(openai, sourceLang, targetLang, title, description) {
  const payload = { sourceLang, targetLang, title, description };
  const system = `Übersetze ein Inserat präzise.
- Keine Kürzungen, keine Umformulierungen mit Sinnänderung.
- Marken, Modelle, Referenzen, Zahlen, Sonderzeichen und Struktur beibehalten.
- Gib NUR JSON zurück: {"title":"...","description":"..."}.`;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const resp = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'translated_pair',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'description'],
              properties: {
                title: { type: 'string' },
                description: { type: 'string' }
              }
            }
          }
        }
      });
      const text = resp.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(text);
      return {
        title: String(parsed.title || ''),
        description: String(parsed.description || '')
      };
    } catch (err) {
      const wait = 400 + attempt * 700;
      console.warn(`[retranslate] ${targetLang} retry ${attempt + 1}/6 after error: ${err.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`translate failed for ${targetLang}`);
}

async function run() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const db = await mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 3
  });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  let done = 0;
  for (const id of IDS) {
    const [[row]] = await db.query(
      'SELECT id, name, description FROM watches WHERE id = ? LIMIT 1',
      [id]
    );
    if (!row) {
      console.warn(`[retranslate] skip missing watch ${id}`);
      continue;
    }
    const sourceTitle = String(row.name || '').trim();
    const sourceDescription = String(row.description || '');
    if (!sourceTitle) {
      console.warn(`[retranslate] skip empty title ${id}`);
      continue;
    }

    // Source language snapshot as DE
    await db.query(
      `INSERT INTO listing_translations (entitie_id, advert_id, language, title, description)
       VALUES (2, ?, 'de', ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         description = VALUES(description),
         updated_at = CURRENT_TIMESTAMP`,
      [id, sourceTitle, sourceDescription]
    );

    for (const lang of TARGET_LANGS) {
      if (lang === 'de') continue;
      const translated = await translatePair(
        openai,
        'de',
        lang,
        sourceTitle,
        sourceDescription
      );
      await db.query(
        `INSERT INTO listing_translations (entitie_id, advert_id, language, title, description)
         VALUES (2, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           description = VALUES(description),
           updated_at = CURRENT_TIMESTAMP`,
        [id, lang, translated.title, translated.description]
      );
      await sleep(120);
    }

    done += 1;
    console.log(`[retranslate] done ${done}/${IDS.length} (watch ${id})`);
  }

  await db.end();
  console.log('[retranslate] completed');
}

run().catch((err) => {
  console.error('[retranslate] failed:', err.message || err);
  process.exit(1);
});

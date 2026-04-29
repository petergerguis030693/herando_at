#!/usr/bin/env node
/**
 * Einmalig: für alle Magazin-Cover unter public/uploads/postings/{slug}/ WebP-Varianten erzeugen.
 * Usage: node scripts/backfill-posting-cover-variants.js
 */
const path = require('path');
const db = require('../src/db');
const { processPostingCoverVariants } = require('../src/lib/responsive-posting-cover');

async function main() {
  const [rows] = await db.query(
    `SELECT slug, cover_image FROM postings WHERE category = 'magazin' AND cover_image IS NOT NULL AND cover_image != ''`
  );
  for (const row of rows) {
    try {
      await processPostingCoverVariants(row.slug, row.cover_image);
      console.log('OK', row.slug);
    } catch (e) {
      console.error('FAIL', row.slug, e.message);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

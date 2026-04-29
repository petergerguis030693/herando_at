/**
 * Responsive srcset for /images/{entity}/{id}/ listing files (variants from listing-image-variants.js).
 */
const fs = require('fs');
const path = require('path');

const LISTING_IMAGES_BASE = path.resolve('/', 'media', 'herando', 'images');

/** Alle Suffixe (längere zuerst), damit Stem z. B. von foo_small.jpg / foo_smallx2.jpg korrekt wird */
const ALL_VARIANT_SUFFIXES = ['_smallx2', '_small', '_largex2', '_medium', '_large'];

/** Nur diese Varianten ins srcset — ohne _small/_large, kleinste Stufe ist _smallx2 (wie Startseiten-Thumbs) */
const SRCSET_VARIANT_SUFFIXES = ['_smallx2', '_medium', '_largex2'];

const WIDTHS_LANDSCAPE = {
  _small: 300,
  _large: 440,
  _smallx2: 580,
  _medium: 800,
  _largex2: 1080,
};

const WIDTHS_PORTRAIT = {
  _small: 220,
  _large: 360,
  _smallx2: 440,
  _medium: 500,
  _largex2: 720,
};

function stripKnownVariantSuffix(basename) {
  if (!basename || typeof basename !== 'string' || basename.startsWith('/')) return basename;
  const ext = path.extname(basename);
  if (!ext) return basename;
  let base = basename.slice(0, -ext.length);
  const sorted = [...ALL_VARIANT_SUFFIXES].sort((a, b) => b.length - a.length);
  for (const suf of sorted) {
    if (base.endsWith(suf)) {
      base = base.slice(0, -suf.length);
      break;
    }
  }
  return base + ext;
}

function insertSuffixBeforeExtension(basename, suffix) {
  const ext = path.extname(basename);
  if (!ext) return `${basename}${suffix}`;
  const stem = basename.slice(0, -ext.length);
  return `${stem}${suffix}${ext}`;
}

function buildPublicImageUrl(entityRoute, itemId, filename) {
  if (!filename || filename.startsWith('/')) return filename || '/assets/herando-weblogo.png';
  return `/images/${entityRoute}/${itemId}/${encodeURIComponent(filename)}`;
}

/**
 * @returns {{ src: string, srcset: string|null, sizes: string }}
 */
function buildListingImageResponsive(entityRoute, itemId, resolvedBasename, isWatch) {
  const fallback = { src: '/assets/herando-weblogo.png', srcset: null, sizes: '(max-width: 768px) 100vw, 480px' };
  if (!resolvedBasename || typeof resolvedBasename !== 'string' || resolvedBasename.startsWith('/')) {
    return { ...fallback, src: resolvedBasename && resolvedBasename.startsWith('/') ? resolvedBasename : fallback.src };
  }

  const stem = stripKnownVariantSuffix(resolvedBasename);
  const dir = path.join(LISTING_IMAGES_BASE, entityRoute, String(itemId));
  const widthMap = isWatch ? WIDTHS_PORTRAIT : WIDTHS_LANDSCAPE;

  const candidates = [];
  for (const suf of SRCSET_VARIANT_SUFFIXES) {
    const fn = insertSuffixBeforeExtension(stem, suf);
    const w = widthMap[suf];
    if (!w) continue;
    try {
      if (fs.existsSync(path.join(dir, fn))) {
        candidates.push({ w, url: buildPublicImageUrl(entityRoute, itemId, fn) });
      }
    } catch (_) {
      /* ignore */
    }
  }

  if (!candidates.length) {
    const src = buildPublicImageUrl(entityRoute, itemId, resolvedBasename);
    return { src, srcset: null, sizes: '(max-width: 768px) 100vw, 480px' };
  }

  candidates.sort((a, b) => a.w - b.w);
  const src = candidates[0].url;
  const srcset = candidates.map((c) => `${c.url} ${c.w}w`).join(', ');
  // Desktop soll bewusst die höchste verfügbare Stufe ziehen
  // (bei vorhandener Datei in der Praxis _largex2).
  const sizes = '(max-width: 576px) 100vw, (max-width: 1200px) 50vw, 1080px';
  return { src, srcset, sizes };
}

module.exports = {
  buildListingImageResponsive,
  buildPublicImageUrl,
  stripKnownVariantSuffix,
};

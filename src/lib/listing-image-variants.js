/**
 * Listing-Bilder: Original komprimieren + feste Varianten (_large, _largex2, _small, _smallx2, _medium).
 * Uhren (watches): gleiche Logik, Breite/Höhe pro Preset getauscht (Portrait).
 */
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');

const VARIANT_KEYS = ['large', 'largex2', 'small', 'smallx2', 'medium'];

/** Landscape (Standard): Breite x Höhe */
const DIMS_LANDSCAPE = {
  large: { w: 440, h: 360 },
  largex2: { w: 1080, h: 720 },
  small: { w: 300, h: 220 },
  smallx2: { w: 580, h: 440 },
  medium: { w: 800, h: 500 },
};

function dimsForWatch(landscapeDims) {
  const out = {};
  for (const k of VARIANT_KEYS) {
    const d = landscapeDims[k];
    out[k] = { w: d.h, h: d.w };
  }
  return out;
}

const DIMS_PORTRAIT = dimsForWatch(DIMS_LANDSCAPE);

const RASTER_EXT = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.tif',
  '.tiff',
  '.bmp',
  '.avif',
  '.heic',
  '.heif',
]);

function isRasterFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return RASTER_EXT.has(ext);
}

function insertSuffixBeforeExtension(basename, suffix) {
  const ext = path.extname(basename);
  const stem = path.basename(basename, ext);
  return `${stem}${suffix}${ext}`;
}

/**
 * Löscht Original + alle bekannten Varianten im Ordner.
 */
function deleteListingImageVariants(uploadDir, filename) {
  const base = path.basename(String(filename || ''));
  if (!base || base === '.' || base === '..') return;
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  const names = new Set([base]);
  for (const suf of ['_large', '_largex2', '_small', '_smallx2', '_medium']) {
    names.add(`${stem}${suf}${ext}`);
  }
  for (const n of names) {
    const fp = path.join(uploadDir, n);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (_) {
      /* ignore */
    }
  }
}

async function writeCompressedOriginal(inputBuffer, destPath, extLower) {
  const meta = await sharp(inputBuffer).metadata();
  const maxEdge = 2560;
  let pipeline = sharp(inputBuffer).rotate();

  if (meta.width && meta.height) {
    const longEdge = Math.max(meta.width, meta.height);
    if (longEdge > maxEdge) {
      pipeline = pipeline.resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
  }

  if (extLower === '.png') {
    await pipeline.png({ compressionLevel: 9, effort: 10 }).toFile(destPath);
  } else if (extLower === '.webp') {
    await pipeline.webp({ quality: 82, effort: 6 }).toFile(destPath);
  } else {
    await pipeline.jpeg({ quality: 85, mozjpeg: true }).toFile(destPath);
  }
}

async function writeVariant(inputBuffer, destPath, w, h, extLower) {
  const img = sharp(inputBuffer)
    .rotate()
    .resize({
      width: w,
      height: h,
      fit: 'inside',
      withoutEnlargement: true,
    });

  if (extLower === '.png') {
    await img.png({ compressionLevel: 9, effort: 10 }).toFile(destPath);
  } else if (extLower === '.webp') {
    await img.webp({ quality: 80, effort: 6 }).toFile(destPath);
  } else {
    await img.jpeg({ quality: 82, mozjpeg: true }).toFile(destPath);
  }
}

/**
 * Nach Upload: Original unter finalFilename komprimieren + Varianten schreiben.
 * finalFilename = Basisname inkl. Extension (z. B. main_123_abc.jpg).
 */
async function processListingImageFromPath(sourcePath, destDir, finalFilename, { isWatch = false } = {}) {
  if (!isRasterFilename(finalFilename)) return;

  const destPath = path.join(destDir, finalFilename);
  const extLower = path.extname(finalFilename).toLowerCase();

  try {
    await fs.ensureDir(destDir);
    const inputBuffer = await fs.readFile(sourcePath);
    await writeCompressedOriginal(inputBuffer, destPath, extLower);

    const masterBuffer = await fs.readFile(destPath);
    const dims = isWatch ? DIMS_PORTRAIT : DIMS_LANDSCAPE;
    for (const key of VARIANT_KEYS) {
      const { w, h } = dims[key];
      const variantName = insertSuffixBeforeExtension(finalFilename, `_${key}`);
      const variantPath = path.join(destDir, variantName);
      await writeVariant(masterBuffer, variantPath, w, h, extLower);
    }
  } catch (err) {
    console.error('listing-image-variants: process failed', finalFilename, err.message);
    try {
      await fs.copy(sourcePath, destPath, { overwrite: true });
    } catch (copyErr) {
      console.error('listing-image-variants: fallback copy failed', copyErr.message);
    }
  }
}

module.exports = {
  processListingImageFromPath,
  deleteListingImageVariants,
  isRasterFilename,
};

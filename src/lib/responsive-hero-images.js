/**
 * Home hero: WebP width variants next to uploaded file (stem_w640.webp, …).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC_ROOT = path.join(__dirname, '../../public');
const HOME_HERO_DIR = path.join(PUBLIC_ROOT, 'uploads/home-hero');

const WIDTHS = [640, 1024, 1536];

/**
 * After multer saves a raster image under uploads/home-hero/, generate stem_w*.webp siblings.
 */
async function buildHomeHeroVariants(sourcePath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return;
  const ext = path.extname(sourcePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return;

  const dir = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, ext);
  let inputBuffer;
  try {
    inputBuffer = await fs.promises.readFile(sourcePath);
  } catch (_) {
    return;
  }

  for (const w of WIDTHS) {
    const outPath = path.join(dir, `${stem}_w${w}.webp`);
    try {
      await sharp(inputBuffer)
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 82, effort: 6 })
        .toFile(outPath);
    } catch (err) {
      console.error('responsive-hero-images: variant failed', outPath, err.message);
    }
  }
}

/**
 * @returns {{ src: string, srcset: string|null, sizes: string, preloadHref: string }}
 */
function buildResponsiveHeroAttrs(publicUrl) {
  const out = {
    src: publicUrl,
    srcset: null,
    sizes: '100vw',
    preloadHref: publicUrl,
  };
  if (!publicUrl || typeof publicUrl !== 'string') return out;
  if (!publicUrl.startsWith('/uploads/home-hero/')) return out;

  const basename = path.basename(publicUrl);
  const stem = basename.includes('.') ? basename.slice(0, basename.lastIndexOf('.')) : basename;
  const parts = [];
  for (const w of WIDTHS) {
    const fn = `${stem}_w${w}.webp`;
    const full = path.join(HOME_HERO_DIR, fn);
    try {
      if (fs.existsSync(full)) {
        parts.push(`/uploads/home-hero/${fn} ${w}w`);
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!parts.length) return out;

  const firstUrl = parts[0].split(' ')[0];
  out.src = firstUrl;
  out.srcset = parts.join(', ');
  const w1024 = parts.find((p) => /\b1024w\b/.test(p));
  out.preloadHref = w1024 ? w1024.split(/\s+/)[0] : firstUrl;
  return out;
}

module.exports = {
  buildHomeHeroVariants,
  buildResponsiveHeroAttrs,
};

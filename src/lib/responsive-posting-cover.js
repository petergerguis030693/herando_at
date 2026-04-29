/**
 * Magazin cover images: compressed WebP variants beside original in uploads/postings/{slug}/
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PUBLIC_ROOT = path.join(__dirname, '../../public');

const CARD_W = 256;
const MAIN_W = 900;

function postingDir(slug) {
  return path.join(PUBLIC_ROOT, 'uploads/postings', slug);
}

/**
 * @param {string} slug
 * @param {string} filename — cover filename only
 */
async function processPostingCoverVariants(slug, filename) {
  if (!slug || !filename) return;
  const ext = path.extname(filename).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return;

  const dir = postingDir(slug);
  const full = path.join(dir, filename);
  if (!fs.existsSync(full)) return;

  const stem = path.basename(filename, ext);
  let inputBuffer;
  try {
    inputBuffer = await fs.promises.readFile(full);
  } catch (_) {
    return;
  }

  const targets = [
    { suffix: '_card256', width: CARD_W },
    { suffix: '_main900', width: MAIN_W },
  ];

  for (const { suffix, width } of targets) {
    const outPath = path.join(dir, `${stem}${suffix}.webp`);
    try {
      await sharp(inputBuffer)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 80, effort: 6 })
        .toFile(outPath);
    } catch (err) {
      console.error('posting-cover-variants:', outPath, err.message);
    }
  }
}

/**
 * @returns {{ src: string, srcset: string|null, sizes: string, width: number, height: number }}
 */
function buildPostingCoverResponsive(slug, filename, role) {
  const placeholder = {
    src: '/assets/herando-weblogo.png',
    srcset: null,
    sizes: '100vw',
    width: role === 'main' ? 1200 : 120,
    height: role === 'main' ? 675 : 80,
  };
  const fallback = {
    src: `/uploads/postings/${slug}/${filename}`,
    srcset: null,
    sizes: '100vw',
    width: 600,
    height: 338,
  };
  if (!slug || !filename || String(filename).trim() === '' || filename.includes('herando-weblogo')) {
    return placeholder;
  }

  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const dir = postingDir(slug);

  const cardFn = `${stem}_card256.webp`;
  const mainFn = `${stem}_main900.webp`;
  const cardPath = path.join(dir, cardFn);
  const mainPath = path.join(dir, mainFn);

  const baseUrl = `/uploads/postings/${slug}/`;

  if (role === 'side') {
    const parts = [];
    if (fs.existsSync(cardPath)) parts.push(`${baseUrl}${cardFn} 256w`);
    if (fs.existsSync(mainPath)) parts.push(`${baseUrl}${mainFn} 900w`);
    if (parts.length) {
      return {
        src: fs.existsSync(cardPath) ? `${baseUrl}${cardFn}` : `${baseUrl}${mainFn}`,
        srcset: parts.join(', '),
        sizes: '(max-width: 1024px) 45vw, 120px',
        width: 120,
        height: 80,
      };
    }
    return { ...fallback, sizes: '(max-width: 1024px) 45vw, 120px', width: 120, height: 80 };
  }

  // main
  const mainParts = [];
  if (fs.existsSync(cardPath)) mainParts.push({ w: 256, u: `${baseUrl}${cardFn}` });
  if (fs.existsSync(mainPath)) mainParts.push({ w: 900, u: `${baseUrl}${mainFn}` });
  if (mainParts.length) {
    mainParts.sort((a, b) => a.w - b.w);
    return {
      src: mainParts[mainParts.length - 1].u,
      srcset: mainParts.map((p) => `${p.u} ${p.w}w`).join(', '),
      sizes: '(max-width: 1024px) 100vw, min(66vw, 900px)',
      width: 1200,
      height: 675,
    };
  }
  return { ...fallback, sizes: '(max-width: 1024px) 100vw, min(66vw, 900px)', width: 1200, height: 675 };
}

module.exports = {
  processPostingCoverVariants,
  buildPostingCoverResponsive,
};

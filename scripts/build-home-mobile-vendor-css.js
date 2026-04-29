#!/usr/bin/env node
/**
 * Purged Bootstrap + Bootstrap Icons for the homepage (mobile viewport).
 * Desktop (min-width: 992px) still loads full CDN in styles.ejs — this file is
 * linked with media="(max-width: 991px)" only.
 *
 * Run via: npm run build:min
 */
const fs = require('fs');
const path = require('path');
const { PurgeCSS } = require('purgecss');
const { globSync } = require('glob');
const CleanCSS = require('clean-css');

const root = path.join(__dirname, '..');
const outFile = path.join(root, 'public', 'css', 'home-mobile-vendor.min.css');

const bootstrapCss = path.join(root, 'node_modules/bootstrap/dist/css/bootstrap.min.css');
const iconsCss = path.join(root, 'node_modules/bootstrap-icons/font/bootstrap-icons.css');
const iconsFontSrc = path.join(root, 'node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2');
const iconsFontDest = path.join(root, 'public', 'fonts', 'bootstrap-icons.woff2');

/** Homepage + globale Partials die dieselbe Navbar/Footer nutzen */
function getContentPaths() {
  const patterns = [
    'src/views/pages/templates/index.ejs',
    'src/views/components/home/**/*.ejs',
    'src/views/partials/**/*.ejs',
    'public/js/home-page.js'
  ];
  const set = new Set();
  for (const p of patterns) {
    for (const abs of globSync(p, { cwd: root, absolute: true, nodir: true })) {
      set.add(abs);
    }
  }
  return [...set];
}

/**
 * Nur was Purge aus Templates nicht sieht (Bootstrap-JS setzt Klassen dynamisch).
 * Utilities (col-, d-flex, …) kommen aus den .ejs-Dateien — nicht hier safelisten.
 */
const safelist = [
  'active',
  'show',
  'fade',
  'collapsing',
  'collapse',
  'collapsed',
  'modal-backdrop',
  'modal-open',
  'dropdown-menu',
  'dropdown-menu-end',
  'dropdown-menu-start',
  'dropdown-toggle',
  'dropdown-item',
  'dropdown-divider',
  'navbar-toggler',
  'navbar-toggler-icon',
  'navbar-collapse',
  'navbar-nav',
  'offcanvas',
  'offcanvas-backdrop',
  'offcanvas-start',
  'offcanvas-end',
  'carousel',
  'carousel-inner',
  'carousel-item',
  'carousel-item-next',
  'carousel-item-prev',
  'carousel-item-start',
  'carousel-item-end',
  'carousel-item-active',
  'carousel-fade',
  'carousel-control-prev',
  'carousel-control-next',
  'carousel-control-prev-icon',
  'carousel-control-next-icon',
  'carousel-caption',
  'carousel-indicators',
  /^carousel-/,
  /^dropdown/,
  /^modal-/,
  /^navbar-/,
  /^nav-/,
  /^offcanvas/,
  /^collapse/,
  /^btn-close/
];

async function run() {
  if (!fs.existsSync(bootstrapCss) || !fs.existsSync(iconsCss)) {
    console.warn('build-home-mobile-vendor-css: skip (run npm install; need bootstrap + bootstrap-icons)');
    return;
  }

  fs.mkdirSync(path.dirname(iconsFontDest), { recursive: true });
  fs.copyFileSync(iconsFontSrc, iconsFontDest);

  const content = getContentPaths();
  if (!content.length) {
    console.warn('build-home-mobile-vendor-css: no content files');
    return;
  }

  const result = await new PurgeCSS().purge({
    content,
    css: [bootstrapCss, iconsCss],
    safelist
  });

  const [bootOut, iconsOut] = result;
  let combined =
    `/* purge: bootstrap */\n${bootOut.css}\n\n/* purge: bootstrap-icons */\n${iconsOut.css}`;

  combined = combined.replace(
    /url\(\s*["']?\.\/fonts\/bootstrap-icons\.woff2[^)]*\)/gi,
    'url("/fonts/bootstrap-icons.woff2")'
  );

  const min = new CleanCSS({ level: 2 }).minify(combined);
  if (min.errors && min.errors.length) console.error('home-mobile-vendor', min.errors);
  /* Bootstrap Icons liefert font-display:block (FOIT); swap = Text/Icons früher sichtbar (PageSpeed) */
  let styles = min.styles.replace(
    /@font-face\{font-display:block;font-family:bootstrap-icons;/g,
    '@font-face{font-display:swap;font-family:bootstrap-icons;'
  );
  fs.writeFileSync(outFile, styles);
  console.log('OK home-mobile-vendor.min.css', `(${min.styles.length} bytes)`);
}

module.exports = { run };

if (require.main === module) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

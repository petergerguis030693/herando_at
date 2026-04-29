#!/usr/bin/env node
/**
 * Minifies listed public CSS/JS for production. Run after editing sources:
 *   npm run build:min
 */
const fs = require('fs');
const path = require('path');
const CleanCSS = require('clean-css');
const { CLEAN_CSS_OPTS } = require('./css-minify-opts');
const { minify: terserMinify } = require('terser');

const root = path.join(__dirname, '..');
const cssDir = path.join(root, 'public', 'css');
const jsDir = path.join(root, 'public', 'js');

const CSS_FILES = [
  'style.css',
  'detail.css',
  'footer.css',
  'product-single.css',
  'products.css',
  'search.css',
  'ui-components.css',
  'magazin.css',
  'mobile.css',
  'mobile-style.css',
  'navbar-clean.css',
  'language-modal.css'
];

const JS_FILES = [
  { in: 'analytics-tracker.js', out: 'analytics-tracker.min.js' },
  { in: 'header-ui.js', out: 'header-ui.min.js' },
  { in: 'home-page.js', out: 'home-page.min.js' }
];

/** Startseite: eine Datei statt style + header + navbar + … (Reihenfolge = Kaskade) */
const HOME_BUNDLE_CSS = [
  'style.css',
  'header.css',
  'navbar-clean.css',
  'ui-components.css',
  'mobile.css',
  'mobile-style.css',
  'magazin.css',
  'products.css',
  'footer.css',
  'product-single.css',
  'search.css',
  'language-modal.css'
];

function writeHomeBundleMin() {
  const chunks = [];
  for (const name of HOME_BUNDLE_CSS) {
    const inputPath = path.join(cssDir, name);
    if (!fs.existsSync(inputPath)) {
      console.warn('home bundle skip missing:', inputPath);
      continue;
    }
    const src = fs.readFileSync(inputPath, 'utf8');
    chunks.push(`/* ${name} */\n${src}`);
  }
  const combined = chunks.join('\n\n');
  const out = new CleanCSS(CLEAN_CSS_OPTS).minify(combined);
  if (out.errors && out.errors.length) console.error('home-bundle', out.errors);
  const outPath = path.join(cssDir, 'home-bundle.min.css');
  fs.writeFileSync(outPath, out.styles);
  console.log('OK home-bundle.min.css', `(${out.styles.length} bytes)`);
}

/** Startseite: Purge-Roh + Bundle-Quellen in einem Minify-Lauf (bessere Kompression als min+min) */
function writeHomeMobileCombinedMin() {
  const purgedPath = path.join(cssDir, 'home-mobile-vendor.purged.css');
  const vendorMinPath = path.join(cssDir, 'home-mobile-vendor.min.css');
  const bundleMinPath = path.join(cssDir, 'home-bundle.min.css');
  const outPath = path.join(cssDir, 'home-mobile-combined.min.css');

  if (fs.existsSync(purgedPath)) {
    const purged = fs.readFileSync(purgedPath, 'utf8');
    const bundleChunks = [];
    for (const name of HOME_BUNDLE_CSS) {
      const inputPath = path.join(cssDir, name);
      if (!fs.existsSync(inputPath)) {
        console.warn('home-mobile-combined skip missing:', inputPath);
        continue;
      }
      bundleChunks.push(`/* ${name} */\n${fs.readFileSync(inputPath, 'utf8')}`);
    }
    const merged = `${purged}\n\n/* home-bundle */\n${bundleChunks.join('\n\n')}`;
    const out = new CleanCSS(CLEAN_CSS_OPTS).minify(merged);
    if (out.errors && out.errors.length) console.error('home-mobile-combined', out.errors);
    fs.writeFileSync(outPath, out.styles);
    console.log('OK home-mobile-combined.min.css', `(${out.styles.length} bytes)`);
    return;
  }

  if (!fs.existsSync(vendorMinPath) || !fs.existsSync(bundleMinPath)) {
    console.warn('home-mobile-combined skip (missing vendor or home-bundle)');
    return;
  }
  const vendor = fs.readFileSync(vendorMinPath, 'utf8');
  const bundle = fs.readFileSync(bundleMinPath, 'utf8');
  const merged = `${vendor}\n/* home-bundle */\n${bundle}`;
  const out = new CleanCSS(CLEAN_CSS_OPTS).minify(merged);
  if (out.errors && out.errors.length) console.error('home-mobile-combined', out.errors);
  fs.writeFileSync(outPath, out.styles);
  console.log('OK home-mobile-combined.min.css (fallback min+min)', `(${out.styles.length} bytes)`);
}

function writeMinCss(name) {
  const inputPath = path.join(cssDir, name);
  if (!fs.existsSync(inputPath)) {
    console.warn('skip missing CSS:', inputPath);
    return;
  }
  const src = fs.readFileSync(inputPath, 'utf8');
  const out = new CleanCSS(CLEAN_CSS_OPTS).minify(src);
  if (out.errors && out.errors.length) console.error(name, out.errors);
  const outName = name.replace(/\.css$/i, '.min.css');
  fs.writeFileSync(path.join(cssDir, outName), out.styles);
  console.log('OK', outName, `(${out.styles.length} bytes)`);
}

async function writeMinJs(entry) {
  const inputPath = path.join(jsDir, entry.in);
  if (!fs.existsSync(inputPath)) {
    console.warn('skip missing JS:', inputPath);
    return;
  }
  const src = fs.readFileSync(inputPath, 'utf8');
  const out = await terserMinify(src, {
    compress: true,
    mangle: true,
    format: { comments: false }
  });
  if (out.error) throw out.error;
  fs.writeFileSync(path.join(jsDir, entry.out), out.code);
  console.log('OK', entry.out, `(${out.code.length} bytes)`);
}

async function writeBootstrapDetailMin() {
  try {
    const { run } = require('./build-bootstrap-detail-css.js');
    await run();
  } catch (e) {
    console.warn('bootstrap-detail build skipped:', e.message);
  }
}

(async () => {
  CSS_FILES.forEach(writeMinCss);
  writeHomeBundleMin();
  try {
    const { run: buildHomeMobileVendor } = require('./build-home-mobile-vendor-css.js');
    await buildHomeMobileVendor();
  } catch (e) {
    console.warn('home-mobile-vendor build skipped:', e.message);
  }
  await writeBootstrapDetailMin();
  writeHomeMobileCombinedMin();
  for (const j of JS_FILES) {
    await writeMinJs(j);
  }
  console.log('build:min done.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

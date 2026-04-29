#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { PurgeCSS } = require('purgecss');
const CleanCSS = require('clean-css');
const { CLEAN_CSS_OPTS } = require('./css-minify-opts');

const root = path.join(__dirname, '..');
const sourceCss = path.join(root, 'public', 'vendor', 'bootstrap', 'bootstrap.min.css');
const outCss = path.join(root, 'public', 'css', 'bootstrap-detail.min.css');

const content = [
  path.join(root, 'src', 'views', 'pages', 'templates', 'detail.ejs'),
  path.join(root, 'src', 'views', 'components', 'detail', '*.ejs'),
  path.join(root, 'src', 'views', 'partials', 'headerzwei.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'navbar.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'language-modal.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'language-mobile.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'user-menu.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'user-menu-mobile.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'search.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'search-mobile.ejs'),
  path.join(root, 'src', 'views', 'partials', 'header', 'mega-menu.ejs')
];

const safelist = {
  standard: [
    'show',
    'fade',
    'collapse',
    'collapsing',
    'dropdown-toggle',
    'dropdown-toggle-split',
    'dropdown-menu',
    'dropdown-menu-end',
    'dropdown-menu-start',
    'dropdown-item',
    'dropdown-header',
    'dropdown-divider',
    'dropdown-item-text',
    'dropdown-menu-dark',
    'btn-close',
    'modal-backdrop',
    'navbar-toggler',
    'navbar-toggler-icon',
    'form-control',
    'form-select',
    'input-group-text',
    'invalid-feedback',
    'valid-feedback',
    /^container(-fluid)?$/,
    /^row$/,
    /^col($|-)/,
    /^g(-[xy])?-\d+$/,
    /^d-/,
    /^justify-content-/,
    /^align-items-/,
    /^align-self-/,
    /^text-/,
    /^bg-/,
    /^btn/,
    /^form-/,
    /^input-group/,
    /^modal/,
    /^fade$/,
    /^show$/,
    /^collapse$/,
    /^collapsing$/,
    /^dropdown/,
    /^offcanvas/,
    /^navbar/,
    /^nav-/,
    /^card/,
    /^table/,
    /^alert/,
    /^badge/,
    /^breadcrumb/,
    /^rounded/,
    /^shadow/,
    /^border/,
    /^w-\d+$/,
    /^h-\d+$/,
    /^w-100$/,
    /^h-100$/,
    /^m([trblxy])?-\d+$/,
    /^p([trblxy])?-\d+$/,
    /^mt-auto$/,
    /^me-auto$/,
    /^ms-auto$/,
    /^position-/,
    /^top-\d+$/,
    /^bottom-\d+$/,
    /^start-\d+$/,
    /^end-\d+$/,
    /^translate-middle/,
    /^fw-/,
    /^fs-/,
    /^lh-/,
    /^gap-\d+$/,
    /^order-\d+$/,
    /^visually-hidden$/,
    /^stretched-link$/,
    /^ratio/,
    /^img-fluid$/,
    /^img-thumbnail$/,
    /^carousel/,
    /^spinner/
  ]
};

async function run() {
  if (!fs.existsSync(sourceCss)) {
    throw new Error(`Missing source CSS: ${sourceCss}`);
  }

  const purge = new PurgeCSS();
  const result = await purge.purge({
    content,
    css: [sourceCss],
    safelist,
    defaultExtractor: (contentText) => {
      const broadMatches = contentText.match(/[\w-/:%.]+(?<!:)/g) || [];
      return broadMatches;
    }
  });

  const purgedCss = result && result[0] && result[0].css ? result[0].css : '';
  const minified = new CleanCSS(CLEAN_CSS_OPTS).minify(purgedCss);
  if (minified.errors && minified.errors.length) {
    throw new Error(`CleanCSS errors: ${minified.errors.join('; ')}`);
  }

  fs.writeFileSync(outCss, minified.styles, 'utf8');
  console.log(`OK bootstrap-detail.min.css (${minified.styles.length} bytes)`);
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.error('build-bootstrap-detail-css failed:', err.message || err);
    process.exit(1);
  });
}

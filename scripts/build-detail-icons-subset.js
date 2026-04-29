#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const subsetFont = require('subset-font');

const ROOT = path.resolve(__dirname, '..');
const ICON_SOURCE_FILES = [
  path.join(ROOT, 'src/views/pages/templates/detail.ejs'),
  path.join(ROOT, 'src/views/components/detail/script.ejs'),
  path.join(ROOT, 'src/views/partials/headerzwei.ejs'),
  path.join(ROOT, 'src/views/partials/header/navbar.ejs'),
  path.join(ROOT, 'src/views/partials/header/language-modal.ejs'),
  path.join(ROOT, 'src/views/partials/header/language-mobile.ejs'),
  path.join(ROOT, 'src/views/partials/header/user-menu.ejs'),
  path.join(ROOT, 'src/views/partials/header/user-menu-mobile.ejs'),
  path.join(ROOT, 'src/views/partials/header/mega-menu.ejs')
];
const SOURCE_CSS = path.join(ROOT, 'public/vendor/bootstrap-icons/bootstrap-icons.css');
const SOURCE_FONT = path.join(ROOT, 'public/fonts/bootstrap-icons.woff2');
const OUT_CSS = path.join(ROOT, 'public/css/bootstrap-icons-detail-subset.css');
const OUT_FONT = path.join(ROOT, 'public/fonts/bootstrap-icons-detail-subset.woff2');

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function collectIconsFromBiClasses(content, outSet) {
  const re = /\bbi-([a-z0-9-]+)\b/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    outSet.add(match[1]);
  }
}

function collectIconColCalls(content, outSet) {
  const re = /iconCol\(\s*'([a-z0-9-]+)'/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    outSet.add(match[1]);
  }
}

function collectEquipmentIconValues(content, outSet) {
  const blockMatch = content.match(/const equipmentIcons = \{([\s\S]*?)\n\};/);
  if (!blockMatch) return;
  const block = blockMatch[1];
  const re = /:\s*"([a-z0-9-]+)"/g;
  let match;
  while ((match = re.exec(block)) !== null) {
    outSet.add(match[1]);
  }
}

function parseBootstrapIconsCss(cssContent) {
  const iconToCodepoint = new Map();
  const re = /\.bi-([a-z0-9-]+)::before\s*\{\s*content:\s*"\\([a-f0-9]+)"\s*;\s*\}/gi;
  let match;
  while ((match = re.exec(cssContent)) !== null) {
    iconToCodepoint.set(match[1], parseInt(match[2], 16));
  }
  return iconToCodepoint;
}

function buildSubsetCss(iconNames, iconToCodepoint) {
  const sorted = Array.from(iconNames).sort();
  const lines = [];
  lines.push('@font-face {');
  lines.push('  font-display: swap;');
  lines.push('  font-family: "bootstrap-icons";');
  lines.push('  src: url("/fonts/bootstrap-icons-detail-subset.woff2") format("woff2");');
  lines.push('}');
  lines.push('');
  lines.push('.bi::before,');
  lines.push('[class^="bi-"]::before,');
  lines.push('[class*=" bi-"]::before {');
  lines.push('  display: inline-block;');
  lines.push('  font-family: bootstrap-icons !important;');
  lines.push('  font-style: normal;');
  lines.push('  font-weight: normal !important;');
  lines.push('  font-variant: normal;');
  lines.push('  text-transform: none;');
  lines.push('  line-height: 1;');
  lines.push('  vertical-align: -.125em;');
  lines.push('  -webkit-font-smoothing: antialiased;');
  lines.push('  -moz-osx-font-smoothing: grayscale;');
  lines.push('}');
  lines.push('');

  const missing = [];
  for (const name of sorted) {
    const cp = iconToCodepoint.get(name);
    if (!cp) {
      missing.push(name);
      continue;
    }
    lines.push(`.bi-${name}::before { content: "\\${cp.toString(16)}"; }`);
  }
  lines.push('');
  return { css: lines.join('\n'), missing };
}

async function buildSubsetFont(unicodes) {
  const sourceBuffer = fs.readFileSync(SOURCE_FONT);
  const glyphText = String.fromCodePoint(...unicodes);
  const outBuffer = await subsetFont(sourceBuffer, glyphText, {
    targetFormat: 'woff2'
  });
  fs.writeFileSync(OUT_FONT, outBuffer);
  return outBuffer.length;
}

async function main() {
  const fileContents = ICON_SOURCE_FILES.map((p) => {
    try {
      return readUtf8(p);
    } catch (_) {
      return '';
    }
  });
  const detailTemplate = fileContents[0] || '';
  const detailComponent = fileContents[1] || '';
  const bootstrapCss = readUtf8(SOURCE_CSS);

  const icons = new Set();
  for (const content of fileContents) {
    if (!content) continue;
    collectIconsFromBiClasses(content, icons);
  }
  collectIconColCalls(detailComponent, icons);
  collectEquipmentIconValues(detailTemplate, icons);
  icons.add('check-circle');

  const iconToCodepoint = parseBootstrapIconsCss(bootstrapCss);
  const { css, missing } = buildSubsetCss(icons, iconToCodepoint);
  fs.writeFileSync(OUT_CSS, css, 'utf8');

  const unicodes = [0x20, ...Array.from(icons).map((name) => iconToCodepoint.get(name)).filter(Boolean)];
  const outSize = await buildSubsetFont(unicodes);

  if (missing.length) {
    console.warn('[detail-icons-subset] Missing icons in source CSS:', missing.join(', '));
  }
  console.log(`[detail-icons-subset] Icons: ${icons.size}, font size: ${outSize} bytes`);
  console.log(`[detail-icons-subset] Wrote ${path.relative(ROOT, OUT_CSS)} and ${path.relative(ROOT, OUT_FONT)}`);
}

main().catch((err) => {
  console.error('[detail-icons-subset] Failed:', err && err.message ? err.message : err);
  process.exit(1);
});

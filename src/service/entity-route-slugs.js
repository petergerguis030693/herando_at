'use strict';

const SUPPORTED_LANGS = ['de', 'en', 'fr', 'it', 'tr', 'ja', 'cs', 'ru', 'es', 'nl', 'pl'];

// Canonical route -> localized slug per language.
// Routes not listed here keep their canonical slug (e.g. lifestyles).
const ENTITY_ROUTE_LANG_MAP = {
  cars: {
    de: 'autos',
    es: 'coches',
    fr: 'voitures',
    it: 'auto',
    tr: 'arabalar',
    en: 'cars',
    ja: 'cars'
  },
  watches: {
    de: 'uhren',
    es: 'relojes',
    fr: 'montres',
    it: 'orologi',
    tr: 'saatler',
    en: 'watches',
    ja: 'watches'
  },
  properties: {
    de: 'immobilien',
    es: 'propiedades',
    fr: 'proprietes',
    it: 'immobili',
    tr: 'emlak',
    en: 'properties',
    ja: 'properties'
  },
  yachts: {
    de: 'boote',
    es: 'barcos',
    fr: 'bateaux',
    it: 'barche',
    tr: 'tekneler',
    en: 'yachts',
    ja: 'yachts'
  }
};

function normalizeLang(input) {
  const value = String(input || 'de').toLowerCase();
  if (SUPPORTED_LANGS.includes(value)) return value;
  const base = value.split(/[-_]/)[0];
  if (SUPPORTED_LANGS.includes(base)) return base;
  return 'de';
}

function normalizeRoute(input) {
  return String(input || '').trim().toLowerCase();
}

function getLocalizedEntityRoute(route, lang = 'de') {
  const canonical = normalizeRoute(route);
  if (!canonical) return canonical;
  const langKey = normalizeLang(lang);
  const langMap = ENTITY_ROUTE_LANG_MAP[canonical];
  if (!langMap) return canonical;
  return langMap[langKey] || canonical;
}

const routeAliasToCanonical = (() => {
  const map = new Map();

  Object.entries(ENTITY_ROUTE_LANG_MAP).forEach(([canonical, byLang]) => {
    map.set(normalizeRoute(canonical), canonical);
    Object.values(byLang).forEach((alias) => {
      map.set(normalizeRoute(alias), canonical);
    });
  });

  // Keep a few common variants robustly resolvable.
  map.set('car', 'cars');
  map.set('coches', 'cars');
  map.set('voitures', 'cars');
  map.set('arabalar', 'cars');
  map.set('uhr', 'watches');
  map.set('montre', 'watches');
  map.set('orologio', 'watches');
  map.set('saat', 'watches');
  map.set('immobilie', 'properties');
  map.set('propriete', 'properties');
  map.set('proprieta', 'properties');
  map.set('yacht', 'yachts');
  map.set('yachten', 'yachts');
  map.set('boot', 'yachts');
  map.set('bateau', 'yachts');
  map.set('barca', 'yachts');
  map.set('tekne', 'yachts');

  return map;
})();

function getCanonicalEntityRoute(routeOrSlug) {
  const key = normalizeRoute(routeOrSlug);
  if (!key) return key;
  return routeAliasToCanonical.get(key) || key;
}

function splitPath(pathname) {
  const input = String(pathname || '/');
  const hasLeadingSlash = input.startsWith('/');
  const parts = input.split('/').filter(Boolean);
  return { hasLeadingSlash, parts };
}

function canonicalizeEntityPath(pathname) {
  const { hasLeadingSlash, parts } = splitPath(pathname);
  if (!parts.length) return '/';

  const [first, ...rest] = parts;
  const canonicalFirst = getCanonicalEntityRoute(first);
  const out = [canonicalFirst, ...rest].join('/');
  return `${hasLeadingSlash ? '/' : ''}${out || ''}` || '/';
}

function localizeEntityPath(pathname, lang = 'de') {
  const { hasLeadingSlash, parts } = splitPath(pathname);
  if (!parts.length) return '/';

  const [first, ...rest] = parts;
  const canonicalFirst = getCanonicalEntityRoute(first);
  const localizedFirst = getLocalizedEntityRoute(canonicalFirst, lang);
  const out = [localizedFirst, ...rest].join('/');
  return `${hasLeadingSlash ? '/' : ''}${out || ''}` || '/';
}

module.exports = {
  SUPPORTED_LANGS,
  getLocalizedEntityRoute,
  getCanonicalEntityRoute,
  canonicalizeEntityPath,
  localizeEntityPath
};

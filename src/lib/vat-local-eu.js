/**
 * Lokale EU-USt-Id-Prüfung (Format + Prüfziffern) ohne Netzwerk.
 * Nutzt jsvat – ersetzt keine VIES-Live-Prüfung, dient als Fallback bei VIES-Ausfall.
 */

'use strict';

const jsvat = require('jsvat');

const EU_JSVAT_COUNTRIES = [
  jsvat.austria,
  jsvat.belgium,
  jsvat.bulgaria,
  jsvat.croatia,
  jsvat.cyprus,
  jsvat.czechRepublic,
  jsvat.denmark,
  jsvat.estonia,
  jsvat.finland,
  jsvat.france,
  jsvat.germany,
  jsvat.greece,
  jsvat.hungary,
  jsvat.ireland,
  jsvat.italy,
  jsvat.latvia,
  jsvat.lithuania,
  jsvat.luxembourg,
  jsvat.malta,
  jsvat.netherlands,
  jsvat.poland,
  jsvat.portugal,
  jsvat.romania,
  jsvat.slovakiaRepublic,
  jsvat.slovenia,
  jsvat.spain,
  jsvat.sweden
];

/**
 * @param {string} normalizedFullVat z. B. DE261140074 (ohne Sonderzeichen, upper case)
 * @param {string} selectedCountryCode ISO-3166-1 alpha-2 aus countries.code (z. B. DE, GR)
 * @returns {{ valid: boolean, reason: string, vatIso?: string, expected?: string, value?: string }}
 */
function validateEuVatLocally(normalizedFullVat, selectedCountryCode) {
  const expected = String(selectedCountryCode || '').toUpperCase();
  if (!expected) {
    return { valid: false, reason: 'no-country' };
  }

  const r = jsvat.checkVAT(normalizedFullVat, EU_JSVAT_COUNTRIES);

  if (!r.isSupportedCountry || !r.country) {
    return { valid: false, reason: 'unsupported-prefix' };
  }

  const vatIso = r.country.isoCode && r.country.isoCode.short;
  if (vatIso !== expected) {
    return {
      valid: false,
      reason: 'country-mismatch',
      vatIso,
      expected
    };
  }

  if (r.isValid === true) {
    return { valid: true, reason: 'local-valid', value: r.value };
  }

  return { valid: false, reason: 'local-invalid', value: r.value };
}

module.exports = {
  validateEuVatLocally,
  EU_JSVAT_COUNTRIES
};

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dictionaries, hasKey, setLanguage, t } from '../../src/js/i18n.js';

test('English and Hindi define exactly the same keys', () => {
  const en = Object.keys(dictionaries.en).sort();
  const hi = Object.keys(dictionaries.hi).sort();
  assert.deepEqual(hi, en);
  assert.ok(en.length > 100, `expected a full dictionary, got ${en.length} keys`);
});

test('no Hindi value is left as the English source text', () => {
  // Latin-only values are legitimate for brand and format strings.
  const allowed = new Set(['English', 'हिन्दी']);
  for (const [key, value] of Object.entries(dictionaries.hi)) {
    if (allowed.has(value)) continue;
    const hasIndic = /[\u0900-\u097F]/.test(value);
    const isTechnical = /^(#|\{|\d)/.test(value) || /^[\d\s.:%]+$/.test(value);
    assert.ok(hasIndic || isTechnical || value.includes('{'), `untranslated: ${key} -> ${value}`);
  }
});

test('t() interpolates placeholders and switches language', () => {
  setLanguage('en');
  assert.equal(t('ledger.entryCount', { count: 3 }), '3 entries');
  setLanguage('hi');
  assert.equal(t('ledger.entryCount', { count: 3 }), '3 एंट्री');
  setLanguage('en');
});

test('unknown keys fall back to the key itself, never to undefined', () => {
  setLanguage('en');
  assert.equal(t('does.not.exist'), 'does.not.exist');
  assert.equal(hasKey('app.name'), true);
  assert.equal(hasKey('does.not.exist'), false);
});

test('an unsupported language falls back to English', () => {
  setLanguage('xx');
  assert.equal(t('app.name'), 'Khata');
  setLanguage('en');
});

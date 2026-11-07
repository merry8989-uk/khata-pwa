import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_AMOUNT_PAISE,
  formatAmount,
  formatINR,
  paiseToInput,
  parseAmountToPaise,
} from '../../shared/money.js';

test('parses plain, comma and symbol input into paise', () => {
  assert.deepEqual(parseAmountToPaise('500'), { ok: true, paise: 50000 });
  assert.deepEqual(parseAmountToPaise('1,250.50'), { ok: true, paise: 125050 });
  assert.deepEqual(parseAmountToPaise('\u20b91,250'), { ok: true, paise: 125000 });
  assert.deepEqual(parseAmountToPaise('  42.5 '), { ok: true, paise: 4250 });
  assert.deepEqual(parseAmountToPaise(1250.5), { ok: true, paise: 125050 });
});

test('rejects empty, zero, negative, over-precise and oversized amounts', () => {
  assert.equal(parseAmountToPaise('').code, 'AMOUNT_REQUIRED');
  assert.equal(parseAmountToPaise('   ').code, 'AMOUNT_REQUIRED');
  assert.equal(parseAmountToPaise('0').code, 'AMOUNT_INVALID');
  assert.equal(parseAmountToPaise('-5').code, 'AMOUNT_INVALID');
  assert.equal(parseAmountToPaise('1.234').code, 'AMOUNT_INVALID');
  assert.equal(parseAmountToPaise('abc').code, 'AMOUNT_INVALID');
  assert.equal(parseAmountToPaise(Number.NaN).code, 'AMOUNT_INVALID');
  assert.equal(parseAmountToPaise(null).code, 'AMOUNT_INVALID');
  const tooLarge = String(MAX_AMOUNT_PAISE / 100 + 1);
  assert.equal(parseAmountToPaise(tooLarge).code, 'AMOUNT_TOO_LARGE');
});

test('integer paise never drift: 0.1 + 0.2 rupees is exactly 30 paise', () => {
  const a = parseAmountToPaise('0.10').paise;
  const b = parseAmountToPaise('0.20').paise;
  assert.equal(a + b, 30);
  assert.equal(formatAmount(a + b), '0.30');
});

test('formats Indian grouping and drops trailing zeros', () => {
  assert.equal(formatAmount(500000), '5,000');
  assert.equal(formatAmount(125050), '1,250.50');
  assert.equal(formatAmount(100000000), '10,00,000');
  assert.equal(formatINR(500000), '\u20b95,000');
  assert.equal(formatINR(-200000), '-\u20b92,000');
  assert.equal(formatINR(0), '\u20b90');
});

test('paiseToInput round-trips through the parser', () => {
  for (const paise of [1, 99, 100, 4250, 125050, 100000000]) {
    const text = paiseToInput(paise);
    assert.equal(parseAmountToPaise(text).paise, paise, `round trip failed for ${paise}`);
  }
});

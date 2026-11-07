import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReminderText, formatTransactionSms, gsmSegments, smsDate } from '../../shared/sms.js';

// Local noon so the assertion does not depend on the machine's timezone.
const NOON = new Date(2026, 10, 7, 12, 0, 0).toISOString();

test('matches the SMS template from the brief', () => {
  const body = formatTransactionSms({
    customerName: 'Ramesh Kumar',
    amountPaise: 500000,
    type: 'GIVEN',
    occurredAt: NOON,
    netPaise: 500000,
  });
  assert.equal(body, 'Dear Ramesh Kumar, Rs.5,000 Gave on 07 Nov 2026. Net Balance: Rs.5,000.- KhataApp');
});

test('uses "Got" for payments received and the absolute balance', () => {
  const body = formatTransactionSms({
    customerName: 'Sita',
    amountPaise: 250050,
    type: 'GOT',
    occurredAt: NOON,
    netPaise: -125000,
  });
  assert.equal(body, 'Dear Sita, Rs.2,500.50 Got on 07 Nov 2026. Net Balance: Rs.1,250.- KhataApp');
});

test('falls back to a neutral name and caps name length', () => {
  assert.match(formatTransactionSms({ amountPaise: 100, type: 'GIVEN', occurredAt: NOON, netPaise: 100 }), /^Dear Customer,/);
  const long = 'A'.repeat(80);
  const body = formatTransactionSms({ customerName: long, amountPaise: 100, type: 'GIVEN', occurredAt: NOON, netPaise: 100 });
  assert.ok(body.length < 200);
});

test('smsDate is locale independent', () => {
  assert.equal(smsDate(NOON), '07 Nov 2026');
  assert.match(smsDate('nonsense'), /^\d{2} [A-Z][a-z]{2} \d{4}$/);
});

test('counts GSM segments', () => {
  assert.equal(gsmSegments('short'), 1);
  assert.equal(gsmSegments('a'.repeat(160)), 1);
  assert.equal(gsmSegments('a'.repeat(161)), 2);
  assert.equal(gsmSegments('a'.repeat(306)), 2);
  assert.equal(gsmSegments('a'.repeat(307)), 3);
});

test('reminder text fills the documented placeholders', () => {
  const text = formatReminderText({ shopName: 'Gupta Kirana', customerName: 'Ramesh', netPaise: 350000 });
  assert.equal(text, 'Namaste Ramesh, your balance with Gupta Kirana is Rs.3,500. Kindly settle when convenient. Thank you.');
  assert.equal(
    formatReminderText({ customerName: 'A', netPaise: 100, template: '{name} owes {balance} to {shop}' }),
    'A owes 1 to our shop',
  );
});

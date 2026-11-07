/**
 * Device SMS rules. The sending itself happens in the Android shell (SmsGateway),
 * so what is testable here is the decision, the message body and the result
 * plumbing that the ledger relies on to mark an entry "SMS sent" exactly once.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  entrySmsBody,
  hasDeviceSms,
  installSmsResultHandler,
  sendEntrySms,
  shouldSendEntrySms,
  smsQuota,
} from '../../src/js/sms.js';

const customer = { id: 'c1', name: 'Ramesh Kumar', phone_number: '+919876543210' };
const settings = { smsAlerts: true };

const transaction = (overrides = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  customer_id: 'c1',
  type: 'GIVEN',
  amount_paise: 50000,
  note: 'Rice',
  occurred_at: new Date(2026, 10, 7, 12, 0, 0).toISOString(),
  ...overrides,
});

const fakeBridge = () => ({ sendSms: () => {}, smsQuota: () => '{"sent":3,"cap":90}' });

test('no bridge means no SMS, because a browser has no SIM', () => {
  const decision = shouldSendEntrySms({ customer, transaction: transaction(), settings, bridge: null });
  assert.deepEqual(decision, { send: false, reason: 'no_device_sms' });
  assert.equal(hasDeviceSms(), false);
});

test('the toggle and the phone number both have to be there', () => {
  const bridge = fakeBridge();
  assert.equal(shouldSendEntrySms({ customer, transaction: transaction(), settings, bridge }).send, true);

  assert.deepEqual(
    shouldSendEntrySms({ customer, transaction: transaction(), settings: { smsAlerts: false }, bridge }),
    { send: false, reason: 'disabled' },
  );
  assert.deepEqual(
    shouldSendEntrySms({ customer: { ...customer, phone_number: null }, transaction: transaction(), settings, bridge }),
    { send: false, reason: 'no_phone' },
  );
});

test('an entry is texted once, never twice', () => {
  const bridge = fakeBridge();
  assert.deepEqual(
    shouldSendEntrySms({ customer, transaction: transaction({ sms_status: 'sent' }), settings, bridge }),
    { send: false, reason: 'already_sent' },
  );
  assert.deepEqual(
    shouldSendEntrySms({ customer, transaction: transaction({ sms_status: 'queued' }), settings, bridge }),
    { send: false, reason: 'in_flight' },
  );
  // A failed attempt may be retried by editing the entry again.
  assert.equal(
    shouldSendEntrySms({ customer, transaction: transaction({ sms_status: 'failed' }), settings, bridge }).send,
    true,
  );
});

test('a zero amount is not worth a text', () => {
  const decision = shouldSendEntrySms({
    customer,
    transaction: transaction({ amount_paise: 0 }),
    settings,
    bridge: fakeBridge(),
  });
  assert.deepEqual(decision, { send: false, reason: 'bad_amount' });
});

test('the body carries the balance after this entry', () => {
  const rows = [
    transaction({ id: 'a', amount_paise: 100000, type: 'GIVEN' }),
    transaction({ id: 'b', amount_paise: 40000, type: 'GOT' }),
  ];
  const body = entrySmsBody({ customer, transaction: rows[1], transactions: rows });
  assert.equal(body, 'Dear Ramesh Kumar, Rs.400 Got on 07 Nov 2026. Net Balance: Rs.600.- KhataApp');
});

test('the balance in the body ignores nothing else in the ledger', () => {
  const entry = transaction({ id: 'x', amount_paise: 50000 });
  const body = entrySmsBody({ customer, transaction: entry, transactions: [entry] });
  assert.match(body, /Net Balance: Rs\.500\.- KhataApp$/);
});

test('smsQuota parses the shell payload and survives nonsense', () => {
  assert.deepEqual(smsQuota(fakeBridge()), { sent: 3, cap: 90 });
  assert.equal(smsQuota({ smsQuota: () => 'not json' }), null);
  assert.equal(smsQuota({ smsQuota: () => '{"sent":"x"}' }), null);
  assert.equal(smsQuota(null), null);
});

test('a send resolves on the radio verdict, not on the queue acknowledgement', async () => {
  installSmsResultHandler();
  const bridge = fakeBridge();
  const entry = transaction();

  const promise = sendEntrySms({ transaction: entry, customer, transactions: [entry], bridge });
  globalThis.__khataSmsResult({ id: entry.id, status: 'queued' });
  globalThis.__khataSmsResult({ id: entry.id, status: 'sent', detail: null });

  const result = await promise;
  assert.deepEqual(result, { status: 'sent', detail: null });
});

test('a failed radio result is reported as failed with its detail', async () => {
  installSmsResultHandler();
  const entry = transaction({ id: '33333333-3333-4333-8333-333333333333' });
  const promise = sendEntrySms({ transaction: entry, customer, transactions: [entry], bridge: fakeBridge() });
  globalThis.__khataSmsResult(JSON.stringify({ id: entry.id, status: 'failed', detail: 'radio_error_1' }));
  assert.deepEqual(await promise, { status: 'failed', detail: 'radio_error_1' });
});

test('a bridge that throws does not leave the entry hanging', async () => {
  installSmsResultHandler();
  const entry = transaction({ id: '44444444-4444-4444-8444-444444444444' });
  const result = await sendEntrySms({
    transaction: entry,
    customer,
    transactions: [entry],
    bridge: {
      sendSms() {
        throw new Error('no sim');
      },
    },
  });
  assert.equal(result.status, 'error');
  assert.match(result.detail, /no sim/);
});

test('without a bridge the send reports unavailable rather than pretending', async () => {
  const entry = transaction({ id: '55555555-5555-4555-8555-555555555555' });
  const result = await sendEntrySms({ transaction: entry, customer, transactions: [entry], bridge: null });
  assert.deepEqual(result, { status: 'unavailable', detail: 'no_device_sms' });
});

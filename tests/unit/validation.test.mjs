import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  LIMITS,
  cleanText,
  isUuid,
  newId,
  normalizePhone,
  validateCustomer,
  validateSyncPayload,
  validateTransaction,
} from '../../shared/validation.js';

const NOW = Date.parse('2026-11-07T10:00:00Z');
const uuid = () => newId();

test('newId produces RFC 4122 v4 ids', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = newId();
    assert.ok(isUuid(id), `${id} is not a uuid`);
    assert.equal(id[14], '4');
    ids.add(id);
  }
  assert.equal(ids.size, 500);
  assert.equal(isUuid('nope'), false);
});

test('phone normalisation accepts the shapes shopkeepers type', () => {
  for (const input of ['9876543210', '+91 98765 43210', '919876543210', '0091-9876543210', '09876543210']) {
    const result = normalizePhone(input);
    assert.equal(result.ok, true, `rejected ${input}`);
    assert.equal(result.e164, '+919876543210');
  }
  for (const input of ['12345', '5876543210', '98765432100', '', 'abcdefghij']) {
    assert.equal(normalizePhone(input).ok, false, `accepted ${input}`);
  }
});

test('cleanText strips control characters and collapses whitespace', () => {
  assert.equal(cleanText('  Ramesh \n\t Kumar  '), 'Ramesh Kumar');
  assert.equal(cleanText(null), '');
  assert.equal(cleanText('a\u0000b'), 'a b');
});

test('customer validation enforces name and phone', () => {
  const ok = validateCustomer({ id: uuid(), name: ' Ramesh Kumar ', phone_number: '98765 43210' }, { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Ramesh Kumar');
  assert.equal(ok.value.phone_number, '+919876543210');

  const noName = validateCustomer({ id: uuid(), name: '   ' }, { now: NOW });
  assert.equal(noName.ok, false);
  assert.ok(noName.errors.includes('NAME_INVALID'));

  const longName = validateCustomer({ id: uuid(), name: 'x'.repeat(LIMITS.NAME_MAX + 1) }, { now: NOW });
  assert.ok(longName.errors.includes('NAME_INVALID'));

  const badPhone = validateCustomer({ id: uuid(), name: 'A', phone_number: '12345' }, { now: NOW });
  assert.ok(badPhone.errors.includes('PHONE_INVALID'));

  const badId = validateCustomer({ id: 'abc', name: 'A' }, { now: NOW });
  assert.ok(badId.errors.includes('ID_INVALID'));

  const generated = validateCustomer({ name: 'No Id' }, { now: NOW, requireId: false });
  assert.equal(generated.ok, true);
  assert.ok(isUuid(generated.value.id));
});

test('transaction validation handles rupees, paise and direction', () => {
  const fromRupees = validateTransaction(
    { id: uuid(), customer_id: uuid(), type: 'CREDIT', amount: '1,250.50', note: ' Groceries ' },
    { now: NOW },
  );
  assert.equal(fromRupees.ok, true);
  assert.equal(fromRupees.value.type, 'GIVEN');
  assert.equal(fromRupees.value.amount_paise, 125050);
  assert.equal(fromRupees.value.note, 'Groceries');

  const fromPaise = validateTransaction(
    { id: uuid(), customer_id: uuid(), type: 'GOT', amount_paise: 250000 },
    { now: NOW },
  );
  assert.equal(fromPaise.ok, true);
  assert.equal(fromPaise.value.amount_paise, 250000);

  const badType = validateTransaction({ id: uuid(), customer_id: uuid(), type: 'MAYBE', amount: '10' }, { now: NOW });
  assert.ok(badType.errors.includes('TYPE_INVALID'));

  const noCustomer = validateTransaction({ id: uuid(), type: 'GIVEN', amount: '10' }, { now: NOW });
  assert.ok(noCustomer.errors.includes('CUSTOMER_MISSING'));

  const future = validateTransaction(
    { id: uuid(), customer_id: uuid(), type: 'GIVEN', amount: '10', occurred_at: new Date(NOW + 5 * 86400000).toISOString() },
    { now: NOW },
  );
  assert.ok(future.errors.includes('DATE_INVALID'));

  const ancient = validateTransaction(
    { id: uuid(), customer_id: uuid(), type: 'GIVEN', amount: '10', occurred_at: '1999-01-01T00:00:00Z' },
    { now: NOW },
  );
  assert.ok(ancient.errors.includes('DATE_INVALID'));

  const longNote = validateTransaction(
    { id: uuid(), customer_id: uuid(), type: 'GIVEN', amount: '10', note: 'x'.repeat(LIMITS.NOTE_MAX + 1) },
    { now: NOW },
  );
  assert.ok(longNote.errors.includes('NOTE_TOO_LONG'));
});

test('sync payload keeps the good rows and reports the bad ones', () => {
  const good = { id: uuid(), name: 'Ramesh' };
  const bad = { id: 'not-a-uuid', name: '' };
  const tx = { id: uuid(), customer_id: good.id, type: 'GIVEN', amount: '500' };
  const brokenTx = { id: uuid(), customer_id: good.id, type: 'GIVEN', amount: '0' };

  const result = validateSyncPayload(
    {
      customers: [good, bad],
      transactions: [tx, brokenTx],
      deletions: [{ kind: 'transaction', id: tx.id }, { kind: 'wrong', id: tx.id }],
    },
    { now: NOW },
  );

  assert.equal(result.ok, true);
  assert.equal(result.accepted.customers.length, 1);
  assert.equal(result.accepted.transactions.length, 1);
  assert.equal(result.accepted.deletions.length, 1);
  assert.equal(result.rejected.length, 3);
  assert.deepEqual(
    result.rejected.map((row) => row.kind),
    ['customer', 'transaction', 'deletion'],
  );
});

test('sync payload refuses oversized batches', () => {
  const customers = Array.from({ length: LIMITS.BATCH_MAX + 1 }, () => ({ id: uuid(), name: 'A' }));
  const result = validateSyncPayload({ customers }, { now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['TOO_MANY_ITEMS']);
});

test('an empty payload is valid and empty', () => {
  const result = validateSyncPayload({}, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.total, 0);
  assert.deepEqual(result.rejected, []);
});

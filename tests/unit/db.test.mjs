/**
 * IndexedDB layer tests. fake-indexeddb supplies a spec-compliant implementation
 * in Node, so this exercises the real db.js code, not a stub.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import * as db from '../../src/js/db.js';

const customer = (overrides = {}) => ({
  id: crypto.randomUUID(),
  name: 'Ramesh Kumar',
  phone_number: '+919876543210',
  created_at: '2026-11-01T06:00:00.000Z',
  updated_at: '2026-11-01T06:00:00.000Z',
  synced: false,
  ...overrides,
});

const transaction = (customerId, overrides = {}) => ({
  id: crypto.randomUUID(),
  customer_id: customerId,
  type: 'GIVEN',
  amount_paise: 50000,
  note: 'Rice',
  occurred_at: '2026-11-02T06:00:00.000Z',
  created_at: '2026-11-02T06:00:00.000Z',
  synced: false,
  ...overrides,
});

after(async () => {
  await db.closeDb();
});

test('customers round-trip and default to unsynced', async () => {
  const row = customer();
  await db.putCustomer(row);
  const stored = await db.getCustomer(row.id);
  assert.equal(stored.name, 'Ramesh Kumar');
  assert.equal(stored.synced, false);
  assert.equal((await db.allCustomers()).length >= 1, true);
});

test('transactions are queryable per customer and counted as pending', async () => {
  const owner = customer({ name: 'Sita' });
  await db.putCustomer(owner);
  await db.putTransaction(transaction(owner.id));
  await db.putTransaction(transaction(owner.id, { type: 'GOT', amount_paise: 20000 }));

  const rows = await db.transactionsForCustomer(owner.id);
  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.customer_id === owner.id), true);

  const pending = await db.pendingRows();
  assert.ok(pending.customers.some((row) => row.id === owner.id));
  assert.equal(pending.transactions.filter((row) => row.customer_id === owner.id).length, 2);
  assert.ok((await db.pendingCount()) >= 3);
});

test('markSynced clears rows from the queue and is idempotent', async () => {
  const owner = customer({ name: 'Queue Test' });
  await db.putCustomer(owner);
  const tx = transaction(owner.id);
  await db.putTransaction(tx);

  await db.markSynced({ customerIds: [owner.id], transactionIds: [tx.id] });
  const pending = await db.pendingRows();
  assert.equal(pending.customers.some((row) => row.id === owner.id), false);
  assert.equal(pending.transactions.some((row) => row.id === tx.id), false);

  // Second call with ids that no longer exist must not throw.
  await db.markSynced({ customerIds: [owner.id], transactionIds: ['00000000-0000-4000-8000-000000000000'] });
  assert.equal((await db.getCustomer(owner.id)).synced, true);
});

test('deleting a synced transaction leaves a tombstone for the server', async () => {
  const owner = customer({ name: 'Tombstone' });
  await db.putCustomer(owner);
  const tx = transaction(owner.id, { synced: true });
  await db.putTransaction(tx);

  await db.deleteTransaction(tx.id);
  assert.equal(await db.getTransaction(tx.id), undefined);

  const pending = await db.pendingRows();
  const tombstone = pending.deletions.find((row) => row.ref_id === tx.id);
  assert.ok(tombstone, 'expected a deletion tombstone');
  assert.equal(tombstone.kind, 'transaction');

  await db.markSynced({ deletionKeys: [tombstone.key] });
  assert.equal((await db.pendingRows()).deletions.some((row) => row.ref_id === tx.id), false);
});

test('deleting a local-only transaction leaves no tombstone', async () => {
  const owner = customer({ name: 'Local Only' });
  await db.putCustomer(owner);
  const tx = transaction(owner.id, { synced: false });
  await db.putTransaction(tx);
  await db.deleteTransaction(tx.id);
  const pending = await db.pendingRows();
  assert.equal(pending.deletions.some((row) => row.ref_id === tx.id), false);
});

test('deleting a customer cascades to their transactions', async () => {
  const owner = customer({ name: 'Cascade', synced: true });
  await db.putCustomer(owner);
  const tx = transaction(owner.id, { synced: true });
  await db.putTransaction(tx);

  const result = await db.deleteCustomer(owner.id);
  assert.equal(result.removedTransactions, 1);
  assert.equal(await db.getCustomer(owner.id), undefined);
  assert.deepEqual(await db.transactionsForCustomer(owner.id), []);

  const pending = await db.pendingRows();
  assert.ok(pending.deletions.some((row) => row.kind === 'customer' && row.ref_id === owner.id));
  assert.ok(pending.deletions.some((row) => row.kind === 'transaction' && row.ref_id === tx.id));
});

test('logs append, list in order, and clear', async () => {
  await db.clearLogs();
  await db.appendLog({ ts: '2026-11-07T10:00:00.000Z', level: 'info', scope: 'test', message: 'first' });
  await db.appendLog({ ts: '2026-11-07T10:00:01.000Z', level: 'error', scope: 'test', message: 'second', data: { a: 1 } });
  const rows = await db.listLogs();
  assert.deepEqual(rows.map((row) => row.message), ['first', 'second']);
  assert.equal(await db.countLogs(), 2);
  await db.clearLogs();
  assert.equal(await db.countLogs(), 0);
});

test('pruneLogs keeps the newest entries', async () => {
  await db.clearLogs();
  for (let i = 0; i < 12; i += 1) {
    await db.appendLog({
      ts: new Date(Date.UTC(2026, 10, 7, 10, 0, i)).toISOString(),
      message: `line ${i}`,
    });
  }
  const removed = await db.pruneLogs(5);
  assert.equal(removed, 7);
  const rows = await db.listLogs();
  assert.equal(rows.length, 5);
  assert.equal(rows.at(-1).message, 'line 11');
});

test('settings persist through the store', async () => {
  await db.setSetting('theme', 'dark');
  await db.setSetting('apiToken', 'abc123');
  assert.equal(await db.getSetting('theme'), 'dark');
  assert.equal(await db.getSetting('missing'), undefined);
  const all = await db.allSettings();
  assert.equal(all.apiToken, 'abc123');
  await db.clearSettings();
  assert.deepEqual(await db.allSettings(), {});
});

test('backup export and merge import round-trip', async () => {
  const backup = await db.exportAll();
  assert.equal(backup.format, 'khata-backup');
  const customerCount = backup.customers.length;
  const transactionCount = backup.transactions.length;
  assert.ok(customerCount > 0 && transactionCount > 0);

  // Merge into the same database: existing ids are skipped, nothing duplicates.
  const merged = await db.importAll(backup, { mode: 'merge' });
  assert.deepEqual(merged, { customers: 0, transactions: 0 });

  // Restore into a wiped database: everything comes back as unsynced.
  await db.wipeAll({ keepSettings: true });
  assert.equal(await db.countCustomers(), 0);
  const restored = await db.importAll(backup, { mode: 'merge' });
  assert.equal(restored.customers, customerCount);
  assert.equal(restored.transactions, transactionCount);
  const pending = await db.pendingRows();
  assert.equal(pending.customers.length, customerCount);
  assert.equal(pending.transactions.length, transactionCount);
});

test('importAll refuses files that are not Khata backups', async () => {
  await assert.rejects(() => db.importAll({ hello: 'world' }), /Not a Khata backup/);
});

test('stats reports row counts', async () => {
  const counts = await db.stats();
  assert.equal(typeof counts.customers, 'number');
  assert.equal(typeof counts.transactions, 'number');
  assert.equal(typeof counts.logs, 'number');
});

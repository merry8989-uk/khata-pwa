/**
 * Attachments and the backup zip they travel in: real blobs in a real database
 * (fake-indexeddb), exported, read back and restored.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import * as db from '../../src/js/db.js';
import {
  ATTACHMENT_LIMITS,
  formatBytes,
  prepareAttachment,
  safeFileName,
} from '../../src/js/attachments.js';
import { readJsonEntry, readZip } from '../../src/js/zip-reader.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const TX_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TX = '33333333-3333-4333-8333-333333333333';

const fileOf = (name, type, bytes) => new File([new Uint8Array(bytes)], name, { type });

after(async () => {
  await db.closeDb();
});

test('names are made safe but stay readable', () => {
  assert.equal(safeFileName('bill 12/11.jpg'), 'bill 12_11.jpg', 'spaces survive, path characters do not');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName(null), 'file');
  assert.equal(safeFileName('बिल.pdf'), 'बिल.pdf');
});

test('sizes read the way a shopkeeper would say them', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('a picked file is validated before it is stored', async () => {
  const ok = await prepareAttachment(fileOf('bill.pdf', 'application/pdf', [0x25, 0x50, 0x44, 0x46]));
  assert.equal(ok.ok, true);
  assert.equal(ok.file.name, 'bill.pdf');
  assert.equal(ok.file.kind, 'PDF');
  assert.equal(ok.file.size, 4);
  assert.equal(ok.file.image, false);

  assert.deepEqual(await prepareAttachment(fileOf('empty.jpg', 'image/jpeg', [])), {
    ok: false,
    code: 'ATTACHMENT_EMPTY',
  });
  assert.deepEqual(await prepareAttachment(null), { ok: false, code: 'ATTACHMENT_INVALID' });

  const big = { name: 'huge.pdf', type: 'application/pdf', size: ATTACHMENT_LIMITS.MAX_BYTES + 1 };
  assert.deepEqual(await prepareAttachment(big), { ok: false, code: 'ATTACHMENT_TOO_LARGE' });
});

test('files are stored against the entry and read back by id', async () => {
  await db.putCustomer({ id: CUSTOMER_ID, name: 'Ramesh', created_at: '2026-11-01T06:00:00.000Z', synced: false });
  await db.putTransaction({ id: TX_ID, customer_id: CUSTOMER_ID, type: 'GIVEN', amount_paise: 50000, occurred_at: '2026-11-02T06:00:00.000Z', synced: false });

  await db.putAttachment({
    id: 'a1',
    transaction_id: TX_ID,
    customer_id: CUSTOMER_ID,
    name: 'bill.jpg',
    mime: 'image/jpeg',
    kind: 'Photo',
    size: 4,
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }),
  });

  const listed = await db.attachmentsForTransaction(TX_ID);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'bill.jpg');
  assert.equal(listed[0].blob, undefined, 'the listing carries metadata only');

  const stored = await db.getAttachment('a1');
  assert.deepEqual([...new Uint8Array(await stored.blob.arrayBuffer())], [1, 2, 3, 4]);

  const stats = await db.attachmentStats();
  assert.deepEqual(stats, { count: 1, bytes: 4 });
});

test('deleting an entry deletes its files, and a customer takes theirs along', async () => {
  await db.putAttachment({
    id: 'a2',
    transaction_id: OTHER_TX,
    customer_id: CUSTOMER_ID,
    name: 'order.pdf',
    mime: 'application/pdf',
    size: 3,
    blob: new Blob([new Uint8Array([9, 9, 9])]),
  });

  await db.deleteTransaction(TX_ID);
  assert.equal(await db.getAttachment('a1'), undefined, 'the entry took its file with it');
  assert.ok(await db.getAttachment('a2'), 'another entry keeps its own');

  await db.deleteCustomer(CUSTOMER_ID);
  assert.equal(await db.getAttachment('a2'), undefined, 'deleting the customer clears the rest');
  assert.equal((await db.attachmentStats()).count, 0);
});

test('a backup zip carries the ledger and every file, and restores both', async () => {
  await db.wipeAll({ keepSettings: true });
  await db.putCustomer({ id: CUSTOMER_ID, name: 'Ramesh', phone_number: '+919876543210', created_at: '2026-11-01T06:00:00.000Z', synced: true });
  await db.putTransaction({ id: TX_ID, customer_id: CUSTOMER_ID, type: 'GIVEN', amount_paise: 50000, note: 'Rice', occurred_at: '2026-11-02T06:00:00.000Z', synced: true });
  await db.putAttachment({
    id: 'a9',
    transaction_id: TX_ID,
    customer_id: CUSTOMER_ID,
    name: 'goods.jpg',
    mime: 'image/jpeg',
    kind: 'Photo',
    size: 5,
    blob: new Blob([new Uint8Array([7, 6, 5, 4, 3])], { type: 'image/jpeg' }),
  });

  const { blob, manifest, attachmentCount } = await db.exportBackupZip({ now: new Date('2026-11-09T10:00:00Z') });
  assert.equal(attachmentCount, 1);
  assert.equal(manifest.customers.length, 1);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const files = readZip(bytes);
  assert.deepEqual(
    [...files.keys()].sort(),
    ['attachments/a9-goods.jpg', 'manifest.json'],
  );
  const readBack = readJsonEntry(files, 'manifest.json');
  assert.equal(readBack.format, 'khata-backup-zip');
  assert.equal(readBack.attachments[0].name, 'goods.jpg');

  // Wipe everything, then restore from the zip alone.
  await db.wipeAll({ keepSettings: true });
  assert.equal((await db.allCustomers()).length, 0);

  const restored = await db.importBackupZip(bytes);
  assert.deepEqual(restored, { customers: 1, transactions: 1, attachments: 1 });
  assert.equal((await db.allCustomers())[0].name, 'Ramesh');
  const attachment = await db.getAttachment('a9');
  assert.deepEqual([...new Uint8Array(await attachment.blob.arrayBuffer())], [7, 6, 5, 4, 3]);
});

test('snapshots keep the newest four and report their size', async () => {
  for (let index = 0; index < 6; index += 1) {
    await db.saveBackupSnapshot({
      blob: new Blob([new Uint8Array(10)]),
      keep: 4,
      now: new Date(Date.UTC(2026, 10, 1 + index, 10, 0, 0)),
      meta: { customers: index },
    });
  }
  const backups = await db.listBackups();
  assert.equal(backups.length, 4, 'old snapshots are pruned');
  assert.equal(backups[0].created_at, '2026-11-06T10:00:00.000Z', 'newest first');
  const stats = await db.backupStats();
  assert.equal(stats.count, 4);
  assert.equal(stats.bytes, 40);
  assert.equal(stats.lastAt, '2026-11-06T10:00:00.000Z');
});

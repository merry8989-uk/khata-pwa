/**
 * The backup schedule, and the zip it writes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BACKUP_INTERVALS, isBackupDue } from '../../src/js/backup.js';
import { createZip } from '../../src/js/zip.js';
import { readJsonEntry, readZip } from '../../src/js/zip-reader.js';

const at = (iso) => new Date(iso);

test('off never backs up, and the first run always does', () => {
  assert.deepEqual(isBackupDue({ interval: 'off', now: at('2026-11-09T10:00:00Z') }), {
    due: false,
    reason: 'off',
  });
  assert.deepEqual(isBackupDue({ interval: 'weekly', lastAt: null, now: at('2026-11-09T10:00:00Z') }), {
    due: true,
    reason: 'never',
  });
  assert.deepEqual(isBackupDue({ interval: 'weekly', lastAt: 'nonsense', now: at('2026-11-09T10:00:00Z') }), {
    due: true,
    reason: 'never',
  });
});

test('weekly and monthly wait their turn', () => {
  const last = '2026-11-01T10:00:00Z';
  assert.equal(isBackupDue({ interval: 'weekly', lastAt: last, now: at('2026-11-05T10:00:00Z') }).due, false);
  assert.equal(isBackupDue({ interval: 'weekly', lastAt: last, now: at('2026-11-08T10:00:00Z') }).due, true);
  assert.equal(isBackupDue({ interval: 'monthly', lastAt: last, now: at('2026-11-20T10:00:00Z') }).due, false);
  assert.equal(isBackupDue({ interval: 'monthly', lastAt: last, now: at('2026-12-01T10:00:00Z') }).due, true);
});

test('automatic backs up after a change, but not twice in a day', () => {
  const last = '2026-11-08T10:00:00Z';
  // Changed an hour ago: wait, it was only just backed up.
  assert.deepEqual(
    isBackupDue({ interval: 'auto', lastAt: last, changedAt: '2026-11-09T09:00:00Z', now: at('2026-11-09T10:00:00Z') }),
    { due: false, reason: 'too_soon' },
  );
  // A week of quiet still gets a backup.
  assert.equal(
    isBackupDue({ interval: 'auto', lastAt: last, changedAt: last, now: at('2026-11-15T10:00:00Z') }).due,
    true,
  );
});

test('an unknown interval falls back to not backing up', () => {
  assert.equal(isBackupDue({ interval: 'hourly', lastAt: null }).due, false);
  assert.equal(BACKUP_INTERVALS.weekly.days, 7);
});

test('a zip written here reads back byte for byte, including binary', async () => {
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const zip = createZip([
    { name: 'manifest.json', data: JSON.stringify({ format: 'khata-backup-zip', customers: [] }) },
    { name: 'attachments/a1-bill.jpg', data: photo },
    { name: 'attachments/a2-order.pdf', data: '%PDF-1.4 fake' },
  ]);

  const files = readZip(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual([...files.keys()].sort(), [
    'attachments/a1-bill.jpg',
    'attachments/a2-order.pdf',
    'manifest.json',
  ]);
  assert.deepEqual([...files.get('attachments/a1-bill.jpg')], [...photo]);
  assert.equal(new TextDecoder().decode(files.get('attachments/a2-order.pdf')), '%PDF-1.4 fake');
  assert.equal(readJsonEntry(files, 'manifest.json').format, 'khata-backup-zip');
});

test('a missing manifest is a clear error, not a silent empty restore', async () => {
  const zip = createZip([{ name: 'readme.txt', data: 'nothing here' }]);
  const files = readZip(new Uint8Array(await zip.arrayBuffer()));
  assert.throws(() => readJsonEntry(files, 'manifest.json'), /missing manifest\.json/);
});

test('garbage is rejected as not a zip', () => {
  assert.throws(() => readZip(new Uint8Array([1, 2, 3, 4, 5])), /Not a zip file/);
});

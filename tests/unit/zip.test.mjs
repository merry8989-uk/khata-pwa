import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createZip, crc32 } from '../../src/js/zip.js';

test('crc32 matches the published value for "hello"', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

test('createZip writes a readable local header and central directory', async () => {
  const zip = createZip([
    { name: 'logs.txt', data: 'line one\nline two\n' },
    { name: 'meta.json', data: JSON.stringify({ ok: true }) },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);

  assert.equal(zip.type, 'application/zip');
  assert.equal(view.getUint32(0, true), 0x04034b50, 'local file header signature');

  // End of central directory record is the last 22 bytes with no comment.
  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'EOCD signature');
  assert.equal(view.getUint16(eocd + 8, true), 2, 'entry count (this disk)');
  assert.equal(view.getUint16(eocd + 10, true), 2, 'entry count (total)');

  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('logs.txt'));
  assert.ok(text.includes('meta.json'));
});

test('a stored entry carries the real crc and length', async () => {
  const payload = 'abc';
  const zip = createZip([{ name: 'a.txt', data: payload }]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(14, true), crc32(new TextEncoder().encode(payload)));
  assert.equal(view.getUint32(18, true), payload.length);
  assert.equal(view.getUint32(22, true), payload.length);
});

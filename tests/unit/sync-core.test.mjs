/**
 * Sync core against a fake Worker: verifies the queue is drained, retried
 * safely, and that a rejected row cannot block the queue forever.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import * as db from '../../src/js/db.js';
import { SyncError, flush, isConfigured, readConfig } from '../../src/js/sync-core.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const TX_ID = '22222222-2222-4222-8222-222222222222';

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// The server URL comes from the build (src/js/config.js) and the token is minted
// on the device, so tests pass a config instead of seeding settings.
const API = 'https://khata-api.test';

async function testConfig() {
  return readConfig({ apiBase: `${API}/` });
}

before(async () => {
  await db.wipeAll({ keepSettings: true });
  await db.clearSettings();
  await db.setSetting('autoSync', true);
  await db.setSetting('smsAlerts', true);
});

after(async () => {
  await db.closeDb();
});

async function seed() {
  await db.putCustomer({
    id: CUSTOMER_ID,
    name: 'Ramesh',
    phone_number: '+919876543210',
    created_at: '2026-11-01T06:00:00.000Z',
    synced: false,
  });
  await db.putTransaction({
    id: TX_ID,
    customer_id: CUSTOMER_ID,
    type: 'GIVEN',
    amount_paise: 50000,
    note: 'Rice',
    occurred_at: '2026-11-02T06:00:00.000Z',
    created_at: '2026-11-02T06:00:00.000Z',
    synced: false,
  });
}

test('readConfig takes the baked server and mints one device token', async () => {
  const config = await testConfig();
  assert.equal(config.apiBase, API, 'the trailing slash is trimmed');
  assert.match(config.apiToken, /^[A-Za-z0-9_-]{43}$/, 'a 256-bit device token');
  assert.equal(isConfigured(config), true);
  assert.equal(isConfigured({ apiBase: '' }), false, 'no baked URL means local-only');

  const again = await testConfig();
  assert.equal(again.apiToken, config.apiToken, 'the token is reused, never regenerated');
  assert.equal(await db.getSetting('deviceToken'), config.apiToken, 'it is kept on the device');
});

test('flush posts the queue with a bearer token and clears it on success', async () => {
  await seed();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({
      ok: true,
      accepted: { customers: [CUSTOMER_ID], transactions: [TX_ID], deletions: [] },
      rejected: [],
      sms: { provider: 'none', enabled: false, queued: 1 },
    });
  };

  const config = await testConfig();
  const result = await flush({ fetchImpl, config });
  assert.equal(result.ok, true);
  assert.deepEqual(result.accepted, { customers: 1, transactions: 1, deletions: 0 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://khata-api.test/api/sync');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${config.apiToken}`);
  assert.equal(calls[0].init.headers.authorization.includes('test-token'), false);

  const payload = JSON.parse(calls[0].init.body);
  assert.equal(payload.customers[0].id, CUSTOMER_ID);
  assert.equal(payload.transactions[0].amount_paise, 50000);
  assert.equal(payload.sms_alerts, true);

  assert.equal((await db.pendingRows()).transactions.length, 0);
  const second = await flush({ fetchImpl, config });
  assert.equal(second.skipped, 'empty');
  assert.equal(calls.length, 1, 'an empty queue must not call the network');
});

test('a replayed batch cannot duplicate rows (ids are client generated)', async () => {
  await db.markSynced({ customerIds: [CUSTOMER_ID], transactionIds: [TX_ID] });
  await db.putTransaction({
    id: TX_ID,
    customer_id: CUSTOMER_ID,
    type: 'GIVEN',
    amount_paise: 50000,
    occurred_at: '2026-11-02T06:00:00.000Z',
    synced: false,
  });
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(JSON.parse(init.body).transactions[0].id);
    return response({ accepted: { customers: [], transactions: [TX_ID], deletions: [] }, rejected: [] });
  };
  const config = await testConfig();
  await flush({ fetchImpl, config });
  await db.putTransaction({ id: TX_ID, customer_id: CUSTOMER_ID, type: 'GIVEN', amount_paise: 50000, synced: false });
  await flush({ fetchImpl, config });
  assert.deepEqual(seen, [TX_ID, TX_ID], 'the same id is resent, and the server dedupes it');
});

test('rejected rows are reported and removed from the queue', async () => {
  const badId = '33333333-3333-4333-8333-333333333333';
  await db.putTransaction({
    id: badId,
    customer_id: CUSTOMER_ID,
    type: 'GIVEN',
    amount_paise: 100,
    occurred_at: '2026-11-03T06:00:00.000Z',
    synced: false,
  });
  const fetchImpl = async () =>
    response({
      accepted: { customers: [], transactions: [], deletions: [] },
      rejected: [{ kind: 'transaction', id: badId, errors: ['AMOUNT_INVALID'] }],
    });

  const config = await testConfig();
  const result = await flush({ fetchImpl, config });
  assert.equal(result.rejected.length, 1);
  const pending = await db.pendingRows();
  assert.equal(
    pending.transactions.some((row) => row.id === badId),
    false,
    'an invalid row must not block the queue forever',
  );
});

test('a 401 is a non-retryable SyncError', async () => {
  await db.putTransaction({ id: '44444444-4444-4444-8444-444444444444', customer_id: CUSTOMER_ID, type: 'GOT', amount_paise: 100, synced: false });
  await assert.rejects(
    async () => flush({ fetchImpl: async () => response({ ok: false }, 401), config: await testConfig() }),
    (error) => {
      assert.ok(error instanceof SyncError);
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('a 500 is a retryable SyncError and the queue survives', async () => {
  const pendingBefore = (await db.pendingRows()).transactions.length;
  await assert.rejects(
    async () => flush({ fetchImpl: async () => response({ ok: false }, 500), config: await testConfig() }),
    (error) => {
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal((await db.pendingRows()).transactions.length, pendingBefore);
});

test('a network failure is a retryable SyncError', async () => {
  await assert.rejects(
    async () =>
      flush({
        fetchImpl: async () => {
          throw new Error('offline');
        },
        config: await testConfig(),
      }),
    (error) => {
      assert.equal(error.code, 'NETWORK');
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('nothing is sent when the build has no server', async () => {
  const result = await flush({
    fetchImpl: async () => {
      throw new Error('should not be called');
    },
    config: { apiBase: '', apiToken: 'irrelevant' },
  });
  assert.equal(result.skipped, 'not-configured');
});

/**
 * Worker handler tests against in-memory D1 and KV doubles.
 *
 * These exercise the real router, auth, provisioning and SMS-gating code. The SQL
 * itself is not executed (there is no SQLite here): the doubles record the
 * statements the Worker emits, and the assertions check both the HTTP behaviour
 * and the shape of the SQL (for example that inserts are ON CONFLICT DO NOTHING).
 * SQL semantics are therefore covered by the schema review, not by this file.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import worker from '../../worker/src/index.js';
import { generateDeviceToken, hashToken } from '../../src/js/shared/token.js';

function firstResult(sql) {
  if (/SELECT 1 AS ok/.test(sql)) return { ok: 1 };
  if (/COUNT\(\*\) AS n FROM sms_log/.test(sql)) return { n: 0 };
  if (/SUM\(CASE WHEN type/.test(sql)) return { net: 50000 };
  if (/COUNT\(\*\) FROM customers/.test(sql)) return { customers: 3, transactions: 7 };
  if (/FROM customers WHERE shop_id/.test(sql)) {
    return { id: 'c1', name: 'Ramesh', phone_number: '+919876543210', deleted: 0 };
  }
  return null;
}

function allResults(sql) {
  if (/FROM sms_log/.test(sql)) return [];
  return [];
}

function makeEnv(overrides = {}) {
  const kv = new Map();
  const statements = [];
  const d1 = {
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async run() {
          statements.push({ sql, params: statement.params });
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          statements.push({ sql, params: statement.params });
          return firstResult(sql);
        },
        async all() {
          statements.push({ sql, params: statement.params });
          return { results: allResults(sql) };
        },
      };
      return statement;
    },
    async batch(list) {
      for (const statement of list) statements.push({ sql: statement.sql, params: statement.params });
      return list.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };

  const env = {
    DB: d1,
    AUTH: {
      async get(key) {
        return kv.has(key) ? kv.get(key) : null;
      },
      async put(key, value) {
        kv.set(key, value);
      },
    },
    SMS_PROVIDER: 'none',
    SMS_DAILY_CAP: '200',
    ALLOWED_ORIGINS: '*',
    ...overrides,
  };

  return { env, kv, statements };
}

function makeCtx() {
  const pending = [];
  return { ctx: { waitUntil: (promise) => pending.push(promise) }, pending };
}

const customer = (id) => ({
  id,
  name: 'Ramesh Kumar',
  phone_number: '+919876543210',
  created_at: '2026-11-01T06:00:00.000Z',
  updated_at: '2026-11-01T06:00:00.000Z',
});

const transaction = (id, customerId) => ({
  id,
  customer_id: customerId,
  type: 'GIVEN',
  amount_paise: 50000,
  note: 'Rice',
  occurred_at: '2026-11-02T06:00:00.000Z',
  created_at: '2026-11-02T06:00:00.000Z',
});

async function post(env, ctx, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`https://khata-api.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, ctx);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function get(env, ctx, path, token) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await worker.fetch(new Request(`https://khata-api.test${path}`, { headers }), env, ctx);
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const TX_ID = '22222222-2222-4222-8222-222222222222';

test('health reports real dependency state without a token', async () => {
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  const result = await get(env, ctx, '/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.checks.db, 'ok');
  assert.equal(result.body.checks.kv, 'ok');
  assert.equal(result.body.checks.sms.provider, 'none');
});

test('OPTIONS answers the preflight with CORS headers', async () => {
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  const response = await worker.fetch(
    new Request('https://khata-api.test/api/sync', {
      method: 'OPTIONS',
      headers: { origin: 'https://merry8989-uk.github.io' },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('a write without a token is refused', async () => {
  const { env, kv } = makeEnv();
  const { ctx } = makeCtx();
  const result = await post(env, ctx, '/api/sync', { customers: [customer(CUSTOMER_ID)] });
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'missing_token');
  assert.equal(kv.size, 0);
});

test('a malformed token is refused and provisions nothing', async () => {
  const { env, kv } = makeEnv();
  const { ctx } = makeCtx();
  const result = await post(env, ctx, '/api/sync', { customers: [customer(CUSTOMER_ID)] }, 'not-a-device-token');
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'invalid_token');
  assert.equal(kv.size, 0);
});

test('the first write from a new device provisions its shop, once', async () => {
  const { env, kv, statements } = makeEnv();
  const { ctx } = makeCtx();
  const token = generateDeviceToken();

  const first = await post(
    env,
    ctx,
    '/api/sync',
    { customers: [customer(CUSTOMER_ID)], transactions: [transaction(TX_ID, CUSTOMER_ID)] },
    token,
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.match(first.body.shop_id, /^shop_[0-9a-f]{24}$/);
  assert.deepEqual(first.body.accepted.customers, [CUSTOMER_ID]);
  assert.deepEqual(first.body.accepted.transactions, [TX_ID]);

  const hash = await hashToken(token);
  assert.equal(kv.size, 1, 'one KV entry for the device');
  assert.equal(kv.get(`shop:${hash}`), first.body.shop_id, 'the raw token is never the KV key');
  assert.equal(kv.has(`shop:${token}`), false, 'the token itself is not stored');

  const inserts = statements.filter((entry) => /INSERT INTO transactions/.test(entry.sql));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /ON CONFLICT\(shop_id, id\) DO NOTHING/, 'a replayed batch cannot duplicate an entry');
  const customerUpserts = statements.filter((entry) => /INSERT INTO customers/.test(entry.sql));
  assert.equal(customerUpserts.length, 1);
  assert.match(customerUpserts[0].sql, /ON CONFLICT\(shop_id, id\) DO UPDATE/);

  const second = await post(env, ctx, '/api/sync', { customers: [customer(CUSTOMER_ID)] }, token);
  assert.equal(second.status, 200);
  assert.equal(second.body.shop_id, first.body.shop_id, 'the same device keeps its shop');
  assert.equal(kv.size, 1, 'no second shop was created');
});

test('a read never provisions a shop', async () => {
  const { env, kv } = makeEnv();
  const { ctx } = makeCtx();
  const result = await get(env, ctx, '/api/whoami', generateDeviceToken());
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'unknown_token');
  assert.equal(kv.size, 0);
});

test('whoami reports the shop and its counts after a write', async () => {
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  const token = generateDeviceToken();
  const write = await post(env, ctx, '/api/sync', { customers: [customer(CUSTOMER_ID)] }, token);
  const who = await get(env, ctx, '/api/whoami', token);
  assert.equal(who.status, 200);
  assert.equal(who.body.shop_id, write.body.shop_id);
  assert.deepEqual(who.body.counts, { customers: 3, transactions: 7 });
});

test('SMS is not attempted when no provider is configured, and says so', async () => {
  const { env } = makeEnv();
  const { ctx, pending } = makeCtx();
  const token = generateDeviceToken();
  const result = await post(
    env,
    ctx,
    '/api/sync',
    { customers: [customer(CUSTOMER_ID)], transactions: [transaction(TX_ID, CUSTOMER_ID)], sms_alerts: true },
    token,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.sms.enabled, false);
  assert.equal(result.body.sms.provider, 'none');
  assert.equal(result.body.sms.note, 'sms_disabled');
  await Promise.all(pending);
});

test('invalid rows are reported per item and the good ones still land', async () => {
  const { env } = makeEnv();
  const { ctx } = makeCtx();
  const token = generateDeviceToken();
  const result = await post(
    env,
    ctx,
    '/api/sync',
    {
      customers: [customer(CUSTOMER_ID), { id: 'nope', name: '' }],
      transactions: [transaction(TX_ID, CUSTOMER_ID), { id: TX_ID, customer_id: CUSTOMER_ID, type: 'GIVEN', amount: '0' }],
    },
    token,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted.customers.length, 1);
  assert.equal(result.body.accepted.transactions.length, 1);
  assert.equal(result.body.rejected.length, 2);
});

test('an oversized batch is refused before touching the database', async () => {
  const { env, statements } = makeEnv();
  const { ctx } = makeCtx();
  const customers = Array.from({ length: 201 }, (_, index) =>
    customer(`3333333${String(index).padStart(1, '0')}-3333-4333-8333-333333333333`),
  );
  const result = await post(env, ctx, '/api/sync', { customers }, generateDeviceToken());
  assert.equal(result.status, 413);
  assert.equal(result.body.error, 'TOO_MANY_ITEMS');
  assert.equal(statements.length, 0, 'nothing reached D1');
});

test('the optional operator token maps to the configured shop', async () => {
  const { env, kv } = makeEnv({ SHOP_TOKEN: 'operator-secret', SHOP_ID: 'default' });
  const { ctx } = makeCtx();
  const result = await post(env, ctx, '/api/sync', { customers: [customer(CUSTOMER_ID)] }, 'operator-secret');
  assert.equal(result.status, 200);
  assert.equal(result.body.shop_id, 'default');
  assert.equal(kv.size, 0, 'the operator token is not written to KV');
});

test('deletions become soft deletes, never row removals', async () => {
  const { env, statements } = makeEnv();
  const { ctx } = makeCtx();
  const token = generateDeviceToken();
  await post(
    env,
    ctx,
    '/api/sync',
    { customers: [customer(CUSTOMER_ID)], deletions: [{ kind: 'customer', id: CUSTOMER_ID }] },
    token,
  );
  const deletes = statements.filter((entry) => /UPDATE customers SET deleted = 1/.test(entry.sql));
  assert.equal(deletes.length, 1);
  assert.equal(statements.some((entry) => /DELETE FROM/.test(entry.sql)), false);
});

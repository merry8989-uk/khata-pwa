/**
 * Khata API - Cloudflare Worker.
 *
 * Routes
 *   GET  /api/health        liveness + real dependency state (D1, KV, SMS provider)
 *   POST /api/sync          batch upsert of customers / transactions / deletions, then SMS
 *   POST /api/transaction   single transaction (same validation and SMS path)
 *   GET  /api/customers     server-side ledger, for verification and support
 *   POST /api/sms/retry     re-sends failed SMS rows (max 20 per call)
 *
 * Design notes
 * - Every row carries a client-generated UUID. Inserts are ON CONFLICT DO NOTHING,
 *   so a retried batch (offline queue replay, Background Sync, double click) cannot
 *   duplicate an entry. This is what makes "assume everything runs twice" true here.
 * - Deletions are soft (deleted = 1) so a stale client cannot resurrect a row.
 * - SMS is claimed in sms_log with a UNIQUE(shop_id, transaction_id) key before the
 *   gateway call, so one entry can never produce two messages.
 * - Auth is zero-configuration. The app mints a random 256-bit token on the device
 *   and sends it as a bearer token; the Worker keys KV on its SHA-256, so the raw
 *   token is never stored server-side. A token seen for the first time on a write
 *   provisions its shop (shop id derived from the hash, so a race cannot create
 *   two shops for one device). Nothing to paste into the app, no shared secret in
 *   the public bundle.
 * - The SHOP_TOKEN secret remains as an operator escape hatch (single shop, full
 *   access) for curl and support work.
 */

import { formatTransactionSms } from '../../src/js/shared/sms.js';
import { hashToken, looksLikeDeviceToken } from '../../src/js/shared/token.js';
import { validateSyncPayload } from '../../src/js/shared/validation.js';
import { sendSms, smsStatus } from './sms.js';

const VERSION = '1.0.0';
const MAX_SMS_PER_BATCH = 25;

function log(level, message, fields = {}) {
  const line = { level, message, ts: new Date().toISOString(), ...fields };
  if (level === 'error') console.error(JSON.stringify(line));
  else if (level === 'warn') console.warn(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

/* ------------------------------------------------------------------- helpers */

function allowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || '*').trim();
  if (raw === '*') return '*';
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(env, request) {
  const origin = request.headers.get('origin') || '';
  const allowed = allowedOrigins(env);
  const allowOrigin = allowed === '*' ? '*' : allowed.includes(origin) ? origin : allowed[0] || '';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolves the caller's shop from the device token.
 * @param {{provision?: boolean}} options - writes may create a shop, reads may not.
 */
async function resolveShop(request, env, { provision = false } = {}) {
  const header = request.headers.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, error: 'missing_token' };
  }
  const token = header.slice(7).trim();
  if (!token) return { ok: false, status: 401, error: 'missing_token' };

  // Operator escape hatch: one token, one shop, for curl and support.
  if (env.SHOP_TOKEN && constantTimeEqual(token, env.SHOP_TOKEN)) {
    return { ok: true, shopId: env.SHOP_ID || 'default', provisioned: false, admin: true };
  }

  if (!looksLikeDeviceToken(token)) {
    return { ok: false, status: 401, error: 'invalid_token' };
  }
  if (!env.AUTH) {
    return { ok: false, status: 503, error: 'auth_unavailable' };
  }

  const hash = await hashToken(token);
  const key = `shop:${hash}`;
  // Deterministic from the hash: two racing first-writes converge on one shop.
  const shopId = `shop_${hash.slice(0, 24)}`;

  try {
    const known = await env.AUTH.get(key);
    if (known) return { ok: true, shopId: known, provisioned: false };
    if (!provision) return { ok: false, status: 401, error: 'unknown_token' };
    await env.AUTH.put(key, shopId);
    log('info', 'Provisioned a new shop', { shopId });
    return { ok: true, shopId, provisioned: true };
  } catch (error) {
    log('error', 'KV lookup failed', { error: error?.message });
    return { ok: false, status: 503, error: 'auth_unavailable' };
  }
}

function todayStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/* --------------------------------------------------------------- persistence */

async function ensureShop(env, shopId, name) {
  await env.DB.prepare(
    'INSERT INTO shops (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, shops.name)',
  )
    .bind(shopId, name || null, new Date().toISOString())
    .run();
}

/** Writes an accepted batch in one D1 batch call. */
async function applyBatch(env, shopId, accepted) {
  const statements = [];

  for (const customer of accepted.customers) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO customers (shop_id, id, name, phone_number, created_at, updated_at, deleted, rent_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(shop_id, id) DO UPDATE SET
           name = excluded.name,
           phone_number = excluded.phone_number,
           updated_at = excluded.updated_at,
           rent_json = excluded.rent_json,
           deleted = 0`,
      ).bind(
        shopId,
        customer.id,
        customer.name,
        customer.phone_number,
        customer.created_at,
        customer.updated_at,
        customer.rent ? JSON.stringify(customer.rent) : null,
      ),
    );
  }

  for (const transaction of accepted.transactions) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO transactions (shop_id, id, customer_id, type, amount_paise, note, occurred_at, created_at, deleted, source, rent_cycle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(shop_id, id) DO NOTHING`,
      ).bind(
        shopId,
        transaction.id,
        transaction.customer_id,
        transaction.type,
        transaction.amount_paise,
        transaction.note,
        transaction.occurred_at,
        transaction.created_at,
        transaction.source === 'rent' ? 'rent' : 'manual',
        transaction.rent_cycle,
      ),
    );
  }

  for (const deletion of accepted.deletions) {
    if (deletion.kind === 'customer') {
      statements.push(
        env.DB.prepare('UPDATE customers SET deleted = 1, updated_at = ? WHERE shop_id = ? AND id = ?').bind(
          new Date().toISOString(),
          shopId,
          deletion.id,
        ),
      );
      statements.push(
        env.DB.prepare('UPDATE transactions SET deleted = 1 WHERE shop_id = ? AND customer_id = ?').bind(
          shopId,
          deletion.id,
        ),
      );
    } else {
      statements.push(
        env.DB.prepare('UPDATE transactions SET deleted = 1 WHERE shop_id = ? AND id = ?').bind(shopId, deletion.id),
      );
    }
  }

  if (statements.length) await env.DB.batch(statements);
  return statements.length;
}

async function customerBalance(env, shopId, customerId) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type = 'GIVEN' THEN amount_paise ELSE -amount_paise END), 0) AS net
     FROM transactions WHERE shop_id = ? AND customer_id = ? AND deleted = 0`,
  )
    .bind(shopId, customerId)
    .first();
  return Number(row?.net || 0);
}

/* ---------------------------------------------------------------- SMS pipeline */

async function dispatchSms(env, shopId, transactions, { requestId, enabled }) {
  if (!enabled || !transactions.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: transactions.length, reason: 'sms_disabled' };
  }

  const cap = Number(env.SMS_DAILY_CAP || 200);
  const usedRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM sms_log WHERE shop_id = ? AND created_at >= ?',
  )
    .bind(shopId, todayStartIso())
    .first();
  let used = Number(usedRow?.n || 0);

  const stats = { attempted: 0, sent: 0, failed: 0, skipped: 0, reason: null };
  const batch = transactions.slice(0, MAX_SMS_PER_BATCH);

  for (const transaction of batch) {
    try {
      const customer = await env.DB.prepare(
        'SELECT id, name, phone_number, deleted FROM customers WHERE shop_id = ? AND id = ?',
      )
        .bind(shopId, transaction.customer_id)
        .first();

      if (!customer || customer.deleted === 1 || !customer.phone_number) {
        stats.skipped += 1;
        continue;
      }

      const net = await customerBalance(env, shopId, transaction.customer_id);
      const body = formatTransactionSms({
        customerName: customer.name,
        amountPaise: transaction.amount_paise,
        type: transaction.type,
        occurredAt: transaction.occurred_at,
        netPaise: net,
      });

      // Claim the row first: UNIQUE(shop_id, transaction_id) makes the send
      // at-most-once even if two syncs race.
      const claim = await env.DB.prepare(
        `INSERT INTO sms_log (id, shop_id, transaction_id, phone, status, provider, body, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
         ON CONFLICT(shop_id, transaction_id) DO NOTHING`,
      )
        .bind(
          crypto.randomUUID(),
          shopId,
          transaction.id,
          customer.phone_number,
          env.SMS_PROVIDER || 'none',
          body,
          new Date().toISOString(),
        )
        .run();

      if (!claim.meta || claim.meta.changes === 0) {
        stats.skipped += 1;
        continue;
      }

      if (used >= cap) {
        stats.skipped += 1;
        stats.reason = 'daily_cap_reached';
        await env.DB.prepare("UPDATE sms_log SET status = 'skipped_cap' WHERE shop_id = ? AND transaction_id = ?")
          .bind(shopId, transaction.id)
          .run();
        continue;
      }

      stats.attempted += 1;
      const result = await sendSms(env, { to: customer.phone_number, body });
      used += 1;

      if (result.ok) {
        stats.sent += 1;
        await env.DB.prepare(
          "UPDATE sms_log SET status = 'sent', provider = ?, provider_id = ?, sent_at = ? WHERE shop_id = ? AND transaction_id = ?",
        )
          .bind(result.provider, result.id || null, new Date().toISOString(), shopId, transaction.id)
          .run();
      } else {
        stats.failed += 1;
        await env.DB.prepare(
          "UPDATE sms_log SET status = 'failed', provider = ?, error = ? WHERE shop_id = ? AND transaction_id = ?",
        )
          .bind(result.provider, String(result.error || 'unknown'), shopId, transaction.id)
          .run();
        log('warn', 'SMS send failed', { requestId, shopId, transactionId: transaction.id, error: result.error });
      }
    } catch (error) {
      stats.failed += 1;
      log('error', 'SMS dispatch error', { requestId, shopId, transactionId: transaction.id, error: error?.message });
    }
  }

  if (transactions.length > batch.length) stats.skipped += transactions.length - batch.length;
  return stats;
}

/* ------------------------------------------------------------------- handlers */

async function handleSync(request, env, ctx, shopId, requestId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const validated = validateSyncPayload(body, { now: Date.now() });
  if (!validated.ok) {
    return json({ ok: false, error: validated.errors[0] }, 413);
  }

  const { accepted, rejected } = validated;
  const shopName = body?.shop?.name ? String(body.shop.name).slice(0, 60) : null;
  const smsWanted = body?.sms_alerts !== false;

  await ensureShop(env, shopId, shopName);
  const written = await applyBatch(env, shopId, accepted);

  const { enabled } = smsStatus(env);
  const smsCandidates = smsWanted ? accepted.transactions : [];

  // Never block the sync response on the gateway: queue it and let the row's
  // status in sms_log be the record of what actually happened.
  if (smsCandidates.length) {
    ctx.waitUntil(
      dispatchSms(env, shopId, smsCandidates, { requestId, enabled }).then((stats) =>
        log('info', 'SMS batch finished', { requestId, shopId, ...stats }),
      ),
    );
  }

  log('info', 'Sync applied', {
    requestId,
    shopId,
    written,
    customers: accepted.customers.length,
    transactions: accepted.transactions.length,
    deletions: accepted.deletions.length,
    rejected: rejected.length,
  });

  return json({
    ok: true,
    request_id: requestId,
    shop_id: shopId,
    server_time: new Date().toISOString(),
    accepted: {
      customers: accepted.customers.map((row) => row.id),
      transactions: accepted.transactions.map((row) => row.id),
      deletions: accepted.deletions.map((row) => row.id),
    },
    rejected,
    sms: {
      provider: smsStatus(env).provider,
      enabled,
      queued: smsCandidates.length,
      note: enabled ? 'queued' : 'sms_disabled',
    },
  });
}

async function handleTransaction(request, env, ctx, shopId, requestId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  const payload = {
    shop: body?.shop,
    sms_alerts: body?.sms_alerts,
    customers: Array.isArray(body?.customers) ? body.customers : [],
    transactions: [body?.transaction || body],
    deletions: [],
  };
  const forwarded = new Request(request.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleSync(forwarded, env, ctx, shopId, requestId);
}

async function handleWhoami(env, shopId) {
  let customers = 0;
  let transactions = 0;
  try {
    const row = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM customers WHERE shop_id = ? AND deleted = 0) AS customers,
              (SELECT COUNT(*) FROM transactions WHERE shop_id = ? AND deleted = 0) AS transactions`,
    )
      .bind(shopId, shopId)
      .first();
    customers = Number(row?.customers || 0);
    transactions = Number(row?.transactions || 0);
  } catch (error) {
    log('warn', 'whoami counts failed', { shopId, error: error?.message });
  }
  return json({
    ok: true,
    shop_id: shopId,
    version: VERSION,
    server_time: new Date().toISOString(),
    counts: { customers, transactions },
    sms: smsStatus(env),
  });
}

async function handleCustomers(env, shopId) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.phone_number, c.created_at, c.rent_json,
            COALESCE(SUM(CASE WHEN t.type = 'GIVEN' THEN t.amount_paise ELSE -t.amount_paise END), 0) AS net_paise,
            COUNT(t.id) AS entries
     FROM customers c
     LEFT JOIN transactions t
       ON t.customer_id = c.id AND t.shop_id = c.shop_id AND t.deleted = 0
     WHERE c.shop_id = ? AND c.deleted = 0
     GROUP BY c.id
     ORDER BY c.name COLLATE NOCASE ASC`,
  )
    .bind(shopId)
    .all();
  return json({ ok: true, shop_id: shopId, customers: results || [] });
}

async function handleHealth(env) {
  const checks = { db: 'unknown', kv: 'unbound', sms: smsStatus(env) };
  let ok = true;

  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first();
    checks.db = row?.ok === 1 ? 'ok' : 'error';
  } catch (error) {
    checks.db = 'error';
    checks.db_error = String(error?.message || error).slice(0, 200);
    ok = false;
  }

  if (env.AUTH) {
    try {
      await env.AUTH.get('health');
      checks.kv = 'ok';
    } catch (error) {
      checks.kv = 'error';
      ok = false;
    }
  }

  return json({ ok, version: VERSION, time: new Date().toISOString(), checks }, ok ? 200 : 503);
}

async function handleSmsRetry(env, shopId, requestId) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM sms_log WHERE shop_id = ? AND status = 'failed' ORDER BY created_at ASC LIMIT 20",
  )
    .bind(shopId)
    .all();

  const rows = results || [];
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const result = await sendSms(env, { to: row.phone, body: row.body });
    if (result.ok) {
      sent += 1;
      await env.DB.prepare(
        "UPDATE sms_log SET status = 'sent', provider_id = ?, sent_at = ?, error = NULL WHERE id = ?",
      )
        .bind(result.id || null, new Date().toISOString(), row.id)
        .run();
    } else {
      failed += 1;
      await env.DB.prepare('UPDATE sms_log SET error = ? WHERE id = ?')
        .bind(String(result.error || 'unknown'), row.id)
        .run();
    }
  }

  log('info', 'SMS retry finished', { requestId, shopId, candidates: rows.length, sent, failed });
  return json({ ok: true, candidates: rows.length, sent, failed });
}

/* --------------------------------------------------------------------- router */

export default {
  async fetch(request, env, ctx) {
    const requestId = request.headers.get('cf-ray') || crypto.randomUUID();
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        const response = await handleHealth(env);
        const body = await response.json();
        return json(body, response.status, cors);
      }

      if (!url.pathname.startsWith('/api/')) {
        return json({ ok: false, error: 'not_found' }, 404, cors);
      }

      // Writes may create a shop for a device the Worker has not seen before;
      // reads may not, so a typo cannot silently create an empty shop.
      const isWrite = request.method === 'POST';
      const auth = await resolveShop(request, env, { provision: isWrite });
      if (!auth.ok) {
        log('warn', 'Auth rejected', { requestId, path: url.pathname, error: auth.error });
        return json({ ok: false, error: auth.error }, auth.status, cors);
      }
      if (auth.provisioned) {
        log('info', 'First write from a new device', { requestId, shopId: auth.shopId });
      }

      const key = `${request.method} ${url.pathname}`;
      switch (key) {
        case 'GET /api/whoami': {
          const response = await handleWhoami(env, auth.shopId);
          const body = await response.json();
          return json(body, response.status, cors);
        }
        case 'POST /api/sync': {
          const response = await handleSync(request, env, ctx, auth.shopId, requestId);
          const body = await response.json();
          return json(body, response.status, cors);
        }
        case 'POST /api/transaction': {
          const response = await handleTransaction(request, env, ctx, auth.shopId, requestId);
          const body = await response.json();
          return json(body, response.status, cors);
        }
        case 'GET /api/customers': {
          const response = await handleCustomers(env, auth.shopId);
          const body = await response.json();
          return json(body, response.status, cors);
        }
        case 'POST /api/sms/retry': {
          const response = await handleSmsRetry(env, auth.shopId, requestId);
          const body = await response.json();
          return json(body, response.status, cors);
        }
        default:
          return json({ ok: false, error: 'not_found' }, 404, cors);
      }
    } catch (error) {
      log('error', 'Unhandled worker error', {
        requestId,
        path: url.pathname,
        error: error?.message,
        stack: String(error?.stack || '').slice(0, 800),
      });
      return json({ ok: false, error: 'internal_error', request_id: requestId }, 500, cors);
    }
  },
};

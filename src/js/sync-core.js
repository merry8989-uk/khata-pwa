/**
 * The sync core. Deliberately free of DOM APIs so the same code runs in the page
 * and inside the service worker's Background Sync handler.
 *
 * Contract with the Worker: POST {apiBase}/api/sync with
 *   { customers: [...], transactions: [...], deletions: [...] }
 * and a bearer token. The Worker is idempotent per row id, so a retried batch is
 * safe; the response lists which ids it accepted.
 */

import { allSettings, markSynced, pendingRows } from './db.js';

export const SYNC_TIMEOUT_MS = 15000;
export const MAX_ATTEMPTS = 5;

export class SyncError extends Error {
  constructor(message, { status = 0, code = 'SYNC_FAILED', retryable = true } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export async function readConfig() {
  const stored = await allSettings();
  return {
    apiBase: String(stored.apiBase || '')
      .trim()
      .replace(/\/+$/, ''),
    apiToken: String(stored.apiToken || '').trim(),
    autoSync: stored.autoSync !== false,
    smsAlerts: stored.smsAlerts !== false,
    shopName: String(stored.shopName || '').trim(),
  };
}

export function isConfigured(config) {
  return Boolean(config?.apiBase && config?.apiToken);
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function toCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    phone_number: row.phone_number || null,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  };
}

function toTransaction(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    type: row.type,
    amount_paise: row.amount_paise,
    note: row.note || '',
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

/**
 * Pushes every unsynced row to the Worker.
 * @returns {Promise<{ok:boolean, skipped?:string, pending:number, accepted?:object, rejected?:Array, at:string}>}
 */
export async function flush({ fetchImpl = globalThis.fetch, config } = {}) {
  const cfg = config || (await readConfig());
  if (!isConfigured(cfg)) {
    return { ok: true, skipped: 'not-configured', pending: 0, at: new Date().toISOString() };
  }

  const rows = await pendingRows();
  const total = rows.customers.length + rows.transactions.length + rows.deletions.length;
  if (total === 0) {
    return { ok: true, skipped: 'empty', pending: 0, at: new Date().toISOString() };
  }

  const payload = {
    shop: { name: cfg.shopName || null },
    sms_alerts: cfg.smsAlerts,
    customers: rows.customers.map(toCustomer),
    transactions: rows.transactions.map(toTransaction),
    deletions: rows.deletions.map((row) => ({ kind: row.kind, id: row.ref_id })),
  };

  let response;
  try {
    response = await fetchImpl(`${cfg.apiBase}/api/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiToken}`,
      },
      body: JSON.stringify(payload),
      signal: timeoutSignal(SYNC_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    throw new SyncError(error?.name === 'AbortError' ? 'Sync timed out' : 'Network error while syncing', {
      code: 'NETWORK',
      retryable: true,
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new SyncError('Sync token rejected', { status: response.status, code: 'UNAUTHORIZED', retryable: false });
  }
  if (response.status === 429) {
    throw new SyncError('Rate limited by the sync server', { status: 429, code: 'RATE_LIMITED', retryable: true });
  }
  if (!response.ok) {
    throw new SyncError(`Sync server returned ${response.status}`, {
      status: response.status,
      code: 'HTTP',
      retryable: response.status >= 500,
    });
  }

  const body = await response.json().catch(() => ({}));
  const accepted = body.accepted || {};
  const acceptedCustomers = Array.isArray(accepted.customers) ? accepted.customers : [];
  const acceptedTransactions = Array.isArray(accepted.transactions) ? accepted.transactions : [];
  const acceptedDeletions = Array.isArray(accepted.deletions) ? accepted.deletions : [];
  const rejected = Array.isArray(body.rejected) ? body.rejected : [];

  // Rows the server refused (bad data) are marked synced too: retrying an invalid
  // row forever would block the queue. They stay on the device and are logged.
  const rejectedCustomerIds = rejected.filter((r) => r.kind === 'customer').map((r) => r.id);
  const rejectedTransactionIds = rejected.filter((r) => r.kind === 'transaction').map((r) => r.id);
  const rejectedDeletionIds = rejected.filter((r) => r.kind === 'deletion').map((r) => r.id);

  const deletionKeyByRef = new Map(rows.deletions.map((row) => [row.ref_id, row.key]));

  await markSynced({
    customerIds: [...acceptedCustomers, ...rejectedCustomerIds].filter(Boolean),
    transactionIds: [...acceptedTransactions, ...rejectedTransactionIds].filter(Boolean),
    deletionKeys: [...acceptedDeletions, ...rejectedDeletionIds]
      .map((id) => deletionKeyByRef.get(id))
      .filter(Boolean),
  });

  return {
    ok: true,
    pending: 0,
    accepted: {
      customers: acceptedCustomers.length,
      transactions: acceptedTransactions.length,
      deletions: acceptedDeletions.length,
    },
    rejected,
    sms: body.sms || null,
    at: new Date().toISOString(),
  };
}

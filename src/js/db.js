/**
 * IndexedDB data layer. This is the source of truth on the device: the app reads
 * and writes here first, and the sync engine copies rows to the Worker later.
 *
 * No third-party wrapper (no Dexie, no CDN script) - the app must work with the
 * network off, so the storage code has to be in the precache, not fetched.
 *
 * Rows carry `synced: false` until the Worker acknowledges them; that flag is
 * the offline queue. Deletions of already-synced rows become tombstones in the
 * `deletions` store so the server does not resurrect the row on the next sync.
 */

import { createZip } from './zip.js';
import { readJsonEntry, readZip } from './zip-reader.js';

export const DB_NAME = 'khata-db';
export const DB_VERSION = 2;

export const STORE = Object.freeze({
  CUSTOMERS: 'customers',
  TRANSACTIONS: 'transactions',
  DELETIONS: 'deletions',
  LOGS: 'logs',
  SETTINGS: 'settings',
  ATTACHMENTS: 'attachments',
  BACKUPS: 'backups',
});

const LOG_LIMIT = 2000;

let connection = null;

function upgrade(db) {
  if (!db.objectStoreNames.contains(STORE.CUSTOMERS)) {
    const customers = db.createObjectStore(STORE.CUSTOMERS, { keyPath: 'id' });
    customers.createIndex('by_phone', 'phone_number', { unique: false });
    // IndexedDB cannot index booleans, so rows carry a numeric mirror of `synced`.
    customers.createIndex('by_synced', 'sync_flag', { unique: false });
    customers.createIndex('by_name', 'name', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.TRANSACTIONS)) {
    const transactions = db.createObjectStore(STORE.TRANSACTIONS, { keyPath: 'id' });
    transactions.createIndex('by_customer', 'customer_id', { unique: false });
    transactions.createIndex('by_synced', 'sync_flag', { unique: false });
    transactions.createIndex('by_occurred', 'occurred_at', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.DELETIONS)) {
    const deletions = db.createObjectStore(STORE.DELETIONS, { keyPath: 'key' });
    deletions.createIndex('by_synced', 'sync_flag', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.LOGS)) {
    const logs = db.createObjectStore(STORE.LOGS, { keyPath: 'id' });
    logs.createIndex('by_ts', 'ts', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.SETTINGS)) {
    db.createObjectStore(STORE.SETTINGS, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE.ATTACHMENTS)) {
    const attachments = db.createObjectStore(STORE.ATTACHMENTS, { keyPath: 'id' });
    attachments.createIndex('by_transaction', 'transaction_id', { unique: false });
    attachments.createIndex('by_customer', 'customer_id', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.BACKUPS)) {
    const backups = db.createObjectStore(STORE.BACKUPS, { keyPath: 'id' });
    backups.createIndex('by_created', 'created_at', { unique: false });
  }
}

export function openDb() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Could not open the database'));
    request.onblocked = () => reject(new Error('Database upgrade blocked by another tab'));
  });
  connection.catch(() => {
    connection = null;
  });
  return connection;
}

/** Closes the handle - used by tests and by "clear all data". */
export async function closeDb() {
  if (!connection) return;
  try {
    const db = await connection;
    db.close();
  } catch {
    /* already broken */
  }
  connection = null;
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
  });
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  const transaction = db.transaction(name, mode);
  const result = await fn(transaction.objectStore(name), transaction);
  await done(transaction);
  return result;
}

/* ------------------------------------------------------------------ customers */

export async function putCustomer(customer) {
  const row = {
    id: customer.id,
    name: customer.name,
    phone_number: customer.phone_number ?? null,
    created_at: customer.created_at,
    updated_at: customer.updated_at || new Date().toISOString(),
    // Tenancy configuration, when this customer rents something from the shop.
    rent: customer.rent || null,
    synced: customer.synced === true,
    sync_flag: customer.synced === true ? 1 : 0,
  };
  await withStore(STORE.CUSTOMERS, 'readwrite', (store) => req(store.put(row)));
  return row;
}

export async function getCustomer(id) {
  return withStore(STORE.CUSTOMERS, 'readonly', (store) => req(store.get(id)));
}

export async function allCustomers() {
  return withStore(STORE.CUSTOMERS, 'readonly', (store) => req(store.getAll()));
}

export async function countCustomers() {
  return withStore(STORE.CUSTOMERS, 'readonly', (store) => req(store.count()));
}

/**
 * Deletes a customer, their transactions, and queues tombstones for anything the
 * server may already know about.
 */
export async function deleteCustomer(id) {
  await deleteAttachmentsForCustomer(id);
  const db = await openDb();
  const transaction = db.transaction([STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.DELETIONS], 'readwrite');
  const customers = transaction.objectStore(STORE.CUSTOMERS);
  const transactions = transaction.objectStore(STORE.TRANSACTIONS);
  const deletions = transaction.objectStore(STORE.DELETIONS);

  const existing = await req(customers.get(id));
  const owned = await req(transactions.index('by_customer').getAll(id));

  customers.delete(id);
  for (const tx of owned) {
    transactions.delete(tx.id);
    if (tx.synced) {
      deletions.put({
        key: `transaction:${tx.id}`,
        kind: 'transaction',
        ref_id: tx.id,
        deleted_at: new Date().toISOString(),
        synced: false,
        sync_flag: 0,
      });
    }
  }
  if (existing?.synced) {
    deletions.put({
      key: `customer:${id}`,
      kind: 'customer',
      ref_id: id,
      deleted_at: new Date().toISOString(),
      synced: false,
      sync_flag: 0,
    });
  }
  await done(transaction);
  return { removedTransactions: owned.length, existed: Boolean(existing) };
}

/* --------------------------------------------------------------- transactions */

export async function putTransaction(transaction) {
  const row = {
    id: transaction.id,
    customer_id: transaction.customer_id,
    type: transaction.type,
    amount_paise: Math.round(transaction.amount_paise),
    note: transaction.note || '',
    occurred_at: transaction.occurred_at,
    created_at: transaction.created_at || new Date().toISOString(),
    synced: transaction.synced === true,
    sync_flag: transaction.synced === true ? 1 : 0,
    // Customer SMS state, so an entry is never texted twice and the ledger can
    // show whether the message actually left the phone.
    // 'rent' marks a charge the rent engine wrote, so the ledger can label it and
    // a deleted month is not recreated on the next pass.
    attachment_count: Number(transaction.attachment_count) || 0,
    source: transaction.source || 'manual',
    charge_kind: transaction.charge_kind || null,
    rent_cycle: transaction.rent_cycle || null,
    sms_status: transaction.sms_status || null,
    sms_at: transaction.sms_at || null,
    sms_error: transaction.sms_error || null,
  };
  await withStore(STORE.TRANSACTIONS, 'readwrite', (store) => req(store.put(row)));
  return row;
}

export async function getTransaction(id) {
  return withStore(STORE.TRANSACTIONS, 'readonly', (store) => req(store.get(id)));
}

export async function transactionsForCustomer(customerId) {
  return withStore(STORE.TRANSACTIONS, 'readonly', (store) =>
    req(store.index('by_customer').getAll(customerId)),
  );
}

export async function allTransactions() {
  return withStore(STORE.TRANSACTIONS, 'readonly', (store) => req(store.getAll()));
}

export async function deleteTransaction(id) {
  await deleteAttachmentsForTransaction(id);
  const db = await openDb();
  const transaction = db.transaction([STORE.TRANSACTIONS, STORE.DELETIONS], 'readwrite');
  const transactions = transaction.objectStore(STORE.TRANSACTIONS);
  const deletions = transaction.objectStore(STORE.DELETIONS);
  const existing = await req(transactions.get(id));
  transactions.delete(id);
  if (existing?.synced) {
    deletions.put({
      key: `transaction:${id}`,
      kind: 'transaction',
      ref_id: id,
      deleted_at: new Date().toISOString(),
      synced: false,
      sync_flag: 0,
    });
  }
  await done(transaction);
  return existing || null;
}

/* ------------------------------------------------------------------ sync queue */

export async function pendingRows() {
  const db = await openDb();
  const transaction = db.transaction([STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.DELETIONS], 'readonly');
  const customers = await req(transaction.objectStore(STORE.CUSTOMERS).index('by_synced').getAll(0));
  const transactions = await req(transaction.objectStore(STORE.TRANSACTIONS).index('by_synced').getAll(0));
  const deletions = await req(transaction.objectStore(STORE.DELETIONS).index('by_synced').getAll(0));
  await done(transaction);
  return { customers, transactions, deletions };
}

export async function pendingCount() {
  const { customers, transactions, deletions } = await pendingRows();
  return customers.length + transactions.length + deletions.length;
}

/** Marks acknowledged rows as synced. Ids of rows deleted meanwhile are ignored. */
export async function markSynced({ customerIds = [], transactionIds = [], deletionKeys = [] }) {
  const db = await openDb();
  const transaction = db.transaction([STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.DELETIONS], 'readwrite');
  const customers = transaction.objectStore(STORE.CUSTOMERS);
  const transactions = transaction.objectStore(STORE.TRANSACTIONS);
  const deletions = transaction.objectStore(STORE.DELETIONS);

  for (const id of customerIds) {
    const row = await req(customers.get(id));
    if (row) customers.put({ ...row, synced: true, sync_flag: 1 });
  }
  for (const id of transactionIds) {
    const row = await req(transactions.get(id));
    if (row) transactions.put({ ...row, synced: true, sync_flag: 1 });
  }
  for (const key of deletionKeys) {
    deletions.delete(key);
  }
  await done(transaction);
}

/* --------------------------------------------------------------- attachments */

/**
 * Files live beside the ledger, never in it: the sync payload stays small and the
 * Worker stays a ledger. `blob` is stored as-is, which IndexedDB handles natively.
 */
export async function putAttachment(attachment) {
  const row = {
    id: attachment.id,
    transaction_id: attachment.transaction_id,
    customer_id: attachment.customer_id || null,
    name: attachment.name,
    mime: attachment.mime,
    kind: attachment.kind || 'File',
    size: Number(attachment.size) || 0,
    created_at: attachment.created_at || new Date().toISOString(),
    blob: attachment.blob,
  };
  await withStore(STORE.ATTACHMENTS, 'readwrite', (store) => req(store.put(row)));
  return row;
}

export async function getAttachment(id) {
  return withStore(STORE.ATTACHMENTS, 'readonly', (store) => req(store.get(id)));
}

/** Metadata only - the blobs are left in the database until someone opens one. */
export async function attachmentsForTransaction(transactionId) {
  const rows = await withStore(STORE.ATTACHMENTS, 'readonly', (store) =>
    req(store.index('by_transaction').getAll(transactionId)),
  );
  return rows
    .map(({ blob, ...meta }) => meta)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export async function deleteAttachment(id) {
  await withStore(STORE.ATTACHMENTS, 'readwrite', (store) => req(store.delete(id)));
}

async function deleteAttachmentsWhere(store, indexName, value) {
  const rows = await req(store.index(indexName).getAllKeys(value));
  for (const key of rows) store.delete(key);
  return rows.length;
}

/** Removes every file belonging to an entry (called when the entry goes). */
export async function deleteAttachmentsForTransaction(transactionId) {
  const db = await openDb();
  const transaction = db.transaction(STORE.ATTACHMENTS, 'readwrite');
  const count = await deleteAttachmentsWhere(transaction.objectStore(STORE.ATTACHMENTS), 'by_transaction', transactionId);
  await done(transaction);
  return count;
}

async function deleteAttachmentsForCustomer(customerId) {
  const db = await openDb();
  const transaction = db.transaction(STORE.ATTACHMENTS, 'readwrite');
  const count = await deleteAttachmentsWhere(transaction.objectStore(STORE.ATTACHMENTS), 'by_customer', customerId);
  await done(transaction);
  return count;
}

/** Files attached to the customer itself - a rent agreement, for example. */
export async function attachmentsForCustomer(customerId) {
  const rows = await withStore(STORE.ATTACHMENTS, 'readonly', (store) =>
    req(store.index('by_customer').getAll(customerId)),
  );
  return rows
    .filter((row) => !row.transaction_id)
    .map(({ blob, ...meta }) => meta)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Total files and bytes, for the Settings screen. */
export async function attachmentStats() {
  const rows = await withStore(STORE.ATTACHMENTS, 'readonly', (store) => req(store.getAll()));
  return { count: rows.length, bytes: rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0) };
}

/* ---------------------------------------------------------------------- logs */

function logId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function appendLog(entry) {
  const row = {
    id: logId(),
    ts: entry.ts || new Date().toISOString(),
    level: entry.level || 'info',
    scope: entry.scope || 'app',
    message: String(entry.message ?? ''),
    data: entry.data === undefined ? null : entry.data,
  };
  await withStore(STORE.LOGS, 'readwrite', (store) => req(store.put(row)));
  return row;
}

export async function listLogs({ limit = LOG_LIMIT } = {}) {
  const rows = await withStore(STORE.LOGS, 'readonly', (store) => req(store.getAll()));
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return rows.slice(-limit);
}

export async function countLogs() {
  return withStore(STORE.LOGS, 'readonly', (store) => req(store.count()));
}

export async function clearLogs() {
  await withStore(STORE.LOGS, 'readwrite', (store) => req(store.clear()));
}

/** Keeps the newest `max` entries so diagnostics cannot grow without bound. */
export async function pruneLogs(max = LOG_LIMIT) {
  const total = await countLogs();
  if (total <= max) return 0;
  const rows = await listLogs({ limit: total });
  const doomed = rows.slice(0, total - max);
  const db = await openDb();
  const transaction = db.transaction(STORE.LOGS, 'readwrite');
  const store = transaction.objectStore(STORE.LOGS);
  for (const row of doomed) store.delete(row.id);
  await done(transaction);
  return doomed.length;
}

/* ------------------------------------------------------------------ settings */

export async function getSetting(key) {
  const row = await withStore(STORE.SETTINGS, 'readonly', (store) => req(store.get(key)));
  return row ? row.value : undefined;
}

export async function allSettings() {
  const rows = await withStore(STORE.SETTINGS, 'readonly', (store) => req(store.getAll()));
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function setSetting(key, value) {
  await withStore(STORE.SETTINGS, 'readwrite', (store) => req(store.put({ key, value })));
  return value;
}

export async function clearSettings() {
  await withStore(STORE.SETTINGS, 'readwrite', (store) => req(store.clear()));
}

/* ------------------------------------------------------- backup / restore */

export async function exportAll() {
  const [customers, transactions, settings, logs] = await Promise.all([
    allCustomers(),
    allTransactions(),
    allSettings(),
    listLogs({ limit: 500 }),
  ]);
  return {
    format: 'khata-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    customers,
    transactions,
    settings,
    logs,
  };
}

/**
 * Restores a backup. `merge` keeps existing rows and adds missing ones; `replace`
 * wipes local data first. Restored rows are marked unsynced so the server learns
 * about them on the next sync.
 */
export async function importAll(backup, { mode = 'merge' } = {}) {
  if (!backup || backup.format !== 'khata-backup' || !Array.isArray(backup.customers)) {
    throw new Error('Not a Khata backup file');
  }
  if (mode === 'replace') await wipeAll({ keepSettings: true });

  let customers = 0;
  let transactions = 0;
  for (const customer of backup.customers) {
    if (!customer?.id) continue;
    const existing = await getCustomer(customer.id);
    if (existing && mode === 'merge') continue;
    await putCustomer({ ...customer, synced: false });
    customers += 1;
  }
  for (const tx of backup.transactions || []) {
    if (!tx?.id) continue;
    const existing = await getTransaction(tx.id);
    if (existing && mode === 'merge') continue;
    await putTransaction({ ...tx, synced: false });
    transactions += 1;
  }
  return { customers, transactions };
}

/**
 * A complete backup as one zip: manifest.json (customers, transactions, settings)
 * plus every attachment as a real file. Opens in any file manager, and can be
 * restored here.
 */
export async function exportBackupZip({ now = new Date() } = {}) {
  const manifest = await exportAll();
  const attachments = await withStore(STORE.ATTACHMENTS, 'readonly', (store) => req(store.getAll()));

  const files = [
    {
      name: 'manifest.json',
      data: JSON.stringify(
        {
          ...manifest,
          format: 'khata-backup-zip',
          attachments: attachments.map(({ blob, ...meta }) => meta),
        },
        null,
        2,
      ),
    },
  ];

  for (const attachment of attachments) {
    const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
    files.push({ name: `attachments/${attachment.id}-${attachment.name}`, data: bytes });
  }

  return { blob: createZip(files), manifest, attachmentCount: attachments.length };
}

/**
 * Restores a zip backup (or the older JSON one).
 * @returns {Promise<{customers: number, transactions: number, attachments: number}>}
 */
export async function importBackupZip(input, { mode = 'merge' } = {}) {
  const files = readZip(input);
  const manifest = readJsonEntry(files, 'manifest.json');
  if (!manifest || !Array.isArray(manifest.customers)) throw new Error('Not a Khata backup');

  const result = await importAll({ ...manifest, format: 'khata-backup' }, { mode });

  let attachments = 0;
  for (const meta of manifest.attachments || []) {
    if (!meta?.id) continue;
    if (mode === 'merge' && (await getAttachment(meta.id))) continue;
    const entry = files.get(`attachments/${meta.id}-${meta.name}`);
    if (!entry) continue;
    await putAttachment({
      ...meta,
      blob: new Blob([entry], { type: meta.mime || 'application/octet-stream' }),
    });
    attachments += 1;
  }

  return { ...result, attachments };
}

/* ------------------------------------------------------------------ backups */

/**
 * Keeps the newest `keep` snapshots and drops the rest. Snapshots are zips, so a
 * backup can be handed to someone or pulled off the phone later.
 */
export async function saveBackupSnapshot({ blob, kind = 'auto', meta = {}, keep = 4, now = new Date() } = {}) {
  const row = {
    id: `${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`,
    created_at: now.toISOString(),
    kind,
    size: blob?.size || 0,
    meta,
    blob,
  };
  await withStore(STORE.BACKUPS, 'readwrite', (store) => req(store.put(row)));

  const all = await listBackups();
  const excess = all.slice(keep);
  for (const old of excess) await deleteBackup(old.id);
  return { row, pruned: excess.length };
}

export async function listBackups() {
  const rows = await withStore(STORE.BACKUPS, 'readonly', (store) => req(store.getAll()));
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getBackup(id) {
  return withStore(STORE.BACKUPS, 'readonly', (store) => req(store.get(id)));
}

export async function deleteBackup(id) {
  await withStore(STORE.BACKUPS, 'readwrite', (store) => req(store.delete(id)));
}

export async function backupStats() {
  const rows = await listBackups();
  return {
    count: rows.length,
    bytes: rows.reduce((sum, row) => sum + (Number(row.size) || 0), 0),
    lastAt: rows[0]?.created_at || null,
  };
}

/** Removes all ledger data. Settings survive unless `keepSettings` is false. */
export async function wipeAll({ keepSettings = true } = {}) {
  // Attachments go with the ledger they belong to. Backup snapshots stay: they are
  // the way back.
  const stores = [STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.DELETIONS, STORE.ATTACHMENTS];
  const db = await openDb();
  const transaction = db.transaction(stores, 'readwrite');
  for (const name of stores) transaction.objectStore(name).clear();
  await done(transaction);
  if (!keepSettings) await clearSettings();
}

/** Row counts for the Settings screen. */
export async function stats() {
  const db = await openDb();
  const transaction = db.transaction([STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.LOGS], 'readonly');
  const [customers, transactions, logs] = await Promise.all([
    req(transaction.objectStore(STORE.CUSTOMERS).count()),
    req(transaction.objectStore(STORE.TRANSACTIONS).count()),
    req(transaction.objectStore(STORE.LOGS).count()),
  ]);
  await done(transaction);
  return { customers, transactions, logs };
}

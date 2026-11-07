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

export const DB_NAME = 'khata-db';
export const DB_VERSION = 1;

export const STORE = Object.freeze({
  CUSTOMERS: 'customers',
  TRANSACTIONS: 'transactions',
  DELETIONS: 'deletions',
  LOGS: 'logs',
  SETTINGS: 'settings',
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

/** Removes all ledger data. Settings survive unless `keepSettings` is false. */
export async function wipeAll({ keepSettings = true } = {}) {
  const stores = [STORE.CUSTOMERS, STORE.TRANSACTIONS, STORE.DELETIONS];
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

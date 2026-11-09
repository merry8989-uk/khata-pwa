/**
 * Settings: defaults and persistence (IndexedDB). Every option here is wired to
 * real behaviour in the app - there are no dead toggles.
 *
 * The app is light-only with one fixed accent colour, so there are no theme,
 * density or text-size options to store or apply.
 */

import { allSettings, clearSettings, setSetting as dbSetSetting, setSetting } from './db.js';

export const DEFAULT_REMINDER =
  'Namaste {name}, your balance with {shop} is Rs.{balance}. Kindly settle when convenient. Thank you.';

export const DEFAULTS = Object.freeze({
  language: 'en',
  smsAlerts: true,
  autoSync: true,
  syncIntervalSec: 60,
  shopName: '',
  shopPhone: '',
  confirmDelete: true,
  logging: true,
  // 'auto' backs up weekly, but only when the ledger changed since the last one.
  backupInterval: 'auto',
  lastBackupAt: null,
  lastChangeAt: null,
  whatsappTemplate: DEFAULT_REMINDER,
});

let cache = { ...DEFAULTS };
const listeners = new Set();

export function current() {
  return { ...cache };
}

export function get(key) {
  return cache[key];
}

export async function loadSettings() {
  const stored = await allSettings();
  cache = { ...DEFAULTS, ...stored };
  return current();
}

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(changed) {
  for (const listener of listeners) {
    try {
      listener(current(), changed);
    } catch {
      /* a broken listener must not break settings */
    }
  }
}

/** Persists one setting and applies whatever side effects it owns. */
export async function update(key, value) {
  cache[key] = value;
  await setSetting(key, value);
  notify({ [key]: value });
  return value;
}

export async function updateMany(patch) {
  cache = { ...cache, ...patch };
  for (const [key, value] of Object.entries(patch)) await setSetting(key, value);
  notify(patch);
  return current();
}

export async function reset() {
  await clearSettings();
  for (const [key, value] of Object.entries(DEFAULTS)) await dbSetSetting(key, value);
  cache = { ...DEFAULTS };
  notify({ ...DEFAULTS });
  return current();
}

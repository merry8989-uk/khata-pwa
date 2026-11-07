/**
 * Settings: defaults, persistence (IndexedDB), and the theme/layout side effects.
 * Every option here is wired to real behaviour in the app - there are no dead
 * toggles. A localStorage mirror of the resolved theme is kept so index.html can
 * paint the right background before the database opens.
 */

import { allSettings, clearSettings, setSetting as dbSetSetting, setSetting } from './db.js';

export const ACCENTS = Object.freeze({
  indigo: { 50: '#eef2ff', 100: '#e0e7ff', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca' },
  blue: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8' },
  emerald: { 50: '#ecfdf5', 100: '#d1fae5', 500: '#10b981', 600: '#059669', 700: '#047857' },
  rose: { 50: '#fff1f2', 100: '#ffe4e6', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c' },
  amber: { 50: '#fffbeb', 100: '#fef3c7', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
  slate: { 50: '#f8fafc', 100: '#f1f5f9', 500: '#64748b', 600: '#475569', 700: '#334155' },
});

export const DEFAULT_REMINDER =
  'Namaste {name}, your balance with {shop} is Rs.{balance}. Kindly settle when convenient. Thank you.';

export const DEFAULTS = Object.freeze({
  theme: 'system',
  accent: 'indigo',
  textSize: 'md',
  density: 'comfortable',
  immersive: true,
  language: 'en',
  smsAlerts: true,
  autoSync: true,
  syncIntervalSec: 60,
  apiBase: '',
  apiToken: '',
  shopName: '',
  shopPhone: '',
  confirmDelete: true,
  logging: true,
  whatsappTemplate: DEFAULT_REMINDER,
});

export const THEME_MIRROR_KEY = 'khata.theme';

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
  applyAppearance(cache);
  notify({ [key]: value });
  return value;
}

export async function updateMany(patch) {
  cache = { ...cache, ...patch };
  for (const [key, value] of Object.entries(patch)) await setSetting(key, value);
  applyAppearance(cache);
  notify(patch);
  return current();
}

export async function reset() {
  await clearSettings();
  for (const [key, value] of Object.entries(DEFAULTS)) await dbSetSetting(key, value);
  cache = { ...DEFAULTS };
  applyAppearance(cache);
  notify({ ...DEFAULTS });
  return current();
}

/** True when the app has enough configuration to talk to a Worker. */
export function isSyncConfigured(settings = cache) {
  return Boolean(String(settings.apiBase || '').trim() && String(settings.apiToken || '').trim());
}

export function resolveTheme(theme, prefersDark) {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return prefersDark ? 'dark' : 'light';
}

/** Applies theme, accent, text size, density and immersive layout to <html>. */
export function applyAppearance(settings = cache) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const prefersDark =
    typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)').matches : false;
  const resolved = resolveTheme(settings.theme, prefersDark);

  root.dataset.theme = resolved;
  root.dataset.textSize = settings.textSize;
  root.dataset.density = settings.density;
  root.dataset.immersive = settings.immersive ? 'on' : 'off';

  const accent = ACCENTS[settings.accent] || ACCENTS.indigo;
  for (const [shade, colour] of Object.entries(accent)) {
    root.style.setProperty(`--accent-${shade}`, colour);
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1220' : accent[600]);

  try {
    localStorage.setItem(THEME_MIRROR_KEY, resolved);
  } catch {
    /* private mode - the mirror is an optimisation, not a requirement */
  }
}

/** Re-applies appearance when the OS theme flips while "system" is selected. */
export function watchSystemTheme() {
  if (typeof matchMedia !== 'function') return;
  const query = matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (cache.theme === 'system') applyAppearance(cache);
  };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', handler);
}

/** Toggles real full-screen where the browser allows it (needs a user gesture). */
export async function toggleFullscreen() {
  if (typeof document === 'undefined') return false;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return false;
    }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    return true;
  } catch {
    return false;
  }
}

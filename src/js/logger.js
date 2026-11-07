/**
 * Diagnostics logger. Collection is ON by default (Settings > Diagnostics can turn
 * it off) and writes to IndexedDB so logs survive a reload and a crash.
 *
 * Nothing here leaves the device on its own: the shopkeeper shares or exports the
 * log file from the Settings screen.
 */

import { appendLog, pruneLogs } from './db.js';

let enabled = true;
let installed = false;
let pendingWrites = 0;

export function setLogging(value) {
  enabled = value !== false;
}

export function isLogging() {
  return enabled;
}

function serialisable(data) {
  if (data === undefined || data === null) return null;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

export function log(level, scope, message, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message: String(message ?? ''),
    data: serialisable(data),
  };
  // Mirror to the console so a desktop debug session sees it live.
  const line = `[khata:${scope}] ${entry.message}`;
  if (level === 'error') console.error(line, entry.data ?? '');
  else if (level === 'warn') console.warn(line, entry.data ?? '');
  else console.log(line, entry.data ?? '');

  if (!enabled) return entry;

  pendingWrites += 1;
  appendLog(entry)
    .then(() => {
      if (pendingWrites % 50 === 0) return pruneLogs();
      return null;
    })
    .catch(() => {
      /* storage full or blocked: the console mirror is the fallback */
    })
    .finally(() => {
      pendingWrites -= 1;
    });
  return entry;
}

export const logger = {
  debug: (scope, message, data) => log('debug', scope, message, data),
  info: (scope, message, data) => log('info', scope, message, data),
  warn: (scope, message, data) => log('warn', scope, message, data),
  error: (scope, message, data) => log('error', scope, message, data),
};

/** Captures uncaught errors and rejections once per page load. */
export function installGlobalHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (event) => {
    logger.error('window', event.message || 'Uncaught error', {
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack ? String(event.error.stack).slice(0, 1200) : null,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    logger.error('promise', 'Unhandled rejection', {
      message: reason?.message || String(reason),
      stack: reason?.stack ? String(reason.stack).slice(0, 1200) : null,
    });
  });
}

/**
 * Page-side sync orchestration: online/offline listeners, backoff, the periodic
 * timer, Background Sync registration, and the status the UI badge renders.
 */

import { pendingCount } from './db.js';
import { logger } from './logger.js';
import { MAX_ATTEMPTS, SyncError, flush, isConfigured, readConfig } from './sync-core.js';

export const STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  ERROR: 'error',
  LOCAL_ONLY: 'localOnly',
});

const BACKGROUND_SYNC_TAG = 'khata-sync';

export function createSyncEngine({ onChange = () => {}, onResult = () => {} } = {}) {
  let status = typeof navigator !== 'undefined' && navigator.onLine === false ? STATUS.OFFLINE : STATUS.ONLINE;
  let pending = 0;
  let attempts = 0;
  let running = false;
  let timer = null;
  let started = false;
  let lastError = null;

  function emit() {
    onChange({ status, pending, lastError, attempts });
  }

  async function refreshPending() {
    try {
      pending = await pendingCount();
    } catch (error) {
      logger.warn('sync', 'Could not count pending rows', { message: error?.message });
      pending = 0;
    }
    return pending;
  }

  function stopTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleRetry() {
    stopTimer();
    if (attempts >= MAX_ATTEMPTS) {
      logger.warn('sync', 'Giving up after max attempts; will retry when online or on next launch', {
        attempts,
      });
      return;
    }
    const base = Math.min(60000, 1000 * 2 ** attempts);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5)); // jitter
    timer = setTimeout(() => {
      timer = null;
      syncNow('retry');
    }, delay);
  }

  async function syncNow(reason = 'manual') {
    if (running) return { ok: false, skipped: 'busy' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      status = STATUS.OFFLINE;
      await refreshPending();
      emit();
      return { ok: false, skipped: 'offline' };
    }

    const config = await readConfig();
    if (!isConfigured(config) || !config.autoSync) {
      status = STATUS.LOCAL_ONLY;
      await refreshPending();
      emit();
      return { ok: false, skipped: 'local-only' };
    }

    running = true;
    status = STATUS.SYNCING;
    emit();
    logger.debug('sync', 'Sync started', { reason, pending });

    try {
      const result = await flush({ config });
      attempts = 0;
      lastError = null;
      await refreshPending();
      status = pending > 0 ? STATUS.ONLINE : STATUS.SYNCED;
      if (result.rejected?.length) {
        logger.warn('sync', 'Server rejected some rows', { rejected: result.rejected.slice(0, 5) });
      }
      logger.info('sync', 'Sync finished', {
        accepted: result.accepted || null,
        rejected: result.rejected?.length || 0,
        skipped: result.skipped || null,
      });
      emit();
      onResult({ ok: true, result });
      return { ok: true, result };
    } catch (error) {
      const isSyncError = error instanceof SyncError;
      lastError = { message: error?.message || 'Sync failed', code: isSyncError ? error.code : 'UNKNOWN' };
      status = STATUS.ERROR;
      logger.error('sync', 'Sync failed', lastError);
      if (isSyncError && !isSyncError.retryable) {
        // A rejected token will never succeed on retry - stop and surface it.
        attempts = MAX_ATTEMPTS;
        stopTimer();
      } else {
        attempts += 1;
        scheduleRetry();
      }
      await refreshPending();
      emit();
      onResult({ ok: false, error: lastError });
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  async function registerBackgroundSync() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    try {
      const registration = await navigator.serviceWorker.ready;
      if (!registration.sync) return false;
      await registration.sync.register(BACKGROUND_SYNC_TAG);
      logger.debug('sync', 'Background sync registered');
      return true;
    } catch (error) {
      logger.warn('sync', 'Background sync unavailable', { message: error?.message });
      return false;
    }
  }

  function startPeriodic(intervalSec = 60) {
    stopTimer();
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) return;
    timer = setTimeout(async function tick() {
      timer = null;
      if (typeof navigator === 'undefined' || navigator.onLine !== false) await syncNow('interval');
      timer = setTimeout(tick, Math.max(15000, intervalSec * 1000));
    }, Math.max(15000, intervalSec * 1000));
  }

  function handleOnline() {
    logger.info('sync', 'Network came back online');
    attempts = 0;
    refreshPending().then(() => {
      status = STATUS.ONLINE;
      emit();
      return syncNow('online');
    });
    registerBackgroundSync();
  }

  function handleOffline() {
    logger.info('sync', 'Network went offline');
    status = STATUS.OFFLINE;
    refreshPending().then(emit);
  }

  async function start() {
    if (started) return;
    started = true;
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && pending > 0) syncNow('visible');
    });
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (event.data?.type === 'khata:sync') syncNow('background-sync');
      if (event.data?.type === 'khata:sync-result') {
        refreshPending().then(() => {
          status = event.data.ok ? STATUS.SYNCED : STATUS.ERROR;
          emit();
        });
      }
    });

    await refreshPending();
    if (navigator.onLine === false) {
      status = STATUS.OFFLINE;
      emit();
    } else {
      const config = await readConfig();
      status = isConfigured(config) && config.autoSync ? STATUS.ONLINE : STATUS.LOCAL_ONLY;
      emit();
      if (pending > 0 && isConfigured(config) && config.autoSync) {
        registerBackgroundSync();
        await syncNow('startup');
      }
    }
    const config = await readConfig();
    if (config.autoSync) startPeriodic(config.syncIntervalSec);
  }

  function stop() {
    stopTimer();
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    started = false;
  }

  return {
    start,
    stop,
    syncNow,
    refreshPending,
    registerBackgroundSync,
    getState: () => ({ status, pending, attempts, lastError }),
  };
}

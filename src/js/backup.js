/**
 * Scheduled on-device backups.
 *
 * A shopkeeper's proof lives on one phone, so Khata keeps its own snapshots: a zip
 * per run, held in the app's storage, newest four kept. The interval is the user's
 * choice - weekly, monthly, or "automatic", which backs up weekly but only when
 * something actually changed since the last one.
 *
 * On Android the same zip is also written into Downloads, so the backup survives
 * even the app's own storage being cleared. In a browser that silent write is not
 * possible, so the snapshot stays inside the app and can be saved with one tap.
 */

import {
  backupStats,
  exportBackupZip,
  listBackups,
  saveBackupSnapshot,
} from './db.js';
import { formatBytes } from './attachments.js';

export const BACKUP_INTERVALS = Object.freeze({
  off: { id: 'off', days: null, label: 'Off' },
  weekly: { id: 'weekly', days: 7, label: 'Every week' },
  monthly: { id: 'monthly', days: 30, label: 'Every month' },
  auto: { id: 'auto', days: 7, label: 'Automatic' },
});

export const KEEP_SNAPSHOTS = 4;
const AUTO_MIN_DAYS = 7;

/**
 * Should a backup run now?
 * Pure, so the schedule is testable without waiting a week.
 */
export function isBackupDue({ interval = 'auto', lastAt = null, now = new Date(), changedAt = null } = {}) {
  const choice = BACKUP_INTERVALS[interval];
  if (!choice || choice.days === null) return { due: false, reason: 'off' };
  if (!lastAt) return { due: true, reason: 'never' };

  const last = Date.parse(lastAt);
  if (!Number.isFinite(last)) return { due: true, reason: 'never' };

  const elapsedDays = (now.getTime() - last) / 86400000;
  if (elapsedDays >= choice.days) return { due: true, reason: 'interval' };

  if (interval === 'auto') {
    // "Automatic" waits for something to back up, then takes a week's distance from
    // the last snapshot rather than churning a new file every launch.
    const changed = Date.parse(changedAt || '');
    const idleDays = Number.isFinite(changed) ? (now.getTime() - changed) / 86400000 : Infinity;
    if (Number.isFinite(changed) && changed > last && idleDays >= 1 && elapsedDays >= 1) {
      return { due: true, reason: 'changed' };
    }
    if (elapsedDays >= AUTO_MIN_DAYS) return { due: true, reason: 'interval' };
  }

  return { due: false, reason: 'too_soon' };
}

function fileNameFor(date) {
  const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `khata-backup-${stamp}.zip`;
}

/**
 * Runs a backup if the schedule says so.
 * @returns {Promise<{ran: boolean, reason: string, id?: string, size?: number, savedToDevice?: boolean}>}
 */
export async function runScheduledBackup({
  interval = 'auto',
  lastAt = null,
  changedAt = null,
  now = new Date(),
  bridge = globalThis.KhataAndroid || null,
  force = false,
  db = null,
} = {}) {
  const decision = force ? { due: true, reason: 'manual' } : isBackupDue({ interval, lastAt, now, changedAt });
  if (!decision.due) return { ran: false, reason: decision.reason };

  const { blob, manifest, attachmentCount } = await exportBackupZip({ now });
  const name = fileNameFor(now);

  const saved = await saveBackupSnapshot({
    blob,
    kind: force ? 'manual' : 'scheduled',
    keep: KEEP_SNAPSHOTS,
    now,
    meta: {
      customers: manifest.customers.length,
      transactions: manifest.transactions.length,
      attachments: attachmentCount,
      name,
    },
  });

  // Android: also drop a real file into Downloads so it outlives the app.
  let savedToDevice = false;
  if (bridge && typeof bridge.saveFile === 'function') {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      bridge.saveFile(name, 'application/zip', btoa(binary));
      savedToDevice = true;
    } catch {
      savedToDevice = false;
    }
  }

  return {
    ran: true,
    reason: decision.reason,
    id: saved.row.id,
    size: blob.size,
    savedToDevice,
    customers: manifest.customers.length,
    transactions: manifest.transactions.length,
    attachments: attachmentCount,
  };
}

/** Human-readable state for Settings. */
export async function backupStatus() {
  const stats = await backupStats();
  const snapshots = await listBackups();
  return {
    ...stats,
    humanSize: formatBytes(stats.bytes),
    newest: snapshots[0] || null,
  };
}

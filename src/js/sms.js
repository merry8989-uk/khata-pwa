/**
 * Customer SMS, sent from the phone's own SIM through the Android shell.
 *
 * This replaces the paid gateways (Fast2SMS, Twilio): no per-message fee, no
 * top-up, and it works with no internet at all because the message leaves the
 * phone's radio rather than a server. The trade-offs are real and are surfaced in
 * the UI rather than hidden: one SIM's daily allowance, the phone must be the one
 * running Khata, and it needs the SMS permission.
 *
 * The native side reports back asynchronously through window.__khataSmsResult, so
 * an entry is only marked "sent" when the network accepted it.
 */

import { summarize } from './shared/ledger.js';
import { formatTransactionSms } from './shared/sms.js';
import { logger } from './logger.js';

const RESULT_TIMEOUT_MS = 30000;

/** The Android shell's bridge, or null in a browser. */
export function smsBridge() {
  const bridge = globalThis.KhataAndroid;
  if (!bridge || typeof bridge.sendSms !== 'function') return null;
  return bridge;
}

export function hasDeviceSms() {
  return smsBridge() !== null;
}

/** {sent, cap, date} from the shell, or null in a browser. */
export function smsQuota(bridge = smsBridge()) {
  if (!bridge || typeof bridge.smsQuota !== 'function') return null;
  try {
    const parsed = JSON.parse(bridge.smsQuota());
    if (typeof parsed?.sent === 'number' && typeof parsed?.cap === 'number') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Should this entry text the customer?
 * Pure so the rules are testable without a phone.
 */
export function shouldSendEntrySms({ customer, transaction, settings, bridge }) {
  if (!bridge) return { send: false, reason: 'no_device_sms' };
  if (settings?.smsAlerts === false) return { send: false, reason: 'disabled' };
  if (!customer || !customer.phone_number) return { send: false, reason: 'no_phone' };
  if (!transaction || !transaction.id) return { send: false, reason: 'no_entry' };
  if (transaction.sms_status === 'sent') return { send: false, reason: 'already_sent' };
  if (transaction.sms_status === 'queued') return { send: false, reason: 'in_flight' };
  if (!Number.isFinite(Number(transaction.amount_paise)) || Number(transaction.amount_paise) <= 0) {
    return { send: false, reason: 'bad_amount' };
  }
  return { send: true, reason: 'ok' };
}

/** The message body, with the balance as it stands after this entry. */
export function entrySmsBody({ customer, transaction, transactions }) {
  const others = (transactions || []).filter((row) => row.id !== transaction.id);
  const { net } = summarize([...others, transaction]);
  return formatTransactionSms({
    customerName: customer?.name,
    amountPaise: transaction.amount_paise,
    type: transaction.type,
    occurredAt: transaction.occurred_at || transaction.created_at,
    netPaise: net,
  });
}

const pending = new Map();
let installed = false;

/** Receives {id, status, detail} from the shell. Idempotent. */
export function installSmsResultHandler() {
  if (installed) return;
  installed = true;
  globalThis.__khataSmsResult = (payload) => {
    let data = payload;
    if (typeof payload === 'string') {
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }
    }
    if (!data || !data.id) return;
    const entry = pending.get(data.id);
    if (!entry) return;

    // "queued" is the shell acknowledging the request; wait for the radio.
    if (data.status === 'queued') {
      logger.debug('sms', 'SMS queued by the shell', { transactionId: data.id });
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(data.id);
    logger.info('sms', 'SMS result', { transactionId: data.id, status: data.status, detail: data.detail });
    entry.resolve({ status: data.status || 'unknown', detail: data.detail || null });
  };
}

/**
 * Hands one message to the shell and waits for the radio's verdict.
 * @returns {Promise<{status: string, detail: string|null}>}
 */
export function sendEntrySms({ transaction, customer, transactions, bridge = smsBridge() }) {
  if (!bridge) return Promise.resolve({ status: 'unavailable', detail: 'no_device_sms' });

  const body = entrySmsBody({ customer, transaction, transactions });
  const entryId = transaction.id;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(entryId);
      resolve({ status: 'timeout', detail: 'no radio verdict' });
    }, RESULT_TIMEOUT_MS);

    pending.set(entryId, { resolve, timer });

    try {
      bridge.sendSms(entryId, String(customer.phone_number || ''), body);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(entryId);
      resolve({ status: 'error', detail: String(error?.message || error) });
    }
  });
}

/** Statuses worth telling the shopkeeper about, and how they read. */
export const SMS_TONE = Object.freeze({
  sent: 'ok',
  queued: 'pending',
  timeout: 'warn',
  failed: 'bad',
  error: 'bad',
  invalid_number: 'bad',
  daily_cap: 'warn',
  permission_required: 'warn',
  unavailable: 'warn',
});

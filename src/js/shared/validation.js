/**
 * Input validation shared by the app (before writing to IndexedDB) and the
 * Worker (before writing to D1). One set of rules, one set of error codes.
 */

import { normalizeType } from './ledger.js';
import { parseAmountToPaise } from './money.js';

export const LIMITS = Object.freeze({
  NAME_MAX: 60,
  NOTE_MAX: 200,
  BATCH_MAX: 200,
  PHONE_DIGITS: 10,
});

export const ERRORS = Object.freeze({
  REQUIRED: 'REQUIRED',
  NAME_INVALID: 'NAME_INVALID',
  PHONE_INVALID: 'PHONE_INVALID',
  AMOUNT_REQUIRED: 'AMOUNT_REQUIRED',
  AMOUNT_INVALID: 'AMOUNT_INVALID',
  AMOUNT_TOO_LARGE: 'AMOUNT_TOO_LARGE',
  TYPE_INVALID: 'TYPE_INVALID',
  DATE_INVALID: 'DATE_INVALID',
  ID_INVALID: 'ID_INVALID',
  NOTE_TOO_LONG: 'NOTE_TOO_LONG',
  CUSTOMER_MISSING: 'CUSTOMER_MISSING',
  TOO_MANY_ITEMS: 'TOO_MANY_ITEMS',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EARLIEST = Date.parse('2000-01-01T00:00:00Z');
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Cryptographically strong UUID v4 with a fallback for insecure origins. */
export function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Strips control characters, collapses whitespace, trims. */
export function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalises Indian mobile numbers to E.164 (+91XXXXXXXXXX).
 * Accepts "9876543210", "+91 98765 43210", "0091-9876543210".
 */
export function normalizePhone(input) {
  const raw = cleanText(input).replace(/[^\d+]/g, '');
  if (raw === '') return { ok: false, code: ERRORS.PHONE_INVALID };

  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);

  if (!new RegExp(`^[6-9]\\d{${LIMITS.PHONE_DIGITS - 1}}$`).test(digits)) {
    return { ok: false, code: ERRORS.PHONE_INVALID };
  }
  return { ok: true, e164: `+91${digits}`, national: digits };
}

function checkTimestamp(value, { now = Date.now(), required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return { ok: true, iso: null };
    return { ok: false, code: ERRORS.DATE_INVALID };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, code: ERRORS.DATE_INVALID };
  if (ms < EARLIEST || ms > now + FUTURE_SKEW_MS) return { ok: false, code: ERRORS.DATE_INVALID };
  return { ok: true, iso: new Date(ms).toISOString() };
}

/** @returns {{ok: boolean, value?: object, errors: string[]}} */
export function validateCustomer(raw, { now = Date.now(), requireId = true } = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  let id = input.id;
  if (requireId) {
    if (!isUuid(id)) errors.push(ERRORS.ID_INVALID);
  } else if (id === undefined) {
    id = newId();
  } else if (!isUuid(id)) {
    errors.push(ERRORS.ID_INVALID);
  }

  const name = cleanText(input.name);
  if (name === '') errors.push(ERRORS.NAME_INVALID);
  else if (name.length > LIMITS.NAME_MAX) errors.push(ERRORS.NAME_INVALID);

  let phone = null;
  if (cleanText(input.phone_number ?? input.phone) !== '') {
    const parsed = normalizePhone(input.phone_number ?? input.phone);
    if (!parsed.ok) errors.push(ERRORS.PHONE_INVALID);
    else phone = parsed.e164;
  }

  const created = checkTimestamp(input.created_at, { now, required: false });
  if (!created.ok) errors.push(created.code);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      id,
      name,
      phone_number: phone,
      created_at: created.iso || new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
    },
  };
}

/** @returns {{ok: boolean, value?: object, errors: string[]}} */
export function validateTransaction(raw, { now = Date.now(), requireId = true } = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  let id = input.id;
  if (requireId) {
    if (!isUuid(id)) errors.push(ERRORS.ID_INVALID);
  } else if (id === undefined) {
    id = newId();
  } else if (!isUuid(id)) {
    errors.push(ERRORS.ID_INVALID);
  }

  const customerId = input.customer_id;
  if (!isUuid(customerId)) errors.push(ERRORS.CUSTOMER_MISSING);

  const type = normalizeType(input.type);
  if (!type) errors.push(ERRORS.TYPE_INVALID);

  const amountInput =
    input.amount_paise !== undefined
      ? typeof input.amount_paise === 'number'
        ? input.amount_paise / 100
        : input.amount_paise
      : input.amount;
  const amount = parseAmountToPaise(amountInput);
  if (!amount.ok) errors.push(amount.code);

  const note = cleanText(input.note);
  if (note.length > LIMITS.NOTE_MAX) errors.push(ERRORS.NOTE_TOO_LONG);

  // occurred_at is optional: when a caller omits it we fall back to created_at,
  // then to "now". An explicit but impossible date is still rejected.
  const occurred = checkTimestamp(input.occurred_at ?? input.timestamp ?? input.created_at, {
    now,
    required: false,
  });
  if (!occurred.ok) errors.push(occurred.code);

  const created = checkTimestamp(input.created_at, { now, required: false });
  if (!created.ok) errors.push(created.code);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      id,
      customer_id: customerId,
      type,
      amount_paise: amount.paise,
      note,
      occurred_at: occurred.iso || created.iso || new Date(now).toISOString(),
      created_at: created.iso || occurred.iso || new Date(now).toISOString(),
    },
  };
}

export function validateDeletion(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (!isUuid(input.id)) return { ok: false, errors: [ERRORS.ID_INVALID] };
  const kind = input.kind === 'customer' ? 'customer' : input.kind === 'transaction' ? 'transaction' : null;
  if (!kind) return { ok: false, errors: [ERRORS.REQUIRED] };
  return { ok: true, errors: [], value: { kind, id: input.id } };
}

/**
 * Validates a whole /api/sync payload, keeping good items and reporting bad ones
 * individually so the client can mark only the accepted rows as synced.
 */
export function validateSyncPayload(body, { now = Date.now() } = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const rawCustomers = Array.isArray(payload.customers) ? payload.customers : [];
  const rawTransactions = Array.isArray(payload.transactions) ? payload.transactions : [];
  const rawDeletions = Array.isArray(payload.deletions) ? payload.deletions : [];

  const total = rawCustomers.length + rawTransactions.length + rawDeletions.length;
  if (total > LIMITS.BATCH_MAX) {
    return { ok: false, errors: [ERRORS.TOO_MANY_ITEMS], total };
  }

  const accepted = { customers: [], transactions: [], deletions: [] };
  const rejected = [];

  for (const raw of rawCustomers) {
    const result = validateCustomer(raw, { now });
    if (result.ok) accepted.customers.push(result.value);
    else rejected.push({ kind: 'customer', id: raw?.id ?? null, errors: result.errors });
  }
  for (const raw of rawTransactions) {
    const result = validateTransaction(raw, { now });
    if (result.ok) accepted.transactions.push(result.value);
    else rejected.push({ kind: 'transaction', id: raw?.id ?? null, errors: result.errors });
  }
  for (const raw of rawDeletions) {
    const result = validateDeletion(raw);
    if (result.ok) accepted.deletions.push(result.value);
    else rejected.push({ kind: 'deletion', id: raw?.id ?? null, errors: result.errors });
  }

  return { ok: true, accepted, rejected, total };
}

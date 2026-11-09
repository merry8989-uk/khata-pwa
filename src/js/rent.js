/**
 * Rent mode: a customer whose monthly rent accrues by itself.
 *
 * A tenant does not follow the calendar. Someone who moves in on the 20th rents
 * "20th to 19th", and usually pays on the 19th for the month that just finished.
 * So the cycle is anchored on the move-in day, and the charge lands either at the
 * end of each rented month (arrears, the common case) or on the anniversary
 * (advance, when rent is collected up front).
 *
 * Every charge is a normal GIVEN entry, so balances, statements, search and sync
 * need no special cases. Charges are idempotent: the id is derived from the
 * customer and the cycle, so two tabs - or a second run a second later - cannot
 * create the same month twice. A charge the shopkeeper deletes is remembered in
 * `rent.skipped`, otherwise the next pass would put it straight back.
 */

export const RENT_MODES = Object.freeze({ ARREARS: 'arrears', ADVANCE: 'advance' });
export const MAX_CYCLES = 600;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> {year, month, day} (month 1-12), or null. */
export function parseDateOnly(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/** Local noon, so a date never slips a day across a timezone or DST boundary. */
function atNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function clampDay(year, month, day) {
  return Math.min(day, daysInMonth(year, month));
}

/** The first day of cycle `index`, clamped to a short month (31 -> 28/30). */
export function cycleStartDate(start, index) {
  const totalMonths = start.month - 1 + index;
  const year = start.year + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  return { year, month, day: clampDay(year, month, start.day) };
}

function addMonths(start, index) {
  return cycleStartDate(start, index);
}

function isoOf(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 'YYYY-MM' of the month the cycle began - the stable key for a charge. */
export function cycleKey(start, index) {
  const { year, month } = cycleStartDate(start, index);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** "Rent — Oct 2026" (the month the tenancy month began). */
export function rentNote(start, index) {
  const { year, month } = cycleStartDate(start, index);
  return `Rent - ${MONTHS[month - 1]} ${year}`;
}

/**
 * When the charge for cycle `index` becomes due.
 * - advance: on the anniversary itself (20th, 20th, ...)
 * - arrears: on the last day of the rented month (19th, 19th, ...)
 */
export function cycleDueDate(start, index, mode = RENT_MODES.ARREARS) {
  if (mode === RENT_MODES.ADVANCE) {
    const { year, month, day } = cycleStartDate(start, index);
    return atNoon(year, month, day);
  }
  const next = addMonths(start, index + 1);
  const due = atNoon(next.year, next.month, next.day);
  due.setDate(due.getDate() - 1);
  return due;
}

/** 'YYYY-MM-DD' of the first day of the tenancy, clamped to the real month. */
export function normalizeStart(dateOnly) {
  const parsed = parseDateOnly(dateOnly);
  if (!parsed) return null;
  const day = clampDay(parsed.year, parsed.month, parsed.day);
  return { ...parsed, day };
}

/**
 * Every charge that has come due by `until`.
 * @returns {Array<{key: string, due_at: string, month_label: string, index: number}>}
 */
export function rentCycles({ rent, until = new Date() }) {
  if (rent?.active === false) return [];
  const start = normalizeStart(rent?.start_date);
  if (!start || !(Number(rent?.amount_paise) > 0)) return [];

  const mode = rent.mode === RENT_MODES.ADVANCE ? RENT_MODES.ADVANCE : RENT_MODES.ARREARS;
  const end = normalizeStart(rent.end_date);
  const limit = atNoon(until.getFullYear(), until.getMonth() + 1, until.getDate());

  const cycles = [];
  for (let index = 0; index < MAX_CYCLES; index += 1) {
    const due = cycleDueDate(start, index, mode);
    if (due > limit) break;
    if (end) {
      const endLimit = atNoon(end.year, end.month, end.day);
      if (due > endLimit) break;
    }
    cycles.push({
      index,
      key: cycleKey(start, index),
      due_at: due.toISOString(),
      due_date: isoOf(due),
      month_label: MONTHS[cycleStartDate(start, index).month - 1],
      year: cycleStartDate(start, index).year,
    });
  }
  return cycles;
}

/** The next charge date after `after` (or the first one, if none has come due). */
export function nextRentDue({ rent, after = new Date() }) {
  const start = normalizeStart(rent?.start_date);
  if (!start || !(Number(rent?.amount_paise) > 0)) return null;
  if (rent.active === false) return null;

  const mode = rent.mode === RENT_MODES.ADVANCE ? RENT_MODES.ADVANCE : RENT_MODES.ARREARS;
  const end = normalizeStart(rent.end_date);
  const limit = atNoon(after.getFullYear(), after.getMonth() + 1, after.getDate());

  for (let index = 0; index < MAX_CYCLES; index += 1) {
    const due = cycleDueDate(start, index, mode);
    if (end) {
      const endLimit = atNoon(end.year, end.month, end.day);
      if (due > endLimit) return null;
    }
    if (due > limit) return { date: isoOf(due), index, key: cycleKey(start, index) };
  }
  return null;
}

/** Deterministic UUID v4-shaped id for one customer-month, so it cannot double up. */
export async function rentEntryId(customerId, key) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('WebCrypto is required to derive rent ids');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(`rent:${customerId}:${key}`));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Writes every missing rent charge for every active rent customer.
 * @returns {Promise<{created: number, customers: number}>}
 */
export async function accrueRent({ db, now = new Date(), logger = null }) {
  const customers = await db.allCustomers();
  const rentCustomers = customers.filter(
    (customer) => customer.rent?.active && Number(customer.rent.amount_paise) > 0 && customer.rent.start_date,
  );

  let created = 0;
  let touched = 0;

  for (const customer of rentCustomers) {
    const cycles = rentCycles({ rent: customer.rent, until: now });
    if (!cycles.length) continue;

    const existing = await db.transactionsForCustomer(customer.id);
    const already = new Set(existing.map((row) => row.rent_cycle).filter(Boolean));
    const skipped = new Set(Array.isArray(customer.rent.skipped) ? customer.rent.skipped : []);
    let wrote = 0;

    for (const cycle of cycles) {
      if (already.has(cycle.key) || skipped.has(cycle.key)) continue;
      const id = await rentEntryId(customer.id, cycle.key);
      if (await db.getTransaction(id)) continue;

      await db.putTransaction({
        id,
        customer_id: customer.id,
        type: 'GIVEN',
        amount_paise: Number(customer.rent.amount_paise),
        note: rentNote(normalizeStart(customer.rent.start_date), cycle.index),
        occurred_at: cycle.due_at,
        created_at: new Date().toISOString(),
        synced: false,
        source: 'rent',
        rent_cycle: cycle.key,
        // A rent charge is a bookkeeping entry, not news: never text the tenant
        // twelve times a year for it.
        sms_status: 'skipped',
        sms_error: 'auto_rent',
      });
      wrote += 1;
    }

    if (wrote) {
      created += wrote;
      touched += 1;
      logger?.info?.('rent', 'Rent charges added', { customerId: customer.id, months: wrote });
    }
  }

  return { created, customers: touched };
}

/** What the ledger card shows: amount, cycle day, next due, months charged. */
export function rentSummary({ rent, transactions = [], now = new Date() }) {
  const start = normalizeStart(rent?.start_date);
  if (!start) return null;
  const mode = rent.mode === RENT_MODES.ADVANCE ? RENT_MODES.ADVANCE : RENT_MODES.ARREARS;
  const charged = transactions.filter((row) => row.source === 'rent' && row.rent_cycle).length;
  return {
    amount_paise: Number(rent.amount_paise) || 0,
    mode,
    active: rent.active !== false,
    start_date: rent.start_date,
    cycle_day: start.day,
    end_date: rent.end_date || null,
    charged,
    next_due: rent.active === false ? null : nextRentDue({ rent, after: now })?.date || null,
  };
}

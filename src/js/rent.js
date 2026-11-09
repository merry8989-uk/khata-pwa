/**
 * Rent mode: a tenancy that charges itself.
 *
 * A tenant does not follow the calendar. Someone who moves in on the 20th rents
 * "20th to 19th" and usually pays on the 19th for the month that just finished, so
 * the cycle is anchored on the move-in day.
 *
 * What a tenancy can carry:
 *   - monthly rent, charged at the end of each rented month (arrears) or on the
 *     anniversary (advance);
 *   - an optional monthly electricity share, charged alongside the rent;
 *   - a security deposit, tracked separately because it is money held, not money
 *     earned: it never pays off rent;
 *   - a notice period, so ending a tenancy sets a real end date;
 *   - pro-rating: the final part-month is charged for the days actually lived.
 *
 * Charges are normal GIVEN entries, so balances, statements, search and sync need
 * no special cases. Their ids are derived from the customer, the month and the
 * charge kind, so a reload, a second tab or a double run cannot charge twice.
 */

export const RENT_MODES = Object.freeze({ ARREARS: 'arrears', ADVANCE: 'advance' });
export const CHARGE_KINDS = Object.freeze({ RENT: 'rent', ELECTRICITY: 'electricity' });
export const MAX_CYCLES = 600;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

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

function startAsDate(start, index) {
  const { year, month, day } = cycleStartDate(start, index);
  return atNoon(year, month, day);
}

/** The last day of cycle `index` (the day before the next anniversary). */
export function cycleEndDate(start, index) {
  const next = startAsDate(start, index + 1);
  next.setDate(next.getDate() - 1);
  return next;
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

/** "Rent - Oct 2026" / "Electricity - Oct 2026" (the month the tenancy month began). */
export function rentNote(start, index, kind = CHARGE_KINDS.RENT) {
  const { year, month } = cycleStartDate(start, index);
  const label = kind === CHARGE_KINDS.ELECTRICITY ? 'Electricity' : 'Rent';
  return `${label} - ${MONTHS[month - 1]} ${year}`;
}

/**
 * When the charge for cycle `index` becomes due.
 * - advance: on the anniversary itself (20th, 20th, ...)
 * - arrears: on the last day of the rented month (19th, 19th, ...)
 * A part-month at the end of a tenancy is due on the day the tenant leaves.
 */
export function cycleDueDate(start, index, mode = RENT_MODES.ARREARS, lastDay = null) {
  if (lastDay) return lastDay;
  if (mode === RENT_MODES.ADVANCE) return startAsDate(start, index);
  return cycleEndDate(start, index);
}

/** 'YYYY-MM-DD' of the first day of the tenancy, clamped to the real month. */
export function normalizeStart(dateOnly) {
  const parsed = parseDateOnly(dateOnly);
  if (!parsed) return null;
  const day = clampDay(parsed.year, parsed.month, parsed.day);
  return { ...parsed, day };
}

/** Days between two noon dates, inclusive of both ends. */
function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

/** The day a notice period ends, from the day the notice was given. */
export function noticeEndDate({ noticeDate, noticeDays = 0 }) {
  const start = parseDateOnly(noticeDate);
  if (!start) return null;
  const date = atNoon(start.year, start.month, start.day);
  date.setDate(date.getDate() + Math.max(0, Math.round(Number(noticeDays) || 0)));
  return isoOf(date);
}

/**
 * Every charge that has come due by `until`, with the amount for that month.
 * The final month of a tenancy is pro-rated to the days actually lived.
 */
export function rentCycles({ rent, until = new Date() }) {
  if (rent?.active === false) return [];
  const start = normalizeStart(rent?.start_date);
  if (!start || !(Number(rent?.amount_paise) > 0)) return [];

  const mode = rent.mode === RENT_MODES.ADVANCE ? RENT_MODES.ADVANCE : RENT_MODES.ARREARS;
  const end = normalizeStart(rent.end_date);
  const endDate = end ? atNoon(end.year, end.month, end.day) : null;
  const limit = atNoon(until.getFullYear(), until.getMonth() + 1, until.getDate());

  const cycles = [];
  for (let index = 0; index < MAX_CYCLES; index += 1) {
    const from = startAsDate(start, index);
    const to = cycleEndDate(start, index);

    // A tenancy that ended before this month began charges nothing more.
    if (endDate && endDate < from) break;

    const truncated = Boolean(endDate && endDate < to);
    const lastDay = truncated ? endDate : null;
    const due = cycleDueDate(start, index, mode, lastDay);
    if (due > limit) break;

    const daysInCycle = daysBetween(from, to);
    const daysUsed = truncated ? daysBetween(from, endDate) : daysInCycle;
    const fraction = truncated ? Math.min(1, daysUsed / daysInCycle) : 1;

    cycles.push({
      index,
      key: cycleKey(start, index),
      from: isoOf(from),
      to: isoOf(truncated ? endDate : to),
      due_at: due.toISOString(),
      due_date: isoOf(due),
      month_label: MONTHS[cycleStartDate(start, index).month - 1],
      year: cycleStartDate(start, index).year,
      truncated,
      days: daysUsed,
      days_in_cycle: daysInCycle,
      amount_paise: Math.round(Number(rent.amount_paise) * fraction),
      electricity_paise: Number(rent.electricity_paise) > 0
        ? Math.round(Number(rent.electricity_paise) * fraction)
        : 0,
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
  const endDate = end ? atNoon(end.year, end.month, end.day) : null;
  const limit = atNoon(after.getFullYear(), after.getMonth() + 1, after.getDate());

  for (let index = 0; index < MAX_CYCLES; index += 1) {
    const from = startAsDate(start, index);
    const to = cycleEndDate(start, index);
    if (endDate && endDate < from) return null;

    const truncated = Boolean(endDate && endDate < to);
    const due = cycleDueDate(start, index, mode, truncated ? endDate : null);
    if (due > limit) return { date: isoOf(due), index, key: cycleKey(start, index) };
  }
  return null;
}

/** Deterministic UUID v4-shaped id, so one charge can never be created twice. */
export async function rentEntryId(customerId, key, kind = CHARGE_KINDS.RENT) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('WebCrypto is required to derive rent ids');
  const digest = await cryptoApi.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${kind}:${customerId}:${key}`),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A charge key that distinguishes rent from electricity inside one month. */
function chargeKey(cycleKeyValue, kind) {
  return kind === CHARGE_KINDS.ELECTRICITY ? `${cycleKeyValue}:e` : cycleKeyValue;
}

/**
 * Writes every missing charge for every active tenancy: rent, and electricity when
 * the tenancy has a monthly share.
 * @returns {Promise<{created: number, customers: number}>}
 */
export async function accrueRent({ db, now = new Date(), logger = null }) {
  const customers = await db.allCustomers();
  const tenants = customers.filter(
    (customer) => customer.rent?.active && Number(customer.rent.amount_paise) > 0 && customer.rent.start_date,
  );

  let created = 0;
  let touched = 0;

  for (const customer of tenants) {
    const cycles = rentCycles({ rent: customer.rent, until: now });
    if (!cycles.length) continue;

    const existing = await db.transactionsForCustomer(customer.id);
    const existingByKey = new Map();
    for (const row of existing.filter((entry) => entry.source === 'rent')) {
      existingByKey.set(chargeKey(row.rent_cycle, row.charge_kind), row);
    }
    const already = new Set(existingByKey.keys());
    const skipped = new Set(Array.isArray(customer.rent.skipped) ? customer.rent.skipped : []);
    const start = normalizeStart(customer.rent.start_date);
    let wrote = 0;

    for (const cycle of cycles) {
      const charges = [{ kind: CHARGE_KINDS.RENT, amount: cycle.amount_paise }];
      if (cycle.electricity_paise > 0) {
        charges.push({ kind: CHARGE_KINDS.ELECTRICITY, amount: cycle.electricity_paise });
      }

      for (const charge of charges) {
        const key = chargeKey(cycle.key, charge.kind);
        if (skipped.has(key) || skipped.has(cycle.key)) continue;
        if (!(charge.amount > 0)) continue;

        const posted = existingByKey.get(key);
        if (posted) {
          // A month already charged at full rate, in a tenancy that has since been
          // cut short: correct it to the days actually lived. Same id, so it is
          // still one charge - the balance shows a credit if they paid the full one.
          if (cycle.truncated && Number(posted.amount_paise) !== charge.amount) {
            await db.putTransaction({
              ...posted,
              amount_paise: charge.amount,
              note: rentNote(start, cycle.index, charge.kind),
              occurred_at: cycle.due_at,
              synced: false,
            });
            wrote += 1;
          }
          continue;
        }

        const id = await rentEntryId(customer.id, cycle.key, charge.kind);
        if (await db.getTransaction(id)) continue;

        await db.putTransaction({
          id,
          customer_id: customer.id,
          type: 'GIVEN',
          amount_paise: charge.amount,
          note: rentNote(start, cycle.index, charge.kind),
          occurred_at: cycle.due_at,
          created_at: new Date().toISOString(),
          synced: false,
          source: 'rent',
          charge_kind: charge.kind,
          rent_cycle: cycle.key,
          // A monthly charge is bookkeeping, not news: never text the tenant for it.
          sms_status: 'skipped',
          sms_error: 'auto_rent',
        });
        wrote += 1;
      }
    }

    if (wrote) {
      created += wrote;
      touched += 1;
      logger?.info?.('rent', 'Charges added', { customerId: customer.id, charges: wrote });
    }
  }

  return { created, customers: touched };
}

/**
 * Deposit money: what was agreed, what is still held, and what has gone back.
 * A deposit is a liability, so it is tracked from its own entries rather than
 * being netted against rent.
 */
export function depositHeld({ rent, transactions = [] }) {
  const agreed = Number(rent?.deposit_paise) || 0;
  const rows = transactions.filter((row) => row.source === 'deposit');
  const received = rows
    .filter((row) => row.type === 'GOT')
    .reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);
  const refunded = rows
    .filter((row) => row.type === 'GIVEN')
    .reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);
  return { agreed, received, refunded, held: received - refunded, entries: rows.length };
}

/** What the ledger card shows. */
export function rentSummary({ rent, transactions = [], now = new Date() }) {
  const start = normalizeStart(rent?.start_date);
  if (!start) return null;
  const mode = rent.mode === RENT_MODES.ADVANCE ? RENT_MODES.ADVANCE : RENT_MODES.ARREARS;
  const rentRows = transactions.filter((row) => row.source === 'rent' && row.rent_cycle);
  const charged = rentRows.filter((row) => (row.charge_kind || CHARGE_KINDS.RENT) === CHARGE_KINDS.RENT).length;
  const billed = rentRows.reduce((sum, row) => sum + Number(row.amount_paise || 0), 0);
  const deposit = depositHeld({ rent, transactions });
  const ended = Boolean(rent.end_date) || rent.active === false;

  return {
    amount_paise: Number(rent.amount_paise) || 0,
    electricity_paise: Number(rent.electricity_paise) || 0,
    mode,
    active: rent.active !== false,
    ended,
    start_date: rent.start_date,
    cycle_day: start.day,
    end_date: rent.end_date || null,
    notice_days: Number(rent.notice_days) || 0,
    charged,
    billed,
    deposit,
    // A change of amount only affects months not yet charged; say so when the
    // last charge used a different figure.
    last_charged_paise: rentRows
      .filter((row) => (row.charge_kind || CHARGE_KINDS.RENT) === CHARGE_KINDS.RENT)
      .sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))
      .map((row) => Number(row.amount_paise))[0] || null,
    next_due: rent.active === false ? null : nextRentDue({ rent, after: now })?.date || null,
  };
}

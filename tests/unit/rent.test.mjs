/**
 * Rent cycle maths. This is date arithmetic that decides money, so it is tested
 * against the awkward cases: short months, leap years, tenants who move in on the
 * 31st, arrears vs advance, and a tenancy that has ended.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  accrueRent,
  cycleDueDate,
  cycleKey,
  nextRentDue,
  normalizeStart,
  rentCycles,
  rentEntryId,
  rentNote,
  rentSummary,
} from '../../src/js/rent.js';

const noon = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const rentOf = (overrides = {}) => ({
  active: true,
  amount_paise: 500000,
  start_date: '2026-10-20',
  mode: 'arrears',
  ...overrides,
});

test('the cycle is anchored on the move-in day, not the calendar month', () => {
  const start = normalizeStart('2026-10-20');
  assert.equal(cycleKey(start, 0), '2026-10');
  assert.equal(cycleKey(start, 1), '2026-11');
  assert.equal(cycleKey(start, 3), '2027-01');
  assert.equal(rentNote(start, 0), 'Rent - Oct 2026');
  assert.equal(rentNote(start, 3), 'Rent - Jan 2027');
});

test('arrears charges on the last day of the rented month', () => {
  const start = normalizeStart('2026-10-20');
  assert.equal(cycleDueDate(start, 0, 'arrears').getDate(), 19);
  assert.equal(cycleDueDate(start, 0, 'arrears').getMonth(), 10); // November
  assert.equal(cycleDueDate(start, 1, 'arrears').getMonth(), 11); // December
});

test('advance charges on the anniversary itself', () => {
  const start = normalizeStart('2026-10-20');
  const first = cycleDueDate(start, 0, 'advance');
  assert.equal(first.getDate(), 20);
  assert.equal(first.getMonth(), 9); // October
});

test('a tenancy starting on the 31st clamps to the short months', () => {
  const start = normalizeStart('2026-01-31');
  assert.equal(start.day, 31);
  assert.equal(cycleKey(start, 0), '2026-01');
  // January's rented month ends on 27 Feb (the next cycle begins 28 Feb, clamped),
  // so the arrears charge lands there.
  const january = cycleDueDate(start, 0, 'arrears');
  assert.equal(january.getMonth(), 1);
  assert.equal(january.getDate(), 27);
  // February's cycle begins on the clamped 28th.
  const february = cycleDueDate(start, 1, 'advance');
  assert.equal(february.getMonth(), 1);
  assert.equal(february.getDate(), 28);
});

test('a leap year February is handled', () => {
  const start = normalizeStart('2028-01-31');
  const advance = cycleDueDate(start, 1, 'advance');
  assert.equal(advance.getDate(), 29, '2028 is a leap year');
  assert.equal(advance.getMonth(), 1);
});

test('arrears on a first-of-month tenancy charges on the last day of that month', () => {
  const start = normalizeStart('2026-11-01');
  const due = cycleDueDate(start, 0, 'arrears');
  assert.equal(due.getMonth(), 10); // November
  assert.equal(due.getDate(), 30);
});

test('cycles stop at the day they are asked about', () => {
  const rent = rentOf();
  // Arrears: October's rented month ends 19 Nov, November's ends 19 Dec.
  const cycles = rentCycles({ rent, until: noon(2026, 12, 19) });
  assert.deepEqual(cycles.map((cycle) => cycle.key), ['2026-10', '2026-11']);
  assert.deepEqual(cycles.map((cycle) => cycle.due_date), ['2026-11-19', '2026-12-19']);

  // December's charge is not due until 19 January, so 20 December adds nothing.
  const later = rentCycles({ rent, until: noon(2026, 12, 20) });
  assert.deepEqual(later.map((cycle) => cycle.key), ['2026-10', '2026-11']);

  const january = rentCycles({ rent, until: noon(2027, 1, 19) });
  assert.deepEqual(january.map((cycle) => cycle.key), ['2026-10', '2026-11', '2026-12']);
});

test('nothing is charged before the tenant moves in', () => {
  const cycles = rentCycles({ rent: rentOf({ start_date: '2027-03-05' }), until: noon(2026, 12, 31) });
  assert.deepEqual(cycles, []);
});

test('a tenancy that has ended stops charging', () => {
  const rent = rentOf({ end_date: '2026-11-19' });
  const cycles = rentCycles({ rent, until: noon(2027, 6, 1) });
  assert.deepEqual(cycles.map((cycle) => cycle.key), ['2026-10']);
});

test('an inactive rent accrues nothing and has no next due', () => {
  const rent = rentOf({ active: false });
  assert.deepEqual(rentCycles({ rent, until: noon(2027, 6, 1) }), []);
  assert.equal(nextRentDue({ rent, after: noon(2026, 12, 1) }), null);
});

test('the next due date is the first one after today', () => {
  const rent = rentOf();
  assert.equal(nextRentDue({ rent, after: noon(2026, 11, 1) }).date, '2026-11-19');
  assert.equal(nextRentDue({ rent, after: noon(2026, 11, 19) }).date, '2026-12-19');
  assert.equal(nextRentDue({ rent, after: noon(2026, 11, 20) }).date, '2026-12-19');
});

test('an advance tenancy that starts in the future has its first charge on the start day', () => {
  const rent = rentOf({ start_date: '2027-02-10', mode: 'advance' });
  assert.deepEqual(rentCycles({ rent, until: noon(2027, 2, 9) }), []);
  assert.equal(nextRentDue({ rent, after: noon(2027, 2, 9) }).date, '2027-02-10');
});

test('a zero or missing amount is not a rent customer', () => {
  assert.deepEqual(rentCycles({ rent: rentOf({ amount_paise: 0 }), until: noon(2027, 1, 1) }), []);
  assert.deepEqual(rentCycles({ rent: { start_date: '2026-10-20' }, until: noon(2027, 1, 1) }), []);
  assert.equal(normalizeStart('nonsense'), null);
  assert.equal(normalizeStart('2026-13-01'), null);
});

test('rent entry ids are deterministic, unique per month and look like UUIDs', async () => {
  const customer = '11111111-1111-4111-8111-111111111111';
  const first = await rentEntryId(customer, '2026-10');
  const again = await rentEntryId(customer, '2026-10');
  const next = await rentEntryId(customer, '2026-11');
  const other = await rentEntryId('22222222-2222-4222-8222-222222222222', '2026-10');

  assert.equal(first, again, 'same customer and month always give the same id');
  assert.notEqual(first, next);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the summary reports the cycle day, the next due date and the months charged', () => {
  const summary = rentSummary({
    rent: rentOf(),
    transactions: [
      { id: 'a', source: 'rent', rent_cycle: '2026-10' },
      { id: 'b', source: 'rent', rent_cycle: '2026-11' },
      { id: 'c', source: 'manual' },
    ],
    now: noon(2026, 12, 1),
  });
  assert.equal(summary.amount_paise, 500000);
  assert.equal(summary.cycle_day, 20);
  assert.equal(summary.charged, 2);
  assert.equal(summary.next_due, '2026-12-19');
  assert.equal(summary.mode, 'arrears');
});

test('accrueRent writes one entry per due month, then does nothing on a second run', async () => {
  const created = [];
  const store = new Map();
  const db = {
    async allCustomers() {
      return [{ id: 'c1', name: 'Rakesh', rent: rentOf() }];
    },
    async transactionsForCustomer() {
      return [...store.values()];
    },
    async getTransaction(id) {
      return store.get(id);
    },
    async putTransaction(row) {
      store.set(row.id, row);
      created.push(row);
      return row;
    },
  };

  const first = await accrueRent({ db, now: noon(2027, 1, 19) });
  assert.equal(first.created, 3, 'Oct, Nov and Dec cycles, all now due');
  assert.equal(first.customers, 1);
  assert.deepEqual(
    created.map((row) => row.note),
    ['Rent - Oct 2026', 'Rent - Nov 2026', 'Rent - Dec 2026'],
  );
  assert.equal(created[0].type, 'GIVEN');
  assert.equal(created[0].amount_paise, 500000);
  assert.equal(created[0].source, 'rent');
  assert.equal(created[0].sms_status, 'skipped', 'rent charges do not text the tenant');
  assert.equal(created[0].synced, false, 'they still queue for the server');

  const second = await accrueRent({ db, now: noon(2027, 1, 19) });
  assert.equal(second.created, 0, 'a second pass adds nothing');
  assert.equal(store.size, 3);
});

test('accrueRent respects a month the shopkeeper deleted', async () => {
  const store = new Map();
  const db = {
    async allCustomers() {
      return [{ id: 'c1', name: 'Rakesh', rent: rentOf({ skipped: ['2026-11'] }) }];
    },
    async transactionsForCustomer() {
      return [...store.values()];
    },
    async getTransaction(id) {
      return store.get(id);
    },
    async putTransaction(row) {
      store.set(row.id, row);
      return row;
    },
  };
  const result = await accrueRent({ db, now: noon(2027, 1, 19) });
  assert.equal(result.created, 2, 'October and December, with November skipped');
  assert.deepEqual([...store.values()].map((row) => row.rent_cycle), ['2026-10', '2026-12']);
});

test('accrueRent ignores customers who are not renting', async () => {
  const db = {
    async allCustomers() {
      return [
        { id: 'c1', name: 'Shop customer' },
        { id: 'c2', name: 'Ex-tenant', rent: rentOf({ active: false }) },
      ];
    },
    async transactionsForCustomer() {
      return [];
    },
    async getTransaction() {
      return undefined;
    },
    async putTransaction() {
      throw new Error('should not write');
    },
  };
  const result = await accrueRent({ db, now: noon(2027, 1, 19) });
  assert.deepEqual(result, { created: 0, customers: 0 });
});

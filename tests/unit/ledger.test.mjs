import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  balanceKind,
  formatDate,
  formatDateTime,
  netByCustomer,
  normalizeType,
  shopTotals,
  sortByTime,
  statementRows,
  summarize,
  withRunningBalance,
} from '../../src/js/shared/ledger.js';

const at = (day, hour = 12) => new Date(2026, 10, day, hour, 0, 0).toISOString();

const entries = [
  { id: 'a', customer_id: 'c1', type: 'GIVEN', amount_paise: 500000, occurred_at: at(1), created_at: at(1) },
  { id: 'b', customer_id: 'c1', type: 'GOT', amount_paise: 200000, occurred_at: at(3), created_at: at(3) },
  { id: 'c', customer_id: 'c2', type: 'GIVEN', amount_paise: 100000, occurred_at: at(2), created_at: at(2) },
  { id: 'd', customer_id: 'c1', type: 'GIVEN', amount_paise: 50000, occurred_at: at(5), created_at: at(5) },
];

test('normalises the spec aliases to GIVEN/GOT', () => {
  assert.equal(normalizeType('GIVEN'), 'GIVEN');
  assert.equal(normalizeType('CREDIT'), 'GIVEN');
  assert.equal(normalizeType('given'), 'GIVEN');
  assert.equal(normalizeType('DEBIT'), 'GOT');
  assert.equal(normalizeType('GOT'), 'GOT');
  assert.equal(normalizeType('nonsense'), null);
  assert.equal(normalizeType(undefined), null);
});

test('summarise nets given minus got and skips voided rows', () => {
  const totals = summarize(entries);
  assert.deepEqual(totals, { given: 650000, got: 200000, net: 450000, count: 4 });
  const withVoid = summarize([...entries, { ...entries[0], id: 'z', voided: true }]);
  assert.equal(withVoid.given, 650000);
});

test('balance direction is derived from the sign of net', () => {
  assert.equal(balanceKind(1), 'GET');
  assert.equal(balanceKind(-1), 'GIVE');
  assert.equal(balanceKind(0), 'SETTLED');
});

test('running balance is cumulative and oldest-first', () => {
  const c1 = withRunningBalance(entries.filter((tx) => tx.customer_id === 'c1'));
  assert.deepEqual(
    c1.map((tx) => [tx.id, tx.running_paise]),
    [
      ['a', 500000],
      ['b', 300000],
      ['d', 350000],
    ],
  );
});

test('sorting is stable for identical timestamps', () => {
  const same = at(7);
  const rows = [
    { id: 'x2', type: 'GIVEN', amount_paise: 1, occurred_at: same, created_at: '2026-11-07T06:00:00.000Z' },
    { id: 'x1', type: 'GIVEN', amount_paise: 1, occurred_at: same, created_at: '2026-11-07T05:00:00.000Z' },
  ];
  assert.deepEqual(sortByTime(rows).map((row) => row.id), ['x1', 'x2']);
});

test('per-customer nets and shop totals', () => {
  const nets = netByCustomer(entries);
  assert.equal(nets.get('c1').net, 350000);
  assert.equal(nets.get('c2').net, 100000);
  const totals = shopTotals(entries);
  assert.deepEqual(totals, { given: 650000, got: 200000, net: 450000, receivable: 450000, payable: 0 });

  const payable = shopTotals([
    { id: 'p', customer_id: 'c9', type: 'GOT', amount_paise: 900000, occurred_at: at(1) },
  ]);
  assert.deepEqual(payable, { given: 0, got: 900000, net: -900000, receivable: 0, payable: 900000 });
});

test('statement rows carry index, direction and running balance', () => {
  const rows = statementRows(entries.filter((tx) => tx.customer_id === 'c1'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.index), [1, 2, 3]);
  assert.equal(rows[1].type, 'GOT');
  assert.equal(rows[1].running_paise, 300000);
  assert.equal(rows[0].date, formatDate(at(1)));
});

test('dates are formatted deterministically, not by locale data', () => {
  assert.equal(formatDate(new Date(2026, 10, 7, 15, 5).toISOString()), '07 Nov 2026');
  assert.equal(formatDateTime(new Date(2026, 10, 7, 15, 5).toISOString()), '07 Nov 2026, 3:05 pm');
  assert.equal(formatDateTime(new Date(2026, 10, 7, 0, 0).toISOString()), '07 Nov 2026, 12:00 am');
  assert.equal(formatDate('not-a-date'), '');
});

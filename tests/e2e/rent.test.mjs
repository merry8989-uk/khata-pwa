/**
 * Rent mode end to end: a tenant whose rent accrues on their own date.
 *
 * Drives the real UI: turn rent on for a customer who moved in three months ago,
 * check the months appear by themselves, pay one, delete one and make sure it is
 * not silently recreated, and confirm a reload does not double anything.
 *
 *   npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4416;
const BASE = `http://localhost:${PORT}/`;

let server = null;
let browser = null;
let page = null;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/local/bin/chromium',
    '/usr/bin/chromium',
    '/usr/local/bin/chromium-headless-shell',
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('No Chromium binary found; set CHROME_PATH');
  return found;
}

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server never came up at ${url}`);
}

/** Three months back, same day of month: the tenant's anniversary is today. */
function moveInDate() {
  const date = new Date();
  date.setMonth(date.getMonth() - 3);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

before(async () => {
  if (!existsSync(join(ROOT, 'docs', 'app', 'index.html'))) {
    throw new Error('docs/app is not built - run npm run build first');
  }
  server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs'), String(PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await waitForServer(BASE);

  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#main .card', { timeout: 15000 });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
});

async function click(selector) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
}

async function fill(selector, value) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.evaluate(
    (sel, val) => {
      const node = document.querySelector(sel);
      node.focus();
      node.value = val;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    value,
  );
}

const rows = () =>
  page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    const customer = customers[0];
    const transactions = await window.Khata.db.transactionsForCustomer(customer.id);
    return { customer, transactions };
  });

test('turning rent on backdates every month the tenant has already lived', async () => {
  await click('#dashboard-add-customer');
  await fill('#customer-name', 'Rakesh Verma');
  await fill('#customer-phone', '9812345678');

  // Rent is off until the switch is turned on.
  assert.equal(await page.$eval('#rent-fields', (node) => node.classList.contains('hidden')), true);
  await click('#rent-toggle');
  assert.equal(await page.$eval('#rent-fields', (node) => node.classList.contains('hidden')), false);

  await fill('#rent-amount', '5000');
  await fill('#rent-start', moveInDate());
  await click('#customer-save');
  await page.waitForSelector('[data-customer-id]');

  await page.waitForFunction(
    async () => {
      const customers = await window.Khata.db.allCustomers();
      const transactions = await window.Khata.db.transactionsForCustomer(customers[0].id);
      return transactions.filter((row) => row.source === 'rent').length >= 2;
    },
    { timeout: 15000 },
  );

  const { customer, transactions } = await rows();
  const rentRows = transactions.filter((row) => row.source === 'rent');
  assert.equal(customer.rent.amount_paise, 500000);
  assert.equal(customer.rent.mode, 'arrears');
  assert.equal(customer.rent.active, true);
  assert.ok(rentRows.length >= 2, `expected months to have accrued, got ${rentRows.length}`);
  assert.ok(rentRows.every((row) => row.type === 'GIVEN' && row.amount_paise === 500000));
  assert.ok(rentRows.every((row) => /^Rent - [A-Z][a-z]{2} \d{4}$/.test(row.note)), rentRows[0].note);
  assert.ok(rentRows.every((row) => row.sms_status === 'skipped'), 'rent charges do not text the tenant');
});

test('the ledger shows the tenancy and the next charge date', async () => {
  await click('[data-customer-id]');
  await page.waitForSelector('#rent-card');

  const card = await page.$eval('#rent-card', (node) => node.textContent);
  assert.match(card, /Rent/);
  assert.match(card, /₹5,000 \/ month/);
  assert.match(card, /Tenant since/);
  assert.match(card, /months charged/);
  assert.match(card, /Charged at the end of each month/);

  const nextDue = await page.$eval('#rent-next-due', (node) => node.textContent);
  assert.match(nextDue, /Next due \d{2} [A-Z][a-z]{2} \d{4}/);

  // The balance is exactly the rent months that have accrued.
  const { transactions } = await rows();
  const accrued = transactions.filter((row) => row.source === 'rent').length;
  const balance = await page.$eval('#customer-balance', (node) => node.textContent);
  assert.equal(balance, `₹${(accrued * 5000).toLocaleString('en-IN')}`);
});

test('a reload does not double the rent months', async () => {
  const before = (await rows()).transactions.filter((row) => row.source === 'rent').length;
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#rent-card');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = (await rows()).transactions.filter((row) => row.source === 'rent').length;
  assert.equal(after, before, 'the accrual pass is idempotent');
});

test('rent received prefills the payment and settles a month', async () => {
  const before = await rows();
  const beforeBalance = before.transactions
    .filter((row) => row.type === 'GIVEN')
    .reduce((sum, row) => sum + row.amount_paise, 0) -
    before.transactions.filter((row) => row.type === 'GOT').reduce((sum, row) => sum + row.amount_paise, 0);

  await click('#rent-payment');
  await page.waitForSelector('#tx-amount');
  assert.equal(await page.$eval('#tx-amount', (node) => node.value), '5000');
  assert.equal(await page.$eval('#tx-note', (node) => node.value), 'Rent payment');
  await click('#tx-save');

  await page.waitForFunction(
    async () => {
      const customers = await window.Khata.db.allCustomers();
      const transactions = await window.Khata.db.transactionsForCustomer(customers[0].id);
      return transactions.some((row) => row.type === 'GOT' && row.note === 'Rent payment');
    },
    { timeout: 15000 },
  );

  const after = await rows();
  const paid = after.transactions.filter((row) => row.type === 'GOT');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].amount_paise, 500000);
  assert.equal(paid[0].source, 'manual', 'a payment is the shopkeeper\'s entry, not an accrual');

  const afterBalance = after.transactions
    .filter((row) => row.type === 'GIVEN')
    .reduce((sum, row) => sum + row.amount_paise, 0) -
    after.transactions.filter((row) => row.type === 'GOT').reduce((sum, row) => sum + row.amount_paise, 0);
  assert.equal(afterBalance, beforeBalance - 500000);
});

test('deleting an auto charge keeps it deleted', async () => {
  const before = await rows();
  const target = before.transactions.filter((row) => row.source === 'rent')[0];
  const countBefore = before.transactions.filter((row) => row.source === 'rent').length;

  await page.evaluate(async (id) => {
    const { db } = window.Khata;
    const transaction = await db.getTransaction(id);
    await db.deleteTransaction(id);
    const customer = await db.getCustomer(transaction.customer_id);
    const skipped = new Set(customer.rent.skipped || []);
    skipped.add(transaction.rent_cycle);
    await db.putCustomer({ ...customer, rent: { ...customer.rent, skipped: [...skipped] } });
    await window.Khata.api.reloadData();
    window.Khata.api.render();
  }, target.id);

  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#rent-card');
  await new Promise((resolve) => setTimeout(resolve, 900));

  const after = await rows();
  const countAfter = after.transactions.filter((row) => row.source === 'rent').length;
  assert.equal(countAfter, countBefore - 1, 'the deleted month was not put back by the accrual pass');
  assert.ok(after.customer.rent.skipped.includes(target.rent_cycle), 'the month is remembered as skipped');
});

test('the dashboard marks a renting customer', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-customer-id]');
  const row = await page.$eval('[data-customer-id]', (node) => node.textContent);
  assert.match(row, /RENT/);
  assert.match(row, /Rakesh Verma/);
});

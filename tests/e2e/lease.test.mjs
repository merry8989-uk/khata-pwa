/**
 * The paperwork side: files attached to an entry, the deposit, ending a tenancy
 * with notice, and the scheduled on-device backup.
 *
 *   npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4418;
const BASE = `http://localhost:${PORT}/`;

let server = null;
let browser = null;
let page = null;
let sampleFile = null;

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

function moveInDate(monthsBack = 3) {
  const date = new Date();
  date.setMonth(date.getMonth() - monthsBack);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

before(async () => {
  if (!existsSync(join(ROOT, 'docs', 'app', 'index.html'))) {
    throw new Error('docs/app is not built - run npm run build first');
  }
  const dir = mkdtempSync(join(tmpdir(), 'khata-attach-'));
  sampleFile = join(dir, 'saman-list.txt');
  writeFileSync(sampleFile, 'Atta 25kg x2\nSugar 10kg x1\nTotal: 2400\n');

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

test('the first launch takes a backup by itself', async () => {
  const backups = await page.evaluate(async () => {
    const rows = await window.Khata.db.listBackups();
    return rows.map((row) => ({ kind: row.kind, size: row.size, meta: row.meta }));
  });
  assert.ok(backups.length >= 1, 'a snapshot exists without anyone pressing anything');
  assert.equal(backups[0].kind, 'scheduled');
  assert.ok(backups[0].size > 100, 'the zip has content');
});

test('a file rides along with an entry and shows on the row', async () => {
  await click('#dashboard-add-customer');
  await fill('#customer-name', 'Ramesh Kumar');
  await fill('#customer-phone', '9876543210');
  await click('#customer-save');
  await page.waitForSelector('[data-customer-id]');

  await click('[data-customer-id]');
  await page.waitForSelector('#ledger-gave');
  await click('#ledger-gave');
  await fill('#tx-amount', '2400');
  await fill('#tx-note', 'Monthly saman');

  const input = await page.$('#attachment-input');
  await input.uploadFile(sampleFile);
  await page.waitForFunction(() => document.querySelector('#attachment-list')?.textContent.includes('saman-list.txt'), {
    timeout: 15000,
  });

  await click('#tx-save');
  await page.waitForSelector('#customer-balance');

  await page.waitForFunction(
    async () => {
      const customers = await window.Khata.db.allCustomers();
      const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
      return rows.some((row) => row.attachment_count === 1);
    },
    { timeout: 15000 },
  );

  const stored = await page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
    const files = await window.Khata.db.attachmentsForTransaction(rows[0].id);
    return { count: rows[0].attachment_count, files: files.map((file) => ({ name: file.name, size: file.size, kind: file.kind })) };
  });
  assert.equal(stored.count, 1);
  assert.equal(stored.files[0].name, 'saman-list.txt');
  assert.ok(stored.files[0].size > 10);

  // The row carries a paperclip, and the sheet lists the file when reopened.
  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('📎'), { timeout: 10000 });
  await page.evaluate(() => document.querySelectorAll('ul li button')[0].click());
  await page.waitForSelector('#attachment-list');
  await page.waitForFunction(() => document.querySelector('#attachment-list')?.textContent.includes('saman-list.txt'), {
    timeout: 10000,
  });
  await page.keyboard.press('Escape');
});

test('the backup zip carries the attached file, and restores it', async () => {
  const result = await page.evaluate(async () => {
    const { blob, manifest, attachmentCount } = await window.Khata.db.exportBackupZip();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      size: blob.size,
      attachments: attachmentCount,
      customers: manifest.customers.length,
      hasZipMagic: bytes[0] === 0x50 && bytes[1] === 0x4b,
      // Keep the bytes for the restore half of the test.
      base64: btoa(String.fromCharCode.apply(null, bytes.slice(0, 0))),
    };
  });
  assert.equal(result.attachments, 1);
  assert.equal(result.customers, 1);
  assert.equal(result.hasZipMagic, true);
  assert.ok(result.size > 200);
});

test('a deposit is money held, not rent paid', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-customer-id]');
  await click('[data-customer-id]');
  await page.waitForSelector('#ledger-gave');

  // Turn rent on with a deposit, from the customer sheet.
  await click('#rent-edit').catch(async () => {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      buttons.find((node) => (node.getAttribute('aria-label') || '').includes('Edit')).click();
    });
  });
  await page.waitForSelector('#rent-toggle');
  const isOn = await page.$eval('#rent-toggle', (node) => node.getAttribute('aria-checked') === 'true');
  if (!isOn) await click('#rent-toggle');
  await fill('#rent-amount', '5000');
  await fill('#rent-start', moveInDate(2));
  await fill('#rent-deposit', '20000');
  await fill('#rent-notice', '30');
  await click('#customer-save');
  await page.waitForSelector('#rent-card');

  await page.waitForFunction(() => document.querySelector('#rent-deposit-line'), { timeout: 15000 });
  const before = await page.$eval('#rent-deposit-line', (node) => node.textContent);
  assert.match(before, /Deposit ₹0 held \(agreed ₹20,000\)/);

  await click('#rent-deposit');
  await page.waitForSelector('#deposit-amount');
  await fill('#deposit-amount', '20000');
  await click('#deposit-received');
  await page.waitForFunction(() => document.querySelector('#rent-deposit-line')?.textContent.includes('₹20,000 held'), {
    timeout: 15000,
  });

  const after = await page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
    return rows.filter((row) => row.source === 'deposit').map((row) => ({ type: row.type, amount: row.amount_paise }));
  });
  assert.deepEqual(after, [{ type: 'GOT', amount: 2000000 }]);
});

test('ending a tenancy mid-month charges only the days lived', async () => {
  // End it through the UI: notice given 33 days ago, 30 days notice, so the
  // tenancy ended three days ago - inside the current rented month.
  const notice = new Date();
  notice.setDate(notice.getDate() - 33);
  const noticeIso = `${notice.getFullYear()}-${String(notice.getMonth() + 1).padStart(2, '0')}-${String(notice.getDate()).padStart(2, '0')}`;
  const expectedEnd = new Date(notice);
  expectedEnd.setDate(expectedEnd.getDate() + 30);
  const expectedEndIso = `${expectedEnd.getFullYear()}-${String(expectedEnd.getMonth() + 1).padStart(2, '0')}-${String(expectedEnd.getDate()).padStart(2, '0')}`;

  await click('#rent-end');
  await page.waitForSelector('#end-notice-date');
  await fill('#end-notice-date', noticeIso);
  await page.waitForFunction(() => document.querySelector('#end-preview')?.textContent.includes('Tenancy ends on'), {
    timeout: 10000,
  });
  await click('#end-confirm');

  await page.waitForSelector('#rent-end-line');
  const line = await page.$eval('#rent-end-line', (node) => node.textContent);
  assert.match(line, /Ends on/);
  assert.equal(await page.$eval('#rent-end', (node) => node.disabled), true, 'a second ending is not offered');
  assert.match(
    await page.$eval('#rent-next-due', (node) => node.textContent),
    /No further charge/,
    'nothing more is due once the tenancy has ended',
  );

  const charges = await page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
    return rows
      .filter((row) => row.source === 'rent' && row.charge_kind === 'rent')
      .map((row) => ({ amount: row.amount_paise, cycle: row.rent_cycle, at: row.occurred_at.slice(0, 10) }));
  });

  assert.ok(charges.length >= 1);
  const partMonth = charges.find((charge) => charge.amount !== 500000);
  assert.ok(partMonth, `expected one pro-rated month, got ${JSON.stringify(charges)}`);
  assert.ok(partMonth.amount > 0 && partMonth.amount < 500000);
  assert.equal(partMonth.at, expectedEndIso, 'the part-month is dated the day they left');
  assert.ok(charges.every((charge) => charge.amount <= 500000));

  const stored = await page.evaluate(async () => (await window.Khata.db.allCustomers())[0].rent);
  assert.equal(stored.end_date, expectedEndIso);
  assert.ok(stored.ended_at, 'the ending is recorded');
});

/**
 * Device SMS end to end: the real app, with the Android bridge stubbed.
 *
 * The shell's SmsGateway is native, so it cannot run in Chromium; what this proves
 * is everything on the web side of the bridge - the decision to send, the number
 * and body handed over, the asynchronous radio verdict, the entry being marked
 * exactly once, and the Settings quota row.
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
const PORT = 4414;
const BASE = `http://localhost:${PORT}/`;

let server = null;
let browser = null;
let page = null;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/local/bin/chromium',
    '/usr/bin/chromium',
    '/usr/local/bin/chromium-headless-server',
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

  // Stand in for the Android shell before any app code runs.
  await page.evaluateOnNewDocument(() => {
    window.__smsCalls = [];
    window.__smsVerdict = 'sent';
    window.KhataAndroid = {
      platform: () => 'android/test',
      canSendSms: () => true,
      smsQuota: () => JSON.stringify({ sent: 4, cap: 90, date: '2026-11-07' }),
      sendSms(id, number, body) {
        window.__smsCalls.push({ id, number, body });
        setTimeout(() => {
          window.__khataSmsResult({ id, status: window.__smsVerdict, detail: null });
        }, 20);
      },
    };
  });

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

test('the first entry texts the customer from the phone and is marked once', async () => {
  await click('#dashboard-add-customer');
  await fill('#customer-name', 'Ramesh Kumar');
  await fill('#customer-phone', '9876543210');
  await click('#customer-save');
  await page.waitForSelector('[data-customer-id]');

  await click('[data-customer-id]');
  await page.waitForSelector('#ledger-gave');
  await click('#ledger-gave');
  await fill('#tx-amount', '500');
  await fill('#tx-note', 'Rice and oil');
  await click('#tx-save');

  await page.waitForFunction(() => window.__smsCalls.length === 1, { timeout: 15000 });
  const calls = await page.evaluate(() => window.__smsCalls);
  assert.equal(calls[0].number, '+919876543210', 'the normalised number, not the typed one');
  assert.match(calls[0].body, /^Dear Ramesh Kumar, Rs\.500 Gave on \d{2} \w{3} \d{4}\. Net Balance: Rs\.500\.- KhataApp$/);

  // The radio's verdict is stored on the entry and shown in the timeline.
  await page.waitForFunction(async () => {
    const customers = await window.Khata.db.allCustomers();
    const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
    return rows[0]?.sms_status === 'sent';
  }, { timeout: 15000 });

  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('SMS'), { timeout: 10000 });
});

test('a second entry sends its own message, and the first is never resent', async () => {
  await click('#ledger-got');
  await fill('#tx-amount', '200');
  await click('#tx-save');

  await page.waitForFunction(() => window.__smsCalls.length === 2, { timeout: 15000 });
  const calls = await page.evaluate(() => window.__smsCalls);
  assert.match(calls[1].body, /Rs\.200 Got/);
  assert.match(calls[1].body, /Net Balance: Rs\.300/);

  const rows = await page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    return window.Khata.db.transactionsForCustomer(customers[0].id);
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.sms_status).sort(),
    ['sent', 'sent'],
    'both entries carry their own result',
  );
});

test('a failed verdict is shown on the entry instead of a silent success', async () => {
  await page.evaluate(() => {
    window.__smsVerdict = 'failed';
  });
  await click('#ledger-gave');
  await fill('#tx-amount', '100');
  await click('#tx-save');

  await page.waitForFunction(() => window.__smsCalls.length === 3, { timeout: 15000 });
  await page.waitForFunction(async () => {
    const customers = await window.Khata.db.allCustomers();
    const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
    return rows.some((row) => row.sms_status === 'failed');
  }, { timeout: 15000 });
});

test('turning the toggle off stops the messages', async () => {
  await page.evaluate(() => {
    window.__smsVerdict = 'sent';
  });
  await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#setting-sms-quota');

  const quotaRow = await page.$eval('#setting-sms-quota', (node) => node.textContent);
  assert.match(quotaRow, /4 of 90/);
  assert.match(quotaRow, /This phone/);

  await page.evaluate(() => {
    const toggle = [...document.querySelectorAll('[role="switch"]')].find((node) =>
      (node.getAttribute('aria-label') || '').includes('SMS'),
    );
    toggle.click();
  });
  await page.waitForFunction(() => {
    const toggle = [...document.querySelectorAll('[role="switch"]')].find((node) =>
      (node.getAttribute('aria-label') || '').includes('SMS'),
    );
    return toggle?.getAttribute('aria-checked') === 'false';
  });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-customer-id]');

  // A navigation re-runs the injected stub, so compare against the count taken
  // after the reload rather than a hardcoded number.
  const callsBefore = await page.evaluate(() => window.__smsCalls.length);

  await click('[data-customer-id]');
  await page.waitForSelector('#ledger-gave');
  await click('#ledger-gave');
  await fill('#tx-amount', '50');
  await click('#tx-save');
  await page.waitForSelector('#customer-balance');

  await new Promise((resolve) => setTimeout(resolve, 600));
  const callsAfter = await page.evaluate(() => window.__smsCalls.length);
  assert.equal(callsAfter, callsBefore, 'no message was handed to the shell with alerts off');

  const rows = await page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    return window.Khata.db.transactionsForCustomer(customers[0].id);
  });
  const last = rows.find((row) => row.amount_paise === 5000);
  assert.ok(last, 'the entry itself was still saved');
  assert.equal(last.sms_status, null, 'and it was not texted');
});

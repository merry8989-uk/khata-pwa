/**
 * End-to-end smoke test: drives the real built app in headless Chromium against
 * a real static server. Everything asserted here is a user-visible behaviour:
 * adding a customer, recording udhar, surviving a reload, surviving going
 * offline, exporting a PDF, switching language and theme, and reading logs.
 *
 *   npm run build && npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 4399;
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
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.log(`[console:${message.type()}]`, message.text().slice(0, 300));
    }
  });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#main h1, #main .card', { timeout: 15000 });
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.kill('SIGTERM');
});

const text = (selector) => page.$eval(selector, (node) => node.textContent.trim());

/** Clicks through the DOM: deterministic even while a sheet animates or a view re-renders. */
async function click(selector) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) throw new Error(`missing element: ${sel}`);
    node.scrollIntoView({ block: 'center' });
    node.click();
  }, selector);
}

/** Fills a field the way a user would: value plus input/change events. */
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

/** Waits until an element's text is exactly what we expect (no substring races). */
async function waitForText(selector, expected) {
  await page.waitForFunction(
    (sel, want) => document.querySelector(sel)?.textContent.trim() === want,
    { timeout: 15000 },
    selector,
    expected,
  );
}

test('the shell boots, the service worker registers and sync starts unconfigured', async () => {
  assert.match(await text('#app-header h1'), /Khata/);
  assert.match(await text('#app-nav'), /Home/);

  const sw = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration ? { scope: registration.scope, active: Boolean(registration.active || registration.installing) } : null;
  });
  assert.ok(sw, 'service worker should be registered');
  assert.equal(sw.active, true);

  const manifest = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.getAttribute('href'));
  assert.equal(manifest, './manifest.json');

  const badge = await page.$eval('[aria-label*="sync" i], [aria-label*="Sync" i]', (node) => node.textContent);
  assert.match(badge, /Local only/);
});

test('adding a customer shows them as settled', async () => {
  await click('#dashboard-add-customer');
  await fill('#customer-name', 'Ramesh Kumar');
  await fill('#customer-phone', '9876543210');
  await click('#customer-save');
  await page.waitForSelector('[data-customer-id]');

  const row = await page.$eval('[data-customer-id]', (node) => node.textContent);
  assert.match(row, /Ramesh Kumar/);
  assert.match(row, /\+91 98765 43210/);
  assert.match(row, /Settled/);
});

test('recording "You Gave" updates the balance in red and persists', async () => {
  await click('[data-customer-id]');
  await page.waitForSelector('#ledger-gave');
  assert.equal(await text('#customer-balance'), '\u20b90');

  await click('#ledger-gave');
  await fill('#tx-amount', '500');
  await fill('#tx-note', 'Rice and oil');
  await click('#tx-save');
  await waitForText('#customer-balance', '\u20b9500');
  const tone = await page.$eval('#customer-balance', (node) => node.className);
  assert.match(tone, /text-due-600/, 'money owed should be red');

  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#customer-balance');
  assert.equal(await text('#customer-balance'), '\u20b9500', 'IndexedDB must survive a reload');
  assert.match(await page.$eval('#main', (node) => node.textContent), /Rice and oil/);
});

test('a tap during start-up still opens the ledger (regression)', async () => {
  // The hashchange listener used to be attached only after boot() finished
  // awaiting settings, IndexedDB and the sync engine, so a tap in that window
  // changed the URL and rendered nothing. Throttling the CPU widens that window.
  await page.emulateCPUThrottling(6);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-customer-id]', { timeout: 20000 });
  await click('[data-customer-id]');
  await page.waitForSelector('#ledger-gave', { timeout: 20000 });
  await page.emulateCPUThrottling(1);
});

test('a payment reduces the balance and turns it green when it flips', async () => {
  await click('#ledger-got');
  await fill('#tx-amount', '800');
  await click('#tx-save');
  await waitForText('#customer-balance', '\u20b9300');
  const tone = await page.$eval('#customer-balance', (node) => node.className);
  assert.match(tone, /text-paid-600/, 'money payable should be green');
});

test('the app still works offline and says so', async () => {
  await page.setOfflineMode(true);
  await page.waitForFunction(() => document.body.textContent.includes('Offline'), { timeout: 10000 });

  await click('#ledger-gave');
  await fill('#tx-amount', '300');
  await click('#tx-save');
  await waitForText('#customer-balance', '\u20b90');

  // A full navigation while offline must be served by the service worker.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#customer-balance', { timeout: 15000 });
  assert.equal(await text('#customer-balance'), '\u20b90');

  // 1 unsynced customer + 3 unsynced entries: the whole offline session is queued.
  const queued = await page.evaluate(async () => {
    const rows = await window.Khata.db.pendingRows();
    return { customers: rows.customers.length, transactions: rows.transactions.length };
  });
  assert.deepEqual(queued, { customers: 1, transactions: 3 }, 'every offline row is queued for sync');

  await page.setOfflineMode(false);
});

test('the PDF statement is a real PDF with the ledger in it', async () => {
  const result = await page.evaluate(async () => {
    const customer = (await window.Khata.db.allCustomers())[0];
    const transactions = await window.Khata.db.transactionsForCustomer(customer.id);
    const blob = window.Khata.api.statementBlob(customer, transactions);
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const head = new TextDecoder().decode(buffer.slice(0, 5));
    return { size: buffer.length, head, transactions: transactions.length };
  });
  assert.equal(result.head, '%PDF-');
  assert.ok(result.size > 1500, `expected a real PDF, got ${result.size} bytes`);
  assert.equal(result.transactions, 3);
});

test('diagnostics captured the session and export a valid zip', async () => {
  const logs = await page.evaluate(async () => {
    const rows = await window.Khata.db.listLogs();
    return { count: rows.length, scopes: [...new Set(rows.map((row) => row.scope))] };
  });
  assert.ok(logs.count > 3, `expected log lines, got ${logs.count}`);
  assert.ok(logs.scopes.includes('transaction'), 'entry saves should be logged');

  const zip = await page.evaluate(async () => {
    const file = await window.Khata.api.buildLogFile('zip');
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    return { name: file.name, head: [...bytes.slice(0, 4)], size: bytes.length };
  });
  assert.match(zip.name, /\.zip$/);
  assert.deepEqual(zip.head, [0x50, 0x4b, 0x03, 0x04], 'PK\\x03\\x04 signature');
  assert.ok(zip.size > 200);
});

test('settings change the theme, language and persist', async () => {
  await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#about-email');

  const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.evaluate(() => {
    const group = document.querySelector('[role="radiogroup"][aria-label="Theme"]');
    const target = [...group.querySelectorAll('[role="radio"]')].find((node) => node.textContent === 'Dark');
    target.click();
  });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.notEqual(themeBefore, 'dark');

  await page.evaluate(() => {
    const group = document.querySelector('[role="radiogroup"][aria-label="Language"]');
    const target = [...group.querySelectorAll('[role="radio"]')].find((node) => node.textContent === 'हिन्दी');
    target.click();
  });
  await page.waitForFunction(() => document.documentElement.lang === 'hi');
  await page.waitForFunction(() => document.getElementById('app-nav')?.textContent.includes('होम'));

  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#about-email');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.match(await text('#app-nav'), /होम/);

  // Back to English so later assertions read the source strings.
  await page.evaluate(() => {
    const group = document.querySelector('[role="radiogroup"][aria-label="भाषा"]');
    const target = [...group.querySelectorAll('[role="radio"]')].find((node) => node.textContent === 'English');
    target.click();
  });
  await page.waitForFunction(() => document.documentElement.lang === 'en');
});

test('About carries the contact email, the Instagram call to action and the version', async () => {
  await page.goto(`${BASE}#/settings`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#about-email');

  const email = await page.$eval('#about-email', (node) => ({ href: node.getAttribute('href'), text: node.textContent }));
  assert.equal(email.href, 'mailto:br19shc39@gmail.com?subject=Khata%20feedback');
  assert.match(email.text, /br19shc39@gmail\.com/);

  const instagram = await page.$eval('#about-instagram', (node) => ({
    href: node.getAttribute('href'),
    text: node.textContent,
  }));
  assert.equal(instagram.href, 'https://instagram.com/osintgram_io');
  assert.match(instagram.text, /@osintgram_io/);

  const expectedVersion = JSON.parse(readFileSync(join(ROOT, 'docs', 'app', 'version.json'), 'utf8')).version;
  assert.match(await text('#about-version'), new RegExp(`Version ${expectedVersion.replace(/\./g, '\\.')}`));
  assert.ok(await page.$('#about-check-updates'), 'check-for-updates control must exist');
});

test('the update check reads version.json and reports the current version', async () => {
  await click('#about-check-updates');
  await page.waitForSelector('#about-update-message', { timeout: 10000 });
  const message = await text('#about-update-message');
  assert.match(message, /latest version/);
});

test('accessibility: every control has an accessible name and the page has one h1', async () => {
  const audit = await page.evaluate(() => {
    const problems = [];
    for (const input of document.querySelectorAll('input, select, textarea')) {
      const id = input.getAttribute('id');
      const labelled = (id && document.querySelector(`label[for="${id}"]`)) || input.getAttribute('aria-label');
      if (!labelled) problems.push(`unlabelled field: ${input.outerHTML.slice(0, 80)}`);
    }
    for (const button of document.querySelectorAll('button')) {
      const name = (button.textContent || '').trim() || button.getAttribute('aria-label');
      if (!name) problems.push(`unnamed button: ${button.outerHTML.slice(0, 80)}`);
    }
    const clickableDivs = [...document.querySelectorAll('div[onclick], span[onclick]')].length;
    return { problems, h1Count: document.querySelectorAll('h1').length, clickableDivs };
  });
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.clickableDivs, 0, 'no div should carry a click handler');
  assert.equal(audit.h1Count, 1);
});

test('a customer can be deleted and the ledger empties', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[data-customer-id]');
  await click('[data-customer-id]');
  await page.waitForFunction(() => location.hash.startsWith('#/c/'), { timeout: 10000 });
  try {
    await page.waitForSelector('#ledger-gave', { timeout: 10000 });
  } catch (error) {
    const dump = await page.evaluate(() => ({
      hash: location.hash,
      route: window.Khata?.state?.route,
      customers: window.Khata?.state?.customers?.length,
      loading: window.Khata?.state?.loading,
      main: document.querySelector('#main')?.textContent?.slice(0, 200),
    }));
    console.log('[diagnostic]', JSON.stringify(dump));
    throw error;
  }

  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((node) =>
      (node.getAttribute('aria-label') || '').startsWith('Delete customer'),
    );
    button.click();
  });
  await page.waitForSelector('[role="dialog"]');
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[role="dialog"] button')];
    buttons.find((node) => node.textContent.trim() === 'Delete').click();
  });

  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('No customers yet'));
  const after = await page.evaluate(async () => ({
    customers: (await window.Khata.db.allCustomers()).length,
    transactions: (await window.Khata.db.allTransactions()).length,
  }));
  assert.deepEqual(after, { customers: 0, transactions: 0 }, 'deleting a customer removes their entries too');
});

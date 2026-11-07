/**
 * Integration test: the real app talking to the real Worker handler over HTTP.
 *
 * The Worker runs in-process with in-memory D1/KV doubles (no Cloudflare account
 * needed), the app is built with that server baked in, and a browser drives it.
 * This is what proves the zero-config path: no URL or token is typed anywhere, the
 * device mints a key, the Worker provisions a shop on the first write, and the
 * offline queue drains to zero.
 *
 *   npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

import { startWorkerServer } from '../helpers/fake-worker.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = join(ROOT, '..', 'build-sync');
const APP_PORT = 4412;
const WORKER_PORT = 4455;
const APP_URL = `http://localhost:${APP_PORT}/`;

let workerServer = null;
let appServer = null;
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

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server never came up at ${url}`);
}

before(async () => {
  workerServer = await startWorkerServer({ port: WORKER_PORT });

  rmSync(BUILD_DIR, { recursive: true, force: true });
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    env: { ...process.env, KHATA_API_BASE: workerServer.url, KHATA_OUT_DIR: BUILD_DIR },
    encoding: 'utf8',
  });
  if (build.status !== 0) throw new Error(`build failed: ${build.stderr || build.stdout}`);

  appServer = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs'), String(APP_PORT), BUILD_DIR], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await waitFor(APP_URL);

  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#main .card', { timeout: 15000 });
});

after(async () => {
  if (browser) await browser.close();
  if (appServer) appServer.kill('SIGTERM');
  if (workerServer) await workerServer.close();
  rmSync(BUILD_DIR, { recursive: true, force: true });
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

test('a fresh install is connected with nothing typed in', async () => {
  const state = await page.evaluate(() => ({
    badge: document.querySelector('[aria-label*="ync" i]')?.textContent || '',
    settingsSections: [...document.querySelectorAll('#main h2')].map((node) => node.textContent.trim()),
  }));
  assert.match(state.badge, /Online|Synced/, `expected a connected badge, got "${state.badge}"`);
  assert.equal(state.badge.includes('Local only'), false, 'the build knows its server');
});

test('the first entry provisions a shop on the Worker and drains the queue', async () => {
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
  await page.waitForSelector('#customer-balance');

  // The queue must drain to zero against the real handler.
  await page.waitForFunction(async () => (await window.Khata.db.pendingCount()) === 0, { timeout: 20000 });

  const syncCalls = workerServer.requests.filter((request) => request.path === '/api/sync' && request.method === 'POST');
  assert.ok(syncCalls.length >= 1, 'the app posted to /api/sync');

  const authorization = syncCalls[0].authorization || '';
  assert.match(authorization, /^Bearer [A-Za-z0-9_-]{43}$/, 'a device token, not a pasted secret');

  const payloads = syncCalls.map((call) => JSON.parse(call.body));
  const customerPayload = payloads.find((payload) => payload.customers.length > 0);
  assert.equal(customerPayload.customers[0].name, 'Ramesh Kumar');
  assert.equal(
    customerPayload.customers[0].phone_number,
    '+919876543210',
    'the phone is normalised before it leaves the device',
  );

  // The customer save flushes first; the entry arrives in a later batch.
  const entryPayload = payloads.find((payload) => payload.transactions.length > 0);
  assert.ok(entryPayload, 'a batch carried the entry');
  assert.equal(entryPayload.transactions[0].amount_paise, 50000);
  assert.equal(entryPayload.transactions[0].note, 'Rice and oil');
  assert.equal(entryPayload.transactions[0].type, 'GIVEN');

  // What the Worker did with it.
  assert.equal(workerServer.kv.size, 1, 'exactly one shop was provisioned');
  const [kvKey] = [...workerServer.kv.keys()];
  assert.match(kvKey, /^shop:[0-9a-f]{64}$/, 'KV is keyed by the token hash, never the token');
  assert.equal(kvKey.includes(authorization.slice(7, 20)), false, 'the raw token is not stored');

  const inserts = workerServer.statements.filter((entry) => /INSERT INTO transactions/.test(entry.sql));
  assert.ok(inserts.length >= 1, 'the entry reached D1');
  assert.ok(
    inserts[0].params.includes(50000),
    `expected the amount in the insert params, got ${JSON.stringify(inserts[0].params)}`,
  );
});

test('a second entry reuses the same shop and never re-provisions', async () => {
  const before = workerServer.kv.size;
  await click('#ledger-got');
  await fill('#tx-amount', '200');
  await click('#tx-save');
  await page.waitForFunction(async () => (await window.Khata.db.pendingCount()) === 0, { timeout: 20000 });

  assert.equal(workerServer.kv.size, before, 'no second shop for the same device');

  const balance = await page.evaluate(async () => {
    const customers = await window.Khata.db.allCustomers();
    const rows = await window.Khata.db.transactionsForCustomer(customers[0].id);
    return { customers: customers.length, transactions: rows.length };
  });
  assert.deepEqual(balance, { customers: 1, transactions: 2 });
});

test('the connection row shows the baked server, not an input', async () => {
  await page.goto(`${APP_URL}#/settings`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#setting-connection');
  const row = await page.evaluate(() => ({
    text: document.querySelector('#setting-connection').textContent,
    state: document.querySelector('#setting-connection-state')?.textContent || '',
    inputs: [...document.querySelectorAll('#main input[type="url"], #main input[type="password"]')].length,
    syncNowHint: document.querySelector('#setting-sync-now')?.parentElement?.textContent || '',
  }));
  assert.match(row.text, new RegExp(`127\\.0\\.0\\.1:${WORKER_PORT}`), 'the row names the server it talks to');
  assert.match(row.state, /Connected|Off/);
  assert.equal(row.inputs, 0, 'no URL or token field exists');
  assert.match(row.syncNowHint, /waiting/i, 'the sync row reports the queue, not the address');
});

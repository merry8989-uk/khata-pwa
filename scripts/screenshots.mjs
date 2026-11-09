/**
 * Captures the real app for the public page. Seeds a demo shop through the
 * app's own IndexedDB API (no mocked markup), then screenshots the live views.
 *
 *   node scripts/build.mjs && node scripts/screenshots.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'assets', 'screens');
const PORT = 4404;

const SHOP = { name: 'Gupta Kirana Store', phone: '+919812345670' };

const CUSTOMERS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Ramesh Kumar',
    phone_number: '+919876543210',
    entries: [
      ['GIVEN', 450000, 'Monthly ration', '2026-10-28T06:30:00.000Z'],
      ['GOT', 200000, 'Part payment', '2026-11-01T09:15:00.000Z'],
      ['GIVEN', 125050, 'Mustard oil 5L', '2026-11-04T11:00:00.000Z'],
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Sunita Devi',
    phone_number: '+919812345671',
    entries: [
      ['GOT', 300000, 'Advance', '2026-11-02T05:45:00.000Z'],
      ['GIVEN', 80000, 'Sugar 10kg', '2026-11-05T07:20:00.000Z'],
    ],
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Imran Shaikh',
    phone_number: '+919812345672',
    entries: [
      ['GIVEN', 150000, 'Atta 25kg', '2026-11-03T08:00:00.000Z'],
      ['GOT', 150000, 'Settled in cash', '2026-11-06T12:10:00.000Z'],
    ],
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Lakshmi Stores',
    phone_number: '+919812345673',
    entries: [['GIVEN', 260000, 'Wholesale tea packets', '2026-11-06T06:05:00.000Z']],
  },
];

function findChrome() {
  return process.env.CHROME_PATH || '/usr/local/bin/chromium';
}

const server = spawn(process.execPath, [join(ROOT, 'scripts', 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
await new Promise((resolve) => setTimeout(resolve, 900));

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });

mkdirSync(OUT, { recursive: true });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2' });
await page.waitForSelector('#main .card');

await page.evaluate(
  async ({ shop, customers }) => {
    const { db, settings, api } = window.Khata;
    await settings.update('shopName', shop.name);
    await settings.update('shopPhone', shop.phone);
    for (const customer of customers) {
      await db.putCustomer({
        id: customer.id,
        name: customer.name,
        phone_number: customer.phone_number,
        created_at: customer.entries[0][3],
        synced: true,
      });
      let index = 0;
      for (const [type, amount, note, when] of customer.entries) {
        await db.putTransaction({
          id: `${customer.id.slice(0, 24)}${String(index).padStart(8, '0')}`.replace(/.{8}-/, '$&-'),
          customer_id: customer.id,
          type,
          amount_paise: amount,
          note,
          occurred_at: when,
          created_at: when,
          synced: true,
        });
        index += 1;
      }
    }
    await api.reloadData();
    window.location.hash = '#/';
    api.render();
  },
  { shop: SHOP, customers: CUSTOMERS },
);

// Reload so the header picks up the shop name from settings.
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForFunction(() => document.querySelectorAll('[data-customer-id]').length >= 4);
await new Promise((resolve) => setTimeout(resolve, 350));
await page.screenshot({ path: join(OUT, 'dashboard.png') });

// Customer ledger
await page.click('[data-customer-id]');
await page.waitForSelector('#customer-balance');
await new Promise((resolve) => setTimeout(resolve, 300));
await page.screenshot({ path: join(OUT, 'ledger.png') });

// Entry sheet over the ledger
await page.click('#ledger-gave');
await page.waitForSelector('#tx-amount');
await page.type('#tx-amount', '450');
await page.type('#tx-note', 'Besan 2kg');
await new Promise((resolve) => setTimeout(resolve, 400));
await page.screenshot({ path: join(OUT, 'entry-sheet.png') });
await page.keyboard.press('Escape');

// Rent: a tenant whose months accrue on their own date
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle2' });
await page.evaluate(async () => {
  const { db, settings, api } = window.Khata;
  await settings.update('shopName', 'Gupta Kirana Store');
  const start = new Date();
  start.setMonth(start.getMonth() - 4);
  start.setDate(20);
  const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-20`;
  await db.putCustomer({
    id: '77777777-7777-4777-8777-777777777777',
    name: 'Rakesh Verma',
    phone_number: '+919812345678',
    created_at: new Date().toISOString(),
    synced: true,
    rent: { active: true, amount_paise: 850000, start_date: iso, mode: 'arrears', end_date: null, skipped: [] },
  });
  await api.reloadData();
  api.render();
});
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('[data-customer-id]');
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-customer-id]')];
  const rent = rows.find((node) => node.textContent.includes('Rakesh Verma'));
  rent.click();
});
await page.waitForSelector('#rent-card');
await new Promise((resolve) => setTimeout(resolve, 500));
await page.screenshot({ path: join(OUT, 'rent.png') });

// Settings, captured as the Android shell sees it so the SMS rows are real.
await page.evaluateOnNewDocument(() => {
  window.KhataAndroid = {
    platform: () => 'android/screenshot',
    canSendSms: () => true,
    smsQuota: () => JSON.stringify({ sent: 3, cap: 90, date: '2026-11-07' }),
    sendSms: () => {},
  };
});
// A hash-only change would keep the existing document and skip the injected
// bridge, so load a fresh document first.
await page.goto(`http://localhost:${PORT}/?settings=1`, { waitUntil: 'networkidle2' });
await page.goto(`http://localhost:${PORT}/?settings=1#/settings`, { waitUntil: 'networkidle2' });
await page.waitForSelector('#about-email');
await new Promise((resolve) => setTimeout(resolve, 350));
await page.screenshot({ path: join(OUT, 'settings.png') });

// The About block, which sits last in Settings
await page.evaluate(() => document.querySelector('#about-email')?.scrollIntoView({ block: 'center' }));
await new Promise((resolve) => setTimeout(resolve, 350));
await page.screenshot({ path: join(OUT, 'about.png') });

await browser.close();
server.kill('SIGTERM');
process.stdout.write(`Screenshots written to ${OUT}\n`);

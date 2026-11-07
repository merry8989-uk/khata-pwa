/**
 * Points the app at a deployed Worker.
 *
 *   node scripts/set-server.mjs https://khata-api.<subdomain>.workers.dev
 *   node scripts/set-server.mjs --local-only
 *
 * Writes apiBase into khata.config.json, which the build then bakes into
 * docs/app/js/config.js and the CSP. There is no server field in the app itself.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'khata.config.json');
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const argument = process.argv[2];

function write(apiBase) {
  config.apiBase = apiBase;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`apiBase = ${apiBase || '(local-only)'}\n`);
  process.stdout.write('Next: npm run build   then commit khata.config.json\n');
}

if (!argument || argument === '--help') {
  process.stdout.write(
    'usage: node scripts/set-server.mjs <https://worker-url> | --local-only\n' +
      `current: ${config.apiBase || '(local-only)'}\n`,
  );
  process.exit(argument ? 0 : 1);
}

if (argument === '--local-only') {
  write('');
  process.exit(0);
}

let parsed;
try {
  parsed = new URL(argument);
} catch {
  process.stderr.write(`not a URL: ${argument}\n`);
  process.exit(1);
}

if (parsed.protocol !== 'https:' && !parsed.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
  process.stderr.write(
    `refusing ${parsed.protocol}// - the app is served over HTTPS, so a plain-http Worker would be blocked by the browser\n`,
  );
  process.exit(1);
}

if (parsed.pathname !== '/' && parsed.pathname !== '') {
  process.stderr.write(`use the Worker origin only, without a path: ${parsed.origin}\n`);
  process.exit(1);
}

write(parsed.origin);

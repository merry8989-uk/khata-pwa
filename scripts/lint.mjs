/**
 * Repo checks that do not need a browser:
 *  1. every JS file parses (node --check)
 *  2. i18n: English and Hindi have identical key sets, and every statically
 *     referenced t('...') key exists
 *  3. no Supabase, no leftover placeholders, no hardcoded secrets
 *  4. the service worker precache list matches the built output (when built)
 *
 *   node scripts/lint.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dictionaries } from '../src/js/i18n.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
  process.stdout.write(`  FAIL ${message}\n`);
}

function pass(message) {
  process.stdout.write(`  ok   ${message}\n`);
}

function sh(command) {
  return execFileSync('bash', ['-c', command], { cwd: ROOT, encoding: 'utf8' });
}

/* 1. syntax ---------------------------------------------------------------- */
process.stdout.write('\nSyntax\n');
const jsFiles = sh(
  "find src shared worker/src scripts tests -type f \\( -name '*.js' -o -name '*.mjs' \\) | sort",
)
  .trim()
  .split('\n')
  .filter(Boolean);

let syntaxErrors = 0;
for (const file of jsFiles) {
  try {
    execFileSync('node', ['--check', file], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    syntaxErrors += 1;
    fail(`${file}: ${String(error.stderr || error.message).split('\n')[0]}`);
  }
}
if (!syntaxErrors) pass(`${jsFiles.length} files parse`);

/* 2. i18n ----------------------------------------------------------------- */
process.stdout.write('\nTranslations\n');
const enKeys = new Set(Object.keys(dictionaries.en));
const hiKeys = new Set(Object.keys(dictionaries.hi));
const missingInHindi = [...enKeys].filter((key) => !hiKeys.has(key));
const extraInHindi = [...hiKeys].filter((key) => !enKeys.has(key));
if (missingInHindi.length) fail(`missing in hi: ${missingInHindi.join(', ')}`);
if (extraInHindi.length) fail(`extra in hi: ${extraInHindi.join(', ')}`);
if (!missingInHindi.length && !extraInHindi.length) pass(`${enKeys.size} keys, en and hi in sync`);

const appSources = sh("find src/js -type f -name '*.js' | sort").trim().split('\n').filter(Boolean);
const usedKeys = new Set();
for (const file of appSources) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) usedKeys.add(match[1]);
}
const unknownKeys = [...usedKeys].filter((key) => !enKeys.has(key));
if (unknownKeys.length) fail(`t() keys with no translation: ${unknownKeys.join(', ')}`);
else pass(`${usedKeys.size} static t() keys resolve`);

/* 3. forbidden content ---------------------------------------------------- */
process.stdout.write('\nContent rules\n');
const scannable = sh(
  "find src shared worker/src scripts docs/index.html README.md .github -type f 2>/dev/null | grep -v 'scripts/lint.mjs' | sort",
)
  .trim()
  .split('\n')
  .filter(Boolean);

const banned = [
  { pattern: /supabase/i, label: 'Supabase reference' },
  { pattern: /\bTODO\b/, label: 'TODO marker' },
  { pattern: /PLACEHOLDER_/, label: 'placeholder token' },
  { pattern: /\bsk_live_|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,}\b/, label: 'hardcoded secret' },
];
let bannedHits = 0;
for (const file of scannable) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  for (const rule of banned) {
    if (rule.pattern.test(source)) {
      bannedHits += 1;
      fail(`${rule.label} in ${relative(ROOT, join(ROOT, file))}`);
    }
  }
}
if (!bannedHits) pass('no Supabase, TODO, placeholder or secret strings');

/* 4. service worker precache --------------------------------------------- */
process.stdout.write('\nService worker\n');
const outDir = join(ROOT, 'docs', 'app');
if (!existsSync(outDir)) {
  process.stdout.write('  skip docs/app not built yet (run npm run build)\n');
} else {
  const sw = readFileSync(join(outDir, 'sw.js'), 'utf8');
  const listMatch = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!listMatch) {
    fail('could not read PRECACHE from sw.js');
  } else {
    const entries = [...listMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const missing = entries.filter((entry) => {
      if (entry === './') return !existsSync(join(outDir, 'index.html'));
      return !existsSync(join(outDir, entry.replace(/^\.\//, '')));
    });
    if (missing.length) fail(`precached files missing from the build: ${missing.join(', ')}`);
    else pass(`${entries.length} precache entries exist`);

    const versionMatch = sw.match(/khata-shell-\$\{APP_VERSION\}/);
    if (!versionMatch) fail('sw.js cache name is not versioned');
  }
}

process.stdout.write(
  failures.length ? `\n${failures.length} problem(s)\n` : '\nAll checks passed\n',
);
process.exit(failures.length ? 1 : 0);

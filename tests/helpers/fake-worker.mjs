/**
 * A stand-in Cloudflare Worker for integration tests: the real handler, real
 * Request/Response objects, in-memory D1 and KV doubles, and a Node HTTP server
 * in front of it. It records every request and every SQL statement so a test can
 * assert what the app actually sent and what the Worker actually wrote.
 */

import { createServer } from 'node:http';

import worker from '../../worker/src/index.js';

function firstResult(sql) {
  if (/SELECT 1 AS ok/.test(sql)) return { ok: 1 };
  if (/COUNT\(\*\) AS n FROM sms_log/.test(sql)) return { n: 0 };
  if (/SUM\(CASE WHEN type/.test(sql)) return { net: 50000 };
  if (/COUNT\(\*\) FROM customers/.test(sql)) return { customers: 1, transactions: 1 };
  if (/FROM customers WHERE shop_id/.test(sql)) {
    return { id: 'c1', name: 'Ramesh', phone_number: '+919876543210', deleted: 0 };
  }
  return null;
}

export function makeEnv(overrides = {}) {
  const kv = new Map();
  const statements = [];
  const d1 = {
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async run() {
          statements.push({ sql, params: statement.params });
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          statements.push({ sql, params: statement.params });
          return firstResult(sql);
        },
        async all() {
          statements.push({ sql, params: statement.params });
          return { results: [] };
        },
      };
      return statement;
    },
    async batch(list) {
      for (const statement of list) statements.push({ sql: statement.sql, params: statement.params });
      return list.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };

  const env = {
    DB: d1,
    AUTH: {
      async get(key) {
        return kv.has(key) ? kv.get(key) : null;
      },
      async put(key, value) {
        kv.set(key, value);
      },
    },
    SMS_PROVIDER: 'none',
    SMS_DAILY_CAP: '200',
    ALLOWED_ORIGINS: '*',
    ...overrides,
  };
  return { env, kv, statements };
}

/** Starts the Worker handler on a local port. */
export async function startWorkerServer({ port = 4455, env } = {}) {
  const requests = [];
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const built = env ? { env, kv: null, statements: [] } : makeEnv();

  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    const url = `http://127.0.0.1:${port}${request.url}`;
    const workerRequest = new Request(url, { method: request.method, headers, body });
    requests.push({
      method: request.method,
      path: new URL(url).pathname,
      authorization: headers.authorization || null,
      body: body ? body.toString('utf8') : null,
    });

    try {
      const workerResponse = await worker.fetch(workerRequest, built.env, ctx);
      const responseHeaders = {};
      workerResponse.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      response.writeHead(workerResponse.status, responseHeaders);
      response.end(Buffer.from(await workerResponse.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    statements: built.statements,
    kv: built.kv,
    async close() {
      await Promise.allSettled(pending);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

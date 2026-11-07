/**
 * Device identity.
 *
 * Khata has no accounts and no shared secret in the bundle. On first run the app
 * mints a random 256-bit token, keeps it on the device, and sends it as a bearer
 * token; the Worker stores only its SHA-256 and uses that to find (or provision)
 * the shop. So:
 *   - the public JavaScript carries no credential at all,
 *   - a token cannot be recovered from the server side (only its hash is stored),
 *   - a fresh install is a fresh, isolated shop with no setup screen.
 *
 * The token is a capability: whoever holds it owns that shop. It never leaves the
 * device except in the Authorization header.
 */

const TOKEN_BYTES = 32;
/**
 * 32 random bytes as 43 URL-safe base64 characters. btoa exists in browsers, in
 * Workers and in Node 20, so one implementation serves every runtime.
 */
function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 43-character URL-safe token with 256 bits of entropy. */
export function generateDeviceToken() {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('A secure random source is required to create a device token');
  }
  const bytes = new Uint8Array(TOKEN_BYTES);
  cryptoApi.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function looksLikeDeviceToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** Hex SHA-256, used as the KV/D1 key so the raw token is never stored. */
export async function hashToken(token) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('WebCrypto is required to hash a token');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

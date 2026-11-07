/**
 * SMS gateway adapters. Each provider is a thin, timeout-bounded fetch.
 * When SMS_PROVIDER is unset the Worker reports sms: 'disabled' and sends
 * nothing - it never pretends an SMS went out.
 */

const TIMEOUT_MS = 8000;

function normaliseNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 10) return digits;
  return null;
}

async function post(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  return { ok: response.ok, status: response.status, body };
}

async function sendFast2Sms(env, { to, body }) {
  const number = normaliseNumber(to);
  if (!number) return { ok: false, error: 'invalid_number' };
  if (!env.FAST2SMS_API_KEY) return { ok: false, error: 'missing_credentials' };

  const result = await post('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: env.FAST2SMS_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      route: 'q',
      message: body,
      language: 'english',
      flash: 0,
      numbers: number,
    }),
  });

  if (result.ok && result.body?.return === true) return { ok: true, id: String(result.body.request_id || '') };
  return { ok: false, error: `fast2sms_${result.status}`, detail: result.body };
}

async function sendTwilio(env, { to, body }) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  if (!sid || !token || !from) return { ok: false, error: 'missing_credentials' };

  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const result = await post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (result.ok && result.body?.sid) return { ok: true, id: result.body.sid };
  return { ok: false, error: `twilio_${result.status}`, detail: result.body };
}

/** @returns {{provider: string, enabled: boolean}} */
export function smsStatus(env) {
  const provider = String(env.SMS_PROVIDER || 'none').toLowerCase();
  return { provider, enabled: provider === 'fast2sms' || provider === 'twilio' };
}

/**
 * @returns {Promise<{ok: boolean, provider: string, id?: string, error?: string}>}
 */
export async function sendSms(env, message) {
  const { provider, enabled } = smsStatus(env);
  if (!enabled) return { ok: false, provider: 'none', error: 'sms_disabled' };
  try {
    if (provider === 'fast2sms') return { ...(await sendFast2Sms(env, message)), provider };
    if (provider === 'twilio') return { ...(await sendTwilio(env, message)), provider };
    return { ok: false, provider, error: 'unknown_provider' };
  } catch (error) {
    return {
      ok: false,
      provider,
      error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  }
}

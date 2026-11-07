/**
 * SMS body construction, shared by the Worker (dispatch) and the app
 * (reminder previews) so both produce byte-identical text.
 */

import { formatAmountForSms } from './money.js';
import { formatDate, normalizeType, TYPES } from './ledger.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "07 Nov 2026" without depending on the runtime's locale data. */
export function smsDate(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return formatDate(new Date());
  return `${String(date.getDate()).padStart(2, '0')} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * The transaction alert template from the brief:
 * "Dear [Name], Rs.[Amount] [Gave/Got] on [Date]. Net Balance: Rs.[Balance].- KhataApp"
 */
export function formatTransactionSms({ customerName, amountPaise, type, occurredAt, netPaise }) {
  const name = String(customerName || 'Customer').trim().slice(0, 40) || 'Customer';
  const kind = normalizeType(type) === TYPES.GOT ? 'Got' : 'Gave';
  const amount = formatAmountForSms(amountPaise);
  const balance = formatAmountForSms(Math.abs(Number(netPaise) || 0));
  return `Dear ${name}, Rs.${amount} ${kind} on ${smsDate(occurredAt)}. Net Balance: Rs.${balance}.- KhataApp`;
}

/** GSM-7 is 160 chars single part, 153 per part when concatenated. */
export function gsmSegments(body) {
  const text = String(body || '');
  const isGsm = /^[\x20-\x7e\n\r]*$/.test(text);
  const single = isGsm ? 160 : 70;
  const multi = isGsm ? 153 : 67;
  if (text.length <= single) return 1;
  return Math.ceil(text.length / multi);
}

/** The reminder text a shopkeeper sends over WhatsApp from the ledger screen. */
export function formatReminderText({ shopName, customerName, netPaise, template }) {
  const tpl =
    template ||
    'Namaste {name}, your balance with {shop} is Rs.{balance}. Kindly settle when convenient. Thank you.';
  return tpl
    .replaceAll('{name}', String(customerName || 'Customer'))
    .replaceAll('{shop}', String(shopName || 'our shop'))
    .replaceAll('{balance}', formatAmountForSms(Math.abs(Number(netPaise) || 0)));
}

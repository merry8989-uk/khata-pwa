/**
 * Money helpers. Every amount in Khata is stored as an integer number of paise
 * (1 rupee = 100 paise). Floats never touch the data layer: 0.1 + 0.2 in rupees
 * is how ledgers end up one paisa out after a few hundred entries.
 */

/** Hard ceiling for a single entry: Rs.10,00,00,000 (10 crore). */
export const MAX_AMOUNT_PAISE = 100000000000;

const INR_WHOLE = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const INR_PAISE = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Parse user input ("1,250.50", "1250", 1250.5) into integer paise.
 * @returns {{ok: true, paise: number} | {ok: false, code: string}}
 */
export function parseAmountToPaise(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) return { ok: false, code: 'AMOUNT_INVALID' };
    input = input.toFixed(2);
  }
  if (typeof input !== 'string') return { ok: false, code: 'AMOUNT_INVALID' };

  const raw = input.trim().replace(/[\u20b9,\s]/g, '');
  if (raw === '') return { ok: false, code: 'AMOUNT_REQUIRED' };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) return { ok: false, code: 'AMOUNT_INVALID' };

  const [whole, frac = ''] = raw.split('.');
  const paise = Number(whole) * 100 + Number((frac + '00').slice(0, 2));

  if (!Number.isSafeInteger(paise) || paise <= 0) return { ok: false, code: 'AMOUNT_INVALID' };
  if (paise > MAX_AMOUNT_PAISE) return { ok: false, code: 'AMOUNT_TOO_LARGE' };
  return { ok: true, paise };
}

/** 125000 -> "1,250" ; 125050 -> "1,250.50" (no symbol). */
export function formatAmount(paise) {
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const fraction = abs % 100;
  if (fraction === 0) return INR_WHOLE.format(rupees);
  return INR_PAISE.format(Number(`${rupees}.${String(fraction).padStart(2, '0')}`));
}

/** 125000 -> "₹1,250" ; negative -> "-₹1,250". */
export function formatINR(paise, { symbol = '\u20b9' } = {}) {
  const sign = paise < 0 ? '-' : '';
  return `${sign}${symbol}${formatAmount(paise)}`;
}

/** Amount for the SMS gateway, which cannot carry the rupee glyph reliably. */
export function formatAmountForSms(paise) {
  return formatAmount(paise);
}

/** Integer paise -> plain rupee string suitable for <input> values. */
export function paiseToInput(paise) {
  const abs = Math.abs(Math.round(paise));
  return Number.isInteger(abs / 100) ? String(abs / 100) : (abs / 100).toFixed(2);
}

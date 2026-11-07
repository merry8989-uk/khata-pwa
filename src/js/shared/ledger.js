/**
 * Ledger maths shared by the browser app, the Cloudflare Worker and the tests.
 *
 * Sign convention: `GIVEN` means the shopkeeper gave money out on credit (udhar),
 * so it increases what the customer owes. `GOT` means money came back (jama).
 *   net = given - got      net > 0  -> "You will get"   (customer owes)
 *                          net < 0  -> "You will give"  (shopkeeper owes)
 *                          net == 0 -> settled
 * Amounts are integer paise everywhere.
 */

export const TYPES = Object.freeze({ GIVEN: 'GIVEN', GOT: 'GOT' });

const TYPE_ALIASES = Object.freeze({
  GIVEN: 'GIVEN',
  CREDIT: 'GIVEN',
  DEBIT_GIVEN: 'GIVEN',
  YOU_GAVE: 'GIVEN',
  GOT: 'GOT',
  DEBIT: 'GOT',
  CREDIT_GOT: 'GOT',
  YOU_GOT: 'GOT',
});

/** Accept the spec's CREDIT/DEBIT names and the app's GIVEN/GOT names. */
export function normalizeType(value) {
  if (typeof value !== 'string') return null;
  return TYPE_ALIASES[value.trim().toUpperCase()] || null;
}

export function isVoided(tx) {
  return tx?.voided === true || tx?.deleted === 1 || tx?.deleted === true;
}

/** Totals for one customer's (or the whole shop's) live transactions. */
export function summarize(transactions = []) {
  let given = 0;
  let got = 0;
  let count = 0;
  for (const tx of transactions) {
    if (!tx || isVoided(tx)) continue;
    const type = normalizeType(tx.type);
    const amount = Number(tx.amount_paise);
    if (!type || !Number.isFinite(amount) || amount <= 0) continue;
    if (type === TYPES.GIVEN) given += amount;
    else got += amount;
    count += 1;
  }
  return { given, got, net: given - got, count };
}

/** 'GET' (customer owes), 'GIVE' (shopkeeper owes) or 'SETTLED'. */
export function balanceKind(net) {
  if (net > 0) return 'GET';
  if (net < 0) return 'GIVE';
  return 'SETTLED';
}

function timeOf(tx) {
  const primary = Date.parse(tx.occurred_at || tx.timestamp || '');
  if (Number.isFinite(primary)) return primary;
  const created = Date.parse(tx.created_at || '');
  return Number.isFinite(created) ? created : 0;
}

/** Oldest first; ties broken by creation time then id so ordering is stable. */
export function sortByTime(transactions = []) {
  return [...transactions].sort((a, b) => {
    const diff = timeOf(a) - timeOf(b);
    if (diff !== 0) return diff;
    const created = Date.parse(a.created_at || '') - Date.parse(b.created_at || '');
    if (Number.isFinite(created) && created !== 0) return created;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Newest first, for the timeline UI. */
export function sortNewestFirst(transactions = []) {
  return sortByTime(transactions).reverse();
}

/** Adds a running net balance (paise) to each transaction, oldest first. */
export function withRunningBalance(transactions = []) {
  let running = 0;
  return sortByTime(transactions).map((tx) => {
    if (!isVoided(tx)) {
      const type = normalizeType(tx.type);
      const amount = Number(tx.amount_paise) || 0;
      running += type === TYPES.GIVEN ? amount : type === TYPES.GOT ? -amount : 0;
    }
    return { ...tx, running_paise: running };
  });
}

/** Map of customer_id -> {given, got, net, count}. */
export function netByCustomer(transactions = []) {
  const grouped = new Map();
  for (const tx of transactions) {
    if (!tx || isVoided(tx) || !tx.customer_id) continue;
    const list = grouped.get(tx.customer_id) || [];
    list.push(tx);
    grouped.set(tx.customer_id, list);
  }
  const out = new Map();
  for (const [id, list] of grouped) out.set(id, summarize(list));
  return out;
}

/** Shop-wide totals across every customer. */
export function shopTotals(transactions = []) {
  const { given, got, net } = summarize(transactions);
  const receivable = net > 0 ? net : 0;
  const payable = net < 0 ? -net : 0;
  return { given, got, net, receivable, payable };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: String(date.getDate()).padStart(2, '0'),
    month: MONTHS[date.getMonth()],
    year: date.getFullYear(),
    hours: date.getHours(),
    minutes: String(date.getMinutes()).padStart(2, '0'),
  };
}

/** "07 Nov 2026" - deterministic, locale independent. */
export function formatDate(iso) {
  const p = parts(iso);
  return p ? `${p.day} ${p.month} ${p.year}` : '';
}

/** "07 Nov 2026, 4:05 pm" */
export function formatDateTime(iso) {
  const p = parts(iso);
  if (!p) return '';
  const suffix = p.hours >= 12 ? 'pm' : 'am';
  const hour12 = p.hours % 12 === 0 ? 12 : p.hours % 12;
  return `${p.day} ${p.month} ${p.year}, ${hour12}:${p.minutes} ${suffix}`;
}

/** yyyy-mm-dd for <input type="date"> in local time. */
export function toDateInputValue(iso) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Rows for the statement table and the PDF export. */
export function statementRows(transactions = []) {
  return withRunningBalance(transactions).map((tx, index) => ({
    index: index + 1,
    date: formatDate(tx.occurred_at || tx.created_at),
    note: tx.note || '-',
    type: normalizeType(tx.type),
    amount_paise: Number(tx.amount_paise) || 0,
    running_paise: tx.running_paise,
  }));
}

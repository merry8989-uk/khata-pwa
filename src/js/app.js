/**
 * Khata app shell: routing, views, forms and the glue between the IndexedDB
 * layer, the settings store and the sync engine.
 *
 * Views are re-rendered from state after every mutation. The dataset is a few
 * thousand rows at most, so a full render is cheaper than tracking fine-grained
 * updates - and it removes a whole class of stale-DOM bugs.
 */

import * as db from './db.js';
import { LANGUAGES, setLanguage, t } from './i18n.js';
import { installGlobalHandlers, logger, setLogging } from './logger.js';
import { downloadStatement, statementBlob } from './pdf.js';
import * as settings from './settings.js';
import { STATUS, createSyncEngine } from './sync.js';
import { isConfigured, readConfig } from './sync-core.js';
import {
  avatarTone,
  clear,
  confirmDialog,
  debounce,
  downloadBlob,
  downloadText,
  el,
  formatPhoneDisplay,
  icon,
  initials,
  openSheet,
  toast,
} from './ui.js';
import { createZip } from './zip.js';
import { APP_VERSION } from './version.js';
import { API_BASE } from './config.js';
import { formatINR, paiseToInput, parseAmountToPaise } from './shared/money.js';
import {
  TYPES,
  formatDate,
  formatDateTime,
  netByCustomer,
  shopTotals,
  sortNewestFirst,
  summarize,
  toDateInputValue,
  withRunningBalance,
} from './shared/ledger.js';
import { formatReminderText } from './shared/sms.js';
import { accrueRent, noticeEndDate, rentSummary } from './rent.js';
import {
  ACCEPT_ATTRIBUTE,
  ATTACHMENT_LIMITS,
  formatBytes,
  prepareAttachment,
} from './attachments.js';
import { BACKUP_INTERVALS, backupStatus, runScheduledBackup } from './backup.js';
import {
  SMS_TONE,
  hasDeviceSms,
  installSmsResultHandler,
  sendEntrySms,
  shouldSendEntrySms,
  smsQuota,
} from './sms.js';
import {
  LIMITS,
  cleanText,
  newId,
  validateCustomer,
  validateTransaction,
} from './shared/validation.js';

const CONTACT_EMAIL = 'br19shc39@gmail.com';
const INSTAGRAM_HANDLE = 'osintgram_io';
const INSTAGRAM_URL = 'https://instagram.com/osintgram_io';

const state = {
  route: { name: 'dashboard', customerId: null },
  customers: [],
  transactions: [],
  nets: new Map(),
  query: '',
  loading: true,
  settings: settings.current(),
  sync: { status: STATUS.ONLINE, pending: 0 },
  stats: { customers: 0, transactions: 0, logs: 0 },
  update: { checking: false, available: null, message: '' },
  agreements: new Map(),
  backup: null,
};

let engine = null;
let booted = false;

const headerEl = () => document.getElementById('app-header');
const mainEl = () => document.getElementById('main');
const navEl = () => document.getElementById('app-nav');

/* ------------------------------------------------------------------ helpers */

function money(paise) {
  return formatINR(paise);
}

function balanceTone(net) {
  if (net > 0) return { text: 'text-due-600', label: t('balance.youGet') };
  if (net < 0) return { text: 'text-paid-600', label: t('balance.youGive') };
  return { text: 'text-sub', label: t('balance.settled') };
}

function errorText(code) {
  const key = `errors.${code}`;
  const translated = t(key);
  return translated === key ? t('errors.generic') : translated;
}

function go(hash) {
  if (location.hash === hash) {
    render();
    return;
  }
  location.hash = hash;
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] === 'c' && parts[1]) return { name: 'customer', customerId: decodeURIComponent(parts[1]) };
  if (parts[0] === 'settings') return { name: 'settings', customerId: null };
  if (parts[0] === 'new-customer') return { name: 'dashboard', customerId: null, openNewCustomer: true };
  return { name: 'dashboard', customerId: null };
}

async function reloadData() {
  const [customers, transactions] = await Promise.all([db.allCustomers(), db.allTransactions()]);
  state.customers = customers.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  state.transactions = transactions;
  state.nets = netByCustomer(transactions);
  await refreshAgreements();
  state.loading = false;
  return { customers: state.customers.length, transactions: transactions.length };
}

/* -------------------------------------------------------------- sync badge */

function syncMeta() {
  const { status, pending } = state.sync;
  const map = {
    [STATUS.ONLINE]: { label: t('status.online'), tone: 'text-paid-600', icon: 'cloud' },
    [STATUS.OFFLINE]: { label: t('status.offline'), tone: 'text-amber-600', icon: 'cloud-off' },
    [STATUS.SYNCING]: { label: t('status.syncing'), tone: 'accent-text', icon: 'refresh' },
    [STATUS.SYNCED]: { label: t('status.synced'), tone: 'text-paid-600', icon: 'check' },
    [STATUS.ERROR]: { label: t('status.error'), tone: 'text-due-600', icon: 'alert' },
    [STATUS.LOCAL_ONLY]: { label: t('status.localOnly'), tone: 'text-sub', icon: 'cloud-off' },
  };
  const meta = map[status] || map[STATUS.ONLINE];
  const suffix = pending > 0 ? ` · ${t('status.pending', { count: pending })}` : '';
  return { ...meta, text: `${meta.label}${suffix}` };
}

function syncBadge() {
  const meta = syncMeta();
  return el(
    'button',
    {
      type: 'button',
      class: `chip border bordered ${meta.tone}`,
      'aria-label': `${meta.text}. ${t('settings.syncNow')}`,
      onclick: async () => {
        const config = await readConfig();
        if (!isConfigured(config)) {
          go('#/settings');
          return;
        }
        const result = await engine?.syncNow('badge');
        if (result?.ok) toast(t('toast.syncDone'), { tone: 'success' });
        else toast(t('toast.syncFailed'), { tone: 'error' });
      },
    },
    icon(meta.icon, 'h-3.5 w-3.5'),
    el('span', { text: meta.text }),
  );
}

/* ------------------------------------------------------------------ header */

function renderHeader() {
  const header = clear(headerEl());
  const route = state.route;

  if (route.name === 'customer') {
    const customer = state.customers.find((c) => c.id === route.customerId);
    header.append(
      el(
        'div',
        { class: 'flex items-center gap-2' },
        el(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('nav.back'),
            onclick: () => go('#/'),
          },
          icon('back', 'h-4 w-4'),
        ),
        el(
          'div',
          { class: 'min-w-0 flex-1' },
          el('h1', {
            class: 'truncate text-lg font-bold text-body focus:outline-none',
            tabindex: '-1',
            dataset: { heading: '1' },
            text: customer ? customer.name : t('app.name'),
          }),
          customer?.phone_number
            ? el('p', { class: 'truncate text-xs text-sub', text: formatPhoneDisplay(customer.phone_number) })
            : null,
        ),
        syncBadge(),
      ),
    );
    return;
  }

  if (route.name === 'settings') {
    header.append(
      el(
        'div',
        { class: 'flex items-center gap-2' },
        el(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('nav.back'),
            onclick: () => go('#/'),
          },
          icon('back', 'h-4 w-4'),
        ),
        el('h1', {
          class: 'flex-1 text-lg font-bold text-body focus:outline-none',
          tabindex: '-1',
          dataset: { heading: '1' },
          text: t('settings.title'),
        }),
      ),
    );
    return;
  }

  const shopName = String(state.settings.shopName || '').trim();
  header.append(
    el(
      'div',
      { class: 'flex items-start justify-between gap-3' },
      el(
        'div',
        { class: 'min-w-0' },
        el('h1', {
          class: 'truncate text-xl font-extrabold tracking-tight text-body focus:outline-none',
          tabindex: '-1',
          dataset: { heading: '1' },
          text: shopName || t('app.name'),
        }),
        el('p', { class: 'truncate text-xs text-sub', text: shopName ? t('app.name') : t('app.tagline') }),
      ),
      el('div', { class: 'flex shrink-0 items-center gap-2' }, syncBadge()),
    ),
  );
}

/* --------------------------------------------------------------- dashboard */

function customerRow(customer) {
  const net = state.nets.get(customer.id)?.net ?? 0;
  const tone = balanceTone(net);
  return el(
    'li',
    {},
    el(
      'button',
      {
        type: 'button',
        class: 'flex w-full items-center gap-3 px-4 row-pad text-left transition-colors hover:bg-ink-50 dark:hover:bg-ink-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
        onclick: () => go(`#/c/${encodeURIComponent(customer.id)}`),
        'aria-label': `${customer.name}, ${tone.label} ${money(Math.abs(net))}`,
        dataset: { customerId: customer.id },
      },
      el(
        'span',
        {
          class: `flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${avatarTone(customer.id)}`,
          'aria-hidden': 'true',
          text: initials(customer.name),
        },
      ),
      el(
        'span',
        { class: 'min-w-0 flex-1' },
        el('span', { class: 'block truncate text-[0.95rem] font-semibold text-body', text: customer.name }),
        el(
          'span',
          { class: 'flex items-center gap-1.5' },
          customer.phone_number
            ? el('span', { class: 'truncate text-xs text-sub', text: formatPhoneDisplay(customer.phone_number) })
            : null,
          customer.rent?.active
            ? el('span', { class: 'chip accent-soft text-[0.6rem] font-semibold accent-text', text: t('rent.badge') })
            : null,
        ),
      ),
      el(
        'span',
        { class: 'shrink-0 text-right' },
        el('span', { class: `block text-[0.95rem] font-bold tabular ${tone.text}`, text: money(Math.abs(net)) }),
        el('span', { class: 'block text-[0.7rem] text-sub', text: tone.label }),
      ),
    ),
  );
}

function renderDashboard(main) {
  const totals = shopTotals(state.transactions);
  const query = state.query.trim().toLowerCase();
  const filtered = query
    ? state.customers.filter(
        (customer) =>
          customer.name.toLowerCase().includes(query) ||
          String(customer.phone_number || '').includes(query.replace(/\D/g, '')),
      )
    : state.customers;

  main.append(
    el(
      'section',
      { class: 'card mb-4 overflow-hidden', 'aria-label': t('nav.dashboard') },
      el(
        'div',
        { class: 'grid grid-cols-2 divide-x divide-ink-200 dark:divide-ink-700' },
        el(
          'div',
          { class: 'p-4' },
          el('p', { class: 'text-[0.7rem] font-semibold uppercase tracking-wide text-sub', text: t('dashboard.receivable') }),
          el('p', { class: 'mt-1 text-xl font-extrabold tabular text-due-600', text: money(totals.receivable) }),
        ),
        el(
          'div',
          { class: 'p-4' },
          el('p', { class: 'text-[0.7rem] font-semibold uppercase tracking-wide text-sub', text: t('dashboard.payable') }),
          el('p', { class: 'mt-1 text-xl font-extrabold tabular text-paid-600', text: money(totals.payable) }),
        ),
      ),
      el(
        'div',
        { class: 'flex items-center justify-between gap-2 border-t bordered px-4 py-2' },
        el('span', {
          class: 'text-xs text-sub',
          text: t('dashboard.customerCount', { count: state.customers.length }),
        }),
        el('span', {
          class: 'text-xs text-sub',
          text: t('ledger.entryCount', { count: state.transactions.length }),
        }),
      ),
    ),
  );

  const searchInput = el('input', {
    id: 'customer-search',
    type: 'search',
    class: 'field pl-10',
    placeholder: t('dashboard.searchPlaceholder'),
    value: state.query,
    autocomplete: 'off',
    oninput: debounce((event) => {
      state.query = event.target.value;
      const list = document.getElementById('customer-list');
      if (list) {
        const fresh = clear(list);
        for (const customer of filteredCustomers()) fresh.append(customerRow(customer));
        if (!fresh.children.length) fresh.append(emptyState(state.query ? 'noResults' : 'empty'));
      }
      const counter = document.getElementById('result-count');
      if (counter) counter.textContent = t('dashboard.customerCount', { count: filteredCustomers().length });
    }, 120),
  });

  main.append(
    el(
      'div',
      { class: 'relative mb-3' },
      el('label', { class: 'sr-only', for: 'customer-search', text: t('dashboard.search') }),
      el(
        'span',
        { class: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sub' },
        icon('search', 'h-4 w-4'),
      ),
      searchInput,
    ),
  );

  const list = el('ul', {
    id: 'customer-list',
    class: 'card divide-y divide-ink-200 overflow-hidden dark:divide-ink-700',
  });

  if (!filtered.length) {
    list.append(emptyState(query ? 'noResults' : 'empty'));
  } else {
    for (const customer of filtered) list.append(customerRow(customer));
  }

  main.append(list);
  main.append(
    el(
      'div',
      { class: 'pointer-events-none fixed inset-x-0 bottom-24 z-20 no-print' },
      el(
        'div',
        { class: 'mx-auto flex w-full max-w-app justify-end px-4' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn-primary pointer-events-auto px-4 py-3 shadow-card',
            id: 'dashboard-add-customer',
            onclick: () => openCustomerSheet(),
          },
          icon('plus', 'h-4 w-4'),
          el('span', { text: t('dashboard.addCustomer') }),
        ),
      ),
    ),
  );
}

function filteredCustomers() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.customers;
  return state.customers.filter(
    (customer) =>
      customer.name.toLowerCase().includes(query) ||
      String(customer.phone_number || '').includes(query.replace(/\D/g, '')),
  );
}

function emptyState(kind) {
  const isSearch = kind === 'noResults';
  return el(
    'li',
    { class: 'px-6 py-10 text-center' },
    el(
      'span',
      { class: 'mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full surface-muted text-sub' },
      icon(isSearch ? 'search' : 'users', 'h-6 w-6'),
    ),
    el('p', { class: 'text-sm font-semibold text-body', text: t(`${isSearch ? 'dashboard.noResults' : 'dashboard.empty'}.title`) }),
    el('p', {
      class: 'mx-auto mt-1 max-w-[18rem] text-xs text-sub',
      text: isSearch
        ? t('dashboard.noResults.body', { query: state.query })
        : t('dashboard.empty.body'),
    }),
    isSearch
      ? null
      : el(
          'button',
          {
            type: 'button',
            class: 'btn-primary mt-4',
            onclick: () => openCustomerSheet(),
          },
          icon('plus', 'h-4 w-4'),
          t('dashboard.addCustomer'),
        ),
  );
}

/* ---------------------------------------------------------------- customer */

function ledgerRow(tx, customer) {
  const isGiven = tx.type === TYPES.GIVEN;
  return el(
    'li',
    {},
    el(
      'button',
      {
        type: 'button',
        class: 'flex w-full items-start gap-3 px-4 row-pad text-left transition-colors hover:bg-ink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset dark:hover:bg-ink-800/40',
        'aria-label': `${tx.note || (isGiven ? t('tx.gaveTitle') : t('tx.gotTitle'))}, ${isGiven ? '-' : '+'}${money(tx.amount_paise)}, ${formatDate(tx.occurred_at || tx.created_at)}`,
        onclick: () => openTransactionSheet({ customer, transaction: tx }),
      },
      el(
      'span',
      {
        class: `mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          isGiven ? 'bg-due-100 text-due-600' : 'bg-paid-100 text-paid-600'
        }`,
        'aria-hidden': 'true',
      },
      icon(isGiven ? 'arrowUp' : 'arrowDown', 'h-4 w-4'),
    ),
    el(
      'div',
      { class: 'min-w-0 flex-1' },
      el('p', { class: 'truncate text-sm font-semibold text-body', text: tx.note || (isGiven ? t('tx.gaveTitle') : t('tx.gotTitle')) }),
      el('p', { class: 'text-xs text-sub', text: formatDateTime(tx.occurred_at || tx.created_at) }),
      el('div', { class: 'flex flex-wrap items-center gap-1' }, rentChip(tx), attachmentChip(tx), smsChip(tx)),
    ),
    el(
      'div',
      { class: 'shrink-0 text-right' },
      el('p', {
        class: `text-sm font-bold tabular ${isGiven ? 'text-due-600' : 'text-paid-600'}`,
        text: `${isGiven ? '-' : '+'}${money(tx.amount_paise)}`,
      }),
      el('p', { class: 'text-[0.7rem] text-sub tabular', text: `${t('ledger.running')} ${money(Math.abs(tx.running_paise))}` }),
      ),
    ),
  );
}

function renderCustomer(main) {
  const customer = state.customers.find((c) => c.id === state.route.customerId);
  if (!customer) {
    main.append(
      el(
        'div',
        { class: 'card p-6 text-center' },
        el('p', { class: 'text-sm font-semibold text-body', text: t('dashboard.noResults.title') }),
        el('button', { type: 'button', class: 'btn-primary mt-4', onclick: () => go('#/') }, t('nav.back')),
      ),
    );
    return;
  }

  const entries = state.transactions.filter((tx) => tx.customer_id === customer.id);
  const totals = summarize(entries);
  const tone = balanceTone(totals.net);
  const running = withRunningBalance(entries);

  main.append(
    el(
      'section',
      { class: 'card mb-4 p-5 text-center' },
      el('p', { class: 'text-[0.7rem] font-semibold uppercase tracking-wide text-sub', text: tone.label }),
      el('p', {
        id: 'customer-balance',
        class: `mt-1 text-3xl font-extrabold tabular ${tone.text}`,
        text: money(Math.abs(totals.net)),
      }),
      el('p', {
        class: 'mt-1 text-xs text-sub',
        text: `${t('ledger.entryCount', { count: entries.length })} · ${t('statement.totalGave')} ${money(totals.given)} · ${t('statement.totalGot')} ${money(totals.got)}`,
      }),
    ),
  );

  const rent = customer.rent ? rentSummary({ rent: customer.rent, transactions: entries }) : null;
  const agreement = rent ? state.agreements.get(customer.id) || null : null;
  if (rent) {
    main.append(
      el(
        'section',
        { class: 'card mb-4 p-4', id: 'rent-card' },
        el(
          'div',
          { class: 'flex items-start justify-between gap-3' },
          el(
            'div',
            { class: 'min-w-0' },
            el('p', { class: 'text-[0.7rem] font-bold uppercase tracking-wide accent-text', text: t('rent.title') }),
            el('p', {
              class: 'mt-0.5 text-lg font-extrabold tabular text-body',
              text: t('rent.perMonth', { amount: money(rent.amount_paise) }),
            }),
            el('p', {
              class: 'mt-0.5 text-xs text-sub',
              text: t('rent.cycleLine', { start: formatDate(rent.start_date), day: rent.cycle_day }),
            }),
          ),
          el('span', {
            class: `chip shrink-0 ${rent.active ? 'bg-paid-100 text-paid-700' : 'surface-muted text-sub'}`,
            text: rent.active ? t('rent.active') : t('rent.stopped'),
          }),
        ),
        el(
          'div',
          { class: 'mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sub' },
          rent.next_due
            ? el('span', { id: 'rent-next-due', text: t('rent.nextDue', { date: formatDate(rent.next_due) }) })
            : el('span', { id: 'rent-next-due', text: t('rent.noNextDue') }),
          el('span', { text: t('rent.charged', { count: rent.charged }) }),
          el('span', { id: 'rent-billed', text: t('rent.billed', { amount: money(rent.billed) }) }),
          el('span', {
            text: rent.mode === 'advance' ? t('rent.modeAdvance') : t('rent.modeArrears'),
          }),
        ),
        el(
          'div',
          { class: 'mt-1.5 space-y-1 text-xs' },
          rent.electricity_paise > 0
            ? el('p', {
                id: 'rent-electricity-line',
                class: 'text-sub',
                text: t('rent.electricityLine', { amount: money(rent.electricity_paise) }),
              })
            : null,
          rent.deposit.agreed > 0 || rent.deposit.entries > 0
            ? el('p', {
                id: 'rent-deposit-line',
                class: 'text-sub',
                text: t('rent.depositLine', {
                  held: money(rent.deposit.held),
                  agreed: money(rent.deposit.agreed),
                }),
              })
            : null,
          rent.end_date
            ? el('p', {
                id: 'rent-end-line',
                class: 'font-semibold text-due-600',
                text: t('rent.endsOn', { date: formatDate(rent.end_date) }),
              })
            : null,
          rent.notice_days > 0 && !rent.end_date
            ? el('p', { class: 'text-sub', text: t('rent.noticeLine', { days: rent.notice_days }) })
            : null,
          rent.last_charged_paise && rent.last_charged_paise !== rent.amount_paise
            ? el('p', {
                class: 'text-sub',
                text: t('rent.amountChanged', { last: money(rent.last_charged_paise) }),
              })
            : null,
          agreement ? el('p', { id: 'rent-agreement-line', class: 'text-sub', text: t('rent.agreementAttached', { name: agreement.name }) }) : null,
        ),
        el(
          'div',
          { class: 'mt-3 grid grid-cols-2 gap-2' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn bg-paid-600 text-white hover:bg-paid-700',
              id: 'rent-payment',
              onclick: () =>
                openTransactionSheet({
                  customer,
                  type: TYPES.GOT,
                  amountPaise: rent.amount_paise,
                  note: t('rent.paymentNote'),
                }),
            },
            icon('arrowDown', 'h-4 w-4'),
            el('span', { text: t('rent.addPayment') }),
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'btn-ghost',
              id: 'rent-edit',
              onclick: () => openCustomerSheet({ customer }),
            },
            icon('edit', 'h-4 w-4'),
            el('span', { text: t('rent.edit') }),
          ),
        ),
        el(
          'div',
          { class: 'mt-2 grid grid-cols-3 gap-2' },
          el(
            'button',
            { type: 'button', class: 'btn-ghost px-2 py-2 text-[0.7rem]', id: 'rent-deposit', onclick: () => openDepositSheet(customer, rent) },
            icon('shield', 'h-4 w-4'),
            el('span', { text: t('rent.deposit') }),
          ),
          el(
            'button',
            { type: 'button', class: 'btn-ghost px-2 py-2 text-[0.7rem]', id: 'rent-agreement', onclick: () => addAgreement(customer) },
            icon('pdf', 'h-4 w-4'),
            el('span', { text: t('rent.agreement') }),
          ),
          el(
            'button',
            {
              type: 'button',
              class: `btn-ghost px-2 py-2 text-[0.7rem] ${rent.end_date ? 'opacity-50' : ''}`,
              id: 'rent-end',
              disabled: Boolean(rent.end_date),
              onclick: () => endTenancy(customer, rent),
            },
            icon('close', 'h-4 w-4'),
            el('span', { text: t('rent.endTenancy') }),
          ),
        ),
      ),
    );
  }

  main.append(
    el(
      'div',
      { class: 'mb-4 grid grid-cols-2 gap-2' },
      el(
        'button',
        {
          type: 'button',
          class: 'btn bg-due-600 text-white hover:bg-due-700',
          id: 'ledger-gave',
          onclick: () => openTransactionSheet({ customer, type: TYPES.GIVEN }),
        },
        icon('arrowUp', 'h-4 w-4'),
        el('span', { text: t('ledger.gave') }),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'btn bg-paid-600 text-white hover:bg-paid-700',
          id: 'ledger-got',
          onclick: () => openTransactionSheet({ customer, type: TYPES.GOT }),
        },
        icon('arrowDown', 'h-4 w-4'),
        el('span', { text: t('ledger.got') }),
      ),
    ),
  );

  const actions = [
    {
      key: 'call',
      label: t('ledger.call'),
      iconName: 'phone',
      disabled: !customer.phone_number,
      onClick: () => {
        window.location.href = `tel:${customer.phone_number}`;
      },
    },
    {
      key: 'whatsapp',
      label: t('ledger.whatsapp'),
      iconName: 'whatsapp',
      disabled: !customer.phone_number,
      onClick: () => {
        if (!customer.phone_number) {
          toast(t('toast.noPhone'), { tone: 'error' });
          return;
        }
        const text = formatReminderText({
          shopName: state.settings.shopName,
          customerName: customer.name,
          netPaise: totals.net,
          template: state.settings.whatsappTemplate,
        });
        const phone = String(customer.phone_number).replace(/\D/g, '');
        window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
      },
    },
    {
      key: 'pdf',
      label: t('ledger.pdf'),
      iconName: 'pdf',
      onClick: () => {
        if (!entries.length) {
          toast(t('toast.noEntries'), { tone: 'error' });
          return;
        }
        try {
          downloadStatement(customer, entries, { shopName: state.settings.shopName });
          toast(t('toast.statementReady'), { tone: 'success' });
          logger.info('pdf', 'Statement generated', { customerId: customer.id, entries: entries.length });
        } catch (error) {
          logger.error('pdf', 'Statement failed', { message: error?.message });
          toast(t('errors.generic'), { tone: 'error' });
        }
      },
    },
    {
      key: 'edit',
      label: t('ledger.edit'),
      iconName: 'edit',
      onClick: () => openCustomerSheet({ customer }),
    },
    {
      key: 'delete',
      label: t('common.delete'),
      ariaLabel: t('ledger.delete'),
      iconName: 'trash',
      danger: true,
      onClick: async () => {
        if (state.settings.confirmDelete) {
          const ok = await confirmDialog({
            title: t('common.delete'),
            message: t('customer.deleteConfirm', { name: customer.name }),
            confirmLabel: t('common.delete'),
            cancelLabel: t('common.cancel'),
          });
          if (!ok) return;
        }
        await db.deleteCustomer(customer.id);
        logger.info('customer', 'Customer deleted', { customerId: customer.id });
        await reloadData();
        go('#/');
        toast(t('toast.deleted'));
        engine?.syncNow('delete');
      },
    },
  ];

  main.append(
    el(
      'div',
      { class: 'mb-4 grid grid-cols-5 gap-1.5' },
      ...actions.map((action) =>
        el(
          'button',
          {
            type: 'button',
            class: `flex flex-col items-center gap-1 rounded-xl border bordered surface py-2 text-[0.68rem] font-semibold ${
              action.danger ? 'text-due-600' : 'text-body'
            } disabled:opacity-40`,
            disabled: action.disabled === true,
            onclick: action.onClick,
            'aria-label': action.ariaLabel || action.label,
          },
          icon(action.iconName, 'h-4 w-4'),
          el('span', { class: 'text-center leading-tight', text: action.label }),
        ),
      ),
    ),
  );

  const list = el('ul', { class: 'card divide-y divide-ink-200 overflow-hidden dark:divide-ink-700' });
  if (!running.length) {
    list.append(
      el(
        'li',
        { class: 'px-6 py-10 text-center' },
        el('p', { class: 'text-sm font-semibold text-body', text: t('ledger.empty.title') }),
        el('p', { class: 'mt-1 text-xs text-sub', text: t('ledger.empty.body') }),
      ),
    );
  } else {
    for (const tx of [...running].reverse()) list.append(ledgerRow(tx, customer));
  }
  main.append(list);
}

/* ---------------------------------------------------------------- settings */

function sectionCard(title, children, { description } = {}) {
  return el(
    'section',
    { class: 'card mb-4 overflow-hidden' },
    el(
      'div',
      { class: 'border-b bordered px-4 py-2.5' },
      el('h2', { class: 'text-xs font-bold uppercase tracking-wide text-sub', text: title }),
      description ? el('p', { class: 'mt-0.5 text-[0.7rem] text-sub', text: description }) : null,
    ),
    el('div', { class: 'divide-y divide-ink-200 dark:divide-ink-700' }, children),
  );
}

function rowWrapper(label, hint, control, { htmlFor } = {}) {
  return el(
    'div',
    { class: 'flex items-center justify-between gap-3 px-4 py-3' },
    el(
      'div',
      { class: 'min-w-0' },
      htmlFor
        ? el('label', { class: 'block text-sm font-semibold text-body', for: htmlFor, text: label })
        : el('p', { class: 'text-sm font-semibold text-body', text: label }),
      hint ? el('p', { class: 'mt-0.5 text-[0.7rem] leading-snug text-sub', text: hint }) : null,
    ),
    el('div', { class: 'shrink-0' }, control),
  );
}

function toggleRow(label, hint, checked, onChange) {
  const button = el(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      class: `relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 ${
        checked ? 'accent-bg' : 'bg-ink-300 dark:bg-ink-700'
      }`,
      onclick: async () => {
        const next = button.getAttribute('aria-checked') !== 'true';
        button.setAttribute('aria-checked', String(next));
        button.className = `relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 ${
          next ? 'accent-bg' : 'bg-ink-300 dark:bg-ink-700'
        }`;
        knob.style.transform = next ? 'translateX(1.25rem)' : 'translateX(0.125rem)';
        await onChange(next);
      },
    },
    (() => {
      const knobEl = el('span', {
        class: 'pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform',
      });
      knobEl.style.transform = checked ? 'translateX(1.25rem)' : 'translateX(0.125rem)';
      return knobEl;
    })(),
  );
  const knob = button.firstElementChild;
  return rowWrapper(label, hint, button);
}

function segmented(label, options, value, onSelect, { hint } = {}) {
  const group = el('div', {
    class: 'inline-flex rounded-xl border bordered surface p-0.5',
    role: 'radiogroup',
    'aria-label': label,
  });
  for (const option of options) {
    const selected = option.id === value;
    group.append(
      el(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': selected ? 'true' : 'false',
          class: `rounded-[0.6rem] px-2.5 py-1.5 text-xs font-semibold transition-colors ${
            selected ? 'accent-bg text-white' : 'text-sub hover:text-body'
          }`,
          onclick: async () => {
            [...group.children].forEach((child, index) => {
              const isSelected = options[index].id === option.id;
              child.setAttribute('aria-checked', String(isSelected));
              child.className = `rounded-[0.6rem] px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                isSelected ? 'accent-bg text-white' : 'text-sub hover:text-body'
              }`;
            });
            await onSelect(option.id);
          },
        },
        option.label,
      ),
    );
  }
  return rowWrapper(label, hint, group);
}

function textRow(label, hint, value, onCommit, { id, placeholder, type = 'text', maxLength } = {}) {
  const input = el('input', {
    id,
    type,
    class: 'field w-full',
    value: value ?? '',
    placeholder: placeholder || '',
    maxlength: maxLength || undefined,
    onchange: (event) => onCommit(cleanText(event.target.value)),
  });
  return el(
    'div',
    { class: 'px-4 py-3' },
    el('label', { class: 'block text-sm font-semibold text-body', for: id, text: label }),
    hint ? el('p', { class: 'mb-1.5 mt-0.5 text-[0.7rem] leading-snug text-sub', text: hint }) : null,
    input,
  );
}

function actionRow(label, hint, buttonLabel, onAction, { danger = false, id } = {}) {
  return el(
    'div',
    { class: 'flex items-center justify-between gap-3 px-4 py-3' },
    el(
      'div',
      { class: 'min-w-0' },
      el('p', { class: 'text-sm font-semibold text-body', text: label }),
      hint ? el('p', { class: 'mt-0.5 text-[0.7rem] leading-snug text-sub', text: hint }) : null,
    ),
    el(
      'button',
      {
        type: 'button',
        id,
        class: `btn shrink-0 ${danger ? 'bg-due-600 text-white hover:bg-due-700' : 'btn-ghost'}`,
        onclick: onAction,
      },
      buttonLabel,
    ),
  );
}

async function renderSettings(main) {
  const s = state.settings;
  const [counts, files] = await Promise.all([db.stats(), db.attachmentStats()]);
  state.stats = { ...counts, attachments: files.count, attachmentBytes: files.bytes };
  // Replace the loading placeholder with the real content in one go.
  clear(main);

  /* General */
  main.append(
    sectionCard(t('settings.general'), [
      segmented(
        t('settings.language'),
        LANGUAGES.map((language) => ({ id: language.id, label: language.label })),
        s.language,
        async (value) => {
          await updateSetting('language', value);
          setLanguage(value);
          render();
        },
      ),
      textRow(
        t('settings.shopName'),
        t('settings.shopNamePlaceholder'),
        s.shopName,
        (value) => updateSetting('shopName', value),
        { id: 'setting-shop-name', maxLength: LIMITS.NAME_MAX },
      ),
      textRow(
        t('settings.shopPhone'),
        null,
        s.shopPhone,
        (value) => updateSetting('shopPhone', value),
        { id: 'setting-shop-phone', type: 'tel' },
      ),
      toggleRow(t('settings.smsAlerts'), t('settings.smsAlertsHint'), s.smsAlerts, (next) =>
        updateSetting('smsAlerts', next),
      ),
      smsQuotaRow(),
      toggleRow(t('settings.autoSync'), t('settings.autoSyncHint'), s.autoSync, async (next) => {
        await updateSetting('autoSync', next);
        if (next) engine?.syncNow('toggle');
        else state.sync.status = STATUS.LOCAL_ONLY;
        render();
      }),
      segmented(
        t('settings.syncInterval'),
        [
          { id: '30', label: '30s' },
          { id: '60', label: '1m' },
          { id: '300', label: '5m' },
          { id: '900', label: '15m' },
        ],
        String(s.syncIntervalSec),
        async (value) => {
          await updateSetting('syncIntervalSec', Number(value));
          engine?.stop();
          engine?.start();
        },
      ),
      connectionRow(),
      actionRow(
        t('settings.syncNow'),
        state.sync.pending > 0 ? t('status.pending', { count: state.sync.pending }) : t('settings.nothingPending'),
        t('settings.syncNow'),
        async () => {
          const result = await engine?.syncNow('manual');
          if (result?.ok) toast(t('toast.syncDone'), { tone: 'success' });
          else toast(t('toast.syncFailed'), { tone: 'error' });
          render();
        },
        { id: 'setting-sync-now' },
      ),
      toggleRow(t('settings.confirmDelete'), t('settings.confirmDeleteHint'), s.confirmDelete, (next) =>
        updateSetting('confirmDelete', next),
      ),
      textRow(
        t('settings.whatsappTemplate'),
        t('settings.whatsappTemplateHint'),
        s.whatsappTemplate,
        (value) => updateSetting('whatsappTemplate', value || settings.DEFAULT_REMINDER),
        { id: 'setting-wa-template', maxLength: 300 },
      ),
    ]),
  );

  /* Data and backup */
  const backup = state.backup || (await backupStatus());
  state.backup = backup;
  main.append(
    sectionCard(
      t('settings.data'),
      [
        segmented(
          t('settings.backupInterval'),
          [
            { id: 'auto', label: t('settings.backupAuto') },
            { id: 'weekly', label: t('settings.backupWeekly') },
            { id: 'monthly', label: t('settings.backupMonthly') },
            { id: 'off', label: t('settings.backupOff') },
          ],
          s.backupInterval,
          async (value) => {
            await updateSetting('backupInterval', value);
            if (value !== 'off') await runBackupNow({ silent: true });
            render();
          },
          { hint: t('settings.backupIntervalHint') },
        ),
        el(
          'div',
          { class: 'flex items-center justify-between gap-3 px-4 py-3', id: 'setting-backup-status' },
          el(
            'div',
            { class: 'min-w-0' },
            el('p', { class: 'text-sm font-semibold text-body', text: t('settings.lastBackup') }),
            el('p', {
              class: 'mt-0.5 text-[0.7rem] leading-snug text-sub',
              text: backup.lastAt
                ? t('settings.backupState', {
                    date: formatDateTime(backup.lastAt),
                    count: backup.count,
                    size: backup.humanSize,
                  })
                : t('settings.backupNever'),
            }),
          ),
          el('span', {
            class: `chip shrink-0 ${backup.lastAt ? 'bg-paid-100 text-paid-700' : 'surface-muted text-sub'}`,
            text: backup.lastAt ? t('settings.backupOk') : t('settings.backupNone'),
          }),
        ),
        actionRow(t('settings.backupNow'), t('settings.backupNowHint'), t('settings.backupNow'), () =>
          runBackupNow({ force: true }), { id: 'setting-backup-now' }),
        actionRow(t('settings.backup'), t('settings.backupHint'), t('settings.backup'), exportBackup, {
          id: 'setting-backup',
        }),
        actionRow(t('settings.restore'), t('settings.restoreHint'), t('settings.restore'), importBackup, {
          id: 'setting-restore',
        }),
        actionRow(t('settings.clearData'), t('settings.clearDataHint'), t('common.delete'), clearData, {
          danger: true,
          id: 'setting-clear-data',
        }),
      ],
      {
        description: t('settings.statsFull', {
          customers: state.stats.customers,
          transactions: state.stats.transactions,
          logs: state.stats.logs,
          files: state.stats.attachments || 0,
          size: formatBytes(state.stats.attachmentBytes || 0),
        }),
      },
    ),
  );

  /* Diagnostics */
  main.append(
    sectionCard(t('settings.diagnostics'), [
      toggleRow(t('settings.logging'), t('settings.loggingHint'), s.logging, async (next) => {
        await updateSetting('logging', next);
        setLogging(next);
        if (!next) toast(t('toast.logsOff'));
      }),
      actionRow(
        t('settings.shareLogs'),
        t('settings.logCount', { count: state.stats.logs }),
        t('settings.shareLogs'),
        () => exportLogs({ share: true }),
        { id: 'setting-share-logs' },
      ),
      el(
        'div',
        { class: 'px-4 py-3' },
        el('p', { class: 'mb-2 text-sm font-semibold text-body', text: t('settings.exportLogs') }),
        el('p', { class: 'mb-2 text-[0.7rem] text-sub', text: t('settings.exportFormat') }),
        el(
          'div',
          { class: 'grid grid-cols-4 gap-2' },
          ...[
            { format: 'txt', label: '.txt' },
            { format: 'json', label: '.json' },
            { format: 'md', label: '.md' },
            { format: 'zip', label: '.zip' },
          ].map((option) =>
            el(
              'button',
              {
                type: 'button',
                class: 'btn-ghost px-2 py-2 text-xs',
                dataset: { export: option.format },
                onclick: () => exportLogs({ share: false, format: option.format }),
              },
              option.label,
            ),
          ),
        ),
      ),
      actionRow(t('settings.clearLogs'), null, t('settings.clearLogs'), async () => {
        await db.clearLogs();
        state.stats = await db.stats();
        toast(t('toast.logsCleared'));
        render();
      }, { id: 'setting-clear-logs' }),
    ]),
  );

  /* Reset */
  main.append(
    sectionCard(t('settings.reset'), [
      actionRow(t('settings.reset'), t('settings.resetHint'), t('common.confirm'), async () => {
        if (state.settings.confirmDelete) {
          const ok = await confirmDialog({
            title: t('settings.reset'),
            message: t('settings.resetConfirm'),
            confirmLabel: t('common.confirm'),
            cancelLabel: t('common.cancel'),
          });
          if (!ok) return;
        }
        await settings.reset();
        state.settings = settings.current();
        setLanguage(state.settings.language);
        setLogging(state.settings.logging);
        toast(t('toast.reset'));
        render();
      }, { id: 'setting-reset' }),
    ]),
  );

  /* About - always last */
  main.append(
    el(
      'section',
      { class: 'card mb-4 overflow-hidden', 'aria-labelledby': 'about-heading' },
      el('div', { class: 'border-b bordered px-4 py-2.5' }, el('h2', {
        id: 'about-heading',
        class: 'text-xs font-bold uppercase tracking-wide text-sub',
        text: t('settings.about'),
      })),
      el(
        'div',
        { class: 'px-4 py-4' },
        el(
          'div',
          { class: 'flex items-center gap-3' },
          el(
            'span',
            {
              class: 'flex h-12 w-12 items-center justify-center rounded-full accent-soft text-base font-extrabold accent-text',
              'aria-hidden': 'true',
              text: 'AG',
            },
          ),
          el(
            'div',
            { class: 'min-w-0' },
            el('p', { class: 'text-sm font-bold text-body', text: t('settings.developer') }),
            el('p', { class: 'text-xs text-sub', text: t('settings.developerTagline') }),
          ),
        ),
        el(
          'div',
          { class: 'mt-4 grid gap-2' },
          el(
            'a',
            {
              class: 'btn-ghost w-full justify-start',
              href: `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Khata feedback')}`,
              id: 'about-email',
            },
            icon('mail', 'h-4 w-4'),
            el('span', { class: 'truncate', text: CONTACT_EMAIL }),
          ),
          el(
            'a',
            {
              class: 'btn-primary w-full justify-start',
              href: INSTAGRAM_URL,
              target: '_blank',
              rel: 'noopener',
              id: 'about-instagram',
            },
            icon('instagram', 'h-4 w-4'),
            el('span', { text: t('settings.followCta') }),
          ),
          el('p', { class: 'text-center text-[0.7rem] text-sub', text: t('settings.followHint') }),
        ),
        el(
          'div',
          { class: 'mt-4 flex items-center justify-between gap-3 border-t bordered pt-3' },
          el('p', { class: 'text-xs text-sub', id: 'about-version', text: t('settings.version', { version: APP_VERSION }) }),
          el(
            'button',
            {
              type: 'button',
              class: 'btn-ghost px-3 py-2 text-xs',
              id: 'about-check-updates',
              disabled: state.update.checking,
              onclick: () => checkForUpdates({ announce: true }),
            },
            icon('refresh', 'h-3.5 w-3.5'),
            el('span', { text: state.update.checking ? t('settings.checking') : t('settings.checkUpdates') }),
          ),
        ),
        state.update.message
          ? el(
              'p',
              { class: 'mt-2 rounded-lg surface-muted px-3 py-2 text-xs text-body', id: 'about-update-message' },
              state.update.message,
            )
          : null,
        state.update.available
          ? el(
              'button',
              {
                type: 'button',
                class: 'btn-primary mt-2 w-full',
                id: 'about-update-now',
                onclick: applyUpdate,
              },
              icon('download', 'h-4 w-4'),
              t('settings.updateNow'),
            )
          : null,
        el('p', { class: 'mt-3 text-center text-[0.65rem] text-sub', text: `Khata ${APP_VERSION} · offline-first PWA` }),
      ),
    ),
  );
}

async function updateSetting(key, value) {
  await settings.update(key, value);
  state.settings = settings.current();
  if (key === 'language') setLanguage(value);
  if (key === 'logging') setLogging(value);
  logger.info('settings', 'Setting changed', { key, value });
}

/** Read-only: how many messages the SIM has sent today, out of the daily cap. */
function smsQuotaRow() {
  const quota = smsQuota();
  const bridge = hasDeviceSms();
  const label = !bridge
    ? t('settings.smsUnavailable')
    : quota
      ? t('settings.smsQuota', { sent: quota.sent, cap: quota.cap })
      : t('settings.smsUnknown');
  return el(
    'div',
    { class: 'flex items-center justify-between gap-3 px-4 py-3', id: 'setting-sms-quota' },
    el(
      'div',
      { class: 'min-w-0' },
      el('p', { class: 'text-sm font-semibold text-body', text: t('settings.smsToday') }),
      el('p', { class: 'mt-0.5 text-[0.7rem] leading-snug text-sub', text: label }),
    ),
    el(
      'span',
      {
        class: `chip shrink-0 ${bridge ? 'bg-paid-100 text-paid-700' : 'surface-muted text-sub'}`,
        text: bridge ? t('settings.smsDevice') : t('settings.smsBrowser'),
      },
    ),
  );
}

function serverHost() {
  try {
    return new URL(API_BASE).host;
  } catch {
    return API_BASE;
  }
}

/** Read-only: the server address is baked into the build, never typed by the shopkeeper. */
function connectionRow() {
  const connected = Boolean(API_BASE) && state.sync.status !== STATUS.LOCAL_ONLY;
  return el(
    'div',
    { class: 'flex items-start justify-between gap-3 px-4 py-3', id: 'setting-connection' },
    el(
      'div',
      { class: 'min-w-0 flex-1' },
      el('p', { class: 'text-sm font-semibold text-body', text: t('settings.connection') }),
      el('p', {
        class: 'mt-0.5 break-words text-[0.7rem] leading-snug text-sub',
        text: API_BASE ? t('settings.connectionHint', { host: serverHost() }) : t('settings.serverNotDeployed'),
      }),
    ),
    el('span', {
      class: `chip shrink-0 ${connected ? 'bg-paid-100 text-paid-700' : 'surface-muted text-sub'}`,
      id: 'setting-connection-state',
      text: connected ? t('settings.syncOn') : t('settings.syncOff'),
    }),
  );
}

function refreshSyncStatus() {
  const configured = isConfigured({ apiBase: API_BASE });
  if (!configured || !state.settings.autoSync) state.sync.status = STATUS.LOCAL_ONLY;
  renderHeader();
}

/* ------------------------------------------------------------- data actions */

let lastBackupRun = 0;

/**
 * Runs the scheduled backup if it is due (or now, if asked), records when it
 * happened, and refreshes the Settings card.
 */
async function runScheduledBackupIfDue({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastBackupRun < 5 * 60 * 1000) return { ran: false, reason: 'checked_recently' };
  lastBackupRun = now;

  const result = await runScheduledBackup({
    interval: state.settings.backupInterval || 'auto',
    lastAt: state.settings.lastBackupAt || null,
    changedAt: state.settings.lastChangeAt || null,
    now: new Date(now),
    force,
  });

  if (result.ran) {
    await settings.updateMany({ lastBackupAt: new Date(now).toISOString(), lastChangeAt: null });
    state.settings = settings.current();
    state.backup = null;
    logger.info('backup', 'Backup written', {
      reason: result.reason,
      size: result.size,
      customers: result.customers,
      transactions: result.transactions,
      attachments: result.attachments,
      savedToDevice: result.savedToDevice,
    });
  }
  return result;
}

async function runBackupNow({ force = true, silent = false } = {}) {
  try {
    const result = await runScheduledBackupIfDue({ force });
    if (!result.ran) {
      if (!silent) toast(t('toast.backupSkipped'));
      return result;
    }
    if (!silent) {
      toast(
        t('toast.backupDone', {
          size: formatBytes(result.size),
          files: result.attachments || 0,
        }),
        { tone: 'success' },
      );
    }
    render();
    return result;
  } catch (error) {
    logger.error('backup', 'Backup failed', { message: error?.message });
    if (!silent) toast(t('errors.generic'), { tone: 'error' });
    return { ran: false, reason: 'error' };
  }
}

async function exportBackup() {
  const { blob, manifest, attachmentCount } = await db.exportBackupZip();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `khata-backup-${stamp}.zip`);
  toast(t('toast.backupSaved'), { tone: 'success' });
  logger.info('data', 'Backup downloaded', {
    customers: manifest.customers.length,
    transactions: manifest.transactions.length,
    attachments: attachmentCount,
  });
}

function importBackup() {
  const input = el('input', { type: 'file', accept: 'application/zip,.zip,application/json,.json', class: 'hidden' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      // A zip carries the attachments too; the older JSON files still restore.
      const isZip = /zip$/i.test(file.type) || /\.zip$/i.test(file.name);
      const result = isZip
        ? await db.importBackupZip(new Uint8Array(await file.arrayBuffer()), { mode: 'merge' })
        : await db.importAll(JSON.parse(await file.text()), { mode: 'merge' });
      await reloadData();
      toast(
        t('toast.restored', {
          customers: result.customers,
          transactions: result.transactions,
          files: result.attachments || 0,
        }),
        { tone: 'success' },
      );
      logger.info('data', 'Backup restored', result);
      engine?.syncNow('restore');
      render();
    } catch (error) {
      logger.error('data', 'Restore failed', { message: error?.message });
      toast(t('errors.generic'), { tone: 'error' });
    }
  });
  input.click();
}

async function clearData() {
  if (state.settings.confirmDelete) {
    const ok = await confirmDialog({
      title: t('settings.clearData'),
      message: t('settings.clearDataConfirm'),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
  }
  await db.wipeAll({ keepSettings: true });
  await reloadData();
  toast(t('toast.cleared'));
  logger.warn('data', 'All ledger data deleted by the user');
  render();
}

/* -------------------------------------------------------------------- logs */

function logsToMarkdown(logs) {
  const lines = [
    `# Khata diagnostics log`,
    '',
    `- Exported: ${new Date().toISOString()}`,
    `- App version: ${APP_VERSION}`,
    `- Entries: ${logs.length}`,
    `- User agent: ${navigator.userAgent}`,
    '',
    '| Time | Level | Scope | Message | Data |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const entry of logs) {
    const data = entry.data ? JSON.stringify(entry.data).replaceAll('|', '\\|').slice(0, 400) : '';
    lines.push(`| ${entry.ts} | ${entry.level} | ${entry.scope} | ${String(entry.message).replaceAll('|', '\\|')} | ${data} |`);
  }
  return lines.join('\n');
}

function logsToText(logs) {
  return logs
    .map((entry) => `${entry.ts} [${entry.level}] (${entry.scope}) ${entry.message}${entry.data ? ` :: ${JSON.stringify(entry.data)}` : ''}`)
    .join('\n');
}

async function buildLogFile(format) {
  const logs = await db.listLogs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `khata-logs-${stamp}`;
  if (format === 'zip') {
    const zip = createZip([
      { name: `${base}.txt`, data: logsToText(logs) },
      { name: `${base}.md`, data: logsToMarkdown(logs) },
      { name: `${base}.json`, data: JSON.stringify({ app: 'khata', version: APP_VERSION, exported_at: new Date().toISOString(), logs }, null, 2) },
      {
        name: 'device.txt',
        data: `userAgent: ${navigator.userAgent}\nlanguage: ${navigator.language}\nplatform: ${navigator.platform}\nversion: ${APP_VERSION}\nonline: ${navigator.onLine}\n`,
      },
    ]);
    return { blob: zip, name: `${base}.zip` };
  }
  if (format === 'json') {
    return {
      blob: new Blob([JSON.stringify({ app: 'khata', version: APP_VERSION, exported_at: new Date().toISOString(), logs }, null, 2)], {
        type: 'application/json',
      }),
      name: `${base}.json`,
    };
  }
  if (format === 'md') {
    return { blob: new Blob([logsToMarkdown(logs)], { type: 'text/markdown' }), name: `${base}.md` };
  }
  return { blob: new Blob([logsToText(logs)], { type: 'text/plain' }), name: `${base}.txt` };
}

async function exportLogs({ share = false, format = 'txt' } = {}) {
  const logs = await db.listLogs();
  if (!logs.length) {
    toast(t('toast.noEntries'), { tone: 'error' });
    return;
  }
  const file = await buildLogFile(format);

  if (share && typeof navigator.canShare === 'function') {
    const fileObj = new File([file.blob], file.name, { type: file.blob.type });
    if (navigator.canShare({ files: [fileObj] })) {
      try {
        await navigator.share({ files: [fileObj], title: 'Khata diagnostics', text: 'Khata log export' });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        logger.warn('logs', 'Share failed, falling back to download', { message: error?.message });
      }
    }
  }
  downloadBlob(file.blob, file.name);
  toast(t('toast.exported'), { tone: 'success' });
}

/* ------------------------------------------------------------------ sheets */

function openCustomerSheet({ customer = null } = {}) {
  const isEdit = Boolean(customer);
  const nameInput = el('input', {
    id: 'customer-name',
    class: 'field',
    value: customer?.name || '',
    placeholder: t('customer.namePlaceholder'),
    maxlength: LIMITS.NAME_MAX,
    autocomplete: 'name',
    'data-autofocus': '',
  });
  const phoneInput = el('input', {
    id: 'customer-phone',
    class: 'field',
    type: 'tel',
    inputmode: 'numeric',
    value: customer?.phone_number ? formatPhoneDisplay(customer.phone_number) : '',
    placeholder: t('customer.phonePlaceholder'),
    autocomplete: 'tel',
  });
  const errorBox = el('p', { class: 'min-h-[1rem] text-xs font-medium text-due-600', role: 'alert' });

  /* --- rent --- */
  const existingRent = customer?.rent || null;
  let rentOn = Boolean(existingRent);
  let rentMode = existingRent?.mode === 'advance' ? 'advance' : 'arrears';

  const rentAmountInput = el('input', {
    id: 'rent-amount',
    class: 'field tabular',
    inputmode: 'decimal',
    value: existingRent?.amount_paise ? paiseToInput(existingRent.amount_paise) : '',
    placeholder: '5000',
    'aria-label': t('rent.amount'),
  });
  const rentStartInput = el('input', {
    id: 'rent-start',
    class: 'field',
    type: 'date',
    value: existingRent?.start_date || toDateInputValue(new Date().toISOString()),
    'aria-label': t('rent.startDate'),
  });
  const modeGroup = el('div', {
    class: 'inline-flex rounded-xl border bordered surface p-0.5',
    role: 'radiogroup',
    'aria-label': t('rent.mode'),
  });
  function paintMode() {
    clear(modeGroup);
    for (const option of [
      { id: 'arrears', label: t('rent.arrears') },
      { id: 'advance', label: t('rent.advance') },
    ]) {
      const selected = option.id === rentMode;
      modeGroup.append(
        el(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(selected),
            class: `rounded-[0.6rem] px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              selected ? 'accent-bg text-white' : 'text-sub hover:text-body'
            }`,
            onclick: () => {
              rentMode = option.id;
              paintMode();
            },
          },
          option.label,
        ),
      );
    }
  }
  paintMode();

  const rentDepositInput = el('input', {
    id: 'rent-deposit',
    class: 'field tabular',
    inputmode: 'decimal',
    value: existingRent?.deposit_paise ? paiseToInput(existingRent.deposit_paise) : '',
    placeholder: t('rent.optional'),
    'aria-label': t('rent.deposit'),
  });
  const rentElectricityInput = el('input', {
    id: 'rent-electricity',
    class: 'field tabular',
    inputmode: 'decimal',
    value: existingRent?.electricity_paise ? paiseToInput(existingRent.electricity_paise) : '',
    placeholder: t('rent.optional'),
    'aria-label': t('rent.electricity'),
  });
  const rentNoticeInput = el('input', {
    id: 'rent-notice',
    class: 'field tabular',
    inputmode: 'numeric',
    value: existingRent?.notice_days ? String(existingRent.notice_days) : '',
    placeholder: '0',
    'aria-label': t('rent.notice'),
  });

  const rentFields = el(
    'div',
    { class: 'mt-3 space-y-3', id: 'rent-fields' },
    el('div', {}, el('label', { class: 'label', for: 'rent-amount', text: t('rent.amount') }), rentAmountInput),
    el('div', {}, el('label', { class: 'label', for: 'rent-start', text: t('rent.startDate') }), rentStartInput),
    el(
      'div',
      { class: 'grid grid-cols-2 gap-2' },
      el('div', {}, el('label', { class: 'label', for: 'rent-deposit', text: t('rent.deposit') }), rentDepositInput),
      el(
        'div',
        {},
        el('label', { class: 'label', for: 'rent-electricity', text: t('rent.electricity') }),
        rentElectricityInput,
      ),
    ),
    el('div', {}, el('label', { class: 'label', for: 'rent-notice', text: t('rent.notice') }), rentNoticeInput),
    el(
      'div',
      {},
      el('p', { class: 'label', text: t('rent.mode') }),
      modeGroup,
      el('p', { class: 'mt-1 text-[0.7rem] leading-snug text-sub', text: t('rent.modeHint') }),
    ),
  );

  const rentSwitch = el(
    'button',
    {
      type: 'button',
      role: 'switch',
      id: 'rent-toggle',
      'aria-checked': String(rentOn),
      'aria-label': t('rent.toggle'),
      class: `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        rentOn ? 'accent-bg' : 'bg-ink-300'
      }`,
      onclick: () => {
        rentOn = !rentOn;
        rentSwitch.setAttribute('aria-checked', String(rentOn));
        rentSwitch.className = `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
          rentOn ? 'accent-bg' : 'bg-ink-300'
        }`;
        rentSwitch.firstElementChild.style.transform = rentOn ? 'translateX(1.25rem)' : 'translateX(0.125rem)';
        rentFields.classList.toggle('hidden', !rentOn);
      },
    },
    (() => {
      const knob = el('span', {
        class: 'pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform',
      });
      knob.style.transform = rentOn ? 'translateX(1.25rem)' : 'translateX(0.125rem)';
      return knob;
    })(),
  );
  rentFields.classList.toggle('hidden', !rentOn);

  const rentBlock = el(
    'div',
    { class: 'rounded-xl border bordered p-3' },
    el(
      'div',
      { class: 'flex items-start justify-between gap-3' },
      el(
        'div',
        { class: 'min-w-0' },
        el('p', { class: 'text-sm font-semibold text-body', text: t('rent.toggle') }),
        el('p', { class: 'mt-0.5 text-[0.7rem] leading-snug text-sub', text: t('rent.toggleHint') }),
      ),
      rentSwitch,
    ),
    rentFields,
  );

  const sheet = openSheet({
    title: isEdit ? t('customer.editTitle') : t('customer.addTitle'),
    content: [
      el('div', {}, el('label', { class: 'label', for: 'customer-name', text: t('customer.name') }), nameInput),
      el(
        'div',
        {},
        el('label', { class: 'label', for: 'customer-phone', text: `${t('customer.phone')} (${t('common.optional')})` }),
        phoneInput,
      ),
      rentBlock,
      errorBox,
    ],
    footer: [
      el('button', { type: 'button', class: 'btn-ghost flex-1', onclick: () => sheet.close() }, t('common.cancel')),
      el(
        'button',
        {
          type: 'button',
          class: 'btn-primary flex-1',
          id: 'customer-save',
          onclick: async () => {
            errorBox.textContent = '';
            rentAmountInput.classList.remove('field-invalid');
            rentStartInput.classList.remove('field-invalid');

            const parsedRent = parseAmountToPaise(rentAmountInput.value);
            let rent = null;
            if (rentOn || existingRent) {
              const deposit = parseAmountToPaise(rentDepositInput.value);
              const electricity = parseAmountToPaise(rentElectricityInput.value);
              rent = {
                active: rentOn,
                amount_paise: parsedRent.ok ? parsedRent.paise : 0,
                start_date: rentStartInput.value,
                mode: rentMode,
                deposit_paise: deposit.ok ? deposit.paise : 0,
                electricity_paise: electricity.ok ? electricity.paise : 0,
                notice_days: Math.max(0, Math.min(365, Math.round(Number(rentNoticeInput.value) || 0))),
                end_date: existingRent?.end_date || null,
                ended_at: existingRent?.ended_at || null,
                skipped: existingRent?.skipped || [],
              };
            }

            const result = validateCustomer(
              {
                id: customer?.id || newId(),
                name: nameInput.value,
                phone_number: phoneInput.value,
                created_at: customer?.created_at || new Date().toISOString(),
                rent,
              },
              { now: Date.now() },
            );
            if (!result.ok) {
              const first = result.errors[0];
              errorBox.textContent = errorText(first);
              if (first === 'NAME_INVALID') nameInput.classList.add('field-invalid');
              else if (first === 'PHONE_INVALID') phoneInput.classList.add('field-invalid');
              else if (first === 'RENT_AMOUNT_INVALID') rentAmountInput.classList.add('field-invalid');
              else if (first === 'RENT_START_INVALID') rentStartInput.classList.add('field-invalid');
              return;
            }
            nameInput.classList.remove('field-invalid');
            phoneInput.classList.remove('field-invalid');
            try {
              await db.putCustomer({ ...result.value, synced: false });
            } catch (error) {
              logger.error('customer', 'Save failed', { message: error?.message });
              errorBox.textContent = t('errors.storage');
              return;
            }
            logger.info('customer', isEdit ? 'Customer updated' : 'Customer created', { customerId: result.value.id });
            await reloadData();
            sheet.close();
            toast(t('toast.saved'), { tone: 'success' });
            if (rent?.active) await runRentAccrual({ force: true });
            render();
            engine?.syncNow('customer');
          },
        },
        t('customer.save'),
      ),
    ],
  });
}

function openTransactionSheet({ customer, type = TYPES.GIVEN, transaction = null, amountPaise = null, note = '' }) {
  let currentType = transaction ? transaction.type : type;

  const amountInput = el('input', {
    id: 'tx-amount',
    class: 'field text-center text-2xl font-bold tabular',
    inputmode: 'decimal',
    type: 'text',
    placeholder: '0',
    value: transaction ? paiseToInput(transaction.amount_paise) : amountPaise ? paiseToInput(amountPaise) : '',
    autocomplete: 'off',
    'data-autofocus': '',
  });
  const noteInput = el('input', {
    id: 'tx-note',
    class: 'field',
    value: transaction?.note || note || '',
    placeholder: t('tx.notePlaceholder'),
    maxlength: LIMITS.NOTE_MAX,
  });
  const dateInput = el('input', {
    id: 'tx-date',
    class: 'field',
    type: 'date',
    value: toDateInputValue(transaction?.occurred_at || new Date().toISOString()),
    max: toDateInputValue(new Date().toISOString()),
  });
  const errorBox = el('p', { class: 'min-h-[1rem] text-xs font-medium text-due-600', role: 'alert' });

  const typeToggle = el('div', { class: 'grid grid-cols-2 gap-2' });
  function paintToggle() {
    clear(typeToggle);
    for (const option of [
      { id: TYPES.GIVEN, label: t('ledger.gave'), classes: 'bg-due-600 text-white' },
      { id: TYPES.GOT, label: t('ledger.got'), classes: 'bg-paid-600 text-white' },
    ]) {
      const selected = option.id === currentType;
      typeToggle.append(
        el(
          'button',
          {
            type: 'button',
            class: `btn ${selected ? option.classes : 'btn-ghost'}`,
            'aria-pressed': String(selected),
            onclick: () => {
              currentType = option.id;
              paintToggle();
              titleNode.textContent = currentType === TYPES.GIVEN ? t('tx.gaveTitle') : t('tx.gotTitle');
            },
          },
          option.label,
        ),
      );
    }
  }
  paintToggle();

  if (transaction?.id) {
    db.attachmentsForTransaction(transaction.id)
      .then((rows) => {
        stored = rows;
        renderAttachments();
      })
      .catch(() => {});
  }

  const titleNode = el('span', {
    class: 'sr-only',
    text: currentType === TYPES.GIVEN ? t('tx.gaveTitle') : t('tx.gotTitle'),
  });

  /* --- attachments --- */
  const picked = []; // prepared files waiting to be stored with the entry
  let stored = []; // already-saved files on this entry (edit mode)

  const attachmentList = el('div', { class: 'mt-2 space-y-1.5', id: 'attachment-list' });
  const attachInput = el('input', {
    type: 'file',
    multiple: true,
    accept: ACCEPT_ATTRIBUTE,
    class: 'hidden',
    id: 'attachment-input',
  });

  function renderAttachments() {
    clear(attachmentList);
    const total = stored.length + picked.length;

    for (const meta of stored) {
      attachmentList.append(
        el(
          'div',
          { class: 'flex items-center gap-2 rounded-lg border bordered px-2.5 py-2' },
          el('span', { class: 'text-sub' }, icon('pdf', 'h-4 w-4')),
          el(
            'div',
            { class: 'min-w-0 flex-1' },
            el('p', { class: 'truncate text-xs font-semibold text-body', text: meta.name }),
            el('p', { class: 'text-[0.65rem] text-sub', text: `${meta.kind} · ${formatBytes(meta.size)}` }),
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'btn-ghost px-2 py-1 text-[0.65rem]',
              onclick: () => openAttachment(meta.id),
            },
            t('attach.open'),
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'icon-btn h-7 w-7 text-due-600',
              'aria-label': t('attach.remove'),
              onclick: async () => {
                await db.deleteAttachment(meta.id);
                stored = stored.filter((row) => row.id !== meta.id);
                await refreshAttachmentCount(transaction?.id);
                renderAttachments();
                toast(t('attach.removed'));
              },
            },
            icon('trash', 'h-3.5 w-3.5'),
          ),
        ),
      );
    }

    picked.forEach((entry, index) => {
      attachmentList.append(
        el(
          'div',
          { class: 'flex items-center gap-2 rounded-lg border bordered px-2.5 py-2' },
          entry.preview
            ? el('img', {
                src: entry.preview,
                alt: '',
                class: 'h-9 w-9 rounded object-cover',
              })
            : el('span', { class: 'text-sub' }, icon('pdf', 'h-4 w-4')),
          el(
            'div',
            { class: 'min-w-0 flex-1' },
            el('p', { class: 'truncate text-xs font-semibold text-body', text: entry.file.name }),
            el('p', {
              class: 'text-[0.65rem] text-sub',
              text: `${entry.file.kind} · ${formatBytes(entry.file.size)} · ${t('attach.pending')}`,
            }),
          ),
          el(
            'button',
            {
              type: 'button',
              class: 'icon-btn h-7 w-7 text-due-600',
              'aria-label': t('attach.remove'),
              onclick: () => {
                if (entry.preview) URL.revokeObjectURL(entry.preview);
                picked.splice(index, 1);
                renderAttachments();
              },
            },
            icon('close', 'h-3.5 w-3.5'),
          ),
        ),
      );
    });

    attachButton.querySelector('span').textContent =
      total >= ATTACHMENT_LIMITS.MAX_PER_ENTRY
        ? t('attach.limit', { max: ATTACHMENT_LIMITS.MAX_PER_ENTRY })
        : t('attach.add');
    attachButton.disabled = total >= ATTACHMENT_LIMITS.MAX_PER_ENTRY;
  }

  attachInput.addEventListener('change', async () => {
    const files = [...(attachInput.files || [])];
    attachInput.value = '';
    for (const file of files) {
      if (stored.length + picked.length >= ATTACHMENT_LIMITS.MAX_PER_ENTRY) {
        toast(t('attach.limit', { max: ATTACHMENT_LIMITS.MAX_PER_ENTRY }), { tone: 'error' });
        break;
      }
      const prepared = await prepareAttachment(file);
      if (!prepared.ok) {
        toast(errorText(prepared.code), { tone: 'error' });
        continue;
      }
      picked.push({
        file: prepared.file,
        preview: prepared.file.image ? URL.createObjectURL(prepared.file.blob) : null,
      });
    }
    renderAttachments();
  });

  const attachButton = el(
    'button',
    {
      type: 'button',
      class: 'btn-ghost w-full justify-start text-xs',
      id: 'attachment-add',
      onclick: () => attachInput.click(),
    },
    icon('pdf', 'h-4 w-4'),
    el('span', { text: t('attach.add') }),
  );

  const attachmentBlock = el(
    'div',
    { class: 'rounded-xl border bordered p-3' },
    el(
      'div',
      { class: 'flex items-center justify-between gap-2' },
      el('p', { class: 'text-sm font-semibold text-body', text: t('attach.title') }),
      el('span', { class: 'text-[0.65rem] text-sub', text: t('attach.hint') }),
    ),
    attachmentList,
    attachInput,
    el('div', { class: 'mt-2' }, attachButton),
  );
  renderAttachments();

  const sheet = openSheet({
    title: customer.name,
    subtitle: transaction ? formatDateTime(transaction.occurred_at) : undefined,
    content: [
      typeToggle,
      titleNode,
      el(
        'div',
        {},
        el('label', { class: 'label', for: 'tx-amount', text: t('tx.amount') }),
        el(
          'div',
          { class: 'relative' },
          el('span', {
            class: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xl font-bold text-sub',
            text: '₹',
          }),
          amountInput,
        ),
      ),
      el('div', {}, el('label', { class: 'label', for: 'tx-note', text: t('tx.note') }), noteInput),
      el('div', {}, el('label', { class: 'label', for: 'tx-date', text: t('tx.date') }), dateInput),
      attachmentBlock,
      errorBox,
      transaction
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn w-full text-due-600',
              id: 'tx-delete',
              onclick: async () => {
                if (state.settings.confirmDelete) {
                  const ok = await confirmDialog({
                    title: t('tx.deleteEntry'),
                    message: `${money(transaction.amount_paise)} · ${formatDate(transaction.occurred_at)}`,
                    confirmLabel: t('common.delete'),
                    cancelLabel: t('common.cancel'),
                  });
                  if (!ok) return;
                }
                await db.deleteTransaction(transaction.id);
                if (transaction.source === 'rent' && transaction.rent_cycle && customer.rent) {
                  // Remember the month, or the next accrual pass would put the
                  // charge straight back.
                  const skipped = new Set(Array.isArray(customer.rent.skipped) ? customer.rent.skipped : []);
                  skipped.add(transaction.rent_cycle);
                  await db.putCustomer({
                    ...customer,
                    rent: { ...customer.rent, skipped: [...skipped] },
                    synced: false,
                  });
                  logger.info('rent', 'Rent charge suppressed', {
                    customerId: customer.id,
                    cycle: transaction.rent_cycle,
                  });
                }
                logger.info('transaction', 'Entry deleted', { transactionId: transaction.id });
                await reloadData();
                sheet.close();
                toast(t('toast.deleted'));
                render();
                engine?.syncNow('delete');
              },
            },
            icon('trash', 'h-4 w-4'),
            t('tx.deleteEntry'),
          )
        : null,
    ],
    footer: [
      el('button', { type: 'button', class: 'btn-ghost flex-1', onclick: () => sheet.close() }, t('common.cancel')),
      el(
        'button',
        {
          type: 'button',
          class: 'btn-primary flex-1',
          id: 'tx-save',
          onclick: async () => {
            errorBox.textContent = '';
            amountInput.classList.remove('field-invalid');
            dateInput.classList.remove('field-invalid');

            const parsed = parseAmountToPaise(amountInput.value);
            if (!parsed.ok) {
              amountInput.classList.add('field-invalid');
              errorBox.textContent = errorText(parsed.code);
              amountInput.focus();
              return;
            }

            const now = Date.now();
            const occurredAt = dateInput.value
              ? new Date(`${dateInput.value}T12:00:00`).toISOString()
              : new Date(now).toISOString();

            const result = validateTransaction(
              {
                id: transaction?.id || newId(),
                customer_id: customer.id,
                type: currentType,
                amount_paise: parsed.paise,
                note: noteInput.value,
                occurred_at: occurredAt,
                created_at: transaction?.created_at || new Date().toISOString(),
              },
              { now },
            );
            if (!result.ok) {
              const first = result.errors[0];
              if (first === 'DATE_INVALID') dateInput.classList.add('field-invalid');
              if (first === 'NOTE_TOO_LONG') noteInput.classList.add('field-invalid');
              errorBox.textContent = errorText(first);
              return;
            }

            try {
              for (const entry of picked) {
                await db.putAttachment({
                  id: newId(),
                  transaction_id: result.value.id,
                  customer_id: customer.id,
                  name: entry.file.name,
                  mime: entry.file.mime,
                  kind: entry.file.kind,
                  size: entry.file.size,
                  blob: entry.file.blob,
                });
              }
              const attachmentCount = stored.length + picked.length;
              for (const entry of picked) if (entry.preview) URL.revokeObjectURL(entry.preview);
              picked.length = 0;
              await db.putTransaction({ ...result.value, synced: false, attachment_count: attachmentCount });
            } catch (error) {
              logger.error('transaction', 'Save failed', { message: error?.message });
              errorBox.textContent = t('errors.storage');
              return;
            }

            const saved = await db.getTransaction(result.value.id);
            await maybeSendEntrySms(customer, saved);

            await settings.update('lastChangeAt', new Date().toISOString());
            state.settings = settings.current();
            logger.info('transaction', 'Entry saved', {
              transactionId: result.value.id,
              type: result.value.type,
              amount_paise: result.value.amount_paise,
              online: navigator.onLine,
            });
            await reloadData();
            sheet.close();
            toast(navigator.onLine ? t('toast.entrySaved') : t('errors.offline'), {
              tone: navigator.onLine ? 'success' : 'default',
            });
            render();
            engine?.syncNow('entry');
          },
        },
        transaction ? t('common.save') : t('tx.save'),
      ),
    ],
  });
}

/* -------------------------------------------------------------------- rent */

let lastRentPass = 0;

/**
 * Adds any rent months that have come due, then re-reads the ledger if something
 * changed. Runs at boot, when the app comes back to the foreground, and after a
 * tenancy is edited - never on a timer, because a shopkeeper's phone sleeps.
 */
async function runRentAccrual({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRentPass < 60 * 60 * 1000) return 0;
  lastRentPass = now;
  try {
    const result = await accrueRent({ db, now: new Date(now), logger });
    if (result.created > 0) {
      await reloadData();
      logger.info('rent', 'Rent accrual applied', result);
      if (state.route.name === 'dashboard') render();
      else render();
    }
    return result.created;
  } catch (error) {
    logger.error('rent', 'Rent accrual failed', { message: error?.message, stack: error?.stack });
    return 0;
  }
}

/* --------------------------------------------------------------------- sms */

/**
 * Texts the customer from the phone's own SIM. Called after an entry is written,
 * so it works offline; the result is stored on the entry either way.
 */
async function maybeSendEntrySms(customer, transaction) {
  const decision = shouldSendEntrySms({
    customer,
    transaction,
    settings: state.settings,
    bridge: hasDeviceSms() ? globalThis.KhataAndroid : null,
  });
  if (!decision.send) {
    if (decision.reason !== 'no_device_sms' && decision.reason !== 'disabled') {
      logger.debug('sms', 'SMS skipped', { reason: decision.reason, transactionId: transaction?.id });
    }
    return null;
  }

  const transactions = await db.transactionsForCustomer(customer.id);
  const result = await sendEntrySms({ transaction, customer, transactions });
  const updated = {
    ...transaction,
    sms_status: result.status,
    sms_at: new Date().toISOString(),
    sms_error: result.detail || null,
  };
  try {
    await db.putTransaction(updated);
  } catch (error) {
    logger.warn('sms', 'Could not store the SMS result', { message: error?.message });
  }

  const tone = SMS_TONE[result.status] || 'warn';
  const message =
    result.status === 'sent'
      ? t('toast.smsSent', { name: customer.name })
      : result.status === 'daily_cap'
        ? t('toast.smsCap')
        : result.status === 'permission_required'
          ? t('toast.smsPermission')
          : t('toast.smsFailed');
  toast(message, { tone: tone === 'ok' ? 'success' : tone === 'bad' ? 'error' : 'default' });
  render();
  return result;
}

function rentChip(transaction) {
  if (transaction.source !== 'rent') return null;
  return el('span', {
    class: 'chip mt-1 accent-soft text-[0.6rem] font-semibold accent-text',
    title: transaction.rent_cycle ? `Rent ${transaction.rent_cycle}` : 'Rent',
    text: t('rent.badge'),
  });
}

function smsChip(transaction) {
  if (!transaction.sms_status) return null;
  const status = transaction.sms_status;
  // 'skipped' is a deliberate choice (auto rent charges), not a failure.
  if (status === 'skipped') return null;
  if (status === 'sent') {
    return el('span', {
      class: 'chip mt-1 bg-paid-100 text-[0.6rem] font-semibold text-paid-700',
      title: t('ledger.smsSent'),
      text: 'SMS',
    });
  }
  if (status === 'queued') {
    return el('span', { class: 'chip mt-1 surface-muted text-[0.6rem] text-sub', text: 'SMS…' });
  }
  return el('span', {
    class: 'chip mt-1 bg-due-100 text-[0.6rem] font-semibold text-due-700',
    title: transaction.sms_error || status,
    text: t('ledger.smsFailed'),
  });
}

/* ------------------------------------------------------- tenancy actions */

/** Deposit received / refunded. Money held, kept out of the rent balance story. */
function openDepositSheet(customer, rent) {
  const amountInput = el('input', {
    id: 'deposit-amount',
    class: 'field tabular',
    inputmode: 'decimal',
    value: paiseToInput(rent.deposit.held || rent.deposit.agreed || 0),
    'aria-label': t('rent.depositAmount'),
    'data-autofocus': '',
  });
  const errorBox = el('p', { class: 'min-h-[1rem] text-xs font-medium text-due-600', role: 'alert' });

  const sheet = openSheet({
    title: t('rent.deposit'),
    subtitle: t('rent.depositHeld', {
      held: money(rent.deposit.held),
      agreed: money(rent.deposit.agreed),
    }),
    content: [
      el('div', {}, el('label', { class: 'label', for: 'deposit-amount', text: t('rent.depositAmount') }), amountInput),
      errorBox,
    ],
    footer: [
      el(
        'button',
        {
          type: 'button',
          class: 'btn-ghost flex-1',
          id: 'deposit-refund',
          onclick: () => save('GIVEN'),
        },
        t('rent.depositRefund'),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'btn bg-paid-600 flex-1 text-white hover:bg-paid-700',
          id: 'deposit-received',
          onclick: () => save('GOT'),
        },
        t('rent.depositReceived'),
      ),
    ],
  });

  async function save(type) {
    errorBox.textContent = '';
    const parsed = parseAmountToPaise(amountInput.value);
    if (!parsed.ok) {
      amountInput.classList.add('field-invalid');
      errorBox.textContent = errorText(parsed.code);
      return;
    }
    const now = new Date().toISOString();
    await db.putTransaction({
      id: newId(),
      customer_id: customer.id,
      type,
      amount_paise: parsed.paise,
      note: type === 'GOT' ? t('rent.depositReceivedNote') : t('rent.depositRefundNote'),
      occurred_at: now,
      created_at: now,
      synced: false,
      source: 'deposit',
    });
    await reloadData();
    sheet.close();
    toast(t('toast.saved'), { tone: 'success' });
    render();
    engine?.syncNow('deposit');
  }
}

/** Attaches a rent agreement (or any document) to the tenancy itself. */
function addAgreement(customer) {
  const input = el('input', { type: 'file', accept: ACCEPT_ATTRIBUTE, class: 'hidden' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const prepared = await prepareAttachment(file);
    if (!prepared.ok) {
      toast(errorText(prepared.code), { tone: 'error' });
      return;
    }
    await db.putAttachment({
      id: newId(),
      transaction_id: null,
      customer_id: customer.id,
      name: prepared.file.name,
      mime: prepared.file.mime,
      kind: prepared.file.kind,
      size: prepared.file.size,
      blob: prepared.file.blob,
    });
    await refreshAgreements();
    toast(t('rent.agreementAdded', { name: prepared.file.name }), { tone: 'success' });
    render();
  });
  input.click();
}

async function refreshAgreements() {
  const customers = state.customers.filter((row) => row.rent);
  const map = new Map();
  for (const customer of customers) {
    const rows = await db.attachmentsForCustomer(customer.id);
    if (rows.length) map.set(customer.id, rows[rows.length - 1]);
  }
  state.agreements = map;
  return map;
}

/**
 * Ends a tenancy. The notice period decides when it really ends, and the final
 * month is charged only for the days lived.
 */
function endTenancy(customer, rent) {
  const noticeInput = el('input', {
    id: 'end-notice-date',
    class: 'field',
    type: 'date',
    value: toDateInputValue(new Date().toISOString()),
    'aria-label': t('rent.noticeGiven'),
  });
  const noticeDays = Number(rent.notice_days) || 0;
  const preview = el('p', { class: 'mt-2 text-xs text-sub', id: 'end-preview' });

  function paint() {
    const endDate = noticeEndDate({ noticeDate: noticeInput.value, noticeDays });
    preview.textContent = endDate
      ? t('rent.endPreview', { date: formatDate(endDate), days: noticeDays })
      : t('errors.RENT_START_INVALID');
  }
  noticeInput.addEventListener('change', paint);
  paint();

  const sheet = openSheet({
    title: t('rent.endTenancy'),
    subtitle: t('rent.endHint'),
    content: [
      el('div', {}, el('label', { class: 'label', for: 'end-notice-date', text: t('rent.noticeGiven') }), noticeInput),
      preview,
    ],
    footer: [
      el('button', { type: 'button', class: 'btn-ghost flex-1', onclick: () => sheet.close() }, t('common.cancel')),
      el(
        'button',
        {
          type: 'button',
          class: 'btn bg-due-600 flex-1 text-white hover:bg-due-700',
          id: 'end-confirm',
          onclick: async () => {
            const endDate = noticeEndDate({ noticeDate: noticeInput.value, noticeDays });
            if (!endDate) return;
            await db.putCustomer({
              ...customer,
              rent: { ...customer.rent, end_date: endDate, ended_at: new Date().toISOString() },
              synced: false,
            });
            // Ending mid-month has to pro-rate the final charge, so re-run the pass.
            await runRentAccrual({ force: true });
            await reloadData();
            sheet.close();
            toast(t('rent.endedToast', { date: formatDate(endDate) }), { tone: 'success' });
            render();
            engine?.syncNow('tenancy');
          },
        },
        t('rent.endConfirm'),
      ),
    ],
  });
}

/* -------------------------------------------------------------- attachments */

/** Opens a stored file: in a tab in the browser, or in Downloads in the app. */
async function openAttachment(id) {
  const row = await db.getAttachment(id);
  if (!row?.blob) {
    toast(t('attach.missing'), { tone: 'error' });
    return;
  }
  const bridge = globalThis.KhataAndroid;
  if (bridge && typeof bridge.saveFile === 'function') {
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    bridge.saveFile(row.name, row.mime || 'application/octet-stream', btoa(binary));
    toast(t('attach.savedToDownloads', { name: row.name }));
    return;
  }
  const url = URL.createObjectURL(row.blob);
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) {
    downloadBlob(row.blob, row.name);
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function refreshAttachmentCount(transactionId) {
  if (!transactionId) return;
  const row = await db.getTransaction(transactionId);
  if (!row) return;
  const rows = await db.attachmentsForTransaction(transactionId);
  await db.putTransaction({ ...row, attachment_count: rows.length });
  await reloadData();
  render();
}

/** A paperclip chip on a timeline row that carries files. */
function attachmentChip(transaction) {
  if (!transaction.attachment_count) return null;
  return el('span', {
    class: 'chip mt-1 surface-muted text-[0.6rem] font-semibold text-sub',
    title: t('attach.count', { count: transaction.attachment_count }),
    text: `📎 ${transaction.attachment_count}`,
  });
}

/* ------------------------------------------------------------------ update */

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function checkForUpdates({ announce = false } = {}) {
  // Inside the Android shell the update is an APK, and only the shell can install it.
  if (globalThis.KhataAndroid && typeof globalThis.KhataAndroid.checkAppUpdate === 'function') {
    globalThis.KhataAndroid.checkAppUpdate();
    if (announce) toast(t('settings.checking'));
    return;
  }
  state.update.checking = true;
  state.update.message = '';
  if (announce) render();
  try {
    const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`version.json ${response.status}`);
    const remote = await response.json();
    const newer = compareVersions(remote.version, APP_VERSION) > 0;
    state.update.available = newer ? remote.version : null;
    state.update.message = newer
      ? t('settings.updateAvailable', { version: remote.version })
      : t('settings.upToDate');
    logger.info('update', 'Update check finished', { remote: remote.version, current: APP_VERSION, newer });
  } catch (error) {
    state.update.available = null;
    state.update.message = t('settings.checkFailed');
    logger.warn('update', 'Update check failed', { message: error?.message });
  } finally {
    state.update.checking = false;
    if (state.route.name === 'settings') render();
    if (!announce) return;
  }
}

async function applyUpdate() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
    registration?.waiting?.postMessage({ type: 'khata:skip-waiting' });
    if (registration?.installing) {
      registration.installing.postMessage({ type: 'khata:skip-waiting' });
    }
  } catch (error) {
    logger.warn('update', 'Service worker update failed', { message: error?.message });
  }
  toast(t('settings.updateReady'), { tone: 'success' });
  setTimeout(() => location.reload(), 600);
}

/* -------------------------------------------------------------- navigation */

function renderNav() {
  const nav = clear(navEl());
  const items = [
    { key: 'dashboard', label: t('nav.dashboard'), iconName: 'home', href: '#/' },
    { key: 'add', label: t('dashboard.addCustomer'), iconName: 'plus', action: () => openCustomerSheet() },
    { key: 'settings', label: t('nav.settings'), iconName: 'settings', href: '#/settings' },
  ];
  for (const item of items) {
    if (item.key === 'add') {
      nav.append(
        el(
          'button',
          {
            type: 'button',
            class: 'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5',
            'aria-label': item.label,
            onclick: item.action,
          },
          el(
            'span',
            { class: 'flex h-10 w-10 items-center justify-center rounded-full accent-bg text-white shadow-card' },
            icon('plus', 'h-5 w-5'),
          ),
        ),
      );
      continue;
    }
    const active =
      (item.key === 'dashboard' && state.route.name === 'dashboard') ||
      (item.key === 'settings' && state.route.name === 'settings');
    nav.append(
      el(
        'a',
        {
          class: 'nav-item',
          href: item.href,
          'aria-current': active ? 'page' : 'false',
        },
        icon(item.iconName, 'h-5 w-5'),
        el('span', { text: item.label }),
      ),
    );
  }
}

/* ------------------------------------------------------------------ render */

function render() {
  state.route = parseRoute();
  renderHeader();
  const main = clear(mainEl());

  if (state.loading) {
    main.append(
      el(
        'div',
        { class: 'space-y-3', 'aria-busy': 'true' },
        el('div', { class: 'skeleton h-24' }),
        el('div', { class: 'skeleton h-12' }),
        el('div', { class: 'skeleton h-12' }),
        el('div', { class: 'skeleton h-12' }),
      ),
    );
    return;
  }

  if (state.route.name === 'customer') renderCustomer(main);
  else if (state.route.name === 'settings') {
    main.append(el('div', { class: 'space-y-3', 'aria-busy': 'true' }, el('div', { class: 'skeleton h-20' })));
    renderSettings(main).catch((error) => {
      logger.error('ui', 'Settings render failed', { message: error?.message });
      clear(main);
      main.append(el('p', { class: 'card p-4 text-sm text-due-600', text: t('errors.generic') }));
    });
  } else {
    renderDashboard(main);
  }

  renderNav();
}

function onRouteChange() {
  const previous = state.route;
  state.route = parseRoute();
  render();
  if (previous.name !== state.route.name || previous.customerId !== state.route.customerId) {
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => document.querySelector('[data-heading="1"]')?.focus?.());
  }
  if (state.route.openNewCustomer) {
    history.replaceState(null, '', '#/');
    state.route = { name: 'dashboard', customerId: null };
    openCustomerSheet();
  }
}

/* -------------------------------------------------------------------- boot */

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    logger.warn('sw', 'Service workers unsupported in this browser');
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', type: 'module' });
    registration.addEventListener('updatefound', () => {
      logger.info('sw', 'New service worker found');
    });
    return registration;
  } catch (error) {
    logger.error('sw', 'Service worker registration failed', { message: error?.message });
    return null;
  }
}

async function boot() {
  if (booted) return;
  booted = true;
  installGlobalHandlers();

  try {
    // Before any entry can be saved, so the shell's radio verdict always has a
    // handler waiting for it.
    installSmsResultHandler();
    state.settings = await settings.loadSettings();
    setLanguage(state.settings.language);
    setLogging(state.settings.logging);

    await db.openDb();
    await runRentAccrual({ force: true });
    // After the ledger settles, take the scheduled backup if one is due.
    await runScheduledBackupIfDue().catch(() => {});
    logger.info('app', 'Boot', { version: APP_VERSION, language: state.settings.language });
    await reloadData();
  } catch (error) {
    logger.error('app', 'Boot failed', { message: error?.message, stack: error?.stack });
    state.loading = false;
    const main = clear(mainEl());
    main.append(
      el(
        'div',
        { class: 'card p-6 text-center' },
        el('p', { class: 'text-sm font-semibold text-body', text: t('errors.storage') }),
        el('p', { class: 'mt-1 text-xs text-sub', text: String(error?.message || '') }),
        el('button', { type: 'button', class: 'btn-primary mt-4', onclick: () => location.reload() }, t('common.retry')),
      ),
    );
    return;
  }

  render();

  // Automation/diagnostics handle: published as soon as the first screen exists so
  // support sessions and the e2e suite never race the service-worker registration.
  globalThis.Khata = {
    version: APP_VERSION,
    db,
    settings,
    state,
    get engine() {
      return engine;
    },
    api: {
      reloadData,
      render,
      openCustomerSheet,
      openTransactionSheet,
      syncNow: (reason) => engine?.syncNow(reason),
      statementBlob: (customer, transactions) =>
        statementBlob(customer, transactions, { shopName: settings.get('shopName') }),
      checkForUpdates,
      exportLogs,
      buildLogFile,
    },
  };

  engine = createSyncEngine({
    onChange: (next) => {
      state.sync = { status: next.status, pending: next.pending };
      renderHeader();
    },
    onResult: ({ ok }) => {
      if (!ok) return;
      engine?.refreshPending();
    },
  });
  await engine.start();

  await registerServiceWorker();

  checkForUpdates({ announce: false });

  if (state.route.openNewCustomer) {
    history.replaceState(null, '', '#/');
    state.route = { name: 'dashboard', customerId: null };
    openCustomerSheet();
  }

}

// Attached before boot() awaits anything: navigation must work from the first
// painted frame, not only after settings, IndexedDB and the sync engine are ready.
window.addEventListener('hashchange', onRouteChange);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') runRentAccrual();
});
window.addEventListener('online', () => {
  state.sync.status = STATUS.ONLINE;
  renderHeader();
});
window.addEventListener('offline', () => {
  state.sync.status = STATUS.OFFLINE;
  renderHeader();
});

boot().catch((error) => {
  logger.error('app', 'Unhandled boot error', { message: error?.message });
  const main = clear(mainEl());
  main.append(el('p', { class: 'card p-4 text-sm text-due-600', text: String(error?.message || error) }));
});

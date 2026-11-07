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
        customer.phone_number
          ? el('span', { class: 'block truncate text-xs text-sub', text: formatPhoneDisplay(customer.phone_number) })
          : null,
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
      smsChip(tx),
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
  state.stats = await db.stats();
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
  main.append(
    sectionCard(
      t('settings.data'),
      [
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
        description: t('settings.stats', {
          customers: state.stats.customers,
          transactions: state.stats.transactions,
          logs: state.stats.logs,
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

async function exportBackup() {
  const backup = await db.exportAll();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadText(JSON.stringify(backup, null, 2), `khata-backup-${stamp}.json`, 'application/json');
  toast(t('toast.backupSaved'), { tone: 'success' });
  logger.info('data', 'Backup exported', { customers: backup.customers.length });
}

function importBackup() {
  const input = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const result = await db.importAll(parsed, { mode: 'merge' });
      await reloadData();
      toast(t('toast.restored', { customers: result.customers, transactions: result.transactions }), {
        tone: 'success',
      });
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
            const result = validateCustomer(
              {
                id: customer?.id || newId(),
                name: nameInput.value,
                phone_number: phoneInput.value,
                created_at: customer?.created_at || new Date().toISOString(),
              },
              { now: Date.now() },
            );
            if (!result.ok) {
              errorBox.textContent = errorText(result.errors[0]);
              (result.errors[0] === 'NAME_INVALID' ? nameInput : phoneInput).classList.add('field-invalid');
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
            render();
            engine?.syncNow('customer');
          },
        },
        t('customer.save'),
      ),
    ],
  });
}

function openTransactionSheet({ customer, type = TYPES.GIVEN, transaction = null }) {
  let currentType = transaction ? transaction.type : type;

  const amountInput = el('input', {
    id: 'tx-amount',
    class: 'field text-center text-2xl font-bold tabular',
    inputmode: 'decimal',
    type: 'text',
    placeholder: '0',
    value: transaction ? paiseToInput(transaction.amount_paise) : '',
    autocomplete: 'off',
    'data-autofocus': '',
  });
  const noteInput = el('input', {
    id: 'tx-note',
    class: 'field',
    value: transaction?.note || '',
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

  const titleNode = el('span', {
    class: 'sr-only',
    text: currentType === TYPES.GIVEN ? t('tx.gaveTitle') : t('tx.gotTitle'),
  });

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
              await db.putTransaction({ ...result.value, synced: false });
            } catch (error) {
              logger.error('transaction', 'Save failed', { message: error?.message });
              errorBox.textContent = t('errors.storage');
              return;
            }

            const saved = await db.getTransaction(result.value.id);
            await maybeSendEntrySms(customer, saved);

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

function smsChip(transaction) {
  if (!transaction.sms_status) return null;
  const status = transaction.sms_status;
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

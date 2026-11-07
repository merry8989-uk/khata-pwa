/**
 * DOM helpers: element builder, icons, toasts and accessible modal sheets.
 * User data always goes in through text nodes - never innerHTML.
 */

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = String(value);
    else if (key in node && key !== 'list' && key !== 'type' && typeof value !== 'string') {
      node[key] = value;
    } else if (key in node && key !== 'list') {
      node[key] = value;
    } else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  settings:
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7 1.7 1.7 0 0 0 4.26 5.13l-.06-.06A2 2 0 1 1 7.03 2.24l.06.06A1.7 1.7 0 0 0 9 2.6h.1A2 2 0 0 1 11 1a2 2 0 0 1 2 1.6V3a1.7 1.7 0 0 0 2.87 1.2l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.1a2 2 0 0 1 1.6 1.9 2 2 0 0 1-1.6 1.9Z',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  phone:
    'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z',
  whatsapp:
    'M20.5 11.6a8.4 8.4 0 0 1-12.3 7.5L3.5 20.5l1.4-4.6A8.4 8.4 0 1 1 20.5 11.6Z M8.4 8.1c.2-.4.4-.4.7-.4h.5c.2 0 .4 0 .6.5l.7 1.6c.1.2.1.4 0 .6l-.4.5c-.1.2-.2.3 0 .6a6 6 0 0 0 2.8 2.4c.3.1.5.1.6-.1l.5-.6c.2-.2.4-.2.6-.1l1.6.8c.2.1.4.2.4.3v.6a2 2 0 0 1-1.9 1.5 8 8 0 0 1-6.9-6.9 2 2 0 0 1 .2-1.3Z',
  pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M12 12v6m0 0-3-3m3 3 3-3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  back: 'M15 18l-6-6 6-6',
  close: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  cloud: 'M18 17H7a4 4 0 0 1-.7-7.9A6 6 0 0 1 18 10a3.5 3.5 0 0 1 0 7Z',
  'cloud-off': 'M3 3l18 18M18 17H7a4 4 0 0 1-.7-7.9M9.5 5.6A6 6 0 0 1 18 10a3.5 3.5 0 0 1 2 6.2',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  share: 'M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M4 21h16',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  users:
    'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  arrowUp: 'M12 19V5m0 0-7 7m7-7 7 7',
  arrowDown: 'M12 5v14m0 0 7-7m-7 7-7-7',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  expand: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5',
  mail: 'M4 4h16v16H4zM4 6l8 7 8-7',
  instagram:
    'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17.5 6.5h.01',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3ZM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
};

/** Trusted, static SVG markup only - never pass user data through this. */
export function icon(name, className = 'h-5 w-5') {
  const path = ICONS[name] || ICONS.alert;
  const wrapper = document.createElement('span');
  wrapper.className = 'inline-flex shrink-0';
  wrapper.innerHTML = `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
  return wrapper.firstElementChild;
}

/* ------------------------------------------------------------------- toasts */

let toastHost = null;

export function mountToastHost() {
  if (toastHost) return toastHost;
  toastHost = el('div', {
    id: 'toast-host',
    class: 'pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 no-print',
    role: 'status',
    'aria-live': 'polite',
    'aria-atomic': 'false',
  });
  document.body.append(toastHost);
  return toastHost;
}

export function toast(message, { tone = 'default', timeout = 2600 } = {}) {
  const host = mountToastHost();
  const toneClass =
    tone === 'error'
      ? 'bg-due-600 text-white'
      : tone === 'success'
        ? 'bg-paid-600 text-white'
        : 'bg-ink-900 text-white dark:bg-ink-100 dark:text-ink-900';
  const node = el('div', {
    class: `pointer-events-auto max-w-app rounded-full px-4 py-2 text-sm font-medium shadow-card animate-fade-in ${toneClass}`,
    text: message,
  });
  host.append(node);
  setTimeout(() => {
    node.classList.add('opacity-0');
    node.style.transition = 'opacity 200ms';
    setTimeout(() => node.remove(), 220);
  }, timeout);
  return node;
}

/* ------------------------------------------------------------------ dialogs */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

/**
 * Opens an accessible bottom-sheet dialog.
 * @returns {{close: Function, root: HTMLElement, body: HTMLElement}}
 */
export function openSheet({ title, subtitle, content, footer, labelledBy = 'sheet-title', onClose }) {
  const previouslyFocused = document.activeElement;
  const titleId = `${labelledBy}-${openCount}`;
  const body = el('div', { class: 'mt-3 space-y-3' }, content);
  const sheet = el(
    'div',
    {
      class: 'sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    el(
      'div',
      { class: 'mx-auto mb-2 h-1.5 w-10 rounded-full bg-ink-300 dark:bg-ink-700 sm:hidden' },
      '',
    ),
    el(
      'div',
      { class: 'flex items-start justify-between gap-3' },
      el(
        'div',
        {},
        el('h2', { id: titleId, class: 'text-lg font-bold text-body', text: title }),
        subtitle ? el('p', { class: 'mt-0.5 text-sm text-sub', text: subtitle }) : null,
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          'aria-label': 'Close',
          onclick: () => close(),
        },
        icon('close', 'h-4 w-4'),
      ),
    ),
    body,
    footer ? el('div', { class: 'mt-4 flex gap-2' }, footer) : null,
  );

  const scrim = el('div', {
    class: 'scrim',
    onclick: () => close(),
  });

  const root = el('div', { class: 'fixed inset-0 z-40 no-print' }, scrim, sheet);
  document.body.append(root);
  document.body.style.overflow = 'hidden';
  openCount += 1;

  function trapFocus(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...sheet.querySelectorAll(FOCUSABLE)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', trapFocus, true);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', trapFocus, true);
    root.remove();
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.style.overflow = '';
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    onClose?.();
  }

  requestAnimationFrame(() => {
    const target = sheet.querySelector('[data-autofocus]') || sheet.querySelector(FOCUSABLE);
    target?.focus();
  });

  return { close, root, body, sheet };
}

/** Promise-based confirm. Resolves false on Escape/scrim. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = true }) {
  return new Promise((resolve) => {
    let settled = false;
    const sheet = openSheet({
      title,
      content: el('p', { class: 'text-sm text-sub', text: message }),
      footer: [
        el(
          'button',
          {
            type: 'button',
            class: 'btn-ghost flex-1',
            onclick: () => {
              settled = true;
              sheet.close();
              resolve(false);
            },
          },
          cancelLabel,
        ),
        el(
          'button',
          {
            type: 'button',
            class: `btn flex-1 text-white ${danger ? 'bg-due-600 hover:bg-due-700' : 'accent-bg'}`,
            'data-autofocus': '',
            onclick: () => {
              settled = true;
              sheet.close();
              resolve(true);
            },
          },
          confirmLabel,
        ),
      ],
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
  });
}

/* ----------------------------------------------------------------- utilities */

export function debounce(fn, wait = 180) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/**
 * Blob downloads never reach the WebView's DownloadListener, so inside the
 * Android shell (window.KhataAndroid) the bytes are handed to MediaStore instead.
 * @returns {boolean} true when the native shell took the file
 */
function saveThroughAndroidShell(blob, filename) {
  const bridge = globalThis.KhataAndroid;
  if (!bridge || typeof bridge.saveFile !== 'function') return false;
  blob
    .arrayBuffer()
    .then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      bridge.saveFile(filename, blob.type || 'application/octet-stream', btoa(binary));
    })
    .catch(() => {
      /* the shell reports its own failure toast */
    });
  return true;
}

export function downloadBlob(blob, filename) {
  if (saveThroughAndroidShell(blob, filename)) return;
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename, class: 'hidden' });
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 1500);
}

export function downloadText(text, filename, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}

export function initials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

/** Deterministic avatar tint so the same customer keeps the same colour. */
export function avatarTone(seed) {
  const tones = [
    'bg-brand-100 text-brand-700',
    'bg-amber-100 text-amber-700',
    'bg-emerald-100 text-emerald-700',
    'bg-rose-100 text-rose-700',
    'bg-sky-100 text-sky-700',
    'bg-violet-100 text-violet-700',
  ];
  let hash = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 9973;
  return tones[hash % tones.length];
}

export function formatPhoneDisplay(e164) {
  if (!e164) return '';
  const digits = String(e164).replace(/\D/g, '');
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  return `+91 ${national.slice(0, 5)} ${national.slice(5)}`.trim();
}

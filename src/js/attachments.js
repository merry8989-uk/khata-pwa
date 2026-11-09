/**
 * Attachments: the proof that goes with an entry - a photo of the goods, a bill, an
 * order PDF, an Excel sheet. Stored as blobs in IndexedDB next to the ledger, so
 * they work offline and travel in the backup.
 *
 * They deliberately never go to the Worker: D1 is a ledger, not a file store, and
 * a 5 MB photo in a sync batch would be absurd. Attachments are device-only, and
 * the scheduled backup is what protects them.
 */

export const ATTACHMENT_LIMITS = Object.freeze({
  MAX_BYTES: 12 * 1024 * 1024,
  MAX_PER_ENTRY: 5,
  IMAGE_MAX_EDGE: 1600,
  IMAGE_QUALITY: 0.82,
});

/** What a shopkeeper is likely to attach, plus a catch-all for anything else. */
export const ATTACHMENT_TYPES = Object.freeze({
  'image/jpeg': { label: 'Photo', ext: 'jpg' },
  'image/png': { label: 'Photo', ext: 'png' },
  'image/webp': { label: 'Photo', ext: 'webp' },
  'image/heic': { label: 'Photo', ext: 'heic' },
  'application/pdf': { label: 'PDF', ext: 'pdf' },
  'application/vnd.ms-excel': { label: 'Excel', ext: 'xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'Excel', ext: 'xlsx' },
  'text/csv': { label: 'CSV', ext: 'csv' },
  'text/plain': { label: 'Text', ext: 'txt' },
});

export const ACCEPT_ATTRIBUTE = [
  'image/*',
  'application/pdf',
  '.xls',
  '.xlsx',
  '.csv',
  '.txt',
].join(',');

export function isImage(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function safeFileName(name) {
  const cleaned = String(name || 'file')
    .replace(/[^\w.\-\u0900-\u097F ]+/g, '_')
    .trim()
    .slice(0, 80);
  return cleaned || 'file';
}

function typeLabel(mime, name) {
  if (ATTACHMENT_TYPES[mime]) return ATTACHMENT_TYPES[mime].label;
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  if (ext && ['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) return 'Photo';
  if (ext === 'pdf') return 'PDF';
  if (ext && ['xls', 'xlsx'].includes(ext)) return 'Excel';
  return 'File';
}

/**
 * Shrinks a photo before it is stored: a 12 MP bill photo is 4-6 MB and unreadable
 * at that size on a phone anyway. PDFs and sheets are kept byte for byte.
 */
async function shrinkImage(blob) {
  const canResize =
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.convertTo === 'function';
  if (!canResize) return blob;

  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, ATTACHMENT_LIMITS.IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, width, height);
    const resized = await canvas.convertTo('image/jpeg', ATTACHMENT_LIMITS.IMAGE_QUALITY);
    bitmap.close?.();
    return resized.size < blob.size ? resized : blob;
  } catch {
    return blob; // a photo that will not decode is still better than nothing
  }
}

/**
 * Validates and prepares one picked file.
 * @returns {Promise<{ok: true, file: object} | {ok: false, code: string}>}
 */
export async function prepareAttachment(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, code: 'ATTACHMENT_INVALID' };
  if (file.size === 0) return { ok: false, code: 'ATTACHMENT_EMPTY' };
  if (file.size > ATTACHMENT_LIMITS.MAX_BYTES) return { ok: false, code: 'ATTACHMENT_TOO_LARGE' };

  const mime = String(file.type || 'application/octet-stream');
  const image = isImage(mime);
  const blob = image ? await shrinkImage(file) : file;
  const finalMime = image && blob.type ? blob.type : mime;

  return {
    ok: true,
    file: {
      name: safeFileName(file.name),
      mime: finalMime,
      size: blob.size,
      kind: typeLabel(finalMime, file.name),
      image,
      blob,
    },
  };
}

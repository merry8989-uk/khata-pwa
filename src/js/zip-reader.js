/**
 * Reads a zip written by our own writer (store-only, no compression).
 *
 * Backups are zips because a shopkeeper's proof is a photo or a PDF, and a zip is
 * the only format here that carries both the ledger JSON and those files in one
 * thing that opens anywhere. Reading is the mirror of writing: parse the central
 * directory, slice the bytes. Files that were deflated by another tool are
 * rejected with a clear message rather than silently producing garbage.
 */

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

function decodeName(bytes) {
  return new TextDecoder().decode(bytes);
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {Map<string, Uint8Array>} name -> bytes
 */
export function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find the end-of-central-directory record: it is the last 22 bytes unless the
  // archive carries a comment.
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0 && offset > bytes.length - 22 - 65536; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file: no end-of-central-directory record');

  const entryCount = u16(view, eocd + 10);
  const centralOffset = u32(view, eocd + 16);
  const files = new Map();

  let pointer = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(view, pointer) !== 0x02014b50) throw new Error('Corrupt zip: bad central directory entry');
    const method = u16(view, pointer + 10);
    const compressedSize = u32(view, pointer + 20);
    const nameLength = u16(view, pointer + 28);
    const extraLength = u16(view, pointer + 30);
    const commentLength = u16(view, pointer + 32);
    const localOffset = u32(view, pointer + 42);
    const name = decodeName(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    if (method !== 0) {
      throw new Error(`Unsupported zip entry "${name}": only uncompressed Khata backups can be read`);
    }

    // Local header: its name/extra lengths can differ from the central copy.
    if (u32(view, localOffset) !== 0x04034b50) throw new Error('Corrupt zip: bad local file header');
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, bytes.subarray(dataStart, dataStart + compressedSize));

    pointer += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

/** Decodes a zip entry as JSON, or throws if it is not JSON. */
export function readJsonEntry(files, name) {
  const entry = files.get(name);
  if (!entry) throw new Error(`Backup is missing ${name}`);
  return JSON.parse(new TextDecoder().decode(entry));
}

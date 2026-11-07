// Reads a received multi-file bundle (an uncompressed .zip from `cdx send
// a b c` or a browser sender) back into its files. Each file is a lazy
// slice of the received Blob, so nothing is copied into memory and the
// staged bytes back every download.

const END = 0x06054b50;
const END_BYTES = 22;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
// Larger directories remain available as a ZIP download instead of using more heap.
const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const decoder = new TextDecoder('utf-8', { fatal: true });

async function bytesAt(blob, start, length) {
  const end = Math.min(blob.size, start + length);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || end - start !== length) throw new Error('bundle is truncated');
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

// safeEntryPath rejects absolute, parent-relative, and control-character
// names. Senders only write plain relative paths.
export function safeEntryPath(name) {
  const clean = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!clean || /[\\\u0000-\u001f\u007f]/.test(clean) || clean.startsWith('/')) return null;
  const parts = clean.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || new TextEncoder().encode(part).byteLength > 255)) return null;
  return clean;
}

// readBundle returns [{ path, size, blob }] for every file in the archive.
// Folders are implied by paths. Throws on anything it cannot read safely;
// callers fall back to offering the .zip itself.
export async function readBundle(blob) {
  const tailLength = Math.min(blob.size, END_BYTES + MAX_COMMENT);
  const tail = await bytesAt(blob, blob.size - tailLength, tailLength);
  let endAt = -1;
  for (let index = tailLength - END_BYTES; index >= 0; index -= 1) {
    if (tail.getUint32(index, true) === END) { endAt = index; break; }
  }
  if (endAt < 0) throw new Error('bundle has no directory');
  let count = tail.getUint16(endAt + 10, true);
  let directorySize = tail.getUint32(endAt + 12, true);
  let directoryOffset = tail.getUint32(endAt + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAt = blob.size - tailLength + endAt - 20;
    const locator = await bytesAt(blob, locatorAt, 20);
    if (locator.getUint32(0, true) !== ZIP64_LOCATOR) throw new Error('bundle directory is invalid');
    const zip64 = await bytesAt(blob, Number(locator.getBigUint64(8, true)), 56);
    if (zip64.getUint32(0, true) !== ZIP64_END) throw new Error('bundle directory is invalid');
    count = Number(zip64.getBigUint64(32, true));
    directorySize = Number(zip64.getBigUint64(40, true));
    directoryOffset = Number(zip64.getBigUint64(48, true));
  }
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(directorySize) || !Number.isSafeInteger(directoryOffset) || count > MAX_ENTRIES || directorySize > MAX_DIRECTORY_BYTES) throw new Error('bundle directory exceeds automatic extraction limits');
  const directory = await bytesAt(blob, directoryOffset, directorySize);
  const files = [];
  const seen = new Set();
  let at = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (directory.getUint32(at, true) !== CENTRAL) throw new Error('bundle directory is invalid');
    const method = directory.getUint16(at + 10, true);
    let compressed = directory.getUint32(at + 20, true);
    let size = directory.getUint32(at + 24, true);
    const nameLength = directory.getUint16(at + 28, true);
    const extraLength = directory.getUint16(at + 30, true);
    const commentLength = directory.getUint16(at + 32, true);
    let offset = directory.getUint32(at + 42, true);
    const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + at + 46, nameLength);
    const name = decoder.decode(nameBytes);
    // Zip64 extra field: 64-bit values replace whichever are saturated.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (size === 0xffffffff) { size = Number(directory.getBigUint64(field, true)); field += 8; }
        if (compressed === 0xffffffff) { compressed = Number(directory.getBigUint64(field, true)); field += 8; }
        if (offset === 0xffffffff) { offset = Number(directory.getBigUint64(field, true)); }
      }
      extra += 4 + length;
    }
    at = extraEnd + commentLength;

    const path = safeEntryPath(name);
    if (!path || seen.has(path)) throw new Error('bundle has an unsafe filename');
    seen.add(path);
    if (name.endsWith('/')) continue;
    if (![size, compressed, offset].every(Number.isSafeInteger)) throw new Error('bundle entry is invalid');
    if (method !== 0 || compressed !== size) throw new Error('bundle is compressed');
    const local = await bytesAt(blob, offset, 30);
    if (local.getUint32(0, true) !== LOCAL) throw new Error('bundle entry is invalid');
    const start = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (start + size > directoryOffset) throw new Error('bundle entry is invalid');
    files.push({ path, size, blob: blob.slice(start, start + size) });
  }
  return files;
}

// downloadNames gives each file a flat download name: its own name, or its
// folder path joined with "_" when two files would otherwise collide.
export function downloadNames(paths) {
  // Downloads are flat; case-insensitive filesystems also treat differently
  // cased or canonically equivalent names as the same file.
  const key = (name) => name.normalize('NFC').toLowerCase();
  const bases = paths.map((path) => path.slice(path.lastIndexOf('/') + 1));
  const counts = new Map();
  for (const base of bases) counts.set(key(base), (counts.get(key(base)) || 0) + 1);

  // Reserve unique original basenames before flattening folder paths so a
  // generated name cannot steal a later file's original download name.
  const reserved = new Set(bases.filter((base) => counts.get(key(base)) === 1).map(key));
  const used = new Set();
  return paths.map((path, index) => {
    const base = bases[index];
    const collides = counts.get(key(base)) > 1;
    const preferred = collides ? path.replaceAll('/', '_') : base;
    const dot = preferred.lastIndexOf('.');
    const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
    const extension = dot > 0 ? preferred.slice(dot) : '';
    let name = preferred;
    for (let copy = 2; used.has(key(name)) || (collides && reserved.has(key(name))); copy += 1) {
      name = `${stem} (${copy})${extension}`;
    }
    used.add(key(name));
    return name;
  });
}

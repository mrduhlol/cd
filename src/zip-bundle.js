// Several picked files travel as one uncompressed .zip, like `cdx send a b`.
// The relay protocol offers one byte stream of known size, so the archive is
// laid out up front (sizes are known; CRCs go in data descriptors) and
// streamed without holding it in memory.

const LOCAL_HEADER_BYTES = 30;
const DESCRIPTOR_BYTES = 16;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
// Bit 3: CRC in the data descriptor. Bit 11: UTF-8 names.
const FLAGS = 0x0808;
const ZIP_LIMIT = 0xffff_fffe;
export const MAX_BUNDLE_BYTES = Number.MAX_SAFE_INTEGER;

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, previous = 0) {
  let crc = ~previous >>> 0;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

// uniqueNames keeps every entry distinct: "a.txt", "a (2).txt", ...
function uniqueNames(files) {
  const seen = new Set();
  return files.map((file) => {
    const base = String(file.name || 'file').replace(/[\\/]/g, '_') || 'file';
    let name = base;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    for (let copy = 2; seen.has(name.toLowerCase()); copy += 1) name = `${stem} (${copy})${extension}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

export function bundleName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `cd-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`;
}

// createZipBundle returns { name, size, stream() } for files (Blob-like with
// name, size, and slice). stream() yields Uint8Arrays in archive order.
export function createZipBundle(files, { now = new Date(), chunkBytes = 256 * 1024 } = {}) {
  const names = uniqueNames(files).map((name) => encoder.encode(name));
  if (names.some((name) => name.length > 0xffff)) throw new Error('file name too long');
  const { time, day } = dosDateTime(now);
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('invalid chunk size');
  let layoutOffset = 0;
  let directorySize = 0;
  const layout = files.map((file, index) => {
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('invalid file size');
    if (names[index].length > 0xffff) throw new Error('filename too long');
    const large = file.size > ZIP_LIMIT;
    const largeOffset = layoutOffset > ZIP_LIMIT;
    const entry = { large, largeOffset };
    layoutOffset += LOCAL_HEADER_BYTES + names[index].length + (large ? 20 : 0) + file.size + (large ? 24 : DESCRIPTOR_BYTES);
    directorySize += CENTRAL_HEADER_BYTES + names[index].length + (large || largeOffset ? 4 + (large ? 16 : 0) + (largeOffset ? 8 : 0) : 0);
    if (!Number.isSafeInteger(layoutOffset)) throw new Error('bundle too large');
    return entry;
  });
  const zip64 = layout.some(entry => entry.large || entry.largeOffset) || files.length >= 0xffff || layoutOffset > ZIP_LIMIT || directorySize > ZIP_LIMIT;
  const size = layoutOffset + directorySize + END_BYTES + (zip64 ? 76 : 0);
  if (!Number.isSafeInteger(size)) throw new Error('bundle too large');

  async function* stream() {
    const central = [];
    let offset = 0;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const name = names[index];
      const { large, largeOffset } = layout[index];
      const local = new Uint8Array(LOCAL_HEADER_BYTES + name.length + (large ? 20 : 0));
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, large ? 45 : 20, true);
      view.setUint16(6, FLAGS, true);
      view.setUint16(10, time, true);
      view.setUint16(12, day, true);
      view.setUint16(26, name.length, true);
      local.set(name, LOCAL_HEADER_BYTES);
      if (large) {
        view.setUint32(18, 0xffffffff, true);
        view.setUint32(22, 0xffffffff, true);
        view.setUint16(28, 20, true);
        const extra = LOCAL_HEADER_BYTES + name.length;
        view.setUint16(extra, 1, true);
        view.setUint16(extra + 2, 16, true);
        view.setBigUint64(extra + 4, BigInt(file.size), true);
        view.setBigUint64(extra + 12, BigInt(file.size), true);
      }
      yield local;

      let crc = 0;
      let read = 0;
      while (read < file.size) {
        const piece = new Uint8Array(await file.slice(read, Math.min(read + chunkBytes, file.size)).arrayBuffer());
        if (piece.length === 0) throw new Error('file changed while sending');
        crc = crc32(piece, crc);
        read += piece.length;
        yield piece;
      }
      if (read !== file.size) throw new Error('file changed while sending');

      const descriptor = new Uint8Array(large ? 24 : DESCRIPTOR_BYTES);
      const descriptorView = new DataView(descriptor.buffer);
      descriptorView.setUint32(0, 0x08074b50, true);
      descriptorView.setUint32(4, crc, true);
      if (large) {
        descriptorView.setBigUint64(8, BigInt(file.size), true);
        descriptorView.setBigUint64(16, BigInt(file.size), true);
      } else {
        descriptorView.setUint32(8, file.size, true);
        descriptorView.setUint32(12, file.size, true);
      }
      yield descriptor;

      central.push({ name, crc, size: file.size, offset, large, largeOffset });
      offset += local.length + file.size + descriptor.length;
    }

    const directoryOffset = offset;
    let directoryBytes = 0;
    for (const entry of central) {
      const extraBytes = entry.large || entry.largeOffset ? 4 + (entry.large ? 16 : 0) + (entry.largeOffset ? 8 : 0) : 0;
      const header = new Uint8Array(CENTRAL_HEADER_BYTES + entry.name.length + extraBytes);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, extraBytes ? 45 : 20, true);
      view.setUint16(6, extraBytes ? 45 : 20, true);
      view.setUint16(8, FLAGS, true);
      view.setUint16(12, time, true);
      view.setUint16(14, day, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.large ? 0xffffffff : entry.size, true);
      view.setUint32(24, entry.large ? 0xffffffff : entry.size, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint32(42, entry.largeOffset ? 0xffffffff : entry.offset, true);
      header.set(entry.name, CENTRAL_HEADER_BYTES);
      view.setUint16(30, extraBytes, true);
      if (extraBytes) {
        let pos = CENTRAL_HEADER_BYTES + entry.name.length;
        view.setUint16(pos, 1, true);
        view.setUint16(pos + 2, extraBytes - 4, true);
        pos += 4;
        if (entry.large) {
          view.setBigUint64(pos, BigInt(entry.size), true);
          view.setBigUint64(pos + 8, BigInt(entry.size), true);
          pos += 16;
        }
        if (entry.largeOffset) view.setBigUint64(pos, BigInt(entry.offset), true);
      }
      directoryBytes += header.length;
      yield header;
    }
    if (zip64) {
      const tail = new Uint8Array(76);
      const v = new DataView(tail.buffer);
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setBigUint64(24, BigInt(central.length), true);
      v.setBigUint64(32, BigInt(central.length), true);
      v.setBigUint64(40, BigInt(directoryBytes), true);
      v.setBigUint64(48, BigInt(directoryOffset), true);
      v.setUint32(56, 0x07064b50, true);
      v.setBigUint64(64, BigInt(directoryOffset + directoryBytes), true);
      v.setUint32(72, 1, true);
      yield tail;
    }
    const end = new Uint8Array(END_BYTES);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, Math.min(central.length, 0xffff), true);
    view.setUint16(10, Math.min(central.length, 0xffff), true);
    view.setUint32(12, Math.min(directoryBytes, 0xffffffff), true);
    view.setUint32(16, Math.min(directoryOffset, 0xffffffff), true);
    yield end;
  }

  return { name: bundleName(now), type: 'application/zip', size, stream, bundle: true, files: files.length };
}

// Read in bounded blocks; the transfer engine separately sets wire record sizes.
export function fileSource(file, { chunkBytes = 4 * 1024 * 1024 } = {}) {
  return {
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    async *stream() {
      for (let offset = 0; offset < file.size; offset += chunkBytes) {
        yield new Uint8Array(await file.slice(offset, Math.min(offset + chunkBytes, file.size)).arrayBuffer());
      }
    }
  };
}

// rechunk regroups a byte stream into pieces of exactly `size` bytes (the
// last may be shorter), the unit the relay protocol sends. A piece that is
// already exactly `size` bytes with nothing buffered is yielded as-is, so the
// caller receives the source's own buffer: sources must not reuse a yielded
// buffer after handing it over (fileSource and the zip stream allocate fresh).
export async function* rechunk(source, size) {
  let buffer = new Uint8Array(size);
  let filled = 0;
  for await (const piece of source) {
    if (filled === 0 && piece.length === size) {
      yield piece;
      continue;
    }
    let offset = 0;
    while (offset < piece.length) {
      const take = Math.min(size - filled, piece.length - offset);
      buffer.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.subarray(0, filled);
}

// Zip reading for archive files. Node's zlib inflates several times faster than the
// pure-JS fallback, which matters on the event loop: a synchronous inflate of a large
// archive file blocks every request until it finishes.

import { inflateRawSync } from 'node:zlib';
import { unzipSync } from 'fflate';

/**
 * Bytes of the first CSV entry of a zip. Reads the central directory, so local-header
 * data descriptors do not matter. Returns null when the layout is not handled.
 */
export function inflateFirstCsv(zip: Uint8Array): Uint8Array | null {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  let off = buf.readUInt32LE(eocd + 16);
  const entries = buf.readUInt16LE(eocd + 10);
  for (let e = 0; e < entries; e++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name.toLowerCase().endsWith('.csv')) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return new Uint8Array(data);
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      return null;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** CSV text of a zip: native inflate when possible, fflate otherwise. Throws if corrupt. */
export function csvBytes(zip: Uint8Array): Uint8Array {
  const native = inflateFirstCsv(zip);
  if (native) return native;
  const entries = unzipSync(zip);
  const name = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.csv')) ?? Object.keys(entries)[0];
  if (!name) throw new Error('zip archive contains no files');
  return entries[name];
}

/** Yield to the event loop so timers, sockets and requests get a turn. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

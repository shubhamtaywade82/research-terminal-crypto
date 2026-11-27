// Decode worker: all CPU-heavy archive work (zip inflate, CSV parse, sort, de-duplicate,
// gap scan) runs here, off the server's event loop.
//
// The worker is an inline (eval) script, so it needs no file on disk and works the same
// in `bun run dev`, the standalone build and the test runner. Only ECMAScript plus
// node:zlib and worker_threads are used. Keep it free of template literals and of
// `${...}` sequences: the source is embedded in a String.raw template.
//
// Series are parallel typed arrays, not objects per row: a 1m year is 525,600 rows, and
// a Float64Array costs 8 bytes per value against roughly 100 bytes per object.

export const DECODE_WORKER_SOURCE = String.raw`
'use strict';
var zlib = require('node:zlib');
var parentPort = require('node:worker_threads').parentPort;
var HOUR_MS = 3600000;

function grow(a, cap) {
  var b = new Float64Array(cap);
  b.set(a);
  return b;
}

// First CSV entry of a zip, from the central directory. Stored and deflated entries only,
// which is what the Binance archive publishes.
function firstCsvBytes(u8) {
  var buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  var eocd = -1;
  for (var i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  var off = buf.readUInt32LE(eocd + 16);
  var entries = buf.readUInt16LE(eocd + 10);
  for (var e = 0; e < entries; e++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip central directory');
    var method = buf.readUInt16LE(off + 10);
    var compSize = buf.readUInt32LE(off + 20);
    var nameLen = buf.readUInt16LE(off + 28);
    var extraLen = buf.readUInt16LE(off + 30);
    var commentLen = buf.readUInt16LE(off + 32);
    var localOff = buf.readUInt32LE(off + 42);
    var name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name.toLowerCase().endsWith('.csv')) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad zip local header');
      var start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      var data = buf.subarray(start, start + compSize);
      if (method === 0) return new Uint8Array(data);
      if (method === 8) return new Uint8Array(zlib.inflateRawSync(data));
      throw new Error('unsupported zip method ' + method);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('zip has no CSV entry');
}

function csvText(u8) {
  return new TextDecoder().decode(firstCsvBytes(u8));
}

function decodeKlines(u8, startMs, endMs) {
  var text = csvText(u8);
  var cap = 4096;
  var t = new Float64Array(cap), o = new Float64Array(cap), h = new Float64Array(cap);
  var l = new Float64Array(cap), c = new Float64Array(cap), v = new Float64Array(cap);
  var n = 0;
  var pos = 0;
  var len = text.length;
  if (text.startsWith('open_time')) {
    var nl = text.indexOf('\n');
    pos = nl < 0 ? len : nl + 1;
  }
  while (pos < len) {
    var eol = text.indexOf('\n', pos);
    if (eol < 0) eol = len;
    var line = text.slice(pos, eol);
    pos = eol + 1;
    if (line.length === 0) continue;
    var f = line.split(',');
    if (f.length < 6) continue;
    var ts = Number(f[0]);
    if (!(ts >= startMs && ts <= endMs)) continue;
    var oo = Number(f[1]), hh = Number(f[2]), ll = Number(f[3]), cc = Number(f[4]), vv = Number(f[5]);
    if (!isFinite(oo) || !isFinite(hh) || !isFinite(ll) || !isFinite(cc)) continue;
    if (n === cap) {
      cap *= 2;
      t = grow(t, cap); o = grow(o, cap); h = grow(h, cap);
      l = grow(l, cap); c = grow(c, cap); v = grow(v, cap);
    }
    t[n] = ts; o[n] = oo; h[n] = hh; l[n] = ll; c[n] = cc; v[n] = isFinite(vv) ? vv : 0;
    n++;
  }
  return { t: t.slice(0, n), o: o.slice(0, n), h: h.slice(0, n), l: l.slice(0, n), c: c.slice(0, n), v: v.slice(0, n) };
}

function decodeFunding(u8, startMs, endMs) {
  var text = csvText(u8);
  var cap = 1024;
  var t = new Float64Array(cap), rate = new Float64Array(cap);
  var n = 0;
  var pos = 0;
  var len = text.length;
  if (text.startsWith('calc_time')) {
    var nl = text.indexOf('\n');
    pos = nl < 0 ? len : nl + 1;
  }
  while (pos < len) {
    var eol = text.indexOf('\n', pos);
    if (eol < 0) eol = len;
    var line = text.slice(pos, eol);
    pos = eol + 1;
    if (line.length === 0) continue;
    var f = line.split(',');
    var raw = Number(f[0]);
    if (!isFinite(raw)) continue;
    var r = Number(f[f.length - 1]);
    if (!isFinite(r)) continue;
    var at = Math.floor(raw / HOUR_MS) * HOUR_MS;
    if (!(at >= startMs && at <= endMs)) continue;
    if (n === cap) { cap *= 2; t = grow(t, cap); rate = grow(rate, cap); }
    t[n] = at; rate[n] = r;
    n++;
  }
  return { t: t.slice(0, n), rate: rate.slice(0, n) };
}

function decodeAggTrades(u8) {
  var text = csvText(u8);
  var cap = 1 << 16;
  var t = new Float64Array(cap), p = new Float64Array(cap);
  var n = 0;
  var pos = 0;
  var len = text.length;
  if (text.startsWith('agg_trade_id')) {
    var nl = text.indexOf('\n');
    pos = nl < 0 ? len : nl + 1;
  }
  while (pos < len) {
    var eol = text.indexOf('\n', pos);
    if (eol < 0) eol = len;
    var line = text.slice(pos, eol);
    pos = eol + 1;
    if (line.length === 0) continue;
    var f = line.split(',');
    if (f.length < 6) continue;
    var price = Number(f[1]);
    var time = Number(f[5]);
    if (!isFinite(price) || !isFinite(time) || price <= 0) continue;
    if (n === cap) { cap *= 2; t = grow(t, cap); p = grow(p, cap); }
    t[n] = time; p[n] = price;
    n++;
  }
  t = t.slice(0, n);
  p = p.slice(0, n);
  var sorted = true;
  for (var i = 1; i < n; i++) if (t[i] < t[i - 1]) { sorted = false; break; }
  if (sorted) return { t: t, p: p };
  var order = new Array(n);
  for (var k = 0; k < n; k++) order[k] = k;
  order.sort(function (a, b) { return (t[a] - t[b]) || (a - b); });
  var t2 = new Float64Array(n), p2 = new Float64Array(n);
  for (var j = 0; j < n; j++) { t2[j] = t[order[j]]; p2[j] = p[order[j]]; }
  return { t: t2, p: p2 };
}

// Concatenate series in list order, sort by time, keep ONE row per timestamp: the last
// occurrence, so a later file (a daily heal, a re-fetch) overrides an earlier one.
function mergeSeries(list, fields) {
  var total = 0;
  for (var s = 0; s < list.length; s++) total += list[s].t.length;
  var T = new Float64Array(total);
  var cols = {};
  for (var f = 0; f < fields.length; f++) cols[fields[f]] = new Float64Array(total);
  var off = 0;
  for (var s2 = 0; s2 < list.length; s2++) {
    var part = list[s2];
    T.set(part.t, off);
    for (var g = 0; g < fields.length; g++) cols[fields[g]].set(part[fields[g]], off);
    off += part.t.length;
  }
  var order = new Array(total);
  for (var k = 0; k < total; k++) order[k] = k;
  order.sort(function (a, b) { return (T[a] - T[b]) || (a - b); });
  var keep = [];
  for (var m = 0; m < total; m++) {
    var idx = order[m];
    if (m + 1 < total && T[order[m + 1]] === T[idx]) continue;
    keep.push(idx);
  }
  var out = { t: new Float64Array(keep.length) };
  for (var g2 = 0; g2 < fields.length; g2++) out[fields[g2]] = new Float64Array(keep.length);
  for (var q = 0; q < keep.length; q++) {
    out.t[q] = T[keep[q]];
    for (var g3 = 0; g3 < fields.length; g3++) out[fields[g3]][q] = cols[fields[g3]][keep[q]];
  }
  return out;
}

// Whole days that contain at least one missing bar between the first and last bar.
function gapDays(t, stepMs) {
  var days = {};
  for (var i = 1; i < t.length; i++) {
    var prev = t[i - 1], next = t[i];
    if (next - prev <= stepMs) continue;
    for (var x = prev + stepMs; x < next; x += stepMs) {
      days[Math.floor(x / 86400000) * 86400000] = true;
    }
  }
  var list = Object.keys(days).map(Number).sort(function (a, b) { return a - b; });
  return { days: Float64Array.from(list) };
}

parentPort.on('message', function (m) {
  var result;
  try {
    if (m.op === 'klines') result = decodeKlines(new Uint8Array(m.bytes), m.startMs, m.endMs);
    else if (m.op === 'funding') result = decodeFunding(new Uint8Array(m.bytes), m.startMs, m.endMs);
    else if (m.op === 'aggtrades') result = decodeAggTrades(new Uint8Array(m.bytes));
    else if (m.op === 'merge') result = mergeSeries(m.series, m.fields);
    else if (m.op === 'gapdays') result = gapDays(m.t, m.stepMs);
    else throw new Error('unknown decode op ' + m.op);
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) });
    return;
  }
  var transfer = [];
  for (var key in result) {
    if (ArrayBuffer.isView(result[key])) transfer.push(result[key].buffer);
    else if (result[key] && typeof result[key] === 'object') {
      for (var inner in result[key]) if (ArrayBuffer.isView(result[key][inner])) transfer.push(result[key][inner].buffer);
    }
  }
  parentPort.postMessage({ id: m.id, ok: true, result: result }, transfer);
});
`;

// Store worker: all SQLite work that is heavy enough to block the server thread runs here,
// on its own thread with its own connections.
//
// Why a worker: @libsql/client runs each statement synchronously on the thread that calls
// it. A multi-second DELETE, a WAL checkpoint or a coverage aggregate on the server thread
// blocks every request and timer for that long. Here the same work blocks nothing else.
//
// Operations:
//   - replace:  delete one symbol/interval dataset and insert the new one, in ONE write
//               transaction. Writes are serialised in arrival order.
//   - coverage: per-dataset counts and time bounds. Reads run beside a write (WAL), so they
//               are not queued behind one.
//
// Insert shape: each chunk of rows is ONE statement that binds a single JSON array and
// unpacks it with json_each. Binding nine values per row (the earlier shape) grew native
// memory by roughly 1 KB per row that was not returned until the worker exited; the JSON
// shape binds a handful of values per chunk.
//
// The worker is an inline (eval) script: plain JavaScript, no imports. It loads
// @libsql/client by the name passed in workerData, resolved from the working directory.
// Table and column names match prisma/schema.prisma; DateTime values are ISO text, the
// same form the Prisma client writes.

export const STORE_WORKER_SOURCE = String.raw`
'use strict';
var workerThreads = require('node:worker_threads');
var parentPort = workerThreads.parentPort;
var libsql = require(workerThreads.workerData.libsqlModule);

// Rows per statement. 20k rows is about 1.5 MB of JSON per chunk.
var CHUNK_ROWS = 20000;
var BUSY_TIMEOUT_MS = 10000;

function iso(ms) {
  return new Date(ms).toISOString();
}

async function openWithTimeout(url) {
  var client = libsql.createClient({ url: url });
  await client.execute('PRAGMA busy_timeout = ' + BUSY_TIMEOUT_MS);
  return client;
}

// One INSERT per chunk: fixed bound values first, then the chunk as one JSON array of rows.
async function insertChunks(tx, head, select, fixedArgs, count, rowAt) {
  var sql = head + ' SELECT ' + select + ' FROM json_each(?)';
  for (var i = 0; i < count; i += CHUNK_ROWS) {
    var end = Math.min(count, i + CHUNK_ROWS);
    var rows = new Array(end - i);
    for (var r = i; r < end; r++) rows[r - i] = rowAt(r);
    await tx.execute({ sql: sql, args: fixedArgs.concat([JSON.stringify(rows)]) });
  }
}

async function insertCandles(tx, symbol, interval, kind, s) {
  await insertChunks(
    tx,
    'INSERT INTO Candle (symbol, interval, kind, openTime, open, high, low, close, volume)',
    "?, ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), " +
      "json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]')",
    [symbol, interval, kind],
    s.t.length,
    function (i) {
      return [iso(s.t[i]), s.o[i], s.h[i], s.l[i], s.c[i], s.v[i]];
    },
  );
}

async function insertFunding(tx, symbol, f) {
  await insertChunks(
    tx,
    'INSERT INTO FundingRate (symbol, fundingTime, rate, markPrice)',
    "?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')",
    [symbol],
    f.t.length,
    function (i) {
      return [iso(f.t[i]), f.rate[i], f.markPrice[i]];
    },
  );
}

// Replace one symbol/interval dataset in a single write transaction. Any failure rolls the
// whole replace back, so the store never holds new candles next to stale funding.
async function replace(m, stage) {
  var client = await openWithTimeout(m.url);
  try {
    var tx = await client.transaction('write');
    try {
      // Candle deletes cover both kinds (last and mark) for this symbol and interval.
      await tx.execute({ sql: 'DELETE FROM Candle WHERE symbol = ? AND interval = ?', args: [m.symbol, m.interval] });
      await tx.execute({ sql: 'DELETE FROM FundingRate WHERE symbol = ?', args: [m.symbol] });
      stage('deleted old rows');
      await insertCandles(tx, m.symbol, m.interval, 'last', m.last);
      stage('inserted execution candles');
      await insertCandles(tx, m.symbol, m.interval, 'mark', m.mark);
      stage('inserted mark candles');
      await insertFunding(tx, m.symbol, m.funding);
      stage('inserted funding, committing');
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(function () {});
      throw e;
    }
  } finally {
    client.close();
  }
}

// Coverage: one row per (symbol, interval, kind) and per funding symbol. Timestamps come back
// as epoch ms, so the caller never parses SQL text.
async function coverage(url) {
  var client = await openWithTimeout(url);
  try {
    var c = await client.execute(
      'SELECT symbol, interval, kind, COUNT(*) AS n, MIN(openTime) AS lo, MAX(openTime) AS hi ' +
      'FROM Candle GROUP BY symbol, interval, kind',
    );
    var f = await client.execute('SELECT symbol, COUNT(*) AS n FROM FundingRate GROUP BY symbol');
    return {
      candles: c.rows.map(function (r) {
        return {
          symbol: String(r.symbol),
          interval: String(r.interval),
          kind: String(r.kind),
          count: Number(r.n),
          fromMs: r.lo == null ? null : Date.parse(String(r.lo)),
          toMs: r.hi == null ? null : Date.parse(String(r.hi)),
        };
      }),
      funding: f.rows.map(function (r) {
        return { symbol: String(r.symbol), count: Number(r.n) };
      }),
    };
  } finally {
    client.close();
  }
}

// Writes are serialised: each replace is its own transaction, in arrival order.
var writeQueue = Promise.resolve();

parentPort.on('message', function (m) {
  if (m.op === 'coverage') {
    // Reads are not queued behind a write.
    coverage(m.url).then(
      function (result) { parentPort.postMessage({ id: m.id, ok: true, result: result }); },
      function (e) { parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); },
    );
    return;
  }
  writeQueue = writeQueue.then(function () {
    var stage = function (what) { parentPort.postMessage({ id: m.id, stage: what }); };
    return replace(m, stage).then(
      function () { parentPort.postMessage({ id: m.id, ok: true }); },
      function (e) { parentPort.postMessage({ id: m.id, ok: false, error: String((e && e.message) || e) }); },
    );
  });
});
`;

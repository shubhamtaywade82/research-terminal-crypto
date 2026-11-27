import { parseAggTradesCsv, utcDayKey, utcDayStart } from '@/lib/datasources/aggtrades';

const HEADER = 'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';

describe('parseAggTradesCsv', () => {
  it('reads transact_time and price, skipping the header', () => {
    const csv = [HEADER, '1,96514.9,0.091,10,11,1736899205109,true', '2,96515.0,0.5,12,12,1736899205200,false'].join('\n');
    const w = parseAggTradesCsv(csv);
    expect(Array.from(w.t)).toEqual([1736899205109, 1736899205200]);
    expect(Array.from(w.p)).toEqual([96514.9, 96515.0]);
  });

  it('skips malformed and non-positive rows instead of inventing prices', () => {
    const csv = [HEADER, '1,abc,1,1,1,1736899205109,true', '2,0,1,1,1,1736899205110,true', '3,50,1,1,1,1736899205111,true'].join('\n');
    const w = parseAggTradesCsv(csv);
    expect(Array.from(w.p)).toEqual([50]);
  });

  it('sorts out-of-order rows rather than trusting the file order', () => {
    const csv = [HEADER, '1,10,1,1,1,300,true', '2,11,1,1,1,100,true', '3,12,1,1,1,200,true'].join('\n');
    const w = parseAggTradesCsv(csv);
    expect(Array.from(w.t)).toEqual([100, 200, 300]);
    expect(Array.from(w.p)).toEqual([11, 12, 10]);
  });

  it('keys UTC days consistently', () => {
    const t = Date.UTC(2025, 0, 15, 23, 59, 59, 999);
    expect(utcDayKey(t)).toBe('2025-01-15');
    expect(utcDayStart(t)).toBe(Date.UTC(2025, 0, 15));
  });
});

import { zipSync, strToU8 } from 'fflate';
import { csvBytes, inflateFirstCsv } from '@/lib/datasources/zip';

describe('native zip reader', () => {
  const csv = `${HEADER}\n1,100,1,1,1,1000,true\n2,101,1,1,1,1001,false\n`;

  it('inflates deflated and stored entries to the original bytes', () => {
    for (const level of [0, 6] as const) {
      const zip = zipSync({ 'BTCUSDT-aggTrades-2025-01-01.csv': strToU8(csv) }, { level });
      expect(Buffer.from(inflateFirstCsv(zip) ?? new Uint8Array()).toString()).toBe(csv);
      expect(Buffer.from(csvBytes(zip)).toString()).toBe(csv);
    }
  });

  it('returns null (so the caller falls back) for bytes that are not a zip', () => {
    expect(inflateFirstCsv(strToU8('not a zip at all, just text padding padding padding padding'))).toBeNull();
  });
});

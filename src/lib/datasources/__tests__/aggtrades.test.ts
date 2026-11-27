import { strToU8, zipSync } from 'fflate';
import { utcDayKey, utcDayStart } from '@/lib/datasources/aggtrades';
import { decodeAggTradesZip, stopDecodeWorker } from '@/lib/datasources/decode-pool';

const HEADER = 'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker';

function dayZip(csv: string, level: 0 | 6 = 6): Uint8Array {
  return zipSync({ 'BTCUSDT-aggTrades-2025-01-15.csv': strToU8(csv) }, { level });
}

afterAll(() => stopDecodeWorker());

describe('decodeAggTradesZip (worker)', () => {
  it('reads transact_time and price, skipping the header', async () => {
    const csv = [HEADER, '1,96514.9,0.091,10,11,1736899205109,true', '2,96515.0,0.5,12,12,1736899205200,false'].join('\n');
    const w = await decodeAggTradesZip(dayZip(csv));
    expect(Array.from(w.t)).toEqual([1736899205109, 1736899205200]);
    expect(Array.from(w.p)).toEqual([96514.9, 96515.0]);
  });

  it('skips malformed and non-positive rows instead of inventing prices', async () => {
    const csv = [HEADER, '1,abc,1,1,1,1736899205109,true', '2,0,1,1,1,1736899205110,true', '3,50,1,1,1,1736899205111,true'].join('\n');
    const w = await decodeAggTradesZip(dayZip(csv));
    expect(Array.from(w.p)).toEqual([50]);
  });

  it('sorts out-of-order rows rather than trusting the file order', async () => {
    const csv = [HEADER, '1,10,1,1,1,300,true', '2,11,1,1,1,100,true', '3,12,1,1,1,200,true'].join('\n');
    const w = await decodeAggTradesZip(dayZip(csv));
    expect(Array.from(w.t)).toEqual([100, 200, 300]);
    expect(Array.from(w.p)).toEqual([11, 12, 10]);
  });

  it('decodes stored (level 0) and deflated (level 6) entries to the same prints', async () => {
    const csv = `${HEADER}\n1,100,1,1,1,1000,true\n2,101,1,1,1,1001,false\n`;
    const stored = await decodeAggTradesZip(dayZip(csv, 0));
    const deflated = await decodeAggTradesZip(dayZip(csv, 6));
    expect(Array.from(stored.t)).toEqual([1000, 1001]);
    expect(Array.from(deflated.t)).toEqual([1000, 1001]);
    expect(Array.from(stored.p)).toEqual([100, 101]);
    expect(Array.from(deflated.p)).toEqual([100, 101]);
  });

  it('rejects bytes that are not a zip, so the caller can re-fetch', async () => {
    await expect(decodeAggTradesZip(strToU8('not a zip at all, just text padding padding padding padding'))).rejects.toThrow(
      'not a zip archive',
    );
  });

  it('rejects a zip with no CSV entry', async () => {
    const zip = zipSync({ 'readme.txt': strToU8('no prints here') });
    await expect(decodeAggTradesZip(zip)).rejects.toThrow('zip has no CSV entry');
  });
});

describe('UTC day keys', () => {
  it('keys UTC days consistently', () => {
    const t = Date.UTC(2025, 0, 15, 23, 59, 59, 999);
    expect(utcDayKey(t)).toBe('2025-01-15');
    expect(utcDayStart(t)).toBe(Date.UTC(2025, 0, 15));
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDatabaseUrl } from '@/lib/db-url';

describe('resolveDatabaseUrl', () => {
  let root: string;
  const saved = process.env.NPRS_ROOT;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nprs-db-url-'));
    process.env.NPRS_ROOT = root;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NPRS_ROOT;
    else process.env.NPRS_ROOT = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves relative file URLs from the project root and creates the directory', () => {
    const url = resolveDatabaseUrl('file:./db/custom.db');
    expect(url).toBe(`file:${path.join(root, 'db', 'custom.db')}`);
    expect(fs.existsSync(path.join(root, 'db'))).toBe(true);
  });

  it('keeps absolute file URLs and remote libsql URLs unchanged', () => {
    expect(resolveDatabaseUrl('file:/var/data/x.db')).toBe('file:/var/data/x.db');
    expect(resolveDatabaseUrl('libsql://example.turso.io')).toBe('libsql://example.turso.io');
  });

  it('fails loudly when DATABASE_URL is missing', () => {
    expect(() => resolveDatabaseUrl(undefined)).toThrow(/DATABASE_URL is not set/);
  });
});

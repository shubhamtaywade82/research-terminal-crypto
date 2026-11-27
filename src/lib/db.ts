import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { resolveDatabaseUrl } from '@/lib/db-url';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient(): PrismaClient {
  const adapter = new PrismaLibSql({ url: resolveDatabaseUrl() });
  return new PrismaClient({
    adapter,
    log: ['error', 'warn'],
  });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;

/**
 * SQLite tuning, applied once per process.
 *  - WAL: readers (status polls, run listings) keep working while a writer holds the
 *    lock. Under the default rollback journal, a multi-second ingest transaction blocked
 *    every read, so the status endpoint hung for the whole write.
 *  - busy_timeout: a second writer waits briefly for the lock instead of failing at once.
 * The journal mode is stored in the database file, so this only has to take effect once.
 */
let sqliteTuned: Promise<void> | null = null;
export function ensureSqliteTuned(): Promise<void> {
  sqliteTuned ??= (async () => {
    await db.$queryRawUnsafe('PRAGMA busy_timeout = 10000');
    await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  })().catch((e: unknown) => {
    console.error('sqlite tuning failed; continuing with defaults:', e);
  });
  return sqliteTuned;
}
void ensureSqliteTuned();

import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { resolveDatabaseUrl } from '@/lib/db-url';

/**
 * Read-only client on its own connection. The write client runs ingest and backtest
 * transactions on one connection, and a read queued behind a multi-second transaction
 * waits for all of it. WAL lets this connection read the last committed state meanwhile.
 * Use ONLY for reads; every write goes through `db`.
 */
const g = globalThis as unknown as { __nprsDbRead?: PrismaClient };
export const dbRead: PrismaClient =
  g.__nprsDbRead ??
  new PrismaClient({
    adapter: new PrismaLibSql({ url: resolveDatabaseUrl() }),
    log: ['error', 'warn'],
  });
if (process.env.NODE_ENV !== 'production') g.__nprsDbRead = dbRead;

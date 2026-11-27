import fs from 'node:fs';
import path from 'node:path';

/**
 * Project root, independent of the current working directory.
 * NPRS_ROOT is set by the start script: the standalone server chdirs into
 * .next/standalone, so process.cwd() is not the project root at runtime.
 */
export function projectRoot(): string {
  return process.env.NPRS_ROOT || process.cwd();
}

/**
 * Resolve DATABASE_URL to an absolute libsql file URL.
 *
 * Relative `file:` paths resolve from the project root for the Prisma CLI
 * (prisma 7 resolves against prisma.config.ts) and here, so both sides always
 * point at the same file. Creates the parent directory if it does not exist.
 */
export function resolveDatabaseUrl(raw: string | undefined = process.env.DATABASE_URL): string {
  if (!raw) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
  }
  if (!raw.startsWith('file:')) return raw; // remote libsql URL - used as-is
  const file = raw.slice('file:'.length);
  const abs = path.isAbsolute(file) ? file : path.resolve(projectRoot(), file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return `file:${abs}`;
}

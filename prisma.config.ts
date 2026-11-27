// Prisma 7 moved connection URLs out of schema.prisma. The CLI (migrate / db push)
// reads the URL from here; runtime connections are built in src/lib/db.ts via the
// libsql driver adapter. The fallback matches .env.example so `prisma generate`
// (run on install) works on a fresh clone before a .env exists.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./db/custom.db',
  },
});

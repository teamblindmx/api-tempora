import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma Migrate corre siempre con el rol dueño (tempora_owner). La API nunca usa esta URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL_OWNER'] ?? '' },
});

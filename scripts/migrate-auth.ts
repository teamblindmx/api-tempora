// Crea o actualiza las tablas de Better Auth y Axeda en el esquema auth. npm run db:migrate lo corre
// después de las migraciones de Prisma.
import 'dotenv/config';
import { migrateAuth } from '../src/auth/auth.js';
import { loadConfig } from '../src/config/config.js';

await migrateAuth(loadConfig());
console.info('Esquema auth al día.');

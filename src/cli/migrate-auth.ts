// Crea o actualiza las tablas de Better Auth y Axeda en el esquema auth. Va después de las
// migraciones de Prisma: `npm run db:migrate` en desarrollo, `npm run db:migrate:prod` en la imagen.
import 'dotenv/config';
import { migrateAuth } from '../auth/auth.js';
import { loadConfig } from '../config/config.js';

await migrateAuth(loadConfig());
console.info('Esquema auth al día.');

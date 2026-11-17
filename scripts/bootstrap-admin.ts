// Hace a un usuario existente dueño de la plataforma (administrador global de Axeda).
// Operación de servidor, no de la API. Uso: npm run bootstrap:admin -- correo@ejemplo.com
// Axeda se niega si ya existe un administrador global.
import 'dotenv/config';
import { createAuth } from '../src/auth/auth.js';
import { loadConfig } from '../src/config/config.js';

const email = process.argv[2];
if (!email) {
  console.error('Uso: npm run bootstrap:admin -- correo@ejemplo.com');
  process.exit(1);
}
const auth = await createAuth(loadConfig());
try {
  const { rows } = await auth.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) throw new Error(`No existe un usuario con el correo ${email}. Regístralo primero.`);
  const result = await auth.axeda.bootstrap({ userId: user.id });
  console.info(`Listo: ${email} es dueño de la plataforma (asignación ${result.assignmentId}).`);
} finally {
  await auth.close();
}

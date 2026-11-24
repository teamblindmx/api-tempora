// Da de alta la compañía del piloto desde un archivo JSON (ADR 0016). Se puede repetir.
//   npm run pilot:setup -- piloto.json [--solo-enlaces] [--reenviar]
//   (en la imagen: node dist/src/cli/pilot-setup.js piloto.json, o con - para leer de la entrada)
// Usa los servicios de Nest, así que corre compilado con tsc (tsx no emite los metadatos de los
// decoradores): npm run pilot:setup compila a dist-cli/ y no toca el dist/ de start:dev.
// Con --solo-enlaces no se manda ningún SMS ni correo: imprime los enlaces para compartirlos a mano.
// Con --reenviar manda de nuevo las invitaciones vigentes (la anterior deja de servir).
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { createAuth } from '../auth/auth.js';
import { mailerFromConfig } from '../auth/mail/from-config.js';
import type { SmsSender } from '../auth/messaging.js';
import { smsFromConfig } from '../auth/sms/from-config.js';
import { loadConfig } from '../config/config.js';
import { PilotSchema, setupPilot } from './pilot.js';

const args = process.argv.slice(2);
const linksOnly = args.includes('--solo-enlaces');
const resend = args.includes('--reenviar');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Uso: npm run pilot:setup -- piloto.json [--solo-enlaces] [--reenviar]');
  process.exit(1);
}

// Sin BOM: el Bloc de notas y PowerShell 5.1 lo agregan al guardar en UTF-8.
const parsed = PilotSchema.safeParse(
  JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8').replace(/^\uFEFF/, '')),
);
if (!parsed.success) {
  console.error('El archivo no es válido:');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.') || '(raíz)'}: ${i.message}`);
  process.exit(1);
}

const yes = (b: boolean) => (b ? 'creada' : 'ya existía');

const config = loadConfig();
const sent: { to: string; text: string }[] = [];
const realSms = smsFromConfig(config);
const sms: SmsSender = {
  async send(to, text) {
    sent.push({ to, text });
    if (!linksOnly) await realSms.send(to, text);
  },
};
const realMail = mailerFromConfig(config);
const auth = await createAuth(config, {
  mailer: {
    sendVerificationEmail: (to, url) => realMail.sendVerificationEmail(to, url),
    async sendInvitationEmail(to, url) {
      sent.push({ to, text: url });
      if (!linksOnly) await realMail.sendInvitationEmail(to, url);
    },
  },
  sms,
});
const ctx = await NestFactory.createApplicationContext(AppModule.forRoot(config, auth), {
  logger: ['error'],
});
try {
  const report = await setupPilot(ctx, auth, parsed.data, { resendInvitations: resend });
  console.info(`Compañía ${parsed.data.company.slug}: ${yes(report.created.company)} (${report.companyId})`);
  if (report.businessId) {
    console.info(
      `Negocio ${parsed.data.business!.slug}: ${report.created.business ? 'creado' : 'ya existía'}`,
    );
  }
  console.info(
    `Sede ${parsed.data.site.slug}: ${yes(report.created.site)} (${report.siteId}), configuración guardada`,
  );
  if (report.holidaysLoaded.length) console.info(`Festivos de ley: ${report.holidaysLoaded.join(', ')}`);
  const label = {
    assigned: 'rol asignado',
    'already-assigned': 'ya tenía el rol',
    invited: 'invitación enviada',
    'already-invited': 'ya tenía una invitación pendiente',
  } as const;
  for (const p of report.people) console.info(`  ${p.contact} (${p.role}): ${label[p.result]}`);
  if (sent.length) {
    console.info(
      linksOnly ? '\nEnlaces para compartir (no se mandó ningún SMS ni correo):' : '\nEnlaces de invitación:',
    );
    for (const s of sent) console.info(`  ${s.to}: ${s.text}`);
  }
} catch (e) {
  // Errores esperados (dueño inexistente, sede con otro negocio, permisos de Axeda): sin la pila.
  console.error(`No se pudo terminar: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await ctx.close();
}

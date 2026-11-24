import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AppModule } from './app.module.js';
import { createAuth, type Messaging } from './auth/auth.js';
import { clientIpMiddleware } from './common/client-ip.js';
import type { AppConfig } from './config/config.js';

export const AUTH_BASE_PATH = '/api/auth';

export async function createApp(config: AppConfig, messaging: Messaging = {}) {
  const auth = await createAuth(config, messaging);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, auth), {
    // Better Auth lee el cuerpo crudo: se monta antes de cualquier parser.
    bodyParser: false,
    logger: config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  // La IP del cliente sale del socket o, si hay proxies de confianza, de X-Forwarded-For (ADR 0016).
  express.set('trust proxy', config.TRUST_PROXY);
  express.use(clientIpMiddleware);
  express.all(`${AUTH_BASE_PATH}/{*any}`, toNodeHandler(auth.auth));
  app.useBodyParser('json', { limit: '100kb' });
  app.enableShutdownHooks();

  const openapi = cleanupOpenApiDoc(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Tempora API')
        .setDescription('Registro electrónico de jornada. Autenticación: cookie de Better Auth en /api/auth.')
        .setVersion('0.1.0')
        .addCookieAuth('better-auth.session_token')
        .build(),
    ),
  );
  SwaggerModule.setup('docs', app, openapi);
  await app.init();
  return { app, auth, openapi };
}

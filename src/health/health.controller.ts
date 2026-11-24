import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { AUTH, type AuthService } from '../auth/auth.js';
import { Public } from '../auth/require-permission.decorator.js';
import type { BasePrisma } from '../database/prisma-client.js';
import { PRISMA_BASE } from '../database/tenant-db.service.js';

/** Tiempo máximo de cada consulta de prueba: un balanceador no debe esperar más. */
const CHECK_TIMEOUT_MS = 2_000;

type Check = 'ok' | 'error';

async function check(fn: () => Promise<unknown>): Promise<Check> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([fn(), timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Salud de la API (ADR 0016). `/health` solo dice que el proceso responde (para reiniciarlo si se
 * cuelga); `/health/ready` además prueba las dos conexiones a Postgres (para no mandarle tráfico si
 * no tiene base). Ninguno revela detalles del error.
 */
@ApiTags('salud')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PRISMA_BASE) private readonly prisma: BasePrisma,
    @Inject(AUTH) private readonly auth: AuthService,
  ) {}

  @Get()
  @Public()
  @ApiOkResponse({ description: 'El proceso responde' })
  health() {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  @ApiOkResponse({ description: 'Lista para recibir tráfico: las dos conexiones a la base responden' })
  @ApiServiceUnavailableResponse({ description: 'Alguna conexión a la base no responde' })
  async ready() {
    const [database, auth] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => this.auth.pool.query('SELECT 1')),
    ]);
    const body = { status: database === 'ok' && auth === 'ok' ? 'ok' : 'unavailable', database, auth };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}

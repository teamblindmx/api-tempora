import { Body, Controller, Get, Module, NotFoundException, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { AuditModule } from '../audit/audit.module.js';
import { SiteDto, SiteSettingsDto } from './sites.schemas.js';
import { SitesRepository } from './sites.repository.js';

type SiteRow = NonNullable<Awaited<ReturnType<SitesRepository['findById']>>>;
const toDto = (s: SiteRow) => ({
  ...s,
  latitude: s.latitude.toNumber(),
  longitude: s.longitude.toNumber(),
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

/**
 * Datos de Tempora de las sedes. La sede se crea en Axeda (POST /api/auth/axeda/site/create) y aquí
 * se le pone ubicación y radio. Un líder de sede ve y ajusta solo la suya.
 */
@ApiTags('sedes')
@Controller()
class SitesController {
  constructor(private readonly sites: SitesRepository) {}

  @Get('companies/:companyId/sites')
  @RequirePermission(PERMISSIONS.siteRead, { company: 'companyId' })
  @ZodResponse({ type: [SiteDto] })
  async list(@Param('companyId') _companyId: string) {
    return (await this.sites.list()).map(toDto);
  }

  @Get('sites/:siteId')
  @RequirePermission(PERMISSIONS.siteRead, { site: 'siteId' })
  @ZodResponse({ type: SiteDto })
  async get(@Param('siteId') siteId: string) {
    const site = await this.sites.findById(siteId);
    if (!site) throw new NotFoundException('La sede no tiene ubicación configurada');
    return toDto(site);
  }

  @Put('sites/:siteId')
  @RequirePermission(PERMISSIONS.siteManage, { site: 'siteId' })
  @ZodResponse({ type: SiteDto })
  async save(@Param('siteId') _siteId: string, @Body() body: SiteSettingsDto) {
    return toDto(await this.sites.save(body));
  }
}

@Module({ imports: [AuditModule], controllers: [SitesController], providers: [SitesRepository] })
export class SitesModule {}

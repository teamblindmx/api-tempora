import { Body, Controller, Get, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { AuditModule } from '../audit/audit.module.js';
import { CreateSiteDto, SiteDto } from './sites.schemas.js';
import { SitesRepository } from './sites.repository.js';

type SiteRow = Awaited<ReturnType<SitesRepository['create']>>;
const toDto = (s: SiteRow) => ({
  ...s,
  latitude: s.latitude.toNumber(),
  longitude: s.longitude.toNumber(),
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

/**
 * Sedes de Tempora (ubicación y radio). Mientras Axeda no publique las sedes (alpha.2), el permiso
 * se comprueba en la compañía; después se enlazan por axedaSiteId y se podrá limitar por sede.
 */
@ApiTags('sedes')
@Controller('companies/:companyId/sites')
class SitesController {
  constructor(private readonly sites: SitesRepository) {}

  @Get()
  @RequirePermission(PERMISSIONS.siteRead, { company: 'companyId' })
  @ZodResponse({ type: [SiteDto] })
  async list(@Param('companyId') _companyId: string) {
    return (await this.sites.list()).map(toDto);
  }

  @Get(':siteId')
  @RequirePermission(PERMISSIONS.siteRead, { company: 'companyId' })
  @ZodResponse({ type: SiteDto })
  async get(@Param('companyId') _companyId: string, @Param('siteId', ParseUUIDPipe) siteId: string) {
    const site = await this.sites.findById(siteId);
    if (!site) throw new NotFoundException();
    return toDto(site);
  }

  @Post()
  @RequirePermission(PERMISSIONS.siteManage, { company: 'companyId' })
  @ZodResponse({ status: 201, type: SiteDto })
  async create(@Param('companyId') _companyId: string, @Body() body: CreateSiteDto) {
    return toDto(await this.sites.create(body));
  }
}

@Module({ imports: [AuditModule], controllers: [SitesController], providers: [SitesRepository] })
export class SitesModule {}

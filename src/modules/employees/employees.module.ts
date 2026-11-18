import { Controller, Get, Injectable, Module, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { TenantDb } from '../../database/tenant-db.service.js';

/**
 * Perfiles de recursos humanos. En Axeda un empleado es una asignación de un usuario en una sede; el
 * alta la hace el líder con una invitación de Axeda (POST /api/auth/axeda/invitation/create).
 */
@Injectable()
export class EmployeesRepository {
  constructor(private readonly db: TenantDb) {}
  /** Perfiles de la compañía, o solo los de una sede. */
  list(siteId?: string) {
    return this.db.run((tx, companyId) =>
      tx.employeeProfile.findMany({
        where: { companyId, ...(siteId ? { siteId } : {}) },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }
}

@ApiTags('empleados')
@Controller()
class EmployeesController {
  constructor(private readonly employees: EmployeesRepository) {}

  @Get('companies/:companyId/employees')
  @RequirePermission(PERMISSIONS.employeeRead, { company: 'companyId' })
  list(@Param('companyId') _companyId: string) {
    return this.employees.list();
  }

  @Get('sites/:siteId/employees')
  @RequirePermission(PERMISSIONS.employeeRead, { site: 'siteId' })
  listForSite(@Param('siteId') siteId: string) {
    return this.employees.list(siteId);
  }
}

@Module({
  controllers: [EmployeesController],
  providers: [EmployeesRepository],
  exports: [EmployeesRepository],
})
export class EmployeesModule {}

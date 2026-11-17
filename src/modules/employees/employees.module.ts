import { Controller, Get, Injectable, Module, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '../../auth/permissions.js';
import { RequirePermission } from '../../auth/require-permission.decorator.js';
import { TenantDb } from '../../database/tenant-db.service.js';

/** Perfiles de recursos humanos. El alta de empleados llega con Axeda alpha.2 (plan 0002). */
@Injectable()
export class EmployeesRepository {
  constructor(private readonly db: TenantDb) {}
  list() {
    return this.db.run((tx, companyId) =>
      tx.employeeProfile.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } }),
    );
  }
}

@ApiTags('empleados')
@Controller('companies/:companyId/employees')
class EmployeesController {
  constructor(private readonly employees: EmployeesRepository) {}

  @Get()
  @RequirePermission(PERMISSIONS.employeeRead, { company: 'companyId' })
  list(@Param('companyId') _companyId: string) {
    return this.employees.list();
  }
}

@Module({
  controllers: [EmployeesController],
  providers: [EmployeesRepository],
  exports: [EmployeesRepository],
})
export class EmployeesModule {}

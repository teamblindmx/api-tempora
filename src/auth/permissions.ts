/**
 * Catálogo de permisos de Tempora, por acción (no por rol). El código decide siempre por permiso;
 * el nombre de un rol nunca decide nada (ADR 0002, plan 0001 paso 4).
 */
export const PERMISSIONS = {
  siteRead: 'site:read',
  siteManage: 'site:manage',
  employeeRead: 'employee:read',
  employeeManage: 'employee:manage',
  /** Ver registros de asistencia de otros (datos de nómina). */
  attendanceRead: 'attendance:read',
  /** Marcar la propia entrada y salida. */
  attendanceMark: 'attendance:mark',
  /** Marcar por otro, con comentario obligatorio. */
  attendanceMarkManual: 'attendance:mark-manual',
  attendanceCorrect: 'attendance:correct',
  dailyCodeShow: 'daily-code:show',
  overtimeAuthorize: 'overtime:authorize',
  justificationWrite: 'justification:write',
  justificationResolve: 'justification:resolve',
  holidayManage: 'holiday:manage',
  reportExport: 'report:export',
  auditRead: 'audit:read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const PERMISSION_CATALOG: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * Permisos con datos de los clientes (asistencia, nómina, personas). Solo cuentan si se conceden en
 * la compañía o el negocio: un permiso global (el dueño de la plataforma, con "*") no da acceso.
 * Así el dueño de la plataforma no ve datos de nómina (ADR 0002).
 */
export const TENANT_DATA_PERMISSIONS: ReadonlySet<Permission> = new Set([
  PERMISSIONS.employeeRead,
  PERMISSIONS.employeeManage,
  PERMISSIONS.attendanceRead,
  PERMISSIONS.attendanceMark,
  PERMISSIONS.attendanceMarkManual,
  PERMISSIONS.attendanceCorrect,
  PERMISSIONS.dailyCodeShow,
  PERMISSIONS.overtimeAuthorize,
  PERMISSIONS.justificationWrite,
  PERMISSIONS.justificationResolve,
  PERMISSIONS.reportExport,
  PERMISSIONS.auditRead,
]);

const P = PERMISSIONS;
const leader = [
  P.siteRead,
  P.employeeRead,
  P.attendanceRead,
  P.attendanceMarkManual,
  P.attendanceCorrect,
  P.dailyCodeShow,
  P.overtimeAuthorize,
  P.justificationWrite,
];

/**
 * Roles gestionados en código; Axeda los sincroniza al arrancar. Son globales en Axeda y se asignan
 * en un alcance (compañía o negocio; sede cuando llegue alpha.2). El dueño de la plataforma es el
 * administrador global de Axeda (`npm run bootstrap:admin`), no un rol de aquí.
 *
 * Pendiente con el equipo de Axeda (ADR 0007): el líder aún no gestiona asignaciones ni invitaciones,
 * porque podría otorgar el rol de líder (riesgo de escalada lateral).
 */
export const ROLES = {
  'company-admin': {
    name: 'Administrador de compañía',
    permissions: [
      ...PERMISSION_CATALOG,
      'axeda:company:manage',
      'axeda:business:manage',
      'axeda:assignment:manage',
      'axeda:invitation:manage',
      'axeda:audit:read',
    ],
  },
  'business-admin': {
    name: 'Administrador de negocio',
    permissions: [
      ...PERMISSION_CATALOG.filter((p) => p !== P.holidayManage),
      'axeda:assignment:manage',
      'axeda:invitation:manage',
    ],
  },
  leader: { name: 'Líder', permissions: leader },
  worker: { name: 'Trabajador', permissions: [P.attendanceMark, P.justificationWrite] },
  'acting-leader': {
    name: 'Encargado',
    description: 'Permisos prestados del líder, con vencimiento (ADR 0007)',
    permissions: [P.attendanceRead, P.attendanceMarkManual, P.dailyCodeShow],
  },
} as const satisfies Record<string, { name: string; description?: string; permissions: readonly string[] }>;

export type RoleKey = keyof typeof ROLES;

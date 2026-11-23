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
  P.attendanceMark,
  P.siteRead,
  P.employeeRead,
  P.attendanceRead,
  P.attendanceMarkManual,
  P.attendanceCorrect,
  P.dailyCodeShow,
  P.overtimeAuthorize,
  P.justificationWrite,
  // Aprueba o rechaza las justificaciones de su sede (regla 12, versión simple; ADR 0014).
  P.justificationResolve,
];

/**
 * Roles gestionados en código; Axeda los sincroniza al arrancar. Son globales en Axeda y se asignan
 * en un alcance (compañía o negocio; sede cuando llegue alpha.2). El dueño de la plataforma es el
 * administrador global de Axeda (`npm run bootstrap:admin`), no un rol de aquí.
 *
 * El líder invita y asigna en su sede (alta de empleados y encargado). Axeda solo exige que quien
 * otorga cubra los permisos del rol, así que un líder podría otorgar el rol de líder: lo impide
 * GRANT_POLICY (src/auth/grant-policy.ts) antes de que la petición llegue a Axeda.
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
  leader: {
    name: 'Líder',
    permissions: [...leader, 'axeda:assignment:manage', 'axeda:invitation:manage'],
  },
  worker: { name: 'Trabajador', permissions: [P.attendanceMark, P.justificationWrite] },
  'acting-leader': {
    name: 'Encargado',
    description: 'Permisos prestados del líder, con vencimiento (ADR 0007)',
    permissions: [P.attendanceRead, P.attendanceMarkManual, P.dailyCodeShow],
  },
} as const satisfies Record<string, { name: string; description?: string; permissions: readonly string[] }>;

export type RoleKey = keyof typeof ROLES;

/** Nivel mínimo de quien otorga, en el lugar donde se otorga, para cada rol. */
export type GrantLevel = 'site' | 'business' | 'company' | 'global';

/**
 * Quién puede otorgar cada rol, además de lo que exige Axeda (tener el permiso y cubrir el rol).
 * Un líder (autoridad de sede) solo otorga trabajador y encargado; un administrador de negocio,
 * hasta líder y administrador de negocio; un administrador de compañía, cualquiera.
 */
export const GRANT_POLICY: Record<RoleKey, GrantLevel> = {
  worker: 'site',
  'acting-leader': 'site',
  leader: 'business',
  'business-admin': 'business',
  'company-admin': 'company',
};

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DAILY_CODE_DEFAULT_TTL, DAILY_CODE_MAX_TTL, DAILY_CODE_MIN_TTL } from './rules/marking.js';
import { MONTH } from './rules/panel.js';

/** Errores de negocio con código estable, para que el frontend muestre el mensaje correcto. */
export const ATTENDANCE_ERRORS = {
  siteNotConfigured: 'TEMPORA_SITE_NOT_CONFIGURED',
  codeInvalid: 'TEMPORA_CODE_INVALID',
  /** El código existió pero venció. La "entrada tardía" (regla 10) llega en la semana 3. */
  codeExpired: 'TEMPORA_CODE_EXPIRED',
  alreadyCheckedIn: 'TEMPORA_ALREADY_CHECKED_IN',
  notCheckedIn: 'TEMPORA_NOT_CHECKED_IN',
  alreadyCheckedOut: 'TEMPORA_ALREADY_CHECKED_OUT',
  /** Regla 7: la jornada abierta es de un día anterior; la corrige el líder. */
  exitPending: 'TEMPORA_EXIT_PENDING',
  earlyExitReasonRequired: 'TEMPORA_EARLY_EXIT_REASON_REQUIRED',
  /** Semana 3: panel, marcado manual y exportación. */
  dateInFuture: 'TEMPORA_DATE_IN_FUTURE',
  /** El líder no se marca a sí mismo a mano. */
  manualSelf: 'TEMPORA_MANUAL_SELF',
  /** La persona no está asignada a la sede (o no marca asistencia). */
  notSiteEmployee: 'TEMPORA_NOT_SITE_EMPLOYEE',
  /** La hora de un marcado manual está fuera de lo permitido (futuro, muy vieja, antes de la entrada). */
  manualTimeInvalid: 'TEMPORA_MANUAL_TIME_INVALID',
  /** Cerrar una salida pendiente exige la hora real de salida. */
  manualTimeRequired: 'TEMPORA_MANUAL_TIME_REQUIRED',
  rangeInvalid: 'TEMPORA_RANGE_INVALID',
} as const;

/** Ubicación del teléfono al marcar. Se lee solo en ese momento (regla 5). */
const LocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Precisión que reporta el navegador, en metros. Se guarda para revisar casos dudosos. */
  accuracyM: z.number().min(0).max(100_000).optional(),
});

export class CreateDailyCodeDto extends createZodDto(
  z.object({
    ttlMinutes: z
      .number()
      .int()
      .min(DAILY_CODE_MIN_TTL)
      .max(DAILY_CODE_MAX_TTL)
      .default(DAILY_CODE_DEFAULT_TTL),
  }),
) {}

export const DailyCodeSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  code: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export class DailyCodeDto extends createZodDto(DailyCodeSchema) {}

export class CheckInDto extends createZodDto(
  z.object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
    /** null o ausente si el teléfono no dio ubicación: el registro queda "por revisar", no se rechaza. */
    location: LocationSchema.nullable().default(null),
  }),
) {}

export class CheckOutDto extends createZodDto(
  z.object({
    location: LocationSchema.nullable().default(null),
    /** Motivo; obligatorio en una salida anticipada (regla 6). */
    reason: z.string().trim().min(3).max(500).nullable().default(null),
  }),
) {}

export const AttendanceRecordSchema = z.object({
  id: z.string(),
  siteId: z.string(),
  userId: z.string(),
  /** Día de jornada en la zona de la sede, "YYYY-MM-DD". */
  workDate: z.string(),
  /** open: falta la salida; pending-exit: quedó sin salida un día anterior (regla 7); closed. */
  status: z.enum(['open', 'pending-exit', 'closed']),
  checkInAt: z.iso.datetime(),
  checkInDistanceM: z.number().int().nullable(),
  /** self: el trabajador, con código y ubicación; manual: el líder por él (ADR 0013). */
  checkInSource: z.enum(['self', 'manual']),
  /** Quién registró una entrada manual, y por qué. */
  checkInBy: z.string().nullable(),
  checkInComment: z.string().nullable(),
  checkOutAt: z.iso.datetime().nullable(),
  checkOutDistanceM: z.number().int().nullable(),
  checkOutKind: z.enum(['regular', 'early']).nullable(),
  checkOutReason: z.string().nullable(),
  checkOutSource: z.enum(['self', 'manual']).nullable(),
  checkOutBy: z.string().nullable(),
  checkOutComment: z.string().nullable(),
  /** Minutos entre entrada y salida; null sin salida. */
  workedMinutes: z.number().int().nullable(),
  needsReview: z.boolean(),
  reviewReasons: z.array(z.string()),
});
export type AttendanceRecord = z.infer<typeof AttendanceRecordSchema>;
export class AttendanceRecordDto extends createZodDto(AttendanceRecordSchema) {}

export class MyAttendanceDto extends createZodDto(
  z.object({
    /** Día de hoy en la sede. */
    today: z.string(),
    /** La jornada de hoy, o null si aún no entra. */
    record: AttendanceRecordSchema.nullable(),
    /** Jornadas anteriores sin salida: las corrige el líder. */
    pendingExits: z.array(AttendanceRecordSchema),
  }),
) {}

// ---------------------------------------------------------------------------------------------
// Semana 3: panel del líder, marcado manual, calendario y exportación.

const DateString = z.iso.date();

/** Comentario obligatorio de todo marcado manual (regla 13). */
const Comment = z.string().trim().min(5, 'Escribe un comentario de al menos 5 letras').max(500);

/** Hora de un marcado manual. Sin ella, la del servidor. Nunca en el futuro (lo revisa el servicio). */
const ManualAt = z.iso.datetime({ offset: true }).nullable().default(null);

export class DayQueryDto extends createZodDto(
  z.object({
    /** Día en la zona de la sede. Sin él, hoy. */
    date: DateString.optional(),
  }),
) {}

export const PersonSchema = z.object({
  userId: z.string(),
  name: z.string(),
  phoneNumber: z.string().nullable(),
  email: z.string().nullable(),
});

export const PanelEntrySchema = z.object({
  person: PersonSchema,
  /** false: marcó en la sede ese día pero ya no está asignada a ella. */
  onRoster: z.boolean(),
  /** missing: no ha entrado; o el estado de su jornada. */
  status: z.enum(['missing', 'open', 'pending-exit', 'closed']),
  /** Minutos después de la entrada oficial (0 si llegó antes). Null sin horario o sin entrada. */
  minutesAfterStart: z.number().int().nullable(),
  /** Entrada o salida registrada por el líder. */
  manual: z.boolean(),
  record: AttendanceRecordSchema.nullable(),
});

export class SiteDayDto extends createZodDto(
  z.object({
    siteId: z.string(),
    date: z.string(),
    today: z.string(),
    timezone: z.string(),
    shift: z.object({ start: z.string(), end: z.string() }).nullable(),
    summary: z.object({
      expected: z.number().int(),
      arrived: z.number().int(),
      missing: z.number().int(),
      open: z.number().int(),
      closed: z.number().int(),
      pendingExit: z.number().int(),
      needsReview: z.number().int(),
      manual: z.number().int(),
    }),
    /** Primero quien falta, luego quien está dentro, luego quien ya salió; por nombre. */
    entries: z.array(PanelEntrySchema),
    /** Jornadas de días anteriores (hasta 31) que quedaron sin salida: las cierra el líder. */
    pendingExits: z.array(PanelEntrySchema),
  }),
) {}

export class ManualCheckInDto extends createZodDto(
  z.object({
    /** Usuario de Axeda asignado a la sede. */
    userId: z.string().min(1).max(128),
    comment: Comment,
    /** Hora real de llegada si el líder la registra después (hasta 7 días atrás). */
    at: ManualAt,
  }),
) {}

export class ManualCheckOutDto extends createZodDto(
  z.object({
    userId: z.string().min(1).max(128),
    comment: Comment,
    /** Hora real de salida. Obligatoria para cerrar una salida pendiente de otro día. */
    at: ManualAt,
    /** Jornada a cerrar. Sin ella, la más reciente sin salida. */
    workDate: DateString.nullable().default(null),
  }),
) {}

export class CalendarQueryDto extends createZodDto(
  z.object({
    /** "YYYY-MM" en la zona de la sede. Sin él, el mes actual. */
    month: z.string().regex(MONTH, 'Mes con formato YYYY-MM').optional(),
  }),
) {}

export class CalendarDto extends createZodDto(
  z.object({
    siteId: z.string(),
    userId: z.string(),
    month: z.string(),
    today: z.string(),
    days: z.array(
      z.object({
        date: z.string(),
        /** no-record: sin jornada (no es "falta": aún no hay días de descanso); future: aún no llega. */
        status: z.enum(['open', 'pending-exit', 'closed', 'no-record', 'future']),
        record: AttendanceRecordSchema.nullable(),
      }),
    ),
    totals: z.object({
      daysWorked: z.number().int(),
      workedMinutes: z.number().int(),
      pendingExits: z.number().int(),
      needsReview: z.number().int(),
      manual: z.number().int(),
    }),
  }),
) {}

export class ExportQueryDto extends createZodDto(
  z.object({
    /** Primer día, "YYYY-MM-DD" (fecha de jornada en la zona de cada sede). */
    from: DateString,
    /** Último día, incluido. Hasta 62 días después de from. */
    to: DateString,
  }),
) {}

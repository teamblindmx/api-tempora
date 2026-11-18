import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DAILY_CODE_DEFAULT_TTL, DAILY_CODE_MAX_TTL, DAILY_CODE_MIN_TTL } from './rules/marking.js';

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
  checkOutAt: z.iso.datetime().nullable(),
  checkOutDistanceM: z.number().int().nullable(),
  checkOutKind: z.enum(['regular', 'early']).nullable(),
  checkOutReason: z.string().nullable(),
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

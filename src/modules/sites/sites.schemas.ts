import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DEFAULT_RADIUS_M } from '../attendance/rules/location.js';
import { DEFAULT_REST_DAYS } from '../attendance/rules/calendar.js';
import { DEFAULT_LATE_TOLERANCE_MIN, MAX_LATE_TOLERANCE_MIN } from '../attendance/rules/lateness.js';
import { HHMM, isValidTimeZone } from '../attendance/rules/workday.js';

const time = z.string().regex(HHMM, 'Formato HH:MM, 24 horas');

/** Lo que Tempora guarda de una sede de Axeda. La compañía y el negocio salen de Axeda, no del cuerpo. */
export const SiteSettingsSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusM: z.number().int().min(50).max(5_000).default(DEFAULT_RADIUS_M),
    timezone: z
      .string()
      .refine(isValidTimeZone, 'Zona horaria IANA, p. ej. America/Mexico_City')
      .default('America/Mexico_City'),
    /** Horario oficial en la zona de la sede. Los dos o ninguno; si el cierre es antes, cruza la medianoche. */
    shiftStart: time.nullable().default(null),
    shiftEnd: time.nullable().default(null),
    /** Minutos después de la entrada oficial antes de contar retardo (ADR 0014). */
    lateToleranceMin: z.number().int().min(0).max(MAX_LATE_TOLERANCE_MIN).default(DEFAULT_LATE_TOLERANCE_MIN),
    /** Días de descanso semanal: 0 = domingo ... 6 = sábado. Al menos un día laborable. */
    restDays: z
      .array(z.number().int().min(0).max(6))
      .max(6)
      .refine((d) => new Set(d).size === d.length, 'Días repetidos')
      .transform((d) => d.toSorted((a, b) => a - b))
      .default([...DEFAULT_REST_DAYS]),
  })
  .refine((s) => (s.shiftStart === null) === (s.shiftEnd === null), {
    message: 'shiftStart y shiftEnd van juntos',
    path: ['shiftEnd'],
  });
export type SiteSettingsInput = z.infer<typeof SiteSettingsSchema>;
export class SiteSettingsDto extends createZodDto(SiteSettingsSchema) {}

export const SiteSchema = z.object({
  /** Id de la sede en Axeda. */
  id: z.string(),
  companyId: z.string(),
  businessId: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  radiusM: z.number().int(),
  timezone: z.string(),
  shiftStart: z.string().nullable(),
  shiftEnd: z.string().nullable(),
  lateToleranceMin: z.number().int(),
  restDays: z.array(z.number().int()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export class SiteDto extends createZodDto(SiteSchema) {}

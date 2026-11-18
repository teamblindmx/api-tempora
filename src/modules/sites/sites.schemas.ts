import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DEFAULT_RADIUS_M } from '../attendance/rules/location.js';

/** Lo que Tempora guarda de una sede de Axeda. La compañía y el negocio salen de Axeda, no del cuerpo. */
export const SiteSettingsSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().int().min(50).max(5_000).default(DEFAULT_RADIUS_M),
  timezone: z.string().min(1).default('America/Mexico_City'),
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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export class SiteDto extends createZodDto(SiteSchema) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { DEFAULT_RADIUS_M } from '../attendance/rules/location.js';

export const CreateSiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  businessId: z.string().min(1).max(128).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusM: z.number().int().min(50).max(5_000).default(DEFAULT_RADIUS_M),
  timezone: z.string().min(1).default('America/Mexico_City'),
});
export type CreateSiteInput = z.infer<typeof CreateSiteSchema>;
export class CreateSiteDto extends createZodDto(CreateSiteSchema) {}

export const SiteSchema = z.object({
  id: z.uuid(),
  companyId: z.string(),
  businessId: z.string().nullable(),
  axedaSiteId: z.string().nullable(),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  radiusM: z.number().int(),
  timezone: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export class SiteDto extends createZodDto(SiteSchema) {}

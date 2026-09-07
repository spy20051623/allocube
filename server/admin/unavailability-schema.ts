import { z } from "zod";

export const plannedUnavailabilityPreviewSchema = z
  .object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime()
  })
  .refine((value) => value.startAt < value.endAt, {
    message: "维护结束时间必须晚于开始时间"
  });

export const plannedUnavailabilitySchema = plannedUnavailabilityPreviewSchema.and(
  z.object({
    reason: z.string().max(1000).optional().default(""),
    expectedRevision: z.number().int().min(1)
  })
);

export const maintenancePreviewSchema = plannedUnavailabilityPreviewSchema.and(
  z.object({
    resourceGroupId: z.string().uuid().nullable().optional()
  })
);

export const maintenanceSchema = maintenancePreviewSchema.and(
  z.object({
    reason: z.string().max(1000).optional().default(""),
    expectedRevision: z.number().int().min(1)
  })
);

export const versionSchema = z.object({
  expectedVersion: z.number().int().min(1)
});

export const longDisableSchema = versionSchema.extend({
  expectedRevision: z.number().int().min(1),
  reason: z.string().max(1000).optional().default("")
});

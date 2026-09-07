import { z } from "zod";
import { BusinessError } from "./business-error.js";
import { replacementSelectionSchema } from "./scheduling.js";

export const reservationBatchRequestSchema = z.object({
  segments: z.array(z.unknown()).min(1).max(100),
  replaceReservationId: z.string().uuid().optional(),
  replaceReservations: replacementSelectionSchema.optional(),
  autoAdjust: z.boolean().optional().default(false)
});

export function assertReservationReplacementOptions(
  options: Pick<z.infer<typeof reservationBatchRequestSchema>, "replaceReservationId" | "replaceReservations" | "autoAdjust">
) {
  if (options.autoAdjust && options.replaceReservationId) {
    throw new BusinessError("请使用批量编辑参数提交自动调整");
  }
  if (options.replaceReservationId && options.replaceReservations) {
    throw new BusinessError("不能同时使用单条和批量编辑参数");
  }
}

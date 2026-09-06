import type { FastifyRequest } from "fastify";
import { BusinessError } from "./business-error.js";

/** Internal editors only. This never bypasses authorization or business rules. */
export function overwriteRequested(request: FastifyRequest) {
  return request.headers["x-allocube-overwrite"] === "true";
}

export function checkEditVersion(current: number, expected: number, overwrite = false, code = "EDIT_CONFLICT") {
  if (!overwrite && current !== expected) {
    throw new BusinessError("数据已更新，请确认是否继续修改", 409, undefined, code);
  }
}

import { ApiError } from "./api";

export function fieldErrorFromApi(error: unknown, field: string) {
  if (!(error instanceof ApiError) || !error.fieldErrors || typeof error.fieldErrors !== "object") {
    return "";
  }
  const value = (error.fieldErrors as Record<string, unknown>)[field];
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

export function validationDetailFromApi(error: unknown, field: string) {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return "";
  const issue = error.details.find(
    (item): item is { path: string; message: string } =>
      Boolean(
        item &&
        typeof item === "object" &&
        "path" in item &&
        item.path === field &&
        "message" in item &&
        typeof item.message === "string"
      )
  );
  return issue?.message ?? "";
}

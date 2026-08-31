import { currentLocale, tr, translateServerMessage } from "./i18n";
import serverEnglish from "./i18n/server-en.json";
import { createSystemMessageCatalog } from "./shared/system-message";

const systemMessages = createSystemMessageCatalog(serverEnglish);

let csrfToken = "";

function localizeApiValue(value: unknown, key = ""): unknown {
  if (currentLocale() !== "en") return value;
  if (typeof value === "string") {
    return ["error", "message", "fieldErrors", "details"].includes(key)
      ? translateServerMessage(value)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => localizeApiValue(item, key));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [childKey, childValue] of Object.entries(record)) {
      if (key === "fieldErrors" || key === "details" || ["error", "message", "fieldErrors"].includes(childKey)) {
        record[childKey] = localizeApiValue(childValue, childKey);
      }
    }
  }
  return value;
}

function localizeCodedApiError(value: unknown) {
  if (currentLocale() !== "en" || !value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const params = record.params && typeof record.params === "object"
    ? record.params as Record<string, unknown>
    : {};
  const candidateCodes = [record.code, record.messageCode]
    .filter((code): code is string => typeof code === "string");
  const translated = candidateCodes
    .map((code) => systemMessages.translate(code, params))
    .find((message): message is string => typeof message === "string");
  if (!translated) return;
  if (typeof record.error === "string") record.error = translated;
  if (typeof record.message === "string") record.message = translated;
}

export function setCsrfToken(value: string) {
  csrfToken = value;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    public code?: string,
    public fieldErrors?: unknown,
    public params?: Record<string, unknown>,
    public messageCode?: string,
    public fieldErrorCodes?: unknown
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  if (csrfToken && !["GET", "HEAD"].includes(options.method ?? "GET")) {
    headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "same-origin"
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  localizeCodedApiError(payload);
  localizeApiValue(payload);
  if (!response.ok) {
    throw new ApiError(
      typeof payload === "object" && payload?.error ? payload.error : tr("请求失败"),
      response.status,
      typeof payload === "object" ? payload?.details : undefined,
      typeof payload === "object" && typeof payload?.code === "string"
        ? payload.code
        : undefined,
      typeof payload === "object" ? payload?.fieldErrors : undefined,
      typeof payload === "object" && payload?.params && typeof payload.params === "object"
        ? payload.params
        : undefined,
      typeof payload === "object" && typeof payload?.messageCode === "string"
        ? payload.messageCode
        : undefined,
      typeof payload === "object" ? payload?.fieldErrorCodes : undefined
    );
  }
  return payload as T;
}

export function jsonBody(value: unknown) {
  return JSON.stringify(value);
}

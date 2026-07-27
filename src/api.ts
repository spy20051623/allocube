let csrfToken = "";

export function setCsrfToken(value: string) {
  csrfToken = value;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    public code?: string,
    public fieldErrors?: unknown
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
  if (!response.ok) {
    throw new ApiError(
      typeof payload === "object" && payload?.error ? payload.error : "请求失败",
      response.status,
      typeof payload === "object" ? payload?.details : undefined,
      typeof payload === "object" && typeof payload?.code === "string"
        ? payload.code
        : undefined,
      typeof payload === "object" ? payload?.fieldErrors : undefined
    );
  }
  return payload as T;
}

export function jsonBody(value: unknown) {
  return JSON.stringify(value);
}

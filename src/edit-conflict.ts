import { api, ApiError } from "./api";
import { withRequestDeadline } from "./request-deadline";

export class EditCancelled extends Error {}
export class EditOutcomeUnknown extends Error {}

// Shared by settings and the other editors, including across unmount/remount.
const pending = new Set<string>();
const uncertain = new Set<string>();
export function hasUncertainEdit(paths: readonly string[]) { return paths.some(path => uncertain.has(path)); }
export function markEditUncertain(path: string) { uncertain.add(path); }
export function claimEdit(path: string) {
  if (uncertain.has(path)) throw new EditOutcomeUnknown();
  if (pending.has(path)) throw new EditCancelled();
  pending.add(path);
  return () => pending.delete(path);
}

/** An action's reason dialog is its draft. Cancelling overwrite returns to that input. */
export async function editWithRetainedReason<T>(options: RequestInit,
  run: (options: RequestInit) => Promise<T>,
  resume: (options: RequestInit) => Promise<RequestInit | null>) {
  let draft = options;
  for (;;) {
    try { return await run(draft); }
    catch (error) {
      if (!(error instanceof EditCancelled)) throw error;
      const next = await resume(draft);
      if (!next) throw error;
      draft = next;
    }
  }
}

const conflictCodes = new Set([
  "EDIT_CONFLICT", "MACHINE_SETTINGS_STALE", "RESOURCE_CONFIGURATION_STALE",
  "FEEDBACK_STALE", "ANNOUNCEMENT_STALE", "UNAVAILABILITY_PREVIEW_STALE", "USER_DISABLE_PREVIEW_STALE"
]);

/** The confirmation is outside the request deadline. Never replay ambiguous writes. */
export async function confirmedEdit<T>(path: string, options: RequestInit,
  confirm: (impactChanged: boolean) => Promise<boolean>, signal: AbortSignal,
  send: typeof api = api): Promise<T> {
  const headers = new Headers(options.headers);
  headers.delete("x-allocube-overwrite");
  const attempt = (overwrite: boolean) => {
    const attemptHeaders = new Headers(headers);
    if (overwrite) attemptHeaders.set("x-allocube-overwrite", "true");
    return withRequestDeadline(async child => {
      const result = await send<T>(path, { ...options, headers: attemptHeaders, signal: child });
      if (!result || typeof result !== "object" || Array.isArray(result) || !Object.keys(result).length || "error" in result) throw new EditOutcomeUnknown();
      return result;
    }, signal);
  };
  try {
    try { return await attempt(false); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || !conflictCodes.has(error.code ?? "")) throw error;
      if (signal.aborted || !(await confirm(error.code?.includes("PREVIEW") ?? false)) || signal.aborted) throw new EditCancelled();
      return await attempt(true);
    }
  } catch (error) {
    if (error instanceof EditCancelled || error instanceof ApiError && error.status < 500) throw error;
    throw new EditOutcomeUnknown();
  }
}

/** Retain the baseline version along with a dirty draft; never silently advance it. */
export function canSyncDraft(baseline: unknown, draft: unknown, busy: boolean) {
  return !busy && JSON.stringify(baseline) === JSON.stringify(draft);
}

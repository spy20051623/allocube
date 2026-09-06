interface SmtpConfiguration {
  host: string;
  port: number;
  security: string;
  username: string;
  fromName: string;
  fromAddress: string;
}

/** Cancelling an overwrite confirmation is not a failed save. */
export class SettingsSaveCancelled extends Error {}

export function validateSettingsResponse(value: unknown, smtp = false) {
  if (!value || typeof value !== "object") throw new Error("Invalid settings response");
  const row = value as Record<string, unknown>;
  const strings = smtp ? ["host", "security", "username", "fromName", "fromAddress", "passwordStatus", "updatedAt"]
    : ["timezone", "siteOrigin", "icpFilingNumber", "publicSecurityFilingNumber"];
  const numbers = smtp ? ["version", "port"] : ["version", "minBookingMinutes", "maxBookingMinutes", "advanceDays"];
  const booleans = smtp ? ["enabled", "hasPassword", "testable", "operational"] : ["allowRegistrationWithoutEmail"];
  if (!strings.every(key => typeof row[key] === "string") ||
    !numbers.every(key => Number.isInteger(row[key]) && Number(row[key]) > 0) ||
    !booleans.every(key => typeof row[key] === "boolean")) throw new Error("Invalid settings response");
  if (!smtp && (!Array.isArray(row.allowedEmailDomains) || !row.allowedEmailDomains.every(domain => typeof domain === "string"))) throw new Error("Invalid settings response");
  if (smtp) {
    const queue = row.queue as Record<string, unknown> | undefined;
    const lastTest = row.lastTest as Record<string, unknown> | null;
    if (!["IMPLICIT_TLS", "STARTTLS"].includes(String(row.security)) || !["NOT_SET", "READY", "UNREADABLE"].includes(String(row.passwordStatus)) ||
      !queue || !Number.isInteger(queue.pending) || !Number.isInteger(queue.failed) || typeof queue.lastError !== "string" ||
      lastTest !== null && (!lastTest || !["SUCCESS", "FAILED"].includes(String(lastTest.status)) || typeof lastTest.error !== "string" || lastTest.testedAt !== null && typeof lastTest.testedAt !== "string")) throw new Error("Invalid settings response");
  }
}

/** A read started before a write/reload can never replace a newer settings snapshot. */
export class SettingsRequestGate {
  private epoch = 0;
  private reader: AbortController | null = null;
  writing = false;

  invalidate() { this.epoch++; this.reader?.abort(); }
  beginWrite() {
    if (this.writing) return false;
    this.invalidate(); this.writing = true;
    return true;
  }
  endWrite() { this.writing = false; this.epoch++; }

  beginRead(parent: AbortSignal) {
    if (this.writing) return null;
    this.reader?.abort();
    const controller = new AbortController(), epoch = this.epoch;
    this.reader = controller;
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) abort();
    return {
      signal: controller.signal,
      current: () => !controller.signal.aborted && epoch === this.epoch && !this.writing,
      dispose: () => {
        parent.removeEventListener("abort", abort);
        if (this.reader === controller) this.reader = null;
      }
    };
  }
}

export function olderSettingsVersion(
  previous: { adminSettings: { version: number } | null; smtp: { version: number } | null },
  settings: { version: number }, smtp: { version: number }
) {
  return Boolean(previous.adminSettings && settings.version < previous.adminSettings.version ||
    previous.smtp && smtp.version < previous.smtp.version);
}

export function smtpConfigurationIsDirty(
  saved: SmtpConfiguration | null,
  draft: SmtpConfiguration,
  password: string,
  clearPassword: boolean
) {
  // Loading has no saved baseline to compare against; it is not an unsaved edit.
  return Boolean(saved && (
    saved.host !== draft.host ||
    saved.port !== draft.port ||
    saved.security !== draft.security ||
    saved.username !== draft.username ||
    saved.fromName !== draft.fromName ||
    saved.fromAddress !== draft.fromAddress ||
    password || clearPassword
  ));
}

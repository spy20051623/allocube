import { tr } from "../../i18n";
import { accessExpiryInput } from "../machines/AccessExpiryField";

export function calendarAccessExpiryLabel(expiresAt: string) {
  return tr("有效至 {{date}} 24:00（北京时间）", { date: accessExpiryInput(expiresAt) });
}

export function accessExpiryIssues(startAt: string, endAt: string, expiresAt?: string | null) {
  if (!expiresAt) return {};
  const boundary = Date.parse(expiresAt);
  const message = tr("所选时间超出机器使用期限");
  return {
    ...(Date.parse(startAt) >= boundary ? { startAt: message } : {}),
    ...(Date.parse(endAt) > boundary ? { endAt: message } : {})
  };
}

export function accessExpiryBusyRanges(expiresAt?: string | null) {
  return expiresAt ? [{ startAt: expiresAt, endAt: "9999-12-31T23:59:59.999Z" }] : [];
}

export const SYSTEM_MAINTENANCE_MAX_LENGTH = 120;

export interface SystemMaintenanceNotice {
  text: string;
  version: number;
}

export function normalizeSystemMaintenanceText(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

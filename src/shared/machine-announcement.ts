export const MACHINE_ANNOUNCEMENT_MAX_LENGTH = 2000;

export function normalizeMachineAnnouncement(value: string): string {
  return value.replace(/\r\n?|[\u2028\u2029]/g, "\n").trim();
}

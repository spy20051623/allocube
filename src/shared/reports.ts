export const REPORT_DAY_MS = 86_400_000;
export function reportDate(time: number = Date.now()): string {
  return new Date(time + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function reportDayStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}
export function shiftReportDate(date: string, days: number): string {
  return reportDate(reportDayStart(date) + days * REPORT_DAY_MS);
}
export function latestReportDate(time: number = Date.now()): string {
  const today = reportDate(time);
  return shiftReportDate(today, time - reportDayStart(today) < 6 * 3_600_000 ? -2 : -1);
}
export interface ReportJob {
  id: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  fromDate: string;
  toDate: string;
  completedDays: number;
  totalDays: number;
  createdAt: string;
  finishedAt: string | null;
}
export interface UsageReport {
  groups: Array<{
    machineId: string; machineName: string; resourceGroupId: string; groupName: string;
    resourceSummary: string; reservedMinutes: number; availableMinutes: number;
    utilization: number; deleted: boolean;
  }>;
  users: Array<{ displayName: string; employeeNumber: string | null; reservedMinutes: number }>;
  summary: { reservationCount: number; reservedMinutes: number; availableMinutes: number; utilization: number };
  coverage: {
    version: string | null; generatedAt: string | null; latestCompletedDate: string | null;
    earliestDate: string; latestDueDate: string; completedDays: number; pendingDates: string[];
  };
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessMachine, getAccessibleMachineIds, requireAuth, requireSystemAdmin } from "./auth.js";
import { db } from "./db.js";
import { mapResourceGroups } from "./resources.js";
import { ReportStore } from "./report-store.js";
import { wakeReportScheduler } from "./report-scheduler.js";
import { latestReportDate, reportDayStart, REPORT_DAY_MS, shiftReportDate, type UsageReport } from "../src/shared/reports.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}, "统计日期无效");
const querySchema = z.object({
  fromDate: date, toDate: date, machineId: z.string().uuid().optional(),
  locale: z.enum(["zh-CN", "en"]).default("zh-CN")
}).strict().refine((v) => v.fromDate <= v.toDate, "统计结束日期不能早于开始日期")
  .refine((v) => reportDayStart(v.toDate) - reportDayStart(v.fromDate) < 366 * REPORT_DAY_MS, "单次统计范围不能超过 366 天");

export function readUsageReport(machineIds: string[], from: string, to: string): UsageReport {
  // Pin generation, coverage, permissions-independent facts and display data to one read transaction.
  return db.transaction(() => {
    const store = new ReportStore(db), state = store.state()!;
    const version = state.active_version;
    const allDays = db.prepare("SELECT day,completed_at FROM report_days WHERE version_id=? AND day BETWEEN ? AND ?")
      .all(version, from, to) as Array<{ day: string; completed_at: string }>;
    const complete = new Set(allDays.map((r) => r.day));
    const pendingDates: string[] = [];
    for (let d = from; d <= to; d = shiftReportDate(d, 1)) if (d >= state.earliest_date && !complete.has(d)) pendingDates.push(d);
    const latest = db.prepare("SELECT MAX(day) AS day, MAX(completed_at) AS generated FROM report_days WHERE version_id=?").get(version) as { day: string | null; generated: string | null };
    const report: UsageReport = {
      groups: [], users: [], summary: { reservationCount: 0, reservedMinutes: 0, availableMinutes: 0, utilization: 0 },
      coverage: { version, generatedAt: latest.generated, latestCompletedDate: latest.day, earliestDate: state.earliest_date,
        latestDueDate: latestReportDate(), completedDays: complete.size, pendingDates }
    };
    if (!machineIds.length) return report;
    const allowed = JSON.stringify(machineIds);
    const facts = db.prepare(`SELECT f.group_id, f.machine_id, SUM(f.reserved_ms) AS reserved, SUM(f.available_ms) AS available,
      rg.*, m.name AS machine_name,
      (rg.id IS NULL OR dg.resource_group_id IS NOT NULL) AS group_deleted,
      (m.id IS NULL OR dm.machine_id IS NOT NULL) AS machine_deleted
      FROM report_group_days f LEFT JOIN resource_groups rg ON rg.id=f.group_id
      LEFT JOIN machines m ON m.id=f.machine_id
      LEFT JOIN deleted_resource_group_tombstones dg ON dg.resource_group_id=f.group_id
      LEFT JOIN deleted_machine_tombstones dm ON dm.machine_id=f.machine_id
      WHERE f.version_id=? AND f.day BETWEEN ? AND ? AND f.machine_id IN (SELECT value FROM json_each(?))
      GROUP BY f.group_id ORDER BY m.name, rg.sort_order, rg.name, f.group_id`).all(version, from, to, allowed) as Array<Record<string, unknown> & {
        group_id: string; machine_id: string; reserved: number; available: number;
        machine_name: string; name: string; group_deleted: number; machine_deleted: number;
      }>;
    const visibleGroups = facts.filter((r) => !r.group_deleted && !r.machine_deleted);
    const summaries = new Map<string, string>();
    // Bound IN parameters even on installations with many resource groups.
    for (let offset = 0; offset < visibleGroups.length; offset += 100) {
      for (const group of mapResourceGroups(visibleGroups.slice(offset, offset + 100))) summaries.set(group.id, group.resourceSummary);
    }
    let reserved = 0, available = 0;
    for (const row of facts) {
      reserved += row.reserved; available += row.available;
      report.groups.push({ machineId: row.machine_id, machineName: row.machine_deleted ? "机器已删除" : row.machine_name,
        resourceGroupId: row.group_id, groupName: row.group_deleted || row.machine_deleted ? "资源组已删除" : row.name,
        resourceSummary: summaries.get(row.group_id) ?? "资源已删除", deleted: Boolean(row.group_deleted || row.machine_deleted),
        reservedMinutes: Math.round(row.reserved / 60_000), availableMinutes: Math.round(row.available / 60_000),
        utilization: row.available > 0 ? Number((row.reserved / row.available * 100).toFixed(1)) : 0 });
    }
    const userRows = db.prepare(`SELECT f.user_id, SUM(f.reserved_ms) AS reserved,
      CASE WHEN u.id IS NULL OR du.user_id IS NOT NULL THEN '用户已删除' ELSE u.display_name END AS display_name,
      CASE WHEN du.user_id IS NULL THEN (SELECT employee_number FROM employee_numbers en WHERE en.user_id=u.id AND status='ACTIVE' LIMIT 1) END AS employee_number
      FROM report_reservation_days f LEFT JOIN users u ON u.id=f.user_id
      LEFT JOIN deleted_user_tombstones du ON du.user_id=f.user_id
      WHERE f.version_id=? AND f.day BETWEEN ? AND ? AND f.machine_id IN (SELECT value FROM json_each(?))
      GROUP BY f.user_id ORDER BY reserved DESC, f.user_id`).all(version, from, to, allowed) as Array<{ reserved: number; display_name: string; employee_number: string | null }>;
    report.users = userRows.map((r) => ({ displayName: r.display_name, employeeNumber: r.employee_number, reservedMinutes: Math.round(r.reserved / 60_000) }));
    const count = db.prepare(`SELECT COUNT(DISTINCT reservation_id) AS count FROM report_reservation_days
      WHERE version_id=? AND day BETWEEN ? AND ? AND machine_id IN (SELECT value FROM json_each(?))`).get(version, from, to, allowed) as { count: number };
    report.summary = { reservationCount: count.count, reservedMinutes: Math.round(reserved / 60_000),
      availableMinutes: Math.round(available / 60_000), utilization: available > 0 ? Number((reserved / available * 100).toFixed(1)) : 0 };
    return report;
  })();
}

export function registerReportRoutes(app: FastifyInstance, csvCell: (value: string) => string) {
  const store = new ReportStore(db);
  store.initialize();
  for (const csv of [false, true]) app.get(csv ? "/api/v1/admin/report.csv" : "/api/v1/admin/report", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const query = querySchema.parse(request.query);
    const ids = query.machineId ? (canAccessMachine(auth.user.id, auth.user.role, query.machineId) ? [query.machineId] : [])
      : auth.user.role === "SYSTEM_ADMIN" ? (db.prepare("SELECT id FROM machines").all() as Array<{ id: string }>).map((r) => r.id)
      : getAccessibleMachineIds(auth.user.id, auth.user.role);
    const report = readUsageReport(ids, query.fromDate, query.toDate);
    if (!csv) return report;
    if (report.coverage.pendingDates.length) return reply.code(409).send({ error: "所选日期尚未完成统计，暂不能导出", code: "REPORT_NOT_READY" });
    const lines = [query.locale === "en"
      ? ["Machine", "Resource group", "Resources", "Reserved minutes", "Available minutes", "Utilization"]
      : ["机器", "资源组", "资源组成", "占用分钟", "可用分钟", "占用率"],
      ...report.groups.map((r) => [r.machineName, r.groupName, r.resourceSummary, String(r.reservedMinutes), String(r.availableMinutes), `${r.utilization}%`])];
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="resource-report.csv"');
    return "\uFEFF" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
  });
  app.get("/api/v1/admin/report/rebuild", async (request, reply) => {
    if (!requireSystemAdmin(request, reply)) return;
    return { job: store.job() };
  });
  app.post("/api/v1/admin/report/rebuild", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    z.object({}).strict().parse(request.body ?? {});
    const job = store.requestRebuild(auth.user.id);
    wakeReportScheduler();
    return reply.code(202).send({ job });
  });
}

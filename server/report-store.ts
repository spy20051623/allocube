import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { latestReportDate, reportDate, reportDayStart, REPORT_DAY_MS, shiftReportDate, type ReportJob } from "../src/shared/reports.js";

type Db = Database.Database;
interface State { active_version: string; earliest_date: string }
interface JobRow {
  id: string; version_id: string; actor_id: string; status: ReportJob["status"];
  from_date: string; to_date: string; completed_days: number; total_days: number;
  created_at: string; finished_at: string | null;
}
interface Group { id: string; machine_id: string; created_at: string; deleted_at: string | null }
interface Reservation {
  id: string; machine_id: string; resource_group_id: string; user_id: string;
  scope: string; start_at: string; end_at: string;
}
interface Unavailability { machine_id: string; resource_group_id: string | null; start_at: string; end_at: string }
type Interval = [number, number];
const stamp = () => new Date().toISOString();

function unionMs(intervals: Interval[], from: number, to: number): number {
  const sorted = intervals.map(([s, e]) => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => s < e).sort((a, b) => a[0] - b[0]);
  let end = from, total = 0;
  for (const [s, e] of sorted) {
    total += Math.max(0, e - Math.max(s, end));
    end = Math.max(end, e);
  }
  return total;
}
function pushInterval(map: Map<string, Interval[]>, key: string, value: Interval) {
  const list = map.get(key) ?? [];
  list.push(value); map.set(key, list);
}
function add(map: Map<string, number>, key: string, amount: number) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** Independent of application bootstrap: the HTTP thread and Worker use their own connection. */
export class ReportStore {
  constructor(readonly db: Db, private readonly onSettled?: (day: string, durationMs: number) => void) {}

  initialize(now = Date.now()) {
    this.db.transaction(() => {
      if (this.state()) return;
      const version = randomUUID();
      this.db.prepare("INSERT INTO report_versions VALUES(?, ?)").run(version, stamp());
      this.db.prepare("INSERT INTO report_state VALUES(1, ?, ?)").run(version, this.historyStart(now));
    }).immediate();
  }

  state(): State | undefined {
    return this.db.prepare("SELECT active_version, earliest_date FROM report_state WHERE id=1").get() as State | undefined;
  }

  historyStart(now = Date.now()): string {
    const { earliest } = this.db.prepare(`SELECT MIN(time) AS earliest FROM (
      SELECT MIN(created_at) AS time FROM machines UNION ALL
      SELECT MIN(created_at) FROM resource_groups UNION ALL
      SELECT MIN(start_at) FROM reservations UNION ALL
      SELECT MIN(start_at) FROM resource_unavailability
    )`).get() as { earliest: string | null };
    const existing = this.state()?.earliest_date;
    return [earliest ? reportDate(Date.parse(earliest)) : reportDate(now), existing].filter((s): s is string => Boolean(s)).sort()[0];
  }

  jobRow(activeOnly = false): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM report_jobs ${activeOnly ? "WHERE status IN ('QUEUED','RUNNING')" : ""}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as JobRow | undefined;
  }

  job(): ReportJob | null {
    const row = this.jobRow();
    return row ? {
      id: row.id, status: row.status, fromDate: row.from_date, toDate: row.to_date,
      completedDays: row.completed_days, totalDays: row.total_days,
      createdAt: row.created_at, finishedAt: row.finished_at
    } : null;
  }

  private audit(actor: string, action: string, jobId: string, values: unknown) {
    this.db.prepare(`INSERT INTO audit_logs(id, actor_user_id, action, entity_type, entity_id, after_json, created_at)
      VALUES(?,?,?,'REPORT',?,?,?)`).run(randomUUID(), actor, action, jobId, JSON.stringify(values), stamp());
  }

  requestRebuild(actor: string, now = Date.now()): ReportJob {
    return this.db.transaction(() => {
      if (this.jobRow(true)) return this.job()!;
      const from = this.historyStart(now), to = latestReportDate(now);
      const total = Math.max(0, Math.round((reportDayStart(to) - reportDayStart(from)) / REPORT_DAY_MS) + 1);
      const id = randomUUID(), version = randomUUID();
      this.db.prepare("INSERT INTO report_versions VALUES(?, ?)").run(version, stamp());
      this.db.prepare(`INSERT INTO report_jobs(id,version_id,actor_id,status,from_date,to_date,total_days,created_at)
        VALUES(?,?,?,'QUEUED',?,?,?,?)`).run(id, version, actor, from, to, total, stamp());
      this.audit(actor, "REPORT_REBUILD_REQUEST", id, { fromDate: from, toDate: to });
      return this.job()!;
    }).immediate();
  }

  private nextMissing(version: string, from: string, to: string): string | null {
    const days = new Set((this.db.prepare("SELECT day FROM report_days WHERE version_id=? AND day BETWEEN ? AND ?")
      .all(version, from, to) as Array<{ day: string }>).map((r) => r.day));
    for (let day = to; day >= from; day = shiftReportDate(day, -1)) if (!days.has(day)) return day;
    return null;
  }

  /** Compute outside the write transaction, publish the complete day atomically. */
  settleDay(version: string, day: string) {
    const started = performance.now();
    const start = reportDayStart(day), end = start + REPORT_DAY_MS;
    const from = new Date(start).toISOString(), to = new Date(end).toISOString();
    const source = this.db.transaction(() => ({
      groups: this.db.prepare(`SELECT rg.id, rg.machine_id, rg.created_at,
        COALESCE(dg.deleted_at, dm.deleted_at) AS deleted_at
        FROM resource_groups rg
        LEFT JOIN deleted_resource_group_tombstones dg ON dg.resource_group_id=rg.id
        LEFT JOIN deleted_machine_tombstones dm ON dm.machine_id=rg.machine_id
        WHERE rg.created_at < ?`).all(to) as Group[],
      reservations: this.db.prepare(`SELECT id,machine_id,resource_group_id,user_id,scope,start_at,end_at
        FROM reservations WHERE status='CONFIRMED' AND start_at < ? AND end_at > ?`).all(to, from) as Reservation[],
      unavailable: this.db.prepare(`SELECT machine_id,resource_group_id,start_at,end_at FROM resource_unavailability
        WHERE status='ACTIVE' AND start_at < ? AND end_at > ?`).all(to, from) as Unavailability[]
    }))();
    const groupReserved = new Map<string, number>(), machineReserved = new Map<string, number>();
    const wholeIntervals = new Map<string, Interval[]>();
    const contributions = source.reservations.map((row) => {
      const ms = Math.max(0, Math.min(end, Date.parse(row.end_at)) - Math.max(start, Date.parse(row.start_at)));
      add(row.scope === "MACHINE" ? machineReserved : groupReserved, row.scope === "MACHINE" ? row.machine_id : row.resource_group_id, ms);
      if (row.scope === "MACHINE") pushInterval(wholeIntervals, row.machine_id, [Math.max(start, Date.parse(row.start_at)), Math.min(end, Date.parse(row.end_at))]);
      return { ...row, ms };
    });
    const machineUnavailable = new Map<string, Interval[]>(), groupUnavailable = new Map<string, Interval[]>();
    for (const row of source.unavailable) pushInterval(row.resource_group_id ? groupUnavailable : machineUnavailable,
      row.resource_group_id ?? row.machine_id, [Math.max(start, Date.parse(row.start_at)), Math.min(end, Date.parse(row.end_at))]);
    const groups = source.groups.map((group) => {
      const lifeStart = Math.max(start, Date.parse(group.created_at));
      const lifeEnd = Math.min(end, group.deleted_at ? Date.parse(group.deleted_at) : end);
      const wholeReserved = lifeStart === start && lifeEnd === end ? (machineReserved.get(group.machine_id) ?? 0)
        : (wholeIntervals.get(group.machine_id) ?? []).reduce((sum, [s, e]) => sum + Math.max(0, Math.min(e, lifeEnd) - Math.max(s, lifeStart)), 0);
      const reserved = (groupReserved.get(group.id) ?? 0) + wholeReserved;
      const available = Math.max(0, lifeEnd - lifeStart - unionMs([
        ...(machineUnavailable.get(group.machine_id) ?? []), ...(groupUnavailable.get(group.id) ?? [])
      ], lifeStart, lifeEnd));
      return { ...group, reserved, available, exists: lifeEnd > lifeStart };
    }).filter((g) => g.exists || g.reserved > 0);
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM report_days WHERE version_id=? AND day=?").get(version, day)) return;
      this.db.prepare("INSERT INTO report_days VALUES(?,?,?)").run(version, day, stamp());
      const groupInsert = this.db.prepare("INSERT INTO report_group_days VALUES(?,?,?,?,?,?)");
      for (const row of groups) groupInsert.run(version, day, row.machine_id, row.id, row.reserved, row.available);
      const reservationInsert = this.db.prepare("INSERT INTO report_reservation_days VALUES(?,?,?,?,?,?)");
      for (const row of contributions) reservationInsert.run(version, day, row.id, row.machine_id, row.user_id, row.ms);
      this.db.prepare("UPDATE report_jobs SET completed_days=completed_days+1 WHERE version_id=? AND status='RUNNING'").run(version);
    }).immediate();
    this.onSettled?.(day, Math.round(performance.now() - started));
  }

  /** One day per step allows a queued rebuild to preempt daily catch-up between days. */
  step(now = Date.now()): boolean {
    const job = this.jobRow(true);
    if (job) {
      try {
        this.db.prepare("UPDATE report_jobs SET status='RUNNING' WHERE id=?").run(job.id);
        const day = this.nextMissing(job.version_id, job.from_date, job.to_date);
        if (day) { this.settleDay(job.version_id, day); return true; }
        this.db.transaction(() => {
          this.db.prepare("UPDATE report_state SET active_version=?,earliest_date=? WHERE id=1").run(job.version_id, job.from_date);
          this.db.prepare("UPDATE report_jobs SET status='SUCCEEDED',finished_at=? WHERE id=?").run(stamp(), job.id);
          this.audit(job.actor_id, "REPORT_REBUILD_SUCCEEDED", job.id, { completedDays: job.total_days });
        }).immediate();
        return true;
      } catch (error) {
        this.db.transaction(() => {
          this.db.prepare("UPDATE report_jobs SET status='FAILED',finished_at=? WHERE id=?").run(stamp(), job.id);
          this.audit(job.actor_id, "REPORT_REBUILD_FAILED", job.id, { reason: "REPORT_CALCULATION_FAILED" });
        }).immediate();
        throw error;
      }
    }
    const state = this.state()!;
    // Delete obsolete versions a day at a time, keeping write locks short.
    const obsolete = this.db.prepare("SELECT id FROM report_versions WHERE id != ? LIMIT 1").get(state.active_version) as { id: string } | undefined;
    if (obsolete) {
      const day = this.db.prepare("SELECT day FROM report_days WHERE version_id=? LIMIT 1").get(obsolete.id) as { day: string } | undefined;
      if (day) this.db.prepare("DELETE FROM report_days WHERE version_id=? AND day=?").run(obsolete.id, day.day);
      else this.db.prepare("DELETE FROM report_versions WHERE id=?").run(obsolete.id);
      return true;
    }
    const day = this.nextMissing(state.active_version, state.earliest_date, latestReportDate(now));
    if (!day) return false;
    this.settleDay(state.active_version, day);
    return true;
  }
}

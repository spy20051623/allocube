import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RealtimeChange, RealtimeScope, RealtimeTopic } from "../src/shared/realtime.js";

interface ChangeRow { kind: string; machine_id: string | null; user_id: string | null; from_at: string | null; to_at: string | null }
interface Audience { id: string; user_id: string; role: string; status: string; expires_at: string }

/** Connection-local transactional journal. No persistent schema changes or business text. */
export class RealtimeChanges {
  private boot = randomUUID();
  private sequence = 0;
  constructor(private db: Database.Database) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS realtime_changes(kind TEXT, machine_id TEXT, user_id TEXT, from_at TEXT, to_at TEXT)`);
    const watch = (table: string, kind: string, machine = "NULL", user = "NULL", from = "NULL", to = "NULL", columns?: string) => {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const refs = operation === "UPDATE" ? ["OLD", "NEW"] : [operation === "DELETE" ? "OLD" : "NEW"];
        const changeKind = operation !== "DELETE" && (kind === "access" || kind === "manager") ? `${kind}Granted` : kind;
        const insert = refs.map(ref => `INSERT INTO realtime_changes VALUES('${changeKind}',${[machine, user, from, to].map(v => v.replaceAll("ROW.", `${ref}.`)).join(",")});`).join("\n");
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS realtime_${table}_${operation} AFTER ${operation}${operation === "UPDATE" && columns ? ` OF ${columns}` : ""} ON main.${table} BEGIN ${insert} END`);
      }
    };
    watch("reservations", "schedule", "ROW.machine_id", "ROW.user_id", "ROW.start_at", "ROW.end_at");
    watch("machines", "resource", "ROW.id");
    watch("resource_groups", "resource", "ROW.machine_id");
    watch("resource_pools", "resource", "ROW.machine_id");
    watch("resource_pool_items", "resource", "(SELECT machine_id FROM resource_pools WHERE id=ROW.pool_id)");
    watch("resource_group_allocations", "resource", "(SELECT machine_id FROM resource_groups WHERE id=ROW.resource_group_id)");
    watch("resource_unavailability", "maintenance", "ROW.machine_id", "NULL", "ROW.start_at", "ROW.end_at");
    watch("machine_access_memberships", "access", "ROW.machine_id", "ROW.user_id");
    watch("machine_admins", "manager", "ROW.machine_id", "ROW.user_id");
    watch("machine_access_requests", "request", "ROW.machine_id", "ROW.user_id");
    watch("users", "identity", "NULL", "ROW.id", "NULL", "NULL", "username,email,display_name,password_change_recommended,auto_logout_minutes");
    // These updates also revoke the client-side authority snapshot immediately.
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS realtime_users_authority AFTER UPDATE OF role,status,password_hash ON main.users
      WHEN OLD.role != NEW.role OR OLD.status != NEW.status OR OLD.password_hash != NEW.password_hash
      BEGIN INSERT INTO realtime_changes(kind,user_id) VALUES('authority',NEW.id); END`);
    watch("employee_numbers", "identity", "NULL", "ROW.user_id");
    watch("profile_change_requests", "users", "NULL", "ROW.user_id");
    watch("user_email_preferences", "session", "NULL", "ROW.user_id");
    watch("settings", "settings");
    watch("smtp_settings", "adminSettings");
    watch("notifications", "notification", "NULL", "ROW.user_id");
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS realtime_sessions_DELETE AFTER DELETE ON main.sessions BEGIN
      INSERT INTO realtime_changes(kind,user_id) VALUES('session',OLD.user_id); END`);
  }

  boundary(machineIds: string[]) {
    const insert = this.db.prepare("INSERT INTO realtime_changes(kind,machine_id) VALUES('maintenance',?)");
    for (const id of new Set(machineIds)) insert.run(id);
  }

  full(revision: number): RealtimeChange {
    return { version: 2, eventId: `${this.boot}:${++this.sequence}`, revision,
      scopes: ["session", "notifications", "catalog", "timeline", "ownReservations", "machines", "machine", "groups", "access", "users", "settings"].map(topic => ({ topic: topic as RealtimeTopic })) };
  }

  drain(sessionIds: string[], revision: number | (() => number)): Map<string, RealtimeChange> {
    const result = new Map<string, RealtimeChange>();
    // A request can publish from a nested business helper. Never observe uncommitted rows.
    if (this.db.inTransaction) return result;
    const rows = this.db.prepare("SELECT DISTINCT * FROM realtime_changes").all() as ChangeRow[];
    if (!rows.length) return result;
    if (!sessionIds.length) { this.db.exec("DELETE FROM realtime_changes"); return result; }
    if (typeof revision === "function") revision = revision();
    const sessions = this.db.prepare(`SELECT s.id,s.user_id,s.expires_at,u.role,u.status FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(sessionIds)) as Audience[];
    const users = [...new Set(sessions.map(s => s.user_id))];
    const machines = new Set((this.db.prepare(`SELECT id FROM machines WHERE id NOT IN (SELECT machine_id FROM deleted_machine_tombstones)`).all() as { id: string }[]).map(m => m.id));
    const memberships = this.db.prepare(`SELECT user_id,machine_id FROM machine_access_memberships WHERE user_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(users)) as { user_id: string; machine_id: string }[];
    const managers = this.db.prepare(`SELECT user_id,machine_id FROM machine_admins WHERE user_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(users)) as { user_id: string; machine_id: string }[];
    const changedMachines = [...new Set(rows.filter(r => r.kind === "resource" || r.kind === "maintenance").map(r => r.machine_id).filter(Boolean))];
    const owners = this.db.prepare(`SELECT DISTINCT user_id,machine_id FROM reservations WHERE machine_id IN (SELECT value FROM json_each(?)) AND user_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(changedMachines), JSON.stringify(users)) as { user_id: string; machine_id: string }[];
    const identities = [...new Set(rows.filter(r => r.kind === "identity" || r.kind === "authority").map(r => r.user_id))];
    const identityMachines = this.db.prepare(`SELECT DISTINCT machine_id FROM reservations WHERE user_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(identities)) as { machine_id: string }[];
    const identityAccess = identities.length ? this.db.prepare(`SELECT machine_id,0 AS manager FROM machine_access_memberships WHERE user_id IN (SELECT value FROM json_each(?))
      UNION SELECT machine_id,1 AS manager FROM machine_admins WHERE user_id IN (SELECT value FROM json_each(?))
      UNION SELECT machine_id,0 AS manager FROM machine_access_requests WHERE user_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(identities), JSON.stringify(identities), JSON.stringify(identities)) as { machine_id: string; manager: number }[] : [];
    const eventId = `${this.boot}:${++this.sequence}`;
    const byUser = new Map<string, RealtimeChange>();
    const checkedUsers = new Set<string>();
    for (const session of sessions) {
      if (checkedUsers.has(session.user_id)) continue;
      checkedUsers.add(session.user_id);
      const own = session.user_id, admin = session.role === "SYSTEM_ADMIN";
      const allowed = new Set(admin ? machines : memberships.filter(m => m.user_id === own && machines.has(m.machine_id)).map(m => m.machine_id));
      const managed = new Set(admin ? machines : managers.filter(m => m.user_id === own && machines.has(m.machine_id)).map(m => m.machine_id));
      const ownedMachines = new Set(owners.filter(m => m.user_id === own).map(m => m.machine_id));
      const scopes = new Map<string, RealtimeScope>();
      let accessChanged = false;
      const add = (topic: RealtimeTopic, machineId?: string, from?: string | null, to?: string | null) => {
        const key = `${topic}:${machineId ?? "*"}`, previous = scopes.get(key);
        const range = from && to && from < to ? { from, to } : {};
        if (!previous) scopes.set(key, { topic, ...(machineId ? { machineId } : {}), ...range });
        else if (!range.from || !previous.from) scopes.set(key, { topic, ...(machineId ? { machineId } : {}) });
        else scopes.set(key, { ...previous, from: previous.from < range.from ? previous.from : range.from, to: previous.to! > range.to! ? previous.to : range.to });
      };
      for (const row of rows) {
        const machine = row.machine_id ?? undefined;
        if (row.kind === "schedule") {
          if (row.user_id === own) add("ownReservations");
          if (machine && allowed.has(machine)) add("timeline", machine, row.from_at, row.to_at);
        } else if (row.kind === "resource" || row.kind === "maintenance") {
          add("catalog");
          if (machine && allowed.has(machine)) add("timeline", machine, row.kind === "resource" ? null : row.from_at, row.kind === "resource" ? null : row.to_at);
          if (machine && ownedMachines.has(machine)) add("ownReservations");
          if (machine && allowed.has(machine)) { add("machines"); add("machine", machine); add("groups", machine); }
          // Deletion must invalidate previously accessible data without disclosing deleted IDs.
          if (machine && !machines.has(machine) && (admin || memberships.some(m => m.user_id === own && m.machine_id === machine) || ownedMachines.has(machine))) {
            accessChanged = true; add("session"); add("timeline"); add("machines"); add("machine"); add("groups");
          }
        } else if (["access", "accessGranted", "manager", "managerGranted", "request"].includes(row.kind)) {
          if (row.kind.startsWith("manager")) add("catalog");
          if (row.user_id === own) {
            add("catalog");
            if (row.kind !== "request") {
              // Grants keep valid drafts; revocations invalidate authority before any read.
              accessChanged ||= row.kind === "access" || row.kind === "manager";
              for (const topic of ["session", "timeline", "ownReservations", "machines", "machine", "groups", "access"] as const) add(topic);
            }
          }
          if (machine && (row.kind === "request" ? managed : allowed).has(machine)) { add("access", machine); add("machines"); }
        } else if (row.kind === "identity" || row.kind === "users" || row.kind === "authority") {
          if (admin || row.kind !== "users") add("users");
          if (row.user_id === own) { add("session"); if (row.kind === "authority") { accessChanged = true; add("timeline"); add("ownReservations"); add("machines"); } }
          if (row.kind !== "users") for (const item of identityMachines) if (allowed.has(item.machine_id)) add("timeline", item.machine_id);
          if (row.kind !== "users") for (const item of identityAccess) {
            if (item.manager) add("catalog");
            if (allowed.has(item.machine_id)) { add("access", item.machine_id); if (item.manager) add("machines"); }
          }
        } else if (row.kind === "notification") { if (row.user_id === own) add("notifications"); }
        else if (row.kind === "session") { if (row.user_id === own) add("session"); }
        else if (row.kind === "settings") { add("session"); if (admin) add("settings"); }
        else if (row.kind === "adminSettings" && admin) add("settings");
      }
      if (scopes.size) byUser.set(own, { version: 2, eventId, revision, scopes: [...scopes.values()], ...(accessChanged ? { accessChanged: true } : {}) });
    }
    const now = new Date().toISOString();
    const sessionsById = new Map(sessions.map(session => [session.id, session]));
    for (const id of new Set(sessionIds)) {
      const session = sessionsById.get(id);
      if (!session || session.status !== "ACTIVE" || session.expires_at <= now) result.set(id, { version: 2, eventId, revision, scopes: [{ topic: "session" }], sessionEnded: true, accessChanged: true });
      else if (byUser.has(session.user_id)) result.set(id, byUser.get(session.user_id)!);
    }
    this.db.exec("DELETE FROM realtime_changes");
    return result;
  }
}

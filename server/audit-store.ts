import { createHmac, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { AUDIT_PAGE_SIZE, type AuditDetail, type AuditEntry, type AuditField, type AuditOptions, type AuditPage, type AuditValue } from "../src/shared/audit.js";
import { BusinessError } from "./business-error.js";

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;
const querySchema = z.object({
  from: z.string().datetime().transform(s => new Date(s).toISOString()).optional(), to: z.string().datetime().transform(s => new Date(s).toISOString()).optional(),
  actor: z.string().min(1).max(100).optional(), action: z.string().min(1).max(150).optional(),
  source: z.enum(["API", "OTHER"]).optional(), cursor: z.string().max(4096).optional()
}).strict().refine(q => !q.from || !q.to || q.from < q.to);
const cursorSchema = z.object({ upper: z.number().int().nonnegative(), time: z.string().nullable(), id: z.string().nullable(), page: z.number().int().positive(), filters: z.string() });
function payload(value: unknown): { data: Payload; invalid: boolean } {
  if (value == null) return { data: {}, invalid: false };
  try {
    const data: unknown = JSON.parse(String(value));
    if (data && typeof data === "object" && !Array.isArray(data)) return { data: data as Payload, invalid: false };
  } catch { /* Legacy rows must not break the list. */ }
  return { data: {}, invalid: true };
}
const str = (value: unknown) => typeof value === "string" ? value : "";
const aliases: Record<string, string> = {
  start_at: "startAt", end_at: "endAt", resource_group_id: "resourceGroupId", machine_id: "machineId", user_id: "userId",
  display_name: "displayName", employee_number: "employeeNumber", hardware_notes: "hardwareNotes", connection_guide: "connectionGuide",
  from_name: "fromName", from_address: "fromAddress", cancelled_at: "cancelledAt", expires_at: "expiresAt",
  cancellation_reason: "reason", adjustment_reason: "reason", disable_reason: "reason"
};
function normalized(data: Payload): Payload {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [aliases[key] ?? key, value]));
}
// Deliberately bounded per object family. Never serialize arbitrary old audit payloads.
const familyFields: Record<string, string[]> = {
  reservation: ["startAt", "endAt", "scope", "status", "title", "purpose", "note", "reason", "action", "resultingSegments", "replacementBatchId", "replacedReservationIds", "newReservationIds", "replacesReservationId", "segmentCount"],
  machine: ["name", "address", "hardwareNotes", "connectionGuide", "announcement", "tags", "status", "reason", "managementNotesChanged", "userId"],
  resource_group: ["name", "description", "tags", "allocations", "status", "reason", "sortOrder", "version"],
  resource_pool: ["name", "kind", "unit", "description", "sharingMode", "rangeStart", "rangeEnd", "capacity", "items", "status", "reason", "version"],
  user: ["username", "displayName", "employeeNumber", "email", "status", "reason", "reviewReason"],
  profile_change_request: ["displayNameChanged", "employeeNumberChanged", "reasonProvided", "status", "reason", "reviewReason", "requestedDisplayName", "requestedEmployeeNumber"],
  machine_access_request: ["status", "reason", "userId"],
  resource_unavailability: ["targetType", "startAt", "endAt", "reason", "reasonProvided", "status", "kind", "impact"],
  settings: ["blockAdminBookings", "maintenanceText", "minBookingMinutes", "maxBookingMinutes", "advanceDays", "siteName", "siteDescription", "siteOrigin", "icpFilingNumber", "publicSecurityFilingNumber", "allowedEmailDomains", "allowRegistrationWithoutEmail", "requireRegistrationEmail", "version"],
  smtp_settings: ["enabled", "host", "port", "security", "username", "fromName", "fromAddress", "hasPassword", "passwordChanged", "passwordCleared"],
  announcement: ["title", "bodyLength", "status", "active"],
  api_token: ["name", "accessLevel", "expiresAt"],
  feedback: ["number", "type", "status", "level", "titleLength", "bodyLength", "changedFields", "commentLength"],
  REPORT: ["reason", "fromDate", "toDate", "completedDays", "totalDays", "status"],
  registration_tombstone: ["reasonCode"]
};

export class AuditStore {
  constructor(private db: Database.Database, private secret: string) {}
  private sign(value: string) { return createHmac("sha256", this.secret).update(value).digest("base64url"); }
  private encode(value: z.infer<typeof cursorSchema>) { const body = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${body}.${this.sign(body)}`; }
  private decode(value: string) {
    try {
      const [body, signature, extra] = value.split(".");
      const expected = Buffer.from(this.sign(body)), actual = Buffer.from(signature ?? "");
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      return cursorSchema.parse(JSON.parse(Buffer.from(body, "base64url").toString()));
    } catch { throw new BusinessError("审计分页已失效，请重新查询", 400); }
  }
  options(): AuditOptions {
    return {
      actors: (this.db.prepare(`SELECT DISTINCT a.actor_user_id AS id,
        CASE WHEN d.user_id IS NOT NULL THEN '用户已删除' ELSE COALESCE(u.display_name,'系统 / 未记录') END AS name
        FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id
        LEFT JOIN deleted_user_tombstones d ON d.user_id=u.id ORDER BY name, id`).all() as { id: string | null; name: string }[])
        .map(row => ({ ...row, id: row.id ?? "__system__" })),
      actions: (this.db.prepare("SELECT DISTINCT action FROM audit_logs ORDER BY action").all() as { action: string }[]).map(row => row.action)
    };
  }
  list(raw: unknown): AuditPage {
    const { cursor, ...filters } = querySchema.parse(raw);
    const filterKey = JSON.stringify(filters);
    const position = cursor ? this.decode(cursor) : undefined;
    if (position && position.filters !== filterKey) throw new BusinessError("审计分页已失效，请重新查询", 400);
    return this.db.transaction(() => {
      const upper = position?.upper ?? Number((this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM audit_logs").get() as Row).n);
      const clauses = ["a.rowid <= ?"], values: (string | number)[] = [upper];
      if (filters.from) { clauses.push("a.created_at >= ?"); values.push(filters.from); }
      if (filters.to) { clauses.push("a.created_at < ?"); values.push(filters.to); }
      if (filters.actor === "__system__") clauses.push("a.actor_user_id IS NULL");
      else if (filters.actor) { clauses.push("a.actor_user_id = ?"); values.push(filters.actor); }
      if (filters.action) { clauses.push("a.action = ?"); values.push(filters.action); }
      const api = "(a.actor_api_token_id IS NOT NULL OR a.api_operation_id IS NOT NULL)";
      if (filters.source) clauses.push(filters.source === "API" ? api : `NOT ${api}`);
      const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${clauses.join(" AND ")}`).get(...values) as Row).n);
      if (position?.time && position.id) { clauses.push("(a.created_at, a.id) < (?, ?)"); values.push(position.time, position.id); }
      const rows = this.db.prepare(`SELECT a.* FROM audit_logs a WHERE ${clauses.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(...values, AUDIT_PAGE_SIZE + 1) as Row[];
      const hasNext = rows.length > AUDIT_PAGE_SIZE;
      const pageRows = rows.slice(0, AUDIT_PAGE_SIZE), last = pageRows.at(-1), page = position?.page ?? 1;
      return { logs: this.present(pageRows).map(item => item.entry), total, page, pageSize: AUDIT_PAGE_SIZE,
        cursor: cursor ?? this.encode({ upper, time: null, id: null, page: 1, filters: filterKey }),
        nextCursor: hasNext && last ? this.encode({ upper, time: str(last.created_at), id: str(last.id), page: page + 1, filters: filterKey }) : null };
    })();
  }
  detail(id: string): AuditDetail {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM audit_logs WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new BusinessError("审计记录不存在", 404);
      return this.present([row])[0];
    })();
  }

  private present(rows: Row[]): AuditDetail[] {
    const parsed = rows.map(row => ({ before: payload(row.before_json), after: payload(row.after_json) }));
    const ids = new Set<string>();
    rows.forEach((row, index) => {
      [row.actor_user_id, row.entity_id, row.actor_api_token_id].forEach(id => { if (typeof id === "string") ids.add(id); });
      for (const data of [parsed[index].before.data, parsed[index].after.data]) {
        const n = normalized(data);
        [n.machineId, n.resourceGroupId, n.userId, n.targetId].forEach(id => { if (typeof id === "string") ids.add(id); });
        if (Array.isArray(n.allocations)) for (const allocation of n.allocations) {
          if (allocation && typeof allocation === "object" && typeof allocation.poolId === "string") ids.add(allocation.poolId);
        }
      }
    });
    const load = (table: string, columns: string, selected = ids) => {
      if (!selected.size) return new Map<string, Row>();
      const result = new Map<string, Row>();
      const list = [...selected];
      for (let i = 0; i < list.length; i += 400) {
        const batch = list.slice(i, i + 400);
        for (const row of this.db.prepare(`SELECT ${columns} FROM ${table} WHERE id IN (${batch.map(() => "?").join(",")})`).all(...batch) as Row[]) result.set(str(row.id), row);
      }
      return result;
    };
    const reservations = load("reservations", "id, machine_id, resource_group_id, user_id, scope");
    const maintenance = load("resource_unavailability", "id, machine_id, resource_group_id");
    const requests = load("machine_access_requests", "id, machine_id, user_id");
    const profiles = load("profile_change_requests", "id, user_id");
    const tokens = load("api_tokens", "id, name, user_id");
    for (const row of [...reservations.values(), ...maintenance.values(), ...requests.values(), ...profiles.values(), ...tokens.values()]) {
      [row.machine_id, row.resource_group_id, row.user_id].forEach(id => { if (typeof id === "string") ids.add(id); });
    }
    const groups = load("resource_groups", "id, machine_id, name"), pools = load("resource_pools", "id, machine_id, name");
    for (const row of [...groups.values(), ...pools.values()]) ids.add(str(row.machine_id));
    const machines = load("machines", "id, name"), users = load("users", "id, display_name");
    const announcements = load("announcements", "id, title");
    const feedback = load("feedback_tickets", "id, number");
    const deleted = (table: string, column: string) => {
      if (!ids.size) return new Set<string>();
      const found = new Set<string>(), list = [...ids];
      for (let i = 0; i < list.length; i += 400) {
        const batch = list.slice(i, i + 400);
        for (const row of this.db.prepare(`SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${batch.map(() => "?").join(",")})`).all(...batch) as Row[]) found.add(str(row.id));
      }
      return found;
    };
    const deletedUsers = deleted("deleted_user_tombstones", "user_id"), deletedMachines = deleted("deleted_machine_tombstones", "machine_id");
    const deletedGroups = deleted("deleted_resource_group_tombstones", "resource_group_id"), deletedPools = deleted("deleted_resource_pool_tombstones", "resource_pool_id");
    return rows.map((row, index) => {
      const type = str(row.entity_type), id = str(row.entity_id), actor = str(row.actor_user_id);
      const { before, after } = parsed[index], b = normalized(before.data), a = normalized(after.data);
      const object = type === "reservation" ? reservations.get(id) : type === "resource_unavailability" ? maintenance.get(id) : type === "machine_access_request" ? requests.get(id) : type === "profile_change_request" ? profiles.get(id) : type === "api_token" ? tokens.get(id) : undefined;
      const groupId = type === "resource_group" ? id : str(object?.resource_group_id) || str(a.resourceGroupId ?? b.resourceGroupId);
      const group = groups.get(groupId), pool = type === "resource_pool" ? pools.get(id) : undefined;
      const machineId = type === "machine" ? id : str(object?.machine_id ?? group?.machine_id ?? pool?.machine_id) || str(a.machineId ?? b.machineId);
      const machine = machines.get(machineId);
      const userId = type === "user" || type === "session" ? id : str(object?.user_id) || str(a.userId ?? b.userId);
      const removedMachine = Boolean(machineId) && (deletedMachines.has(machineId) || !machine);
      const removedGroup = Boolean(groupId) && (removedMachine || deletedGroups.has(groupId) || !group);
      const removedUser = Boolean(userId) && (deletedUsers.has(userId) || !users.has(userId));
      const removed = removedMachine || removedGroup || removedUser || deletedUsers.has(actor) || (type === "resource_pool" && (deletedPools.has(id) || !pool)) || (type === "profile_change_request" && !profiles.has(id));
      const machineName = machineId ? removedMachine ? "机器已删除" : str(machine?.name) : undefined;
      const resourceGroupName = groupId ? removedGroup ? "资源组已删除" : str(group?.name) : undefined;
      let entityName = type;
      if (type === "user" || type === "session") entityName = removedUser ? "用户已删除" : str(users.get(id)?.display_name);
      else if (type === "machine") entityName = machineName ?? "机器已删除";
      else if (type === "resource_group") entityName = resourceGroupName ?? "资源组已删除";
      else if (type === "resource_pool") entityName = removed ? "资源项已删除" : str(pool?.name);
      else if (machineId || type === "reservation" || type === "resource_unavailability") entityName = [machineName, resourceGroupName].filter(Boolean).join(" / ") || type;
      else if (type === "announcement") entityName = str(announcements.get(id)?.title) || "系统公告";
      else if (type === "api_token") entityName = removed ? "个人访问令牌" : str(tokens.get(id)?.name) || "个人访问令牌";
      else if (type === "feedback") entityName = feedback.has(id) ? `#${feedback.get(id)!.number}` : "反馈";
      else if (type === "settings" || type === "smtp_settings" || type === "REPORT") entityName = type === "REPORT" ? "使用统计" : type === "smtp_settings" ? "邮件配置" : id;
      const scope = str(a.scope ?? b.scope ?? object?.scope);
      const entry: AuditEntry = {
        id: str(row.id), createdAt: str(row.created_at), actorId: actor || null,
        actorName: actor ? deletedUsers.has(actor) ? "用户已删除" : str(users.get(actor)?.display_name) || "用户已删除" : "系统 / 未记录",
        action: str(row.action), entityType: type, entityId: id, entityName,
        actorDeleted: Boolean(actor) && (deletedUsers.has(actor) || !users.has(actor)), entityDeleted: Boolean(removed), machineDeleted: removedMachine, resourceGroupDeleted: removedGroup,
        source: row.actor_api_token_id != null || row.api_operation_id != null ? "API" : "OTHER",
        apiTokenId: row.actor_api_token_id as string | null, apiTokenName: deletedUsers.has(actor) ? null : str(tokens.get(str(row.actor_api_token_id))?.name) || null,
        apiOperationId: row.api_operation_id as string | null,
        ...(machineName ? { machineName } : {}), ...(resourceGroupName ? { resourceGroupName } : {}), ...(scope ? { scope } : {})
      };
      for (const key of ["startAt", "endAt"] as const) {
        const value = a[key] ?? b[key];
        if (!removed && typeof value === "string" && Number.isFinite(Date.parse(value))) entry[key] = value;
      }
      const fields: AuditField[] = [];
      const safeValue = (key: string, value: unknown): AuditValue | undefined => {
        if (key === "allocations" && Array.isArray(value)) return value.slice(0,100).flatMap(allocation => {
          if (!allocation || typeof allocation !== "object") return [];
          const item = allocation as Row, poolId = str(item.poolId), resource = pools.get(poolId);
          if (!resource || deletedPools.has(poolId) || deletedMachines.has(str(resource.machine_id))) return ["资源项已删除"];
          let summary: string[] = [];
          if (item.kind === "CAPACITY" && typeof item.quantity === "number") summary = [String(item.quantity)];
          if (item.kind === "INDEX_RANGE" && Array.isArray(item.ranges)) summary = item.ranges.slice(0,100).flatMap(range => range && typeof range.start === "number" && typeof range.end === "number" ? [`${range.start}–${range.end}`] : []);
          if (item.kind === "ITEM_LIST" && Array.isArray(item.items)) summary = item.items.slice(0,100).flatMap(i => i && typeof i.id === "string" ? [i.id] : []);
          return [`${str(resource.name)} · ${summary.join(", ")}`];
        });
        if (key === "items" && Array.isArray(value)) return value.slice(0,100).flatMap(item => item && typeof item === "object" && typeof item.key === "string" ? [item.key + (typeof item.label === "string" && item.label ? ` · ${item.label}` : "")] : []);
        if (key === "userId" && typeof value === "string") return deletedUsers.has(value) ? "用户已删除" : str(users.get(value)?.display_name) || "用户已删除";
        if (key === "resultingSegments" && Array.isArray(value)) return value.slice(0, 100).flatMap(segment => {
          if (!segment || typeof segment !== "object") return [];
          const s = segment as Row;
          return typeof s.startAt === "string" && typeof s.endAt === "string" && Number.isFinite(Date.parse(s.startAt)) && Number.isFinite(Date.parse(s.endAt)) ? [`${s.startAt} — ${s.endAt}`] : [];
        });
        if (key === "impact" && value && typeof value === "object") return Object.entries(value).filter(([k,v]) => ["total", "cancelled", "trimmed", "adjusted", "split", "affectedUsers"].includes(k) && typeof v === "number").map(([k,v]) => `${k}: ${v}`);
        if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value as AuditValue;
        if (typeof value === "string") return value.slice(0, 10000);
        if (Array.isArray(value) && value.every(v => typeof v === "string")) return value.slice(0, 100).map(v => v.slice(0, 1000));
        return undefined;
      };
      if (!removed) for (const key of familyFields[type] ?? []) {
        // "Changed" flags describe this operation, not the previous value of a setting.
        const changeFlag = key.endsWith("Changed");
        const oldValue = changeFlag ? undefined : safeValue(key, b[key]);
        const newValue = safeValue(key, changeFlag ? a[key] ?? b[key] : a[key]);
        if (oldValue === undefined && newValue === undefined) continue;
        if (oldValue !== undefined && newValue !== undefined && JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
        fields.push({ key, ...(oldValue !== undefined ? { before: oldValue } : {}), ...(newValue !== undefined ? { after: newValue } : {}) });
      }
      return { entry, fields, unavailable: removed || before.invalid || after.invalid || fields.length === 0 };
    });
  }
}

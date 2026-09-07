export const AUDIT_PAGE_SIZE = 50;
export type AuditSource = "API" | "OTHER";
export type AuditFilters = { from?: string; to?: string; actor?: string; action?: string; source?: AuditSource };
export type AuditEntry = {
  id: string; createdAt: string; actorId: string | null; actorName: string;
  action: string; entityType: string; entityId: string; entityName: string;
  source: AuditSource; apiTokenId: string | null; apiTokenName: string | null; apiOperationId: string | null;
  machineName?: string; resourceGroupName?: string; scope?: string; startAt?: string; endAt?: string;
  actorDeleted: boolean; entityDeleted: boolean; machineDeleted: boolean; resourceGroupDeleted: boolean;
};
export type AuditPage = { logs: AuditEntry[]; total: number; page: number; pageSize: number; cursor: string; nextCursor: string | null };
export type AuditOptions = { actors: { id: string; name: string }[]; actions: string[] };
export type AuditValue = string | number | boolean | string[] | null;
export type AuditField = { key: string; before?: AuditValue; after?: AuditValue };
export type AuditDetail = { entry: AuditEntry; fields: AuditField[]; unavailable: boolean };

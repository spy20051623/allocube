export const realtimeTopics = ["session", "notifications", "catalog", "timeline", "ownReservations", "machines", "machine", "groups", "access", "users", "settings"] as const;
export type RealtimeTopic = typeof realtimeTopics[number];
export interface RealtimeScope { topic: RealtimeTopic; machineId?: string; from?: string; to?: string }
export interface RealtimeChange {
  version: 2;
  eventId: string;
  revision: number;
  scopes: RealtimeScope[];
  accessChanged?: boolean;
  sessionEnded?: boolean;
}

// Unknown/legacy payloads invalidate the current view instead of silently losing changes.
export function parseRealtimeChange(data: string): RealtimeChange | null {
  try {
    const value = JSON.parse(data) as RealtimeChange;
    if (value.version !== 2 || typeof value.eventId !== "string" || !Number.isInteger(value.revision) || !Array.isArray(value.scopes)) return null;
    if (value.accessChanged !== undefined && typeof value.accessChanged !== "boolean" || value.sessionEnded !== undefined && typeof value.sessionEnded !== "boolean") return null;
    if (!value.scopes.every(s => s && realtimeTopics.includes(s.topic) &&
      (s.machineId === undefined || typeof s.machineId === "string") &&
      (s.from === undefined && s.to === undefined || typeof s.from === "string" && typeof s.to === "string" && Number.isFinite(Date.parse(s.from)) && Date.parse(s.from) < Date.parse(s.to)))) return null;
    return value;
  } catch { return null; }
}

export function affectsRealtime(change: RealtimeChange | null, topic: RealtimeTopic, filter: { machineId?: string; machineIds?: string[]; from?: string; to?: string } = {}) {
  if (!change) return true;
  return change.scopes.some(scope => scope.topic === topic &&
    (!scope.machineId || (!filter.machineId && !filter.machineIds) || scope.machineId === filter.machineId || filter.machineIds?.includes(scope.machineId)) &&
    (!scope.from || !scope.to || !filter.from || !filter.to || Date.parse(scope.from) < Date.parse(filter.to) && Date.parse(scope.to) > Date.parse(filter.from)));
}

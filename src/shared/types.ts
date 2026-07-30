export type UserRole = "SYSTEM_ADMIN" | "USER";
export type UserStatus =
  | "PENDING_APPROVAL"
  | "CHANGES_REQUESTED"
  | "ACTIVE"
  | "DISABLED";

export interface EmailPreferences {
  reservationUpdates: boolean;
  machineAccessUpdates: boolean;
  approvalUpdates: boolean;
  administrationUpdates: boolean;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  employeeNumber: string | null;
  role: UserRole;
  status: UserStatus;
  passwordChangeRecommended: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string;
  autoLogoutMinutes: 0 | 15 | 60 | 240 | 1440;
  emailPreferences: EmailPreferences;
  pendingProfileChange: {
    id: string;
    displayName: string;
    employeeNumber: string;
    requestedAt: string;
  } | null;
}

export interface Machine {
  id: string;
  name: string;
  address: string;
  hardwareNotes: string;
  connectionGuide: string;
  tags: string[];
  resourceSummary: string;
  status: "ACTIVE" | "DISABLED";
  disabledAt?: string | null;
  disableReason?: string;
  isManager: boolean;
}

export type ResourcePoolKind = "INDEX_RANGE" | "ITEM_LIST" | "CAPACITY";
export type ResourceSharingMode = "EXCLUSIVE" | "SHARED";

export interface ResourcePoolItem {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
}

export type ResourcePool =
  | {
      id: string;
      machineId: string;
      name: string;
      kind: "INDEX_RANGE";
      sharingMode: ResourceSharingMode;
      unit: string;
      description: string;
      sortOrder: number;
      version: number;
      rangeStart: number;
      rangeEnd: number;
      items: [];
      capacity: null;
      summary: string;
    }
  | {
      id: string;
      machineId: string;
      name: string;
      kind: "ITEM_LIST";
      sharingMode: ResourceSharingMode;
      unit: string;
      description: string;
      sortOrder: number;
      version: number;
      rangeStart: null;
      rangeEnd: null;
      items: ResourcePoolItem[];
      capacity: null;
      summary: string;
    }
  | {
      id: string;
      machineId: string;
      name: string;
      kind: "CAPACITY";
      sharingMode: ResourceSharingMode;
      unit: string;
      description: string;
      sortOrder: number;
      version: number;
      rangeStart: null;
      rangeEnd: null;
      items: [];
      capacity: number;
      summary: string;
    };

export type ResourceAllocation =
  | {
      poolId: string;
      poolName: string;
      kind: "INDEX_RANGE";
      sharingMode: ResourceSharingMode;
      unit: string;
      ranges: Array<{ start: number; end: number; label?: string }>;
    }
  | {
      poolId: string;
      poolName: string;
      kind: "ITEM_LIST";
      sharingMode: ResourceSharingMode;
      unit: string;
      items: Array<{ id: string; key: string; label: string }>;
    }
  | {
      poolId: string;
      poolName: string;
      kind: "CAPACITY";
      sharingMode: ResourceSharingMode;
      unit: string;
      quantity: number;
    };

export interface ResourceGroup {
  id: string;
  machineId: string;
  name: string;
  allocations: ResourceAllocation[];
  resourceSummary: string;
  description: string;
  tags: string[];
  sortOrder: number;
  status: "ACTIVE" | "DISABLED";
  disabledAt?: string | null;
  disableReason?: string;
  scheduledUnavailabilityCount?: number;
  hasCurrentPlannedUnavailability?: boolean;
  version: number;
}

export interface TimelineReservation {
  id: string;
  scope: "RESOURCE_GROUP" | "MACHINE";
  machineId: string;
  resourceGroupId: string;
  applicantName: string;
  applicantEmployeeNumber: string | null;
  startAt: string;
  endAt: string;
  title?: string;
  purpose?: string;
  note?: string;
  status: "CONFIRMED" | "CANCELLED" | "CANCELLED_UNAVAILABILITY";
  initialStartAt?: string;
  initialEndAt?: string;
  adjustmentType?: "CANCEL" | "TRIM_START" | "TRIM_END" | "SPLIT" | null;
  adjustmentReason?: string;
  mine: boolean;
}

export interface UnavailabilityWindow {
  id: string;
  machineId: string;
  resourceGroupId: string | null;
  resourceGroupName?: string | null;
  kind: "PLANNED" | "LONG_TERM";
  startAt: string;
  endAt: string;
  reason: string;
  status: "ACTIVE" | "CANCELLED";
}

export interface ReservationSegmentInput {
  scope?: "RESOURCE_GROUP" | "MACHINE";
  machineId?: string;
  resourceGroupId: string;
  startMode?: "IMMEDIATE" | "SCHEDULED";
  startAt: string;
  endAt: string;
  title?: string;
  purpose?: string;
  note?: string;
}

export interface ConflictItem {
  type: "RESERVATION" | "UNAVAILABILITY" | "RESOURCE_UNAVAILABLE";
  startAt: string;
  endAt: string;
  label: string;
}

export interface ReservationPreviewItem {
  input: ReservationSegmentInput;
  available: boolean;
  conflicts: ConflictItem[];
  splitSegments: ReservationSegmentInput[];
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string;
  readAt: string | null;
  createdAt: string;
}

export interface DashboardBootstrap {
  user: AuthUser;
  csrfToken: string;
  serverNow: string;
  settings: {
    minBookingMinutes: number;
    maxBookingMinutes: number;
    advanceDays: number;
    timezone: string;
  };
  managedMachineIds: string[];
}

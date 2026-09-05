export type ReservationCategory = "ACTIVE" | "UPCOMING" | "HISTORY";
export type ReservationHistoryStatus = "ALL" | "ENDED" | "CANCELLED";
export type OwnReservation = {
  id: string;
  scope: "RESOURCE_GROUP" | "MACHINE";
  machineId: string;
  machineName: string;
  resourceGroupId: string;
  resourceGroupName: string;
  currentResourceSummary: string;
  snapshotGroupName: string;
  snapshotResourceSummary: string;
  changedSinceBooking: boolean;
  machineDeleted: boolean;
  resourceGroupDeleted: boolean;
  startAt: string;
  endAt: string;
  initialStartAt: string;
  initialEndAt: string;
  adjustmentType: string | null;
  adjustmentReason: string;
  cancellationReason: string;
  title: string;
  purpose: string;
  note: string;
  status: "CONFIRMED" | "CANCELLED" | "CANCELLED_UNAVAILABILITY";
  stateToken: string;
  canViewCalendar: boolean;
  canEdit: boolean;
};

export type OwnReservationPage = {
  reservations: OwnReservation[];
  nextCursor: string | null;
  total: number;
  counts: Record<ReservationCategory, number>;
  machineOptions: Array<{ id: string; name: string }>;
  resourceGroupOptions: Array<{ id: string; machineId: string; name: string; scope: "RESOURCE_GROUP" | "MACHINE" }>;
  serverNow: string;
  nextBoundary: string | null;
  revision: number;
};

export type OwnReservationDetail = {
  reservation: OwnReservation;
  serverNow: string;
  revision: number;
};

export type ReservationSelection = Pick<OwnReservation, "id" | "stateToken">;
export type BulkCancellationIssue = {
  id: string;
  code: "NOT_AVAILABLE" | "NOT_UPCOMING" | "CHANGED";
};

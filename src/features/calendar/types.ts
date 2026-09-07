import type { Machine, ResourceGroup, TimelineReservation, UnavailabilityWindow } from "../../shared/types";

export type TimelinePayload = {
  machines: Machine[];
  groups: Array<Omit<ResourceGroup, "version">>;
  reservations: TimelineReservation[];
  unavailability: UnavailabilityWindow[];
  revision: number;
  serverNow: string;
};

export type CalendarReservationTarget = {
  scope: "RESOURCE_GROUP" | "MACHINE";
  machineId: string;
  resourceGroupId: string;
};

export type CalendarReservationDetail = {
  item: TimelineReservation;
  machineName: string;
  groupName: string;
  anchor: DOMRect;
};

export type CalendarNearbyReservations = {
  items: CalendarReservationDetail[];
  anchor: DOMRect;
};

export type CalendarDragState = {
  action: "ADD" | "ERASE";
  target: CalendarReservationTarget;
  groupId: string;
  pointerId: number;
  startX: number;
  lastX: number;
  anchorAt: string;
  track: HTMLDivElement;
  engaged: boolean;
};

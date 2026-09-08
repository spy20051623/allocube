import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { withRequestDeadline } from "../../request-deadline";
import type { OwnReservation, OwnReservationDetail } from "../../shared/my-reservations";
import { useReservationRefresh } from "../../useMyReservations";
import { useServerClock } from "../../ServerClock";
import { tr } from "../../i18n/index";
import { useTranslation } from "react-i18next";
import { type CalendarSearchTarget } from "../../CalendarResourceFinder";
import { useMemo, useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { api, jsonBody, ApiError } from "../../api";
import { type Page } from "../../app-routing";
import {
  isoToChinaLocal,
  mondayOf,
  chinaLocalToIso,
  addDays,
  todayChina,
  minuteDifference,
  clientUsesUtcPlus8
} from "../../date";
import {
  parseCalendarQuery,
  parseCalendarEditRoute,
  type CalendarView,
  defaultDayWindowStartMinutes,
  type CalendarDraft,
  type CalendarMetadata,
  type CalendarTimeRange,
  clampDayWindowStartMinutes,
  DAY_ZOOM_LEVELS,
  timelineWheelAction,
  calendarQueryUrl,
  reservationTargetKey,
  currentMinuteStart,
  subtractBusyTimeRanges,
  mergeTimeRanges,
  calendarDraftIssues,
  calendarDraftFieldIssues,
  mergeCalendarDrafts,
  calendarUrlWithoutEditRequest,
  advanceCalendarDrafts,
  reservationInput,
  adjustDraftsToAvailability,
  previewsByDraftId,
  snappedTimelineInstant,
  draggedTimeRange,
  eraseCalendarDraftRange,
  timelineNearbyHitIndexes
} from "../../calendar-state";
import {
  readCalendarPreference,
  readCollapsedCalendarMachineIds,
  writeCalendarPreference,
  writeCollapsedCalendarMachineIds
} from "../../calendar-preference";
import { type ProjectedUnavailability } from "../../calendar-unavailability";
import { createClientId } from "../../client-id";
import type { AuthUser, DashboardBootstrap, ReservationPreviewItem, TimelineReservation, ReservationSegmentInput } from "../../shared/types";
import { useAppDialog } from "../../components/dialogs";
import {
  type CalendarReservationTarget,
  type CalendarReservationDetail,
  type CalendarNearbyReservations,
  type CalendarDragState
} from "./types";
import { TIMELINE_RESOURCE_COLUMN_WIDTH } from "./layout";
import { useTimelineData } from "./useTimelineData";
import { useDragAutoScroll } from "./useDragAutoScroll";
import { readZoomGuideDismissed, saveZoomGuideDismissed } from "./calendar-zoom-guide-preference";

export function useCalendarController({
  user,
  settings,
  notify,
  beijingTimeMode,
  onBeijingTimeModeChange
}: {
  user: AuthUser;
  settings: DashboardBootstrap["settings"];
  notify: (kind: "success" | "error", message: string) => void;
  navigate: (page: Page) => void;
  beijingTimeMode: boolean;
  onBeijingTimeModeChange: (enabled: boolean) => void;
}) {
  const { i18n } = useTranslation();
  const dialog = useAppDialog();
  const {
    currentTime,
    ready: serverClockReady,
    synchronize: synchronizeServerClock
  } = useServerClock();
  const routeLocation = useLocation();
  const calendarRouteNavigate = useNavigate();
  const initialServerDate = useMemo(
    () =>
      isoToChinaLocal(new Date(currentTime).toISOString()).slice(0, 10),
    []
  );
  const initialQuery = useMemo(
    () => parseCalendarQuery(routeLocation.searchStr, initialServerDate),
    []
  );
  const calendarEditRoute = useMemo(
    () => parseCalendarEditRoute(routeLocation.searchStr),
    [routeLocation.searchStr]
  );
  const initialCalendarPreference = useMemo(
    () => readCalendarPreference(),
    []
  );
  const [view, setView] = useState<CalendarView>(initialQuery.view);
  const [date, setDate] = useState(initialQuery.date);
  const [search, setSearch] = useState("");
  const [calendarSearchTarget, setCalendarSearchTarget] = useState<
    (CalendarSearchTarget & { revision: number }) | null
  >(
    initialQuery.machineId
      ? { machineId: initialQuery.machineId, revision: 1 }
      : null
  );
  const calendarStateRef = useRef(initialQuery);
  const initialCalendarRouteAppliedRef = useRef(false);
  const serverDateCorrectionAppliedRef = useRef(false);
  const [visibleHours, setVisibleHours] = useState(
    initialCalendarPreference.visibleHours
  );
  const [zoomGuideDismissed, setZoomGuideDismissed] = useState(readZoomGuideDismissed);
  const dismissZoomGuide = useCallback(() => {
    setZoomGuideDismissed(true);
    saveZoomGuideDismissed();
  }, []);
  const [timelineWindowStartMinutes, setTimelineWindowStartMinutes] = useState(
    () => defaultDayWindowStartMinutes(currentTime)
  );
  const [timelineScrollTarget, setTimelineScrollTarget] = useState(() => ({
    startMinutes: defaultDayWindowStartMinutes(currentTime),
    revision: 0
  }));
  const [reservationMode, setReservationMode] = useState<
    "RESOURCE_GROUP" | "MACHINE"
  >(initialCalendarPreference.reservationMode);
  const [collapsedMachineIds, setCollapsedMachineIds] = useState<Set<string>>(
    () => new Set(readCollapsedCalendarMachineIds(user.id))
  );
  const [drafts, setDrafts] = useState<CalendarDraft[]>([]);
  const [editingReservations, setEditingReservations] = useState<OwnReservation[]>([]);
  const editingReservation = editingReservations[0] ?? null;
  const editingIds = useMemo(() => new Set(editingReservations.map(item => item.id)), [editingReservations]);
  const addingEdit = useRef(false);
  const submittingRef = useRef(false);
  const [editingChanged, setEditingChanged] = useState(false);
  const [editingCheckError, setEditingCheckError] = useState(false);
  const editingRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingRefreshRef = useRef<() => Promise<unknown>>(async () => undefined);
  const [submissionUncertain, setSubmissionUncertain] = useState(false);
  const [myReservationsOpen, setMyReservationsOpen] = useState(() => new URLSearchParams(routeLocation.searchStr).get("mine") === "1");
  const [pendingReservationLocation, setPendingReservationLocation] = useState<OwnReservation | null>(null);
  useEffect(() => {
    if (new URLSearchParams(routeLocation.searchStr).get("mine") === "1") setMyReservationsOpen(true);
  }, [routeLocation.searchStr]);
  const { epoch: editEpoch, refresh: refreshOwnReservations } = useReservationRefresh();
  const [editingDraftTime, setEditingDraftTime] = useState(false);
  const [metadata, setMetadata] = useState<CalendarMetadata>({
    title: "",
    purpose: "",
    note: ""
  });
  const [previewByDraft, setPreviewByDraft] = useState<
    Map<string, ReservationPreviewItem>
  >(new Map());
  const [previewReadError, setPreviewReadError] = useState(false);
  const previewRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRefreshRef = useRef<() => Promise<unknown>>(async () => undefined);
  const draftSnapshot = useRef({ drafts, metadata, editingReservations, editingDraftTime });
  draftSnapshot.current = { drafts, metadata, editingReservations, editingDraftTime };
  const announceAdjustment = useCallback((count: number) => {
    const message = count
      ? tr("已自动调整占用草稿，保留 {{v0}} 个可用时段。", { v0: count })
      : tr("已自动移除不可用时段，没有剩余可用时段。");
    notify(count ? "success" : "error", message);
  }, [notify]);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dragPreview, setDragPreview] = useState<{
    action: "ADD" | "ERASE";
    sourceGroupId: string;
    target: CalendarReservationTarget;
    requested: CalendarTimeRange;
    projected: Array<CalendarTimeRange & CalendarReservationTarget>;
    available: CalendarTimeRange[];
    blocked: boolean;
  } | null>(null);
  const [hoveredTime, setHoveredTime] = useState<{
    groupId: string;
    at: string;
  } | null>(null);
  const [manualBookingOpen, setManualBookingOpen] = useState(false);
  const [reservationDetail, setReservationDetail] =
    useState<CalendarReservationDetail | null>(null);
  const [nearbyReservations, setNearbyReservations] =
    useState<CalendarNearbyReservations | null>(null);
  const [unavailabilityDetail, setUnavailabilityDetail] = useState<{
    item: ProjectedUnavailability;
    machineName: string;
    groupName: string;
    anchor: DOMRect;
  } | null>(null);
  const dragState = useRef<CalendarDragState | null>(null);
  const dragPreviewUpdaterRef = useRef<
    (active: CalendarDragState, endClientX: number) => void
  >(() => undefined);
  const previewRequestIdRef = useRef(0);
  const timelineFrameRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const timelineHorizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const bookingDrawerRef = useRef<HTMLElement | null>(null);
  const calendarSearchHighlightTimerRef = useRef<number | null>(null);
  const lastAltZoomAtRef = useRef(0);
  const timelineStartMinutesRef = useRef(
    defaultDayWindowStartMinutes(currentTime)
  );

  const range = useMemo(() => {
    const startDate = view === "week" ? mondayOf(date) : date;
    const days = view === "week" ? 7 : 1;
    return {
      from: chinaLocalToIso(`${startDate}T00:00`),
      to: chinaLocalToIso(`${addDays(startDate, days)}T00:00`),
      startDate,
      days
    };
  }, [date, view]);
  const {

    timeline,

    initialLoading,

    refreshing,

    connectionState,

    loadTimeline,

    reservationsByGroup,

    machineReservationsByMachine,

    unavailabilityByGroup,

    machineUnavailability,

    groupsByMachine

  } = useTimelineData({ range, notify, synchronizeServerClock });
  const hasTimelineContent = Boolean(
    timeline?.machines.length && timeline?.groups.length
  );
  const serverToday = isoToChinaLocal(
    new Date(currentTime).toISOString()
  ).slice(0, 10);

  const scrollTimelineToMinutes = useCallback(
    (requestedStartMinutes: number) => {
      const shell = timelineShellRef.current;
      const card = shell?.querySelector<HTMLElement>(".timeline-card");
      if (!shell || !card || view !== "day") return;
      const startMinutes = clampDayWindowStartMinutes(
        requestedStartMinutes,
        visibleHours
      );
      const timeTrackWidth = Math.max(
        1,
        card.scrollWidth - TIMELINE_RESOURCE_COLUMN_WIDTH
      );
      timelineStartMinutesRef.current = startMinutes;
      setTimelineWindowStartMinutes(Math.round(startMinutes));
      const scrollLeft = (startMinutes / (24 * 60)) * timeTrackWidth;
      shell.scrollLeft = scrollLeft;
      if (timelineHorizontalScrollRef.current) {
        timelineHorizontalScrollRef.current.scrollLeft = scrollLeft;
      }
    },
    [view, visibleHours]
  );

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollTimelineToMinutes(timelineScrollTarget.startMinutes);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hasTimelineContent, scrollTimelineToMinutes, timelineScrollTarget]);

  useEffect(() => {
    if (view !== "day") {
      timelineStartMinutesRef.current = 0;
      setTimelineWindowStartMinutes(0);
      if (timelineShellRef.current) timelineShellRef.current.scrollLeft = 0;
      if (timelineHorizontalScrollRef.current) {
        timelineHorizontalScrollRef.current.scrollLeft = 0;
      }
      return;
    }
    const preferredHours = readCalendarPreference().visibleHours;
    const startMinutes = defaultDayWindowStartMinutes(
      currentTime,
      preferredHours
    );
    timelineStartMinutesRef.current = startMinutes;
    setTimelineWindowStartMinutes(startMinutes);
    setVisibleHours(preferredHours);
    setTimelineScrollTarget((current) => ({
      startMinutes,
      revision: current.revision + 1
    }));
  }, [date, view]);

  useEffect(() => {
    const shell = timelineShellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        scrollTimelineToMinutes(timelineStartMinutesRef.current);
      });
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [hasTimelineContent, scrollTimelineToMinutes]);

  const handleTimelineScroll = () => {
    const shell = timelineShellRef.current;
    const card = shell?.querySelector<HTMLElement>(".timeline-card");
    if (!shell || !card || view !== "day") return;
    const timeTrackWidth = Math.max(
      1,
      card.scrollWidth - TIMELINE_RESOURCE_COLUMN_WIDTH
    );
    const startMinutes = clampDayWindowStartMinutes(
      (shell.scrollLeft / timeTrackWidth) * 24 * 60,
      visibleHours
    );
    timelineStartMinutesRef.current = startMinutes;
    setTimelineWindowStartMinutes(Math.round(startMinutes));
    if (
      timelineHorizontalScrollRef.current &&
      Math.abs(
        timelineHorizontalScrollRef.current.scrollLeft - shell.scrollLeft
      ) > 0.5
    ) {
      timelineHorizontalScrollRef.current.scrollLeft = shell.scrollLeft;
    }
  };

  const handleTimelineHorizontalScroll = () => {
    const controller = timelineHorizontalScrollRef.current;
    const shell = timelineShellRef.current;
    if (!controller || !shell) return;
    shell.scrollLeft = controller.scrollLeft;
  };

  const { startDragAutoScroll, stopDragAutoScroll } = useDragAutoScroll({ dragState, timelineShellRef, timelineHorizontalScrollRef, dragPreviewUpdaterRef });
  const changeTimelineZoom = useCallback((direction: "IN" | "OUT") => {
    const currentIndex = DAY_ZOOM_LEVELS.indexOf(
      visibleHours as (typeof DAY_ZOOM_LEVELS)[number]
    );
    const nextIndex =
      direction === "IN"
        ? Math.max(0, currentIndex - 1)
        : Math.min(DAY_ZOOM_LEVELS.length - 1, currentIndex + 1);
    const nextHours = DAY_ZOOM_LEVELS[nextIndex];
    if (!nextHours || nextHours === visibleHours) return;
    const currentCenterMinutes =
      timelineStartMinutesRef.current + visibleHours * 30;
    const nextStartMinutes = clampDayWindowStartMinutes(
      currentCenterMinutes - nextHours * 30,
      nextHours
    );
    timelineStartMinutesRef.current = nextStartMinutes;
    setVisibleHours(nextHours);
    dismissZoomGuide();
    writeCalendarPreference({ visibleHours: nextHours });
    setTimelineScrollTarget((current) => ({
      startMinutes: nextStartMinutes,
      revision: current.revision + 1
    }));
  }, [visibleHours, dismissZoomGuide]);

  const handleTimelineWheel = useCallback((event: WheelEvent) => {
    if (view !== "day") return;
    const action = timelineWheelAction(event);
    if (!action || action.kind === "VERTICAL") return;
    if (action.kind === "ZOOM_IN" || action.kind === "ZOOM_OUT") {
      event.preventDefault();
      const now = Date.now();
      if (now - lastAltZoomAtRef.current < 180) return;
      lastAltZoomAtRef.current = now;
      changeTimelineZoom(action.kind === "ZOOM_IN" ? "IN" : "OUT");
      return;
    }
    event.preventDefault();
    const controller = timelineHorizontalScrollRef.current;
    if (!controller) return;
    controller.scrollLeft += action.delta;
  }, [changeTimelineZoom, view]);

  useEffect(() => {
    const frame = timelineFrameRef.current;
    if (!frame) return;
    frame.addEventListener("wheel", handleTimelineWheel, { passive: false });
    return () => frame.removeEventListener("wheel", handleTimelineWheel);
  }, [handleTimelineWheel]);

  const timelineZoom = view === "day" ? 24 / visibleHours : 1;
  const timelineCardWidth =
    view === "day" && timelineZoom > 1
      ? `calc(${timelineZoom * 100}% - ${(timelineZoom - 1) * TIMELINE_RESOURCE_COLUMN_WIDTH
      }px)`
      : "100%";

  const writeCalendarRoute = useCallback(
    (
      next: Partial<{
        date: string;
        view: CalendarView;
        machineId: string;
      }>,
      replace = false
    ) => {
      const state = {
        ...calendarStateRef.current,
        ...next
      };
      calendarStateRef.current = state;
      void calendarRouteNavigate({
        href: calendarQueryUrl(state),
        replace
      });
    },
    [calendarRouteNavigate]
  );

  useEffect(() => {
    const next = parseCalendarQuery(routeLocation.searchStr, todayChina());
    if (!initialCalendarRouteAppliedRef.current && next.machineId) {
      setCalendarSearchTarget({ machineId: next.machineId, revision: 1 });
    }
    initialCalendarRouteAppliedRef.current = true;
    calendarStateRef.current = next;
    setDate((current) => (current === next.date ? current : next.date));
    setView((current) => (current === next.view ? current : next.view));
  }, [routeLocation.searchStr]);

  useEffect(() => {
    if (!pendingReservationLocation || !timeline || refreshing || initialLoading) return;
    const targetDate = isoToChinaLocal(pendingReservationLocation.startAt).slice(0, 10);
    if (date !== targetDate || view !== "day" || !timeline.reservations.some(item => item.id === pendingReservationLocation.id)) return;
    setCalendarSearchTarget({ machineId: pendingReservationLocation.machineId, groupId: pendingReservationLocation.resourceGroupId, revision: Date.now() });
    const time = isoToChinaLocal(pendingReservationLocation.startAt).slice(11, 16).split(":").map(Number);
    setTimelineScrollTarget(current => ({ startMinutes: Math.max(0, time[0] * 60 + time[1] - 30), revision: current.revision + 1 }));
    setPendingReservationLocation(null);
  }, [pendingReservationLocation, timeline, refreshing, initialLoading, date, view]);

  useEffect(() => {
    if (!serverClockReady || serverDateCorrectionAppliedRef.current) return;
    serverDateCorrectionAppliedRef.current = true;
    const params = new URLSearchParams(
      routeLocation.searchStr.startsWith("?")
        ? routeLocation.searchStr.slice(1)
        : routeLocation.searchStr
    );
    if (!params.has("date") && date !== serverToday) {
      setDate(serverToday);
      writeCalendarRoute({ date: serverToday }, true);
    }
  }, [
    date,
    routeLocation.searchStr,
    serverClockReady,
    serverToday,
    writeCalendarRoute
  ]);

  useEffect(() => {
    if (!reservationDetail || !timeline) return;
    const current = timeline.reservations.find(
      (item) => item.id === reservationDetail.item.id
    );
    if (!current) {
      setReservationDetail(null);
      return;
    }
    if (current !== reservationDetail.item) {
      setReservationDetail((detail) =>
        detail ? { ...detail, item: current } : null
      );
    }
  }, [reservationDetail, timeline]);

  const locateCalendarResource = useCallback((target: CalendarSearchTarget) => {
    setCalendarSearchTarget((current) => ({
      ...target,
      revision: (current?.revision ?? 0) + 1
    }));
  }, []);

  const toggleCalendarMachine = useCallback((machineId: string) => {
    setCollapsedMachineIds((current) => {
      const next = new Set(current);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      writeCollapsedCalendarMachineIds(user.id, next);
      return next;
    });
    setHoveredTime(null);
    setDragPreview(null);
  }, [user.id]);

  useLayoutEffect(() => {
    if (!calendarSearchTarget || !timeline) return;
    const machine = timeline.machines.find(
      (item) => item.id === calendarSearchTarget.machineId
    );
    const group = calendarSearchTarget.groupId
      ? timeline.groups.find(
        (item) =>
          item.id === calendarSearchTarget.groupId &&
          item.machineId === calendarSearchTarget.machineId
      )
      : undefined;
    if (!machine || (calendarSearchTarget.groupId && !group)) {
      setCalendarSearchTarget(null);
      return;
    }
    if (
      calendarSearchTarget.groupId &&
      collapsedMachineIds.has(calendarSearchTarget.machineId)
    ) {
      setCollapsedMachineIds((current) => {
        const next = new Set(current);
        next.delete(calendarSearchTarget.machineId);
        writeCollapsedCalendarMachineIds(user.id, next);
        return next;
      });
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const root = timelineFrameRef.current;
      const targets = root?.querySelectorAll<HTMLElement>(
        calendarSearchTarget.groupId
          ? "[data-calendar-group-id]"
          : "[data-calendar-machine-id]:not([data-calendar-group-id])"
      );
      const element = Array.from(targets ?? []).find(
        (item) =>
          item.dataset.calendarMachineId === calendarSearchTarget.machineId &&
          (calendarSearchTarget.groupId
            ? item.dataset.calendarGroupId === calendarSearchTarget.groupId
            : true)
      );
      if (!element) return;
      element.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
        inline: "nearest"
      });
      if (calendarSearchHighlightTimerRef.current !== null) {
        window.clearTimeout(calendarSearchHighlightTimerRef.current);
      }
      const revision = calendarSearchTarget.revision;
      calendarSearchHighlightTimerRef.current = window.setTimeout(() => {
        setCalendarSearchTarget((current) =>
          current?.revision === revision ? null : current
        );
        calendarSearchHighlightTimerRef.current = null;
      }, 1_800);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [calendarSearchTarget, collapsedMachineIds, timeline, user.id, view]);

  useEffect(
    () => () => {
      if (calendarSearchHighlightTimerRef.current !== null) {
        window.clearTimeout(calendarSearchHighlightTimerRef.current);
      }
    },
    []
  );

  const groupById = useMemo(
    () =>
      new Map(
        (timeline?.groups ?? []).map((group) => [group.id, group] as const)
      ),
    [timeline]
  );

  const draftsByTarget = useMemo(() => {
    const map = new Map<string, CalendarDraft[]>();
    for (const draft of drafts) {
      const key = reservationTargetKey(draft);
      const bucket = map.get(key) ?? [];
      bucket.push(draft);
      map.set(key, bucket);
    }
    return map;
  }, [drafts]);

  const busyRangesForTarget = useCallback(
    (target: CalendarReservationTarget) => {
      const group = groupById.get(target.resourceGroupId);
      if (!group) return [];
      const reservations =
        target.scope === "MACHINE"
          ? (timeline?.reservations ?? []).filter(
            (item) =>
              item.machineId === target.machineId &&
              !editingIds.has(item.id)
          )
          : [
            ...(reservationsByGroup.get(target.resourceGroupId) ?? []),
            ...(machineReservationsByMachine.get(target.machineId) ?? [])
          ].filter((item) => !editingIds.has(item.id));
      const unavailable =
        target.scope === "MACHINE"
          ? (timeline?.unavailability ?? []).filter(
            (item) => item.machineId === target.machineId
          )
          : [
            ...(unavailabilityByGroup.get(target.resourceGroupId) ?? []),
            ...(machineUnavailability.get(target.machineId) ?? [])
          ];
      return [
        ...reservations,
        ...unavailable
      ].map((item) => ({
        startAt: item.startAt,
        endAt: item.endAt
      }));
    },
    [
      groupById,
      editingIds,
      machineUnavailability,
      machineReservationsByMachine,
      reservationsByGroup,
      timeline,
      unavailabilityByGroup
    ]
  );

  const projectDraggedRange = useCallback(
    (target: CalendarReservationTarget, requested: CalendarTimeRange) => {
      const currentMinute = currentMinuteStart(currentTime);
      const available = subtractBusyTimeRanges(
        requested,
        [
          ...busyRangesForTarget(target),
          {
            startAt: range.from,
            endAt: currentMinute
          }
        ],
        settings.minBookingMinutes
      );
      return {
        target,
        requested,
        available,
        blocked: !available.length,
        projected: mergeTimeRanges([
          ...(draftsByTarget.get(reservationTargetKey(target)) ?? []),
          ...available
        ]).map((projectedRange) => ({
          ...target,
          ...projectedRange
        }))
      };
    },
    [
      busyRangesForTarget,
      currentTime,
      draftsByTarget,
      range.from,
      settings.minBookingMinutes
    ]
  );

  const draftIssues = useMemo(
    () =>
      editingDraftTime
        ? []
        : calendarDraftIssues(drafts, settings, currentTime, editingReservations.length > 0),
    [currentTime, drafts, editingDraftTime, editingReservations.length, i18n.resolvedLanguage, settings]
  );
  const draftFieldIssuesById = useMemo(
    () =>
      new Map(
        drafts.map((draft) => [
          draft.id,
          editingDraftTime
            ? {}
            : calendarDraftFieldIssues(draft, settings, currentTime)
        ])
      ),
    [currentTime, drafts, editingDraftTime, editingReservations.length, i18n.resolvedLanguage, settings]
  );
  const generalDraftIssues = useMemo(() => {
    const fieldMessages = new Set(
      [...draftFieldIssuesById.values()].flatMap((issues) =>
        [issues.startAt, issues.endAt].filter(
          (message): message is string => Boolean(message)
        )
      )
    );
    return draftIssues.filter((issue) => !fieldMessages.has(issue));
  }, [draftFieldIssuesById, draftIssues]);

  const invalidatePreview = () => {
    previewRequestIdRef.current += 1;
    setPreviewing(false);
    setPreviewByDraft(new Map());
  };

  const updateDraftTime = (
    draftId: string,
    field: "startAt" | "endAt",
    localValue: string
  ) => {
    if (submittingRef.current) return;
    const currentMinute = currentMinuteStart(currentTime);
    const currentMinuteTime = new Date(currentMinute).getTime();
    let normalizedValue = localValue ? chinaLocalToIso(localValue) : "";
    const original = drafts.find((draft) => draft.id === draftId);
    if (!original) return;
    let startMode = original.startMode;
    if (
      field === "startAt" &&
      normalizedValue &&
      new Date(normalizedValue).getTime() <= currentMinuteTime
    ) {
      normalizedValue = currentMinute;
      startMode = "IMMEDIATE";
    } else if (field === "startAt" && normalizedValue) {
      startMode = "SCHEDULED";
    }
    const edited = {
      ...original,
      [field]: normalizedValue,
      startMode
    };
    const start = new Date(edited.startAt).getTime();
    const end = new Date(edited.endAt).getTime();
    if (
      !normalizedValue ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end
    ) {
      setDrafts((current) =>
        current.map((draft) => (draft.id === draftId ? edited : draft))
      );
      invalidatePreview();
      return;
    }
    const target: CalendarReservationTarget = {
      scope: edited.scope ?? "RESOURCE_GROUP",
      machineId: edited.machineId ?? groupById.get(edited.resourceGroupId)?.machineId ?? "",
      resourceGroupId: edited.resourceGroupId
    };
    const projection = projectDraggedRange(target, {
      startAt: edited.startAt,
      endAt: edited.endAt
    });
    const adjusted =
      normalizedValue !== (localValue ? chinaLocalToIso(localValue) : "") ||
      projection.available.length !== 1 ||
      projection.available[0]?.startAt !== edited.startAt ||
      projection.available[0]?.endAt !== edited.endAt;
    setDrafts((current) => {
      const withoutEdited = current.filter((draft) => draft.id !== draftId);
      const replacements = projection.available.length
        ? projection.available.map((range, index) => ({
          ...edited,
          id: index === 0 ? draftId : createClientId(),
          ...range,
          startMode:
            new Date(range.startAt).getTime() <= currentMinuteTime
              ? "IMMEDIATE" as const
              : "SCHEDULED" as const
        }))
        : [edited];
      return mergeCalendarDrafts(
        [...withoutEdited, ...replacements],
        [],
        () => createClientId(),
        currentMinute
      );
    });
    if (adjusted && projection.available.length) {
      notify(
        "success",
        projection.available.length === 1
          ? tr("已跳过过去或被占用的部分，并保留可用时段")
          : tr("已跳过过去或被占用的部分，并保留 {{v0}} 个可用时段", { v0: projection.available.length })
      );
    }
    invalidatePreview();
  };

  const resetReservationDetailsState = () => {
    previewRequestIdRef.current++;
    setPreviewReadError(false);
    setDrafts([]);
    setEditingReservations([]);
    setEditingChanged(false); setSubmissionUncertain(false);
    setEditingDraftTime(false);
    setMetadata({ title: "", purpose: "", note: "" });
    setPreviewByDraft(new Map());
  };

  const clearReservationDetails = () => {
    if (editingReservation || calendarEditRoute.kind !== "NONE") {
      void calendarRouteNavigate({
        href: calendarUrlWithoutEditRequest(routeLocation.searchStr),
        replace: true
      });
    }
    resetReservationDetailsState();
  };

  const requestEditingReservation = async (item: Pick<TimelineReservation, "id" | "mine" | "endAt">) => {
    if (!item.mine || editingIds.has(item.id) || addingEdit.current || submittingRef.current) return;
    if (editingReservations.length >= 100) { notify("error", tr("一次最多编辑 100 条占用")); return; }
    addingEdit.current = true;
    try {
      const result = await api<OwnReservationDetail>(`/reservations/mine/${item.id}`);
      const original = result.reservation;
      if (!original.canEdit || original.status !== "CONFIRMED" || Date.parse(original.endAt) <= currentTime) {
        notify("error", tr("该占用已经结束或无法修改")); return;
      }
      const minute = currentMinuteStart(currentTime);
      const startAt = original.startAt < minute ? minute : original.startAt;
      if (minuteDifference(startAt, original.endAt) < settings.minBookingMinutes) {
        notify("error", tr("该占用剩余时间过短，无法进入编辑状态")); return;
      }
      if (!editingReservations.length && !drafts.length) {
        setReservationMode(original.scope);
        setMetadata({ title: original.title, purpose: original.purpose, note: original.note });
      }
      setEditingReservations(current => [...current, original]);
      setDrafts(current => mergeCalendarDrafts(current, [{
        scope: original.scope, machineId: original.machineId,
        resourceGroupId: original.resourceGroupId, startMode: startAt <= minute ? "IMMEDIATE" : "SCHEDULED",
        startAt, endAt: original.endAt
      }], () => createClientId(), minute));
      setReservationDetail(null); setPreviewByDraft(new Map());
    } catch (error) { notify("error", error instanceof Error ? error.message : tr("请求失败")); }
    finally { addingEdit.current = false; }
  };
  useEffect(() => {
    if (calendarEditRoute.kind !== "EDIT" || !timeline || refreshing || initialLoading) return;
    const item = timeline.reservations.find(row => row.id === calendarEditRoute.reservationId);
    if (item) void requestEditingReservation(item);
    else notify("error", tr("该占用已经结束或无法修改"));
    void calendarRouteNavigate({ href: calendarUrlWithoutEditRequest(routeLocation.searchStr), replace: true });
  }, [calendarEditRoute, timeline, refreshing, initialLoading]);

  const inspectEditingReservations = useCallback(async (signal: AbortSignal) => {
    if (editingRetry.current) clearTimeout(editingRetry.current);
    if (!editingReservations.length) { setEditingChanged(false); setEditingCheckError(false); return; }
    await withRequestDeadline(readSignal => api<{ reservations: OwnReservation[] }>("/reservations/mine/inspect", {
      method: "POST", body: jsonBody({ ids: editingReservations.map(item => item.id) }), signal: readSignal
    }), signal).then(result => {
      if (signal.aborted) return;
      setEditingCheckError(false);
      const latest = new Map(result.reservations.map(item => [item.id, item]));
      setEditingChanged(editingReservations.some(item => {
        const current = latest.get(item.id);
        return !current || !current.canEdit || current.status !== "CONFIRMED" || current.stateToken !== item.stateToken;
      }));
    }).catch(() => {
      if (signal.aborted) return;
      setEditingCheckError(true);
      editingRetry.current = setTimeout(() => void editingRefreshRef.current(), 5000);
    });
  }, [editingReservations]);
  const refreshEditingReservations = useRealtimeRefresh(inspectEditingReservations, ["ownReservations"], { enabled: editingReservations.length > 0 });
  editingRefreshRef.current = refreshEditingReservations;
  useEffect(() => {
    void refreshEditingReservations();
    return () => { if (editingRetry.current) clearTimeout(editingRetry.current); };
  }, [editEpoch, refreshEditingReservations]);
  useEffect(() => {
    if (editingReservations.some(item => Date.parse(item.endAt) <= currentTime)) setEditingChanged(true);
  }, [currentTime, editingReservations]);

  useEffect(() => {
    if (editingDraftTime || submittingRef.current) return;
    if (editingReservations.some(item => Date.parse(item.endAt) <= currentTime)) setEditingChanged(true);
    const minute = currentMinuteStart(currentTime);
    const advanced = advanceCalendarDrafts(drafts, minute, settings.minBookingMinutes);
    if (advanced.changed) {
      setDrafts(mergeCalendarDrafts(advanced.drafts, [], () => createClientId(), minute));
      setPreviewByDraft(new Map());
      if (drafts.length !== advanced.drafts.length || drafts.some((draft, index) => draft.startAt !== advanced.drafts[index]?.startAt || draft.endAt !== advanced.drafts[index]?.endAt)) announceAdjustment(advanced.drafts.length);
    }
  }, [currentTime, editingReservations, editingDraftTime, drafts, settings.minBookingMinutes, announceAdjustment]);

  const clearReservationDetailsWithConfirmation = async () => {
    if (
      (drafts.length || editingReservation) &&
      !(await dialog.confirm({
        title: editingReservation ? tr("放弃编辑") : tr("清空占用详情"),
        message: editingReservation
          ? tr("当前修改不会提交，原占用将保持不变。")
          : tr("当前未提交的占用时段和填写内容将被清除。"),
        confirmLabel: editingReservation ? tr("确认放弃") : tr("确认清空"),
        tone: "danger"
      }))
    ) {
      return;
    }
    clearReservationDetails();
  };

  const appendDraft = (
    target: CalendarReservationTarget,
    startAt: string,
    endAt: string
  ) => {
    if (submittingRef.current) return false;
    const requested = { startAt, endAt };
    const currentMinute = currentMinuteStart(currentTime);
    const currentMinuteTime = new Date(currentMinute).getTime();
    const projection = projectDraggedRange(target, requested);
    const additions = projection.available.map((availableRange) => ({
      ...target,
      ...availableRange,
      startMode:
        new Date(availableRange.startAt).getTime() <= currentMinuteTime
          ? "IMMEDIATE" as const
          : "SCHEDULED" as const
    }));
    if (!additions.length) {
      notify(
        "error",
        target.scope === "MACHINE"
          ? tr("该时段内机器已有资源被占用")
          : tr("所选时段已被占用，没有可加入的空闲片段")
      );
      return false;
    }
    setDrafts((current) =>
      mergeCalendarDrafts(
        current,
        additions,
        () => createClientId(),
        currentMinute
      )
    );
    invalidatePreview();
    const adjusted =
      projection.available.length !== 1 ||
      projection.available[0]?.startAt !== requested.startAt ||
      projection.available[0]?.endAt !== requested.endAt;
    if (adjusted) {
      notify(
        "success",
        projection.available.length === 1
          ? tr("已跳过过去或被占用的部分，并保留可用时段")
          : tr("已跳过过去或被占用的部分，并保留 {{v0}} 个可用时段", { v0: projection.available.length })
      );
    }
    return true;
  };

  // Expired/too-short slots need an authoritative adjustment too; incomplete input does not.
  const previewBlocked = drafts.length > 100 || drafts.some(draft => {
    const start = Date.parse(draft.startAt), end = Date.parse(draft.endAt);
    return !Number.isFinite(start) || !Number.isFinite(end) || end <= start ||
      end - Math.max(start, currentTime) > settings.maxBookingMinutes * 60_000 ||
      end > currentTime + settings.advanceDays * 86_400_000;
  });
  const fetchDraftPreview = useCallback(async (signal: AbortSignal) => {
    if (previewRetry.current) clearTimeout(previewRetry.current);
    if (!drafts.length || previewBlocked || editingDraftTime || submittingRef.current || submissionUncertain || editingChanged) return;
    const requestId = ++previewRequestIdRef.current;
    setPreviewing(true);
    try {
      const requestStartedAt = performance.now();
      const result = await withRequestDeadline(readSignal => api<{ items: ReservationPreviewItem[]; serverNow: string }>("/reservations/preview", {
        method: "POST", signal: readSignal,
        body: jsonBody({
          segments: drafts.map(draft => reservationInput(draft, metadata)), autoAdjust: true,
          ...(editingReservations.length ? { replaceReservations: editingReservations.map(({ id, stateToken }) => ({ id, stateToken })) } : {})
        })
      }), signal);
      const current = draftSnapshot.current;
      if (signal.aborted || requestId !== previewRequestIdRef.current || submittingRef.current || current.editingDraftTime || current.drafts !== drafts || current.metadata !== metadata || current.editingReservations !== editingReservations) return;
      const adjusted = adjustDraftsToAvailability(drafts, result.items, createClientId);
      synchronizeServerClock(result.serverNow, requestStartedAt);
      setPreviewReadError(false);
      if (adjusted.changed) {
        setDrafts(adjusted.drafts); setPreviewByDraft(new Map()); announceAdjustment(adjusted.drafts.length);
      } else setPreviewByDraft(previewsByDraftId(drafts, result.items));
    } catch (error) {
      if (signal.aborted || requestId !== previewRequestIdRef.current) return;
      if (error instanceof ApiError && error.status === 409 && editingReservations.length) setEditingChanged(true);
      else {
        setPreviewReadError(true);
        previewRetry.current = setTimeout(() => void previewRefreshRef.current(), 5000);
      }
    } finally {
      if (requestId === previewRequestIdRef.current) setPreviewing(false);
    }
  }, [drafts, previewBlocked, editingDraftTime, metadata, editingReservations, submissionUncertain, editingChanged, announceAdjustment, synchronizeServerClock]);
  const refreshDraftPreview = useRealtimeRefresh(fetchDraftPreview, ["timeline", "ownReservations"], {
    enabled: drafts.length > 0 && !submitting && !editingDraftTime && !submissionUncertain,
    filter: () => ({
      machineIds: [...new Set(drafts.map(draft => draft.machineId).filter((id): id is string => Boolean(id)))],
      from: drafts.reduce((value, draft) => value < draft.startAt ? value : draft.startAt, drafts[0]?.startAt ?? ""),
      to: drafts.reduce((value, draft) => value > draft.endAt ? value : draft.endAt, drafts[0]?.endAt ?? "")
    })
  });
  previewRefreshRef.current = refreshDraftPreview;
  useEffect(() => {
    void refreshDraftPreview();
    return () => { previewRequestIdRef.current++; if (previewRetry.current) clearTimeout(previewRetry.current); };
  }, [refreshDraftPreview, timeline?.revision, submitting]);

  const submitDrafts = async () => {
    if (!drafts.length || draftIssues.length || editingChanged || submissionUncertain || submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true);
    previewRequestIdRef.current++;
    try {
      const requestStartedAt = performance.now();
      // Availability adjustment and the write run under one server transaction.
      const result = await withRequestDeadline(signal => api<{ serverNow: string; adjusted: boolean; reservations: ReservationSegmentInput[] }>("/reservations/batch", {
        method: "POST", signal,
        body: jsonBody({
          segments: drafts.map(draft => reservationInput(draft, metadata)), autoAdjust: true,
          ...(editingReservations.length ? { replaceReservations: editingReservations.map(({ id, stateToken }) => ({ id, stateToken })) } : {})
        })
      }));
      if (!Array.isArray(result.reservations) || !result.reservations.length || typeof result.adjusted !== "boolean" || !Number.isFinite(Date.parse(result.serverNow))) throw new Error("Invalid submission response");
      synchronizeServerClock(result.serverNow, requestStartedAt);
      notify("success", result.adjusted
        ? tr("已自动调整并提交 {{v0}} 条资源占用", { v0: result.reservations.length })
        : editingReservation ? tr("已更新为 {{v0}} 条资源占用", { v0: result.reservations.length })
          : tr("已提交 {{v0}} 条资源占用", { v0: result.reservations.length }));
      clearReservationDetails();
      refreshOwnReservations();
      await loadTimeline();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) {
        setSubmissionUncertain(true);
        notify("error", tr("提交结果暂不明确，请先核对占用记录，勿重复提交。"));
      } else if (Array.isArray(error.details)) {
        const adjusted = adjustDraftsToAvailability(drafts, error.details as ReservationPreviewItem[], createClientId);
        setDrafts(adjusted.drafts); setPreviewByDraft(new Map());
        if (adjusted.changed) announceAdjustment(adjusted.drafts.length);
        if (adjusted.drafts.length) notify("error", error.message);
      } else {
        if (error.status === 409 && editingReservations.length) setEditingChanged(true);
        notify("error", error.message);
      }
      refreshOwnReservations();
    } finally {
      submittingRef.current = false; setSubmitting(false); setPreviewing(false);
    }
  };

  const updateHoveredTimelineTime = (
    track: HTMLDivElement,
    groupId: string,
    pointer: number
  ) => {
    const rect = track.getBoundingClientRect();
    const at = snappedTimelineInstant({
      rangeStart: range.from,
      days: range.days,
      trackLeft: rect.left,
      trackWidth: rect.width,
      pointer
    });
    setHoveredTime(at ? { groupId, at } : null);
  };

  const updateDragSelection = useCallback(
    (active: CalendarDragState, endClientX: number) => {
      const rect = active.track.getBoundingClientRect();
      const requested = draggedTimeRange({
        rangeStart: range.from,
        days: range.days,
        trackLeft: rect.left,
        trackWidth: rect.width,
        pointerStart: active.startX,
        pointerEnd: endClientX,
        anchorAt: active.anchorAt
      });
      if (!requested) {
        setDragPreview(null);
        return;
      }
      if (active.action === "ERASE") {
        const erased = eraseCalendarDraftRange(
          drafts,
          active.target,
          requested,
          () => "preview",
          settings.minBookingMinutes,
          currentMinuteStart(currentTime)
        );
        setDragPreview({
          action: "ERASE",
          sourceGroupId: active.groupId,
          target: active.target,
          requested,
          available: [],
          blocked: false,
          projected: erased.drafts
            .filter(
              (draft) =>
                reservationTargetKey(draft) ===
                reservationTargetKey(active.target)
            )
            .map((draft) => ({
              scope: draft.scope ?? "RESOURCE_GROUP",
              machineId: draft.machineId ?? active.target.machineId,
              resourceGroupId: draft.resourceGroupId,
              startAt: draft.startAt,
              endAt: draft.endAt
            }))
        });
        return;
      }
      const projection = projectDraggedRange(active.target, requested);
      setDragPreview({
        action: "ADD",
        sourceGroupId: active.groupId,
        ...projection
      });
    },
    [
      currentTime,
      drafts,
      projectDraggedRange,
      range.days,
      range.from,
      settings.minBookingMinutes
    ]
  );

  dragPreviewUpdaterRef.current = updateDragSelection;

  const finishDrag = (
    track: HTMLDivElement,
    groupId: string,
    pointerId: number,
    endClientX: number
  ) => {
    const active = dragState.current;
    dragState.current = null;
    stopDragAutoScroll();
    setDragPreview(null);
    updateHoveredTimelineTime(track, groupId, endClientX);
    if (
      !active ||
      active.groupId !== groupId ||
      active.pointerId !== pointerId ||
      view !== "day"
    ) {
      return;
    }
    const rect = track.getBoundingClientRect();
    const dragged = draggedTimeRange({
      rangeStart: range.from,
      days: range.days,
      trackLeft: rect.left,
      trackWidth: rect.width,
      pointerStart: active.startX,
      pointerEnd: endClientX,
      anchorAt: active.anchorAt
    });
    if (!dragged) return;
    if (active.action === "ERASE") {
      const erased = eraseCalendarDraftRange(
        drafts,
        active.target,
        dragged,
        () => createClientId(),
        settings.minBookingMinutes,
        currentMinuteStart(currentTime)
      );
      if (!erased.changed) return;
      setDrafts(erased.drafts);
      invalidatePreview();
      return;
    }
    appendDraft(
      active.target,
      dragged.startAt,
      dragged.endAt
    );
  };

  const changeDate = (nextDate: string) => {
    setDate(nextDate);
    writeCalendarRoute({ date: nextDate });
  };

  const changeView = (nextView: CalendarView, nextDate = date) => {
    setView(nextView);
    setDate(nextDate);
    writeCalendarRoute({ view: nextView, date: nextDate });
  };

  const openTimelineReservation = (
    event: React.MouseEvent<HTMLButtonElement>,
    clickedItem: TimelineReservation,
    rowReservations: TimelineReservation[],
    machineName: string,
    resourceGroupName: string
  ) => {
    event.stopPropagation();
    setUnavailabilityDetail(null);
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const anchor =
      event.detail === 0
        ? buttonRect
        : new DOMRect(event.clientX, event.clientY, 0, 0);
    const detailFor = (item: TimelineReservation): CalendarReservationDetail => ({
      item,
      machineName,
      groupName:
        item.scope === "MACHINE"
          ? tr("{{v0}} · 整机", { v0: machineName })
          : resourceGroupName,
      anchor
    });
    if (event.detail === 0) {
      setNearbyReservations(null);
      setReservationDetail(detailFor(clickedItem));
      return;
    }

    const track = event.currentTarget.closest<HTMLElement>(".time-track");
    const trackRect = track?.getBoundingClientRect();
    const candidates = rowReservations
      .filter((item) => !editingIds.has(item.id))
      .sort((left, right) => left.startAt.localeCompare(right.startAt));
    if (!trackRect || trackRect.width <= 0) {
      setNearbyReservations(null);
      setReservationDetail(detailFor(clickedItem));
      return;
    }
    const hit = timelineNearbyHitIndexes({
      items: candidates,
      rangeStart: range.from,
      rangeEnd: range.to,
      trackWidth: trackRect.width,
      pointerX: event.clientX - trackRect.left
    });
    if (hit.directIndex !== null) {
      setNearbyReservations(null);
      setReservationDetail(detailFor(candidates[hit.directIndex]));
      return;
    }
    const nearby = hit.nearbyIndexes.map((index) => detailFor(candidates[index]));
    if (nearby.length > 1) {
      setReservationDetail(null);
      setNearbyReservations({ items: nearby, anchor });
      return;
    }
    setNearbyReservations(null);
    setReservationDetail(detailFor(nearby[0]?.item ?? clickedItem));
  };

  const syncLabel = refreshing
    ? tr("正在更新")
    : connectionState === "CONNECTED"
      ? tr("实时同步")
      : connectionState === "CONNECTING"
        ? tr("正在连接")
        : tr("同步已断开");
  const serverClockIso = new Date(currentTime).toISOString();
  const showBeijingCompanion =
    serverClockReady && !beijingTimeMode && !clientUsesUtcPlus8(currentTime);
  const toggleBeijingTimeMode = () => {
    const rangeCenter = new Date(
      (new Date(range.from).getTime() + new Date(range.to).getTime()) / 2
    ).toISOString();
    const nextMode = !beijingTimeMode;
    onBeijingTimeModeChange(nextMode);
    const nextDate = isoToChinaLocal(rangeCenter).slice(0, 10);
    if (nextDate && nextDate !== date) changeDate(nextDate);
  };
  return {
    setMyReservationsOpen,
    serverClockReady,
    serverClockIso,
    showBeijingCompanion,
    toggleBeijingTimeMode,
    connectionState,
    refreshing,
    syncLabel,
    changeDate,
    date,
    view,
    serverToday,
    range,
    changeView,
    reservationMode,
    editingReservation,
    drafts,
    setReservationMode,
    visibleHours,
    changeTimelineZoom,
    zoomGuideDismissed,
    dismissZoomGuide,
    timeline,
    search,
    setSearch,
    locateCalendarResource,
    loadTimeline,
    timelineFrameRef,
    initialLoading,
    timelineShellRef,
    handleTimelineScroll,
    timelineCardWidth,
    timelineWindowStartMinutes,
    currentTime,
    groupsByMachine,
    machineUnavailability,
    collapsedMachineIds,
    calendarSearchTarget,
    toggleCalendarMachine,
    reservationsByGroup,
    machineReservationsByMachine,
    editingIds,
    unavailabilityByGroup,
    dragPreview,
    draftsByTarget,
    submittingRef,
    dragState,
    setDragPreview,
    updateHoveredTimelineTime,
    updateDragSelection,
    startDragAutoScroll,
    stopDragAutoScroll,
    setHoveredTime,
    finishDrag,
    hoveredTime,
    setReservationDetail,
    setNearbyReservations,
    setUnavailabilityDetail,
    openTimelineReservation,
    timelineHorizontalScrollRef,
    handleTimelineHorizontalScroll,
    timelineZoom,
    bookingDrawerRef,
    submitting,
    setManualBookingOpen,
    clearReservationDetailsWithConfirmation,
    previewReadError,
    editingCheckError,
    editingReservations,
    setEditingReservations,
    setPreviewByDraft,
    editingChanged,
    submissionUncertain,
    previewByDraft,
    draftFieldIssuesById,
    setDrafts,
    invalidatePreview,
    setMetadata,
    updateDraftTime,
    previewRequestIdRef,
    setEditingDraftTime,
    generalDraftIssues,
    metadata,
    previewing,
    draftIssues,
    submitDrafts,
    myReservationsOpen,
    setView,
    setDate,
    writeCalendarRoute,
    setPendingReservationLocation,
    reservationDetail,
    requestEditingReservation,
    nearbyReservations,
    unavailabilityDetail,
    manualBookingOpen,
    appendDraft
  };
}

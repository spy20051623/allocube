import { CalendarDateButton } from "../../CalendarDateButton";
import { PageHeader } from "../../PageHeader";
import { CalendarMyReservations } from "../../CalendarMyReservations";
import type { OwnReservationDetail } from "../../shared/my-reservations";
import { tr } from "../../i18n/index";
import { CalendarResourceFinder } from "../../CalendarResourceFinder";
import { type CalendarEventModel, CalendarDayEventBlock } from "../../CalendarEventVisual";
import {
  Clock3,
  Server,
  ChevronLeft,
  ChevronRight,
  ZoomOut,
  ZoomIn,
  RefreshCw,
  PowerOff,
  Plus,
  X,
  Cpu,
  Trash2,
  Check,
  CircleAlert
} from "lucide-react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { type Page } from "../../app-routing";
import {
  formatChina,
  formatBeijing,
  addDays,
  chinaLocalToIso,
  formatChinaFullMinute,
  isoToChinaLocal,
  durationText,
  minuteDifference
} from "../../date";
import {
  currentMinuteStart,
  reservationTargetKey,
  calendarDragAction,
  snappedTimelineInstant
} from "../../calendar-state";
import { writeCalendarPreference } from "../../calendar-preference";
import {
  mergeProjectedUnavailability,
  mergeProjectedDisableHistory,
  type ProjectedUnavailability
} from "../../calendar-unavailability";
import type { AuthUser, DashboardBootstrap, TimelineReservation } from "../../shared/types";
import { type CalendarReservationTarget } from "./types";
import { MouseLeftButtonIcon, MouseRightButtonIcon, MouseWheelIcon } from "./MouseControlIcon";
import { CalendarEmptyState } from "./CalendarEmptyState";
import {
  TimelineScale,
  CalendarWeekDayCell,
  TrackGrid,
  CurrentTimeLine,
  PastTimeShade,
  TimelineHoverGuide,
  formatTimelineDayPeriod
} from "./CalendarTimeline";
import { CalendarMachineStripLine, CalendarResourceCell } from "./CalendarMachineRows";
import { reservationCalendarEvent, draftCalendarEvent } from "./reservation-events";
import { CalendarReservationTimeFields, CalendarReservationMetadataFields } from "./ReservationFields";
import {
  CalendarReservationPopover,
  CalendarNearbyReservationsPopover,
  CalendarUnavailabilityPopover
} from "./ReservationPopovers";
import { CalendarManualBookingModal } from "./ManualBookingModal";
import { useCalendarController } from "./useCalendarController";

export function CalendarPage({
  user,
  settings,
  notify,
  navigate,
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
  const {
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
  } = useCalendarController({ user, settings, notify, navigate, beijingTimeMode, onBeijingTimeModeChange });

  return (
    <div className="calendar-layout composer-open">
      <section className="calendar-main">
        <PageHeader
          title={tr("资源日历")}
          actions={(
            <div className="calendar-header-actions">
              <button className="secondary-button" onClick={() => setMyReservationsOpen(true)}><Clock3 size={16} />{tr("我的占用")}</button>
              <button className="secondary-button" onClick={() => navigate("resources")}>
                <Server size={16} />{tr("全部资源")}</button>
            </div>
          )}
        />
        <div className="calendar-utility-row">
          <div className="calendar-title-status">
            <div
              className={`server-clock${serverClockReady ? "" : " synchronizing"}`}
              title={formatChina(serverClockIso, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
              })}
            >
              <Clock3 size={14} />
              <span>{tr("服务器时间")}</span>
              <strong>
                {serverClockReady
                  ? formatChina(serverClockIso, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false
                  })
                  : tr("同步中")}
              </strong>
              {showBeijingCompanion && (
                <>
                  <i aria-hidden="true" />
                  <span>{tr("北京")}</span>
                  <strong>
                    {formatBeijing(serverClockIso, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false
                    })}
                  </strong>
                </>
              )}
            </div>
            <button
              type="button"
              className={`time-zone-toggle${beijingTimeMode ? " active" : ""}`}
              aria-pressed={beijingTimeMode}
              title={beijingTimeMode ? tr("切换为当地时间") : tr("切换为北京时间")}
              onClick={toggleBeijingTimeMode}
            >
              {beijingTimeMode ? tr("北京") : tr("当地")}
            </button>
            <div className={`live-state ${connectionState.toLowerCase()}${refreshing ? " refreshing" : ""}`}>
              <span />{syncLabel}
            </div>
          </div>
          <div
            className="calendar-wheel-hint"
            title={tr("左键拖动：新增占用；右键拖动或 Ctrl + 左键拖动：删除草稿时段；滚轮：上下滚动；Shift + 滚轮：左右滚动；Alt + 滚轮：缩放时间轴")}
            aria-label={tr("时间轴操作：鼠标左键拖动新增占用，鼠标右键拖动或 Control 加鼠标左键拖动删除草稿时段，滚轮上下滚动，Shift 加滚轮左右滚动，Alt 加滚轮缩放")}
          >
            <span><MouseLeftButtonIcon />{tr("拖动 新增")}</span>
            <i />
            <span>
              <MouseRightButtonIcon />{tr("拖动")}<b>/</b>
              <span className="calendar-hint-combination"><kbd>Ctrl</kbd>+<MouseLeftButtonIcon /></span>{tr("拖动 删除")}</span>
            <i />
            <span><MouseWheelIcon />{tr("上下")}</span>
            <i />
            <span><span className="calendar-hint-combination"><kbd>Shift</kbd>+<MouseWheelIcon /></span>{tr("左右")}</span>
            <i />
            <span><span className="calendar-hint-combination"><kbd>Alt</kbd>+<MouseWheelIcon /></span>{tr("缩放")}</span>
          </div>
        </div>
        <div className="toolbar">
          <div className="toolbar-group">
            <button className="icon-button" aria-label={tr("上一时间范围")} onClick={() => changeDate(addDays(date, view === "week" ? -7 : -1))}><ChevronLeft size={18} /></button>
            <CalendarDateButton
              date={date}
              today={serverToday}
              label={
                view === "day"
                  ? formatChina(range.from, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    weekday: "short"
                  })
                  : `${formatChina(range.from, {
                    month: "short",
                    day: "numeric"
                  })} — ${formatChina(
                    chinaLocalToIso(
                      `${addDays(range.startDate, 6)}T00:00`
                    ),
                    { month: "short", day: "numeric" }
                  )}`
              }
              onSelect={changeDate}
            />
            <button className="icon-button" aria-label={tr("下一时间范围")} onClick={() => changeDate(addDays(date, view === "week" ? 7 : 1))}><ChevronRight size={18} /></button>
          </div>
          <div className="segmented">
            <button className={view === "day" ? "active" : ""} onClick={() => changeView("day")}>{tr("一天")}</button>
            <button className={view === "week" ? "active" : ""} onClick={() => changeView("week")}>{tr("一周")}</button>
          </div>
          <div
            className={`segmented reservation-mode calendar-day-control${view === "day" ? "" : " hidden"}`}
            aria-hidden={view !== "day"}
          >
            <button
              className={reservationMode === "RESOURCE_GROUP" ? "active" : ""}
              disabled={
                Boolean(editingReservation) ||
                drafts.some((draft) => draft.scope === "MACHINE")
              }
              title={
                editingReservation
                  ? tr("编辑占用时不能更改占用模式")
                  : drafts.length
                    ? tr("清空当前草稿后可以切换占用模式")
                    : undefined
              }
              onClick={() => {
                setReservationMode("RESOURCE_GROUP");
                writeCalendarPreference({
                  reservationMode: "RESOURCE_GROUP"
                });
              }}
            >
              {tr("资源组")}</button>
            <button
              className={reservationMode === "MACHINE" ? "active" : ""}
              disabled={
                Boolean(editingReservation) ||
                drafts.some((draft) => draft.scope !== "MACHINE")
              }
              title={
                editingReservation
                  ? tr("编辑占用时不能更改占用模式")
                  : drafts.length
                    ? tr("清空当前草稿后可以切换占用模式")
                    : undefined
              }
              onClick={() => {
                setReservationMode("MACHINE");
                writeCalendarPreference({ reservationMode: "MACHINE" });
              }}
            >
              {tr("整机")}</button>
          </div>
          <div
            className={`timeline-zoom-control calendar-day-control${view === "day" ? "" : " hidden"}`}
            aria-label={tr("时间轴缩放")}
            aria-hidden={view !== "day"}
          >
            <button
              type="button"
              aria-label={tr("缩小时间轴")}
              disabled={visibleHours === 24}
              onClick={() => changeTimelineZoom("OUT")}
            >
              <ZoomOut size={15} />
            </button>
            <span aria-label={tr("{{v0}} 小时", { v0: visibleHours })}>
              {visibleHours}h
            </span>
            <button
              type="button"
              aria-label={tr("放大时间轴")}
              disabled={visibleHours === 6}
              onClick={() => changeTimelineZoom("IN")}
            >
              <ZoomIn size={15} />
            </button>
          </div>
          <CalendarResourceFinder
            machines={timeline?.machines ?? []}
            groups={timeline?.groups ?? []}
            value={search}
            onChange={setSearch}
            onSelect={locateCalendarResource}
          />
          <button className="secondary-button" disabled={refreshing} onClick={() => void loadTimeline()}>
            {refreshing ? <RefreshCw size={16} className="spin" /> : <RefreshCw size={16} />}
            {tr("刷新")}</button>
        </div>
        <div ref={timelineFrameRef} className="timeline-scroll-frame">
          {initialLoading && !timeline ? (
            <div className="timeline-loading calendar-panel-state">
              <RefreshCw className="spin" />
              {tr("正在同步资源状态")}</div>
          ) : !timeline?.machines.length ? (
            <CalendarEmptyState
              icon={Server}
              title={tr("暂无可用资源")}
              text={tr("可以前往全部资源查看完整机器列表并申请使用权。")}
              onOpenResourceCatalog={() => navigate("resources")}
            />
          ) : !timeline.groups.length ? (
            <CalendarEmptyState
              icon={Server}
              title={tr("尚未配置资源组")}
              text={tr("可以前往全部资源查看完整机器列表。")}
              onOpenResourceCatalog={() => navigate("resources")}
            />
          ) : (
            <>
              <div
                ref={timelineShellRef}
                className={`timeline-scroll-shell ${view}`}
                onScroll={handleTimelineScroll}
              >
                <div
                  className={`timeline-card ${view}`}
                  style={{ width: timelineCardWidth }}
                >
                  <div className="timeline-head">
                    <div className="resource-head">
                      <span>{tr("资源组")}</span>
                    </div>
                    <TimelineScale
                      range={range}
                      view={view}
                      visibleHours={visibleHours}
                      windowStartMinutes={timelineWindowStartMinutes}
                      currentTime={currentTime}
                      onSelectDay={(selectedDate) => changeView("day", selectedDate)}
                    />
                  </div>
                  {timeline?.machines.map((machine) => {
                    const machineGroups = groupsByMachine.get(machine.id) ?? [];
                    if (!machineGroups.length) return null;
                    const unavailable = machineUnavailability.get(machine.id) ?? [];
                    const machineMaintenance = unavailable.filter(
                      (item) => item.kind === "PLANNED"
                    );
                    const machineMaintenanceNow = machineMaintenance.some(
                      (item) =>
                        new Date(item.startAt).getTime() <= currentTime &&
                        new Date(item.endAt).getTime() > currentTime
                    );
                    const machineCollapsed = collapsedMachineIds.has(machine.id);
                    const machineContentsId = `calendar-machine-${machine.id}-contents`;
                    return (
                      <div className="machine-block" key={machine.id}>
                        <button
                          type="button"
                          className={`machine-strip${machineCollapsed ? " collapsed" : ""}${calendarSearchTarget?.machineId === machine.id && !calendarSearchTarget.groupId ? " calendar-search-highlight" : ""}`}
                          data-calendar-machine-id={machine.id}
                          aria-expanded={!machineCollapsed}
                          aria-controls={machineContentsId}
                          aria-label={tr("{{v0}}{{v1}}的资源组", {
                            v0: tr(machineCollapsed ? "展开" : "收起"),
                            v1: machine.name
                          })}
                          onClick={() => toggleCalendarMachine(machine.id)}
                        >
                          <CalendarMachineStripLine
                            machine={machine}
                            maintenanceNow={machineMaintenanceNow}
                          />
                        </button>
                        <div
                          id={machineContentsId}
                          className={`machine-contents${machineCollapsed ? " collapsed" : ""}`}
                          aria-hidden={machineCollapsed}
                        >
                          <div className="machine-contents-inner">
                            {machineGroups.map((group) => {
                              const groupTarget: CalendarReservationTarget = {
                                scope: "RESOURCE_GROUP",
                                machineId: machine.id,
                                resourceGroupId: group.id
                              };
                              const machineTarget: CalendarReservationTarget = {
                                scope: "MACHINE",
                                machineId: machine.id,
                                resourceGroupId: group.id
                              };
                              const reservations = [
                                ...(reservationsByGroup.get(group.id) ?? []),
                                ...(machineReservationsByMachine.get(machine.id) ?? [])
                              ];
                              const currentMinute = currentMinuteStart(currentTime);
                              const visibleReservations = reservations.flatMap((item) => {
                                if (!editingIds.has(item.id)) return [item];
                                if (item.startAt >= currentMinute) return [];
                                return [
                                  {
                                    ...item,
                                    endAt:
                                      item.endAt < currentMinute
                                        ? item.endAt
                                        : currentMinute
                                  }
                                ];
                              });
                              const groupUnavailability = unavailabilityByGroup.get(group.id) ?? [];
                              const longTermDisabled =
                                machine.status === "DISABLED" ||
                                group.status === "DISABLED";
                              const visibleUnavailability =
                                mergeProjectedUnavailability(
                                  unavailable,
                                  groupUnavailability
                                );
                              const visibleDisableHistory = longTermDisabled
                                ? []
                                : mergeProjectedDisableHistory(
                                  unavailable,
                                  groupUnavailability
                                );
                              const visibleResourceWindows = [
                                ...visibleUnavailability,
                                ...visibleDisableHistory
                              ].sort(
                                (left, right) =>
                                  new Date(left.startAt).getTime() -
                                  new Date(right.startAt).getTime()
                              );
                              const visibleCalendarEvents: Array<{
                                event: CalendarEventModel;
                                reservation?: TimelineReservation;
                                unavailability?: ProjectedUnavailability;
                              }> = [
                                  ...visibleResourceWindows.map((item) => {
                                    const isDisableHistory =
                                      item.sources[0]?.window.kind === "LONG_TERM";
                                    const onlySource =
                                      item.sources.length === 1 ? item.sources[0] : null;
                                    const label =
                                      item.sources.length > 1
                                        ? tr("{{v0}} · {{v1}}项", {
                                          v0: tr(isDisableHistory ? "停用" : "维护"),
                                          v1: item.sources.length
                                        })
                                        : onlySource?.window.reason ||
                                        (onlySource?.scope === "MACHINE"
                                          ? isDisableHistory
                                            ? tr("整机停用")
                                            : tr("整机维护")
                                          : isDisableHistory
                                            ? tr("资源组停用")
                                            : tr("资源组维护"));
                                    const event: CalendarEventModel = {
                                      key: `${group.id}-${item.startAt}-${item.endAt}-${item.sources.map((source) => source.window.id).join("-")}`,
                                      kind: isDisableHistory
                                        ? "DISABLE_HISTORY"
                                        : "MAINTENANCE",
                                      stage: "COMMITTED",
                                      startAt: item.startAt,
                                      endAt: item.endAt,
                                      label
                                    };
                                    return {
                                      event,
                                      unavailability: item
                                    };
                                  }),
                                  ...visibleReservations.map((item) => {
                                    const event: CalendarEventModel = {
                                      ...reservationCalendarEvent(item),
                                      stage:
                                        editingIds.has(item.id)
                                          ? "EDITING_HISTORY"
                                          : "COMMITTED"
                                    };
                                    return { event, reservation: item };
                                  })
                                ];
                              const groupMaintenanceNow = visibleUnavailability.some(
                                (item) =>
                                  new Date(item.startAt).getTime() <= currentTime &&
                                  new Date(item.endAt).getTime() > currentTime
                              );
                              const isDragTarget =
                                dragPreview?.target.scope === "MACHINE"
                                  ? dragPreview.target.machineId === machine.id
                                  : dragPreview?.target.resourceGroupId === group.id;
                              const timelineDrafts = isDragTarget
                                ? dragPreview?.projected ?? []
                                : [
                                  ...(draftsByTarget.get(
                                    reservationTargetKey(groupTarget)
                                  ) ?? []),
                                  ...(draftsByTarget.get(
                                    reservationTargetKey(machineTarget)
                                  ) ?? [])
                                ];
                              const selectable =
                                view === "day" &&
                                machine.status === "ACTIVE" &&
                                group.status === "ACTIVE" &&
                                (reservationMode === "RESOURCE_GROUP" ||
                                  machineGroups.every((item) => item.status === "ACTIVE"));
                              return (
                                <div
                                  className={`timeline-row${longTermDisabled ? " long-term-disabled" : ""}${calendarSearchTarget?.machineId === machine.id && calendarSearchTarget.groupId === group.id ? " calendar-search-highlight" : ""}`}
                                  data-calendar-machine-id={machine.id}
                                  data-calendar-group-id={group.id}
                                  key={group.id}
                                >
                                  <CalendarResourceCell
                                    group={group}
                                    longTermDisabled={longTermDisabled}
                                    maintenanceNow={groupMaintenanceNow}
                                  />
                                  {view === "week" ? (
                                    <div className="week-days-track">
                                      {Array.from({ length: 7 }, (_, index) =>
                                        addDays(range.startDate, index)
                                      ).map((day) => {
                                        const dayStart = chinaLocalToIso(`${day}T00:00`);
                                        const dayEnd = chinaLocalToIso(
                                          `${addDays(day, 1)}T00:00`
                                        );
                                        const dayReservations = reservations.filter(
                                          (item) =>
                                            item.startAt < dayEnd && item.endAt > dayStart
                                        );
                                        const dayUnavailability =
                                          timeline.unavailability.filter(
                                            (item) =>
                                              item.machineId === machine.id &&
                                              (!item.resourceGroupId ||
                                                item.resourceGroupId === group.id) &&
                                              item.startAt < dayEnd &&
                                              item.endAt > dayStart
                                          );
                                        return (
                                          <CalendarWeekDayCell
                                            key={day}
                                            day={day}
                                            today={serverToday}
                                            dayStart={dayStart}
                                            dayEnd={dayEnd}
                                            groupName={group.name}
                                            reservations={dayReservations}
                                            unavailable={dayUnavailability}
                                            onSelect={() => changeView("day", day)}
                                          />
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div
                                      className={`time-track${!selectable ? " not-selectable" : ""}${longTermDisabled ? " long-term-disabled" : ""}`}
                                      title={
                                        !selectable
                                          ? machine.status !== "ACTIVE"
                                            ? tr("机器当前停用")
                                            : group.status !== "ACTIVE"
                                              ? tr("资源组当前停用")
                                              : reservationMode === "MACHINE"
                                                ? tr("机器内存在停用的资源组，当前不能整机占用")
                                                : undefined
                                          : undefined
                                      }
                                      onPointerDown={(event) => {
                                        if (submittingRef.current) return;
                                        if (longTermDisabled) return;
                                        const action = calendarDragAction(event);
                                        if (!action) return;
                                        if (action === "ADD" && !selectable) return;
                                        if (
                                          (event.target as HTMLElement).closest(
                                            ".booking-bar, .unavailability-bar"
                                          )
                                        ) {
                                          return;
                                        }
                                        const target =
                                          reservationMode === "MACHINE"
                                            ? machineTarget
                                            : groupTarget;
                                        const rect =
                                          event.currentTarget.getBoundingClientRect();
                                        const anchorAt = snappedTimelineInstant({
                                          rangeStart: range.from,
                                          days: range.days,
                                          trackLeft: rect.left,
                                          trackWidth: rect.width,
                                          pointer: event.clientX
                                        });
                                        if (!anchorAt) return;
                                        event.preventDefault();
                                        dragState.current = {
                                          action,
                                          target,
                                          groupId: group.id,
                                          pointerId: event.pointerId,
                                          startX: event.clientX,
                                          lastX: event.clientX,
                                          anchorAt,
                                          track: event.currentTarget,
                                          engaged: false
                                        };
                                        setDragPreview(null);
                                        updateHoveredTimelineTime(
                                          event.currentTarget,
                                          group.id,
                                          event.clientX
                                        );
                                        event.currentTarget.setPointerCapture(event.pointerId);
                                      }}
                                      onPointerMove={(event) => {
                                        if (longTermDisabled) return;
                                        const active = dragState.current;
                                        if (
                                          selectable ||
                                          (active?.pointerId === event.pointerId &&
                                            active.groupId === group.id)
                                        ) {
                                          updateHoveredTimelineTime(
                                            event.currentTarget,
                                            group.id,
                                            event.clientX
                                          );
                                        }
                                        if (
                                          active?.pointerId === event.pointerId &&
                                          active.groupId === group.id
                                        ) {
                                          active.lastX = event.clientX;
                                          active.track = event.currentTarget;
                                          active.engaged =
                                            active.engaged ||
                                            Math.abs(active.lastX - active.startX) >= 4;
                                          updateDragSelection(active, event.clientX);
                                          if (active.engaged) startDragAutoScroll();
                                        }
                                      }}
                                      onPointerCancel={() => {
                                        dragState.current = null;
                                        stopDragAutoScroll();
                                        setDragPreview(null);
                                      }}
                                      onPointerLeave={() => {
                                        if (!dragState.current) setHoveredTime(null);
                                      }}
                                      onPointerUp={(event) =>
                                        longTermDisabled
                                          ? undefined
                                          : finishDrag(
                                            event.currentTarget,
                                            group.id,
                                            event.pointerId,
                                            event.clientX
                                          )
                                      }
                                      onContextMenu={(event) => event.preventDefault()}
                                    >
                                      <TrackGrid view={view} visibleHours={visibleHours} />
                                      {longTermDisabled && (
                                        <div className="long-term-disabled-state">
                                          <PowerOff size={14} />
                                          <span>
                                            {machine.status === "DISABLED"
                                              ? tr("机器已停用")
                                              : tr("资源组已停用")}
                                          </span>
                                        </div>
                                      )}
                                      <CurrentTimeLine
                                        range={range}
                                        currentTime={currentTime}
                                      />
                                      {view === "day" && (
                                        <PastTimeShade
                                          range={range}
                                          currentTime={currentTime}
                                        />
                                      )}
                                      {view === "day" &&
                                        hoveredTime?.groupId === group.id && (
                                          <TimelineHoverGuide
                                            range={range}
                                            at={hoveredTime.at}
                                            label={
                                              dragPreview?.sourceGroupId === group.id
                                                ? `${formatChina(
                                                  dragPreview.requested.startAt,
                                                  {
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                    hour12: false
                                                  }
                                                )}–${formatChina(
                                                  dragPreview.requested.endAt,
                                                  {
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                    hour12: false
                                                  }
                                                )}`
                                                : formatChina(hoveredTime.at, {
                                                  hour: "2-digit",
                                                  minute: "2-digit",
                                                  hour12: false
                                                })
                                            }
                                          />
                                        )}
                                      {visibleCalendarEvents.map(
                                        ({ event, reservation, unavailability }) => (
                                          <CalendarDayEventBlock
                                            key={event.key}
                                            event={event}
                                            range={range}
                                            periodLabel={formatTimelineDayPeriod(
                                              event.startAt,
                                              event.endAt,
                                              range
                                            )}
                                            onClick={
                                              unavailability
                                                ? (clickEvent) => {
                                                  clickEvent.stopPropagation();
                                                  setReservationDetail(null);
                                                  setNearbyReservations(null);
                                                  setUnavailabilityDetail({
                                                    item: unavailability,
                                                    machineName: machine.name,
                                                    groupName: group.name,
                                                    anchor:
                                                      clickEvent.currentTarget.getBoundingClientRect()
                                                  });
                                                }
                                                : reservation &&
                                                  !longTermDisabled &&
                                                  !editingIds.has(reservation.id)
                                                  ? (clickEvent) =>
                                                    openTimelineReservation(
                                                      clickEvent,
                                                      reservation,
                                                      visibleReservations,
                                                      machine.name,
                                                      group.name
                                                    )
                                                  : undefined
                                            }
                                          />
                                        )
                                      )}
                                      {timelineDrafts
                                        .filter(
                                          (draft) =>
                                            draft.startAt < range.to &&
                                            draft.endAt > range.from
                                        )
                                        .map((draft, index) => {
                                          const event = draftCalendarEvent(
                                            draft,
                                            user,
                                            `${group.id}-${draft.startAt}-${draft.endAt}-${index}`,
                                            Boolean(
                                              isDragTarget && dragPreview?.action === "ADD"
                                            )
                                          );
                                          return (
                                            <CalendarDayEventBlock
                                              key={event.key}
                                              event={event}
                                              range={range}
                                              periodLabel={formatTimelineDayPeriod(
                                                event.startAt,
                                                event.endAt,
                                                range
                                              )}
                                            />
                                          );
                                        })}
                                      {dragPreview &&
                                        isDragTarget &&
                                        dragPreview.action === "ERASE" && (
                                          <CalendarDayEventBlock
                                            event={{
                                              key: `erase-${group.id}`,
                                              kind: "ERASE_PREVIEW",
                                              stage: "DRAFT_PREVIEW",
                                              startAt: dragPreview.requested.startAt,
                                              endAt: dragPreview.requested.endAt,
                                              label: tr("删除草稿")
                                            }}
                                            range={range}
                                          />
                                        )}
                                      {dragPreview &&
                                        isDragTarget &&
                                        dragPreview.action === "ADD" &&
                                        dragPreview.blocked && (
                                          <CalendarDayEventBlock
                                            event={{
                                              key: `conflict-${group.id}`,
                                              kind: "CONFLICT_PREVIEW",
                                              stage: "DRAFT_PREVIEW",
                                              startAt: dragPreview.requested.startAt,
                                              endAt: dragPreview.requested.endAt,
                                              label:
                                                dragPreview.target.scope === "MACHINE"
                                                  ? tr("机器已有资源被占用")
                                                  : tr("已被占用")
                                            }}
                                            range={range}
                                          />
                                        )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {refreshing && timeline && (
                    <div className="timeline-refreshing" aria-live="polite">
                      <RefreshCw size={14} className="spin" />{tr("正在更新")}</div>
                  )}
                </div>
              </div>
              <div className={`timeline-horizontal-scroll-row ${view}`}>
                <div
                  ref={timelineHorizontalScrollRef}
                  className="timeline-horizontal-scroll"
                  onScroll={handleTimelineHorizontalScroll}
                  aria-label={tr("横向滚动时间轴")}
                  tabIndex={0}
                >
                  <div
                    className={view}
                    style={
                      view === "day"
                        ? { width: `${timelineZoom * 100}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </section>
      <aside className="booking-drawer" ref={bookingDrawerRef} aria-busy={submitting}>
        <fieldset disabled={submitting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="drawer-head">
            <h2>{tr("占用详情")}</h2>
            {(drafts.length > 0 || editingReservation) && (
              <div className="drawer-head-actions">
                <button
                  type="button"
                  className="drawer-manual-add-button"
                  onClick={() => setManualBookingOpen(true)}
                >
                  <Plus size={14} />
                  {tr("新增")}</button>
                <button
                  type="button"
                  className="drawer-clear-button"
                  onClick={() => void clearReservationDetailsWithConfirmation()}
                >
                  <X size={14} />
                  {tr("放弃")}</button>
              </div>
            )}
          </div>
          {previewReadError && <div className="context-notice warning" role="status">{tr("暂时无法检查可用时段，正在重试。草稿已保留。")}</div>}
          {editingCheckError && <div className="context-notice warning" role="status">{tr("暂时无法核对原占用，正在重试。草稿已保留。")}</div>}
          {editingReservations.length > 0 && <div className="calendar-edit-sequence">
            <strong>{tr("编辑序列")} · {editingReservations.length}</strong>
            {editingReservations.map(item => <div key={item.id}>
              <span title={`${item.machineName} · ${item.resourceGroupName}`}>{item.machineName} · {item.resourceGroupName}</span>
              <small>{formatChinaFullMinute(item.startAt)} → {formatChinaFullMinute(item.endAt)}</small>
              <button type="button" className="secondary-button" disabled={submitting} onClick={() => {
                setEditingReservations(current => current.filter(row => row.id !== item.id)); setPreviewByDraft(new Map());
              }}>{tr("移出编辑序列")}</button>
            </div>)}
          </div>}
          {(editingChanged || submissionUncertain) && <div className="draft-issues" role="alert">
            {submissionUncertain ? tr("提交结果暂不明确，请先核对占用记录，勿重复提交。") : tr("编辑序列中的记录已变化，请放弃本次编辑后重新选择。")}
          </div>}
          {!drafts.length && (
            <div className="drawer-empty">
              <Clock3 className="drawer-empty-icon" size={28} />
              <strong>{tr("暂无占用时段")}</strong>
              <p>{tr("在日历时间轴上拖动，以添加一段占用。")}</p>
              <button
                type="button"
                className="secondary-button drawer-add-button"
                onClick={() => setManualBookingOpen(true)}
              >
                <Plus size={14} />
                {tr("action.reservation.new")}</button>
            </div>
          )}
          {!!drafts.length && (
            <>
              <div className="selected-summary">
                <span>{new Set(drafts.map(reservationTargetKey)).size}</span>
                <div><strong>{tr("个占用目标，")}{drafts.length} {tr("条占用")}</strong></div>
              </div>
              <div className="draft-list">
                {drafts.map((draft) => {
                  const group = timeline?.groups.find((item) => item.id === draft.resourceGroupId);
                  const machine = timeline?.machines.find(
                    (item) => item.id === draft.machineId
                  );
                  const result = previewByDraft.get(draft.id);
                  const fieldIssues = draftFieldIssuesById.get(draft.id);
                  const targetName =
                    draft.scope === "MACHINE"
                      ? tr("{{v0}} · 整机", { v0: machine?.name ?? "机器" })
                      : group?.name ?? tr("资源组");
                  return (
                    <div
                      className={`draft-card ${fieldIssues?.startAt || fieldIssues?.endAt
                          ? "invalid"
                          : result
                            ? result.available
                              ? "available"
                              : "conflicted"
                            : ""
                        }`}
                      key={draft.id}
                    >
                      <div className="draft-card-head">
                        <div>
                          {draft.scope === "MACHINE"
                            ? <Server size={15} />
                            : <Cpu size={15} />}
                          <strong>{targetName}</strong>
                          {draft.startMode === "IMMEDIATE" && (
                            <span className="immediate-start-label">{tr("立即开始")}</span>
                          )}
                        </div>
                        <button
                          className="icon-button tiny"
                          aria-label={tr("删除 {{v0}} 草稿", { v0: targetName })}
                          onClick={() => {
                            const next = drafts.filter((item) => item.id !== draft.id);
                            setDrafts(next);
                            invalidatePreview();
                            if (!next.length) {
                              setMetadata({ title: "", purpose: "", note: "" });
                            }
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <CalendarReservationTimeFields
                        className="draft-time-fields"
                        startValue={
                          draft.startAt ? isoToChinaLocal(draft.startAt) : ""
                        }
                        endValue={
                          draft.endAt ? isoToChinaLocal(draft.endAt) : ""
                        }
                        fieldKey={`${draft.id}-${draft.startAt}-${draft.endAt}`}
                        onStartBlur={(value) => {
                          updateDraftTime(draft.id, "startAt", value);
                        }}
                        onEndBlur={(value) => {
                          updateDraftTime(draft.id, "endAt", value);
                        }}
                        onFocusCapture={() => {
                          previewRequestIdRef.current++;
                          setEditingDraftTime(true);
                          setPreviewByDraft(new Map());
                        }}
                        onBlurCapture={(event) => {
                          const next = event.relatedTarget;
                          if (
                            !(next instanceof Node) ||
                            !event.currentTarget.contains(next)
                          ) {
                            setEditingDraftTime(false);
                          }
                        }}
                        startError={fieldIssues?.startAt}
                        endError={fieldIssues?.endAt}
                      />
                      <div className="draft-duration">
                        <Clock3 size={12} />
                        {draft.startAt &&
                          draft.endAt &&
                          new Date(draft.endAt).getTime() >
                          new Date(draft.startAt).getTime()
                          ? durationText(
                            minuteDifference(draft.startAt, draft.endAt)
                          )
                          : tr("时间有误")}
                      </div>
                      {result && (
                        result.available
                          ? <span className="status-label success"><Check size={13} />{tr("完整时段可用")}</span>
                          : <span className="status-label danger"><CircleAlert size={13} />{result.conflicts.length} {tr("处冲突")}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {generalDraftIssues.length > 0 && (
                <div className="draft-issues" role="alert">
                  {generalDraftIssues.map((issue) => <span key={issue}>{issue}</span>)}
                </div>
              )}
              <div className="section-label"><span>{tr("占用信息")}</span></div>
              <CalendarReservationMetadataFields
                values={metadata}
                onChange={(field, value) =>
                  setMetadata((current) => ({ ...current, [field]: value }))
                }
              />
              <div className="drawer-actions">
                <button className="primary-button" disabled={submitting || previewing || !!draftIssues.length || editingChanged || submissionUncertain} onClick={() => void submitDrafts()}>
                  {submitting ? <RefreshCw size={16} className="spin" /> : <Check size={16} />}
                  {editingReservation ? tr("提交修改") : tr("提交占用")}
                </button>
              </div>
            </>
          )}
        </fieldset>
      </aside>
      {myReservationsOpen && <CalendarMyReservations onClose={() => setMyReservationsOpen(false)} onLocate={async selected => {
        try {
          const { reservation: item } = await api<OwnReservationDetail>(`/reservations/mine/${selected.id}`);
          if (item.status !== "CONFIRMED" || !item.canViewCalendar) { notify("error", tr("该占用无法定位到日历")); return; }
          setMyReservationsOpen(false); setSearch(""); setView("day");
          setDate(isoToChinaLocal(item.startAt).slice(0, 10));
          writeCalendarRoute({ date: isoToChinaLocal(item.startAt).slice(0, 10), view: "day", machineId: item.machineId });
          setPendingReservationLocation(item);
        } catch (error) { notify("error", error instanceof Error ? error.message : tr("请求失败")); }
      }} />}
      {reservationDetail &&
        createPortal(
          <CalendarReservationPopover
            detail={reservationDetail}
            currentTime={currentTime}
            canManage={Boolean(
              timeline?.machines.find(
                (machine) =>
                  machine.id === reservationDetail.item.machineId
              )?.isManager
            )}
            notify={notify}
            onClose={() => setReservationDetail(null)}
            onChanged={() => loadTimeline()}
            onEdit={() =>
              void requestEditingReservation(reservationDetail.item)
            }
          />,
          document.body
        )}
      {nearbyReservations &&
        createPortal(
          <CalendarNearbyReservationsPopover
            nearby={nearbyReservations}
            onClose={() => setNearbyReservations(null)}
            onSelect={(detail) => {
              setNearbyReservations(null);
              setReservationDetail(detail);
            }}
          />,
          document.body
        )}
      {unavailabilityDetail &&
        createPortal(
          <CalendarUnavailabilityPopover
            detail={unavailabilityDetail}
            onClose={() => setUnavailabilityDetail(null)}
          />,
          document.body
        )}
      {manualBookingOpen && timeline && (
        <CalendarManualBookingModal
          mode={reservationMode}
          machines={timeline.machines}
          groups={timeline.groups}
          settings={settings}
          currentTime={currentTime}
          lockMode={drafts.length > 0}
          initialMachineId={drafts[0]?.machineId}
          onClose={() => setManualBookingOpen(false)}
          onAdd={(target, startAt, endAt) => {
            setReservationMode(target.scope);
            writeCalendarPreference({ reservationMode: target.scope });
            const added = appendDraft(target, startAt, endAt);
            if (added) setManualBookingOpen(false);
            return added;
          }}
        />
      )}
    </div>
  );
}

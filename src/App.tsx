import {
  Activity,
  Bell,
  BookOpenText,
  Boxes,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Cpu,
  Download,
  Eye,
  EyeOff,
  Gauge,
  Globe2,
  GripVertical,
  Info,
  KeyRound,
  LogOut,
  Mail,
  MessageSquare,
  Megaphone,
  Plus,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Trash2,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  Users,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import {
  createContext,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useContext
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ApiError, api, jsonBody, setCsrfToken } from "./api";
import { copyTextToClipboard } from "./clipboard";
import { DocumentationPage } from "./DocumentationPage";
import { AnnouncementMarkdown } from "./AnnouncementMarkdown";
import {
  appPath,
  feedbackPath,
  machineAdminPath,
  resolveAppRoute,
  type AdminTab,
  type AppPath,
  type MachineAdminSection,
  type Page
} from "./app-routing";
import {
  verificationButtonLabel,
  verificationCooldownSeconds
} from "./auth-feedback";
import {
  resolveAuthLocation,
  type AuthPath
} from "./auth-routing";
import { resolveDocsRoute } from "./docs-routing";
import {
  readLoginPreference,
  rememberLoginMethod,
  rememberSuccessfulLogin,
  rememberUsername,
  type LoginMethod
} from "./login-preference";
import {
  validateLoginForm,
  type LoginField,
  type LoginFieldErrors
} from "./login-validation";
import {
  isServerRegistrationField,
  normalizeRegistrationEmail,
  parseServerRegistrationErrors,
  registrationFieldValue,
  registrationFields,
  validateEmail,
  validateRegistrationField,
  validateRegistrationForm,
  type RegistrationField,
  type RegistrationFieldErrors,
  type RegistrationFormValues
} from "./registration-validation";
import {
  validateForgotPasswordEmail,
  validateResetPasswordForm,
  type ResetPasswordField
} from "./public-auth-validation";
import {
  reorderResourceDrafts,
  resourceTagDraftIssue,
  validateResourceConfigurationDraft
} from "./resource-config-validation";
import {
  EMPLOYEE_NUMBER_MESSAGE,
  getPasswordChecks,
  isEmployeeNumberValid
} from "./shared/identity-rules";
import {
  EMAIL_DOMAIN_MESSAGE,
  normalizeAllowedEmailDomain
} from "./shared/email-domain-rules";
import {
  normalizeSiteOrigin,
  siteOriginValidationError
} from "./shared/site-origin";
import {
  announcementSeenStorageKey,
  hasSeenAnnouncementVersion,
  readSeenAnnouncementIds,
  rememberSeenAnnouncement
} from "./shared/announcements";
import { resolveCatalogAccessDisplay } from "./catalog-access-state";
import {
  feedbackLevelLabels,
  feedbackLevelsFor,
  feedbackStatusLabels,
  feedbackStatusesFor,
  feedbackTemplates,
  feedbackTypeLabels,
  type FeedbackAttachment,
  type FeedbackLevel,
  type FeedbackStatus,
  type FeedbackTicketDetail,
  type FeedbackTicketSummary,
  type FeedbackType
} from "./shared/feedback";
import { calculateVisibleManagerCount } from "./manager-summary";
import {
  resolveNotificationDestination,
  type NotificationDestination
} from "./notification-navigation";
import {
  addDays,
  calendarMonthDates,
  calendarMonthLabel,
  chinaDateDayOffset,
  chinaLocalToIso,
  durationHoursText,
  durationText,
  formatChina,
  formatChinaDate,
  formatChinaFullMinute,
  isoToChinaLocal,
  minuteDifference,
  mondayOf,
  shiftCalendarMonth,
  todayChina
} from "./date";
import {
  clampDayWindowStartMinutes,
  DAY_ZOOM_LEVELS,
  calendarDraftFieldIssues,
  calendarDraftIssues,
  calendarDragAction,
  calendarEditUrl,
  calendarQueryUrl,
  calendarUrlWithoutEditRequest,
  calendarUrlWithEditRequest,
  currentMinuteStart,
  defaultDayWindowStartMinutes,
  draggedTimeRange,
  eraseCalendarDraftRange,
  mergeCalendarDrafts,
  mergeTimeRanges,
  parseCalendarQuery,
  parseCalendarEditRoute,
  previewsByDraftId,
  reservationInput,
  reservationTargetKey,
  snappedTimelineInstant,
  subtractBusyTimeRanges,
  splitDrafts,
  timelineDragAutoScrollDelta,
  timelineWheelAction,
  advanceCalendarDrafts,
  type CalendarDraft,
  type CalendarMetadata,
  createServerClockAnchor,
  serverTimeFromAnchor,
  type CalendarTimeRange,
  type CalendarView
} from "./calendar-state";
import {
  readCalendarPreference,
  writeCalendarPreference
} from "./calendar-preference";
import {
  mergeProjectedDisableHistory,
  mergeProjectedUnavailability,
  type ProjectedUnavailability
} from "./calendar-unavailability";
import { createClientId } from "./client-id";
import type {
  AuthUser,
  DashboardBootstrap,
  Machine,
  NotificationItem,
  ReservationPreviewItem,
  ResourceAllocation,
  ResourceGroup,
  ResourcePool,
  TimelineReservation,
  UnavailabilityWindow
} from "./shared/types";
import {
  auditActionLabel,
  reservationStatusLabel,
  userStatusLabel
} from "./ui-copy";

type TimelinePayload = {
  machines: Machine[];
  groups: Array<Omit<ResourceGroup, "version">>;
  reservations: TimelineReservation[];
  unavailability: UnavailabilityWindow[];
  revision: number;
  serverNow: string;
};

type SystemAnnouncement = {
  id: string;
  title: string;
  bodyMarkdown: string;
  status: "ACTIVE" | "WITHDRAWN";
  version: number;
  createdByName: string;
  createdAt: string;
  publishedAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
};

type AnnouncementEditorState =
  | { mode: "CREATE" }
  | {
      mode: "EDIT" | "REACTIVATE";
      announcement: SystemAnnouncement;
    };

type CalendarReservationTarget = {
  scope: "RESOURCE_GROUP" | "MACHINE";
  machineId: string;
  resourceGroupId: string;
};

type CalendarDragState = {
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

const TIMELINE_RESOURCE_COLUMN_WIDTH = 260;

type SmtpSettingsPayload = {
  enabled: boolean;
  host: string;
  port: number;
  security: "IMPLICIT_TLS" | "STARTTLS";
  username: string;
  fromName: string;
  fromAddress: string;
  hasPassword: boolean;
  passwordStatus: "NOT_SET" | "READY" | "UNREADABLE";
  testable: boolean;
  operational: boolean;
  version: number;
  updatedAt: string;
  lastTest: {
    status: "SUCCESS" | "FAILED";
    error: string;
    testedAt: string | null;
  } | null;
  queue: {
    pending: number;
    failed: number;
    lastError: string;
  };
};

type RegistrationConfigPayload = {
  emailEnabled: boolean;
  allowRegistrationWithoutEmail: boolean;
  allowedEmailDomains: string[];
  revision: number;
};

type AdminSettingsPayload = {
  minBookingMinutes: number;
  maxBookingMinutes: number;
  advanceDays: number;
  timezone: string;
  allowedEmailDomains: string[];
  allowRegistrationWithoutEmail: boolean;
  siteOrigin: string;
  version: number;
};

type ToastState = { kind: "success" | "error"; message: string } | null;

type DialogTone = "default" | "danger";

type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: DialogTone;
};

type PromptDialogOptions = ConfirmDialogOptions & {
  label: string;
  initialValue?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  multiline?: boolean;
  validate?: (value: string) => string;
};

type DialogController = {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  prompt: (options: PromptDialogOptions) => Promise<string | null>;
};

function scrollPastNumberInput(input: HTMLInputElement, event: WheelEvent) {
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? window.innerHeight
        : 1;
  const deltaX = event.deltaX * scale;
  const deltaY = event.deltaY * scale;

  for (let element = input.parentElement; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    const canScrollY =
      /(auto|scroll|overlay)/.test(style.overflowY) &&
      element.scrollHeight > element.clientHeight &&
      (deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop + element.clientHeight < element.scrollHeight);
    const canScrollX =
      /(auto|scroll|overlay)/.test(style.overflowX) &&
      element.scrollWidth > element.clientWidth &&
      (deltaX < 0
        ? element.scrollLeft > 0
        : element.scrollLeft + element.clientWidth < element.scrollWidth);

    if (canScrollY || canScrollX) {
      element.scrollBy({
        left: canScrollX ? deltaX : 0,
        top: canScrollY ? deltaY : 0
      });
      return;
    }
  }

  window.scrollBy({ left: deltaX, top: deltaY });
}

const DialogContext = createContext<DialogController | null>(null);

function useAppDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error("DialogProvider is missing");
  return value;
}

type ServerClockContextValue = {
  currentTime: number;
  ready: boolean;
  synchronize: (
    serverNow: string,
    requestStartedAt: number,
    responseReceivedAt?: number
  ) => void;
};

const ServerClockContext = createContext<ServerClockContextValue | null>(null);

function useServerClock() {
  const value = useContext(ServerClockContext);
  if (!value) throw new Error("ServerClockProvider is missing");
  return value;
}

function ServerClockProvider({
  initialServerNow,
  children
}: {
  initialServerNow: string;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<ReturnType<typeof createServerClockAnchor>>(null);
  const initialMonotonicTime = performance.now();
  if (!anchorRef.current) {
    anchorRef.current = createServerClockAnchor(
      initialServerNow,
      initialMonotonicTime,
      initialMonotonicTime
    );
  }
  const [currentTime, setCurrentTime] = useState(
    () =>
      anchorRef.current
        ? serverTimeFromAnchor(anchorRef.current, performance.now())
        : 0
  );
  const [ready, setReady] = useState(Boolean(anchorRef.current));

  const synchronize = useCallback(
    (
      serverNow: string,
      requestStartedAt: number,
      responseReceivedAt = performance.now()
    ) => {
      const anchor = createServerClockAnchor(
        serverNow,
        requestStartedAt,
        responseReceivedAt
      );
      if (!anchor) return;
      anchorRef.current = anchor;
      setCurrentTime(serverTimeFromAnchor(anchor, responseReceivedAt));
      setReady(true);
    },
    []
  );

  useEffect(() => {
    const receivedAt = performance.now();
    synchronize(initialServerNow, receivedAt, receivedAt);
  }, [initialServerNow, synchronize]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (anchor) {
        setCurrentTime(serverTimeFromAnchor(anchor, performance.now()));
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const requestStartedAt = performance.now();
    try {
      const result = await api<{ serverNow: string }>("/server-time");
      synchronize(result.serverNow, requestStartedAt);
    } catch {
      // 保留现有服务器时间基准继续计时，等待下一次校准。
    }
  }, [synchronize]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 5 * 60_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ currentTime, ready, synchronize }),
    [currentTime, ready, synchronize]
  );

  return (
    <ServerClockContext.Provider value={value}>
      {children}
    </ServerClockContext.Provider>
  );
}

export function App() {
  const routeLocation = useLocation();
  const routeNavigate = useNavigate();
  const docsRoute = useMemo(
    () => resolveDocsRoute(routeLocation.pathname),
    [routeLocation.pathname]
  );
  const [bootstrap, setBootstrap] = useState<DashboardBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState>(null);
  const [passwordReminderDismissed, setPasswordReminderDismissed] = useState(false);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [feedbackUnreadCount, setFeedbackUnreadCount] = useState(0);
  const [feedbackRefreshToken, setFeedbackRefreshToken] = useState(0);
  const [announcementRefreshToken, setAnnouncementRefreshToken] = useState(0);

  const notify = useCallback((kind: "success" | "error", message: string) => {
    setToast({ kind, message });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const value = await api<DashboardBootstrap>("/auth/me");
      setCsrfToken(value.csrfToken);
      setBootstrap(value);
    } catch {
      setBootstrap(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const acceptAuthenticatedSession = useCallback(
    async (value: DashboardBootstrap) => {
      setCsrfToken(value.csrfToken);
      setBootstrap(value);
      setLoading(false);
    },
    []
  );

  const loadUnreadNotificationCount = useCallback(async () => {
    try {
      const result = await api<{ unreadCount: number; feedbackUnreadCount: number }>("/notifications/unread-count");
      setUnreadNotificationCount(Math.max(0, result.unreadCount));
      setFeedbackUnreadCount(Math.max(0, result.feedbackUnreadCount));
    } catch {
      // 通知数量属于辅助状态，短暂加载失败不应干扰当前页面。
    }
  }, []);

  useEffect(() => {
    if (docsRoute) {
      setLoading(false);
      return;
    }
    void loadSession();
  }, [docsRoute, loadSession]);

  useEffect(() => {
    const ignoreNumberInputWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "number") {
        return;
      }
      event.preventDefault();
      scrollPastNumberInput(target, event);
    };

    document.addEventListener("wheel", ignoreNumberInputWheel, {
      capture: true,
      passive: false
    });
    return () => {
      document.removeEventListener("wheel", ignoreNumberInputWheel, true);
    };
  }, []);

  useEffect(() => {
    if (docsRoute || !bootstrap || bootstrap.user.status !== "ACTIVE") return;
    const events = new EventSource("/api/v1/events");
    events.addEventListener("revision", () => {
      void loadSession();
      void loadUnreadNotificationCount();
    });
    events.addEventListener("announcement", () => {
      setAnnouncementRefreshToken((current) => current + 1);
    });
    events.addEventListener("feedback", () => {
      setFeedbackRefreshToken((current) => current + 1);
      void loadUnreadNotificationCount();
    });
    return () => events.close();
  }, [
    bootstrap?.user.id,
    bootstrap?.user.status,
    docsRoute,
    loadSession,
    loadUnreadNotificationCount
  ]);

  useEffect(() => {
    if (docsRoute || !bootstrap) {
      setUnreadNotificationCount(0);
      setFeedbackUnreadCount(0);
      return;
    }
    void loadUnreadNotificationCount();
    const refresh = window.setInterval(
      () => void loadUnreadNotificationCount(),
      30_000
    );
    const refreshOnFocus = () => void loadUnreadNotificationCount();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(refresh);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [bootstrap?.user.id, docsRoute, loadUnreadNotificationCount]);

  useEffect(() => {
    if (
      docsRoute ||
      !bootstrap ||
      bootstrap.user.status === "ACTIVE"
    ) {
      return;
    }
    const refresh = window.setInterval(() => void loadSession(), 30_000);
    return () => window.clearInterval(refresh);
  }, [bootstrap?.user.id, bootstrap?.user.status, docsRoute, loadSession]);

  const activeUser = bootstrap?.user.status === "ACTIVE";
  const currentRoute = resolveAppRoute(routeLocation.pathname);
  const canonicalRedirect = (() => {
    if (docsRoute) return null;
    if (loading) return null;
    if (!bootstrap) {
      return resolveAuthLocation(
        routeLocation.pathname,
        routeLocation.searchStr,
        routeLocation.hash
      ).canonicalUrl;
    }
    if (!currentRoute) return activeUser ? "/calendar" : "/profile";
    if (
      !activeUser &&
      currentRoute.page !== "profile" &&
      currentRoute.page !== "notifications"
    ) {
      return "/profile";
    }
    if (
      currentRoute.page === "admin" &&
      bootstrap.user.role !== "SYSTEM_ADMIN" &&
      currentRoute.adminTab &&
      ["announcements", "feedback", "settings", "audit"].includes(currentRoute.adminTab)
    ) {
      return "/admin/machines";
    }
    return null;
  })();

  useEffect(() => {
    if (!canonicalRedirect) return;
    void routeNavigate({ href: canonicalRedirect, replace: true });
  }, [canonicalRedirect, routeNavigate]);

  if (docsRoute) {
    return (
      <>
        <DocumentationPage route={docsRoute} notify={notify} />
        {toast && <Toast {...toast} />}
      </>
    );
  }

  if (loading || canonicalRedirect) {
    return <LoadingScreen />;
  }

  const navigateAuth: AuthNavigate = (path, state = null, replace = false) => {
    void routeNavigate({
      href: path,
      state: state ?? {},
      replace
    });
  };

  if (!bootstrap) {
    const authLocation = resolveAuthLocation(
      routeLocation.pathname,
      routeLocation.searchStr,
      routeLocation.hash
    );
    return (
      <DialogProvider>
        <AuthRouter
          location={authLocation}
          historyState={routeLocation.state}
          navigate={navigateAuth}
          onAuthenticated={acceptAuthenticatedSession}
          notify={notify}
          consumeAuthFlash={() => {
            void routeNavigate({
              href: "/login",
              replace: true,
              state: (current) => {
                const next = { ...current };
                delete next.authFlash;
                return next;
              }
            });
          }}
        />
        {toast && <Toast {...toast} />}
      </DialogProvider>
    );
  }

  const logout = async (message?: string) => {
    try {
      await api("/auth/logout", { method: "POST", body: "{}" });
    } finally {
      setCsrfToken("");
      setBootstrap(null);
      setUnreadNotificationCount(0);
      setFeedbackUnreadCount(0);
      void routeNavigate({
        href: "/login",
        replace: true,
        state: message ? { authFlash: { message } } : {}
      });
    }
  };

  const navigate = (next: Page, nextAdminTab?: AdminTab) => {
    const target =
      activeUser || next === "profile" || next === "notifications"
        ? next
        : "profile";
    void routeNavigate({
      href: appPath(target, nextAdminTab ?? "machines")
    });
  };
  const visiblePage = currentRoute?.page ?? (activeUser ? "calendar" : "profile");
  const adminTab = currentRoute?.adminTab ?? "machines";

  const showPasswordReminder =
    bootstrap.user.passwordChangeRecommended && !passwordReminderDismissed;

  return (
    <ServerClockProvider initialServerNow={bootstrap.serverNow}>
      <DialogProvider>
        <div className={`app-frame${showPasswordReminder ? " has-password-banner" : ""}${visiblePage === "admin" && adminTab === "feedback" && currentRoute?.feedbackId ? " feedback-admin-detail-frame" : ""}`}>
        <Topbar
          user={bootstrap.user}
          restricted={!activeUser}
          showAdmin={Boolean(activeUser)}
          page={visiblePage}
          unreadNotificationCount={unreadNotificationCount}
          feedbackUnreadCount={feedbackUnreadCount}
          navigate={navigate}
          onLogout={() => void logout()}
        />
        {showPasswordReminder && (
          <PasswordBanner
            onModify={() => navigate("profile")}
            onDismiss={() => setPasswordReminderDismissed(true)}
          />
        )}
        <main className="app-content">
          {visiblePage === "calendar" && (
            <CalendarPage
              user={bootstrap.user}
              settings={bootstrap.settings}
              notify={notify}
              navigate={navigate}
            />
          )}
          {visiblePage === "resources" && (
            <ResourceCatalogPage
              user={bootstrap.user}
              notify={notify}
              navigate={navigate}
            />
          )}
          {visiblePage === "my" && (
            <MyReservationsPage
              notify={notify}
              onEditReservation={(reservation) => {
                void routeNavigate({
                  href: calendarEditUrl({
                    reservationId: reservation.id,
                    date: isoToChinaLocal(reservation.startAt).slice(0, 10),
                    machineId: reservation.machineId
                  })
                });
              }}
            />
          )}
          {visiblePage === "profile" && (
            <AccountProfilePage bootstrap={bootstrap} notify={notify} reload={loadSession} />
          )}
          {visiblePage === "notifications" && (
            <NotificationsPage
              notify={notify}
              onUnreadCountChange={setUnreadNotificationCount}
              onFeedbackUnreadCountChange={setFeedbackUnreadCount}
              navigate={(path) => {
                if (resolveAppRoute(path)) void routeNavigate({ href: path });
              }}
            />
          )}
          {visiblePage === "announcements" && <AnnouncementListPage />}
          {visiblePage === "feedback" && (
            <FeedbackPage
              feedbackId={currentRoute?.feedbackId}
              refreshToken={feedbackRefreshToken}
              notify={notify}
              onUnreadCountRefresh={loadUnreadNotificationCount}
              onOpen={(id) => void routeNavigate({ href: feedbackPath(id) })}
              onBack={() => void routeNavigate({ href: "/feedback" })}
            />
          )}
          {visiblePage === "admin" && (
            <AdminPage
              bootstrap={bootstrap}
              notify={notify}
              tab={adminTab}
              onTabChange={(nextTab) => navigate("admin", nextTab)}
              onOpenResourceCatalog={() => navigate("resources")}
              machineId={currentRoute?.machineId}
              machineSection={currentRoute?.machineSection}
              feedbackId={currentRoute?.feedbackId}
              feedbackRefreshToken={feedbackRefreshToken}
              onFeedbackRoute={(id) => void routeNavigate({ href: id ? feedbackPath(id, true) : "/admin/feedback" })}
              onUnreadCountRefresh={loadUnreadNotificationCount}
              onMachineRoute={(nextMachineId, nextSection, replace = false) => {
                void routeNavigate({
                  href: machineAdminPath(nextMachineId, nextSection),
                  replace
                });
              }}
            />
          )}
        </main>
        {toast && <Toast {...toast} />}
        </div>
        {activeUser && (
          <AnnouncementCenter
            userId={bootstrap.user.id}
            refreshToken={announcementRefreshToken}
            onInternalNavigate={(href) => window.location.assign(href)}
          />
        )}
      </DialogProvider>
    </ServerClockProvider>
  );
}

function AnnouncementCenter({
  userId,
  refreshToken,
  onInternalNavigate
}: {
  userId: string;
  refreshToken: number;
  onInternalNavigate: (href: string) => void;
}) {
  const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);

  const load = useCallback(async () => {
    try {
      const result = await api<{ announcements: SystemAnnouncement[] }>(
        "/announcements"
      );
      const seen = readSeenAnnouncementIds(userId, window.localStorage);
      setAnnouncements(
        result.announcements.filter(
          (announcement) =>
            !hasSeenAnnouncementVersion(
              seen,
              announcement.id,
              announcement.version
            )
        )
      );
    } catch {
      // 公告加载失败不阻止用户进入系统。
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === announcementSeenStorageKey(userId)) void load();
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [load, userId]);

  const current = announcements[0];
  if (!current) return null;

  const dismiss = () => {
    try {
      rememberSeenAnnouncement(
        userId,
        current.id,
        current.version,
        window.localStorage
      );
    } catch {
      // 本机存储不可用时，本次页面仍继续展示后续公告。
    }
    setAnnouncements((items) => items.filter((item) => item.id !== current.id));
  };

  return (
    <Modal title={current.title} onClose={dismiss} wide>
      <div className="announcement-dialog">
        <AnnouncementMarkdown
          markdown={current.bodyMarkdown}
          onInternalNavigate={(href) => {
            dismiss();
            onInternalNavigate(href);
          }}
        />
        <div className="announcement-dialog-footer">
          {announcements.length > 1 && (
            <span>还有 {announcements.length - 1} 条公告</span>
          )}
          <button type="button" className="primary-button" onClick={dismiss}>
            我知道了
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AnnouncementListPage() {
  const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ announcements: SystemAnnouncement[] }>(
        "/announcements"
      );
      setAnnouncements(result.announcements);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const events = new EventSource("/api/v1/events");
    events.addEventListener("announcement", () => void load());
    return () => events.close();
  }, [load]);

  return (
    <div className="page-shell narrow-page announcement-viewer-page">
      <PageHeader title="系统公告" />
      {loading ? (
        <div className="card announcement-admin-empty">正在加载系统公告…</div>
      ) : loadError ? (
        <div className="card announcement-load-error" role="alert">
          <span>系统公告加载失败</span>
          <button type="button" className="secondary-button" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : announcements.length ? (
        <div className="announcement-admin-list">
          {announcements.map((announcement) => (
            <article className="card announcement-admin-card" key={announcement.id}>
              <header>
                <div><h2>{announcement.title}</h2></div>
              </header>
              <AnnouncementMarkdown
                markdown={announcement.bodyMarkdown}
                onInternalNavigate={(href) => window.location.assign(href)}
              />
              <footer>
                <span>{announcement.createdByName}</span>
                <time>发布于 {formatChinaFullMinute(announcement.publishedAt)}</time>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Megaphone}
          title="暂无系统公告"
          text="当前没有正在展示的系统公告。"
        />
      )}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="boot-shell">
      <div className="boot-mark">A</div>
      <h1>Allocube</h1>
      <p>正在载入机器资源与占用日历…</p>
    </main>
  );
}

type AuthFlash = {
  message: string;
  username?: string;
};

type AuthHistoryState = {
  authFlash?: AuthFlash;
  registrationSuccess?: {
    username: string;
  };
};

type AuthNavigate = (
  path: AuthPath,
  state?: AuthHistoryState | null,
  replace?: boolean
) => void;

function AuthRouter({
  location,
  historyState,
  navigate,
  onAuthenticated,
  notify,
  consumeAuthFlash
}: {
  location: ReturnType<typeof resolveAuthLocation>;
  historyState: AuthHistoryState;
  navigate: AuthNavigate;
  onAuthenticated: (bootstrap: DashboardBootstrap) => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
  consumeAuthFlash: () => void;
}) {
  const flash = location.path === "/login" ? historyState.authFlash ?? null : null;
  useEffect(() => {
    if (flash) consumeAuthFlash();
  }, [consumeAuthFlash, flash]);

  if (location.path === "/register") {
    return (
      <RegisterPage
        navigate={navigate}
        notify={notify}
        successUsername={historyState.registrationSuccess?.username ?? ""}
      />
    );
  }
  if (location.path === "/forgot-password") {
    return <ForgotPasswordPage navigate={navigate} />;
  }
  if (location.path === "/reset-password") {
    return (
      <ResetPasswordPage
        navigate={navigate}
        token={location.resetToken}
      />
    );
  }
  return (
    <LoginPage
      navigate={navigate}
      onAuthenticated={onAuthenticated}
      initialIdentifier={flash?.username ?? ""}
      initialMessage={flash?.message ?? ""}
    />
  );
}

function AuthLayout({
  title,
  wide = false,
  children
}: {
  title: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="brand-lockup auth-brand">
          <div className="brand-icon"><Boxes size={23} /></div>
          <span>Allocube</span>
        </div>
        <div className="auth-intro">
          <h1>计算资源占用系统</h1>
          <p>统一安排机器、设备与共享资源的占用时间，减少多人协作中的冲突。</p>
        </div>
      </section>
      <section className="auth-panel">
        <div className={`auth-card${wide ? " auth-card-wide" : ""}`}>
          <div className="auth-card-head">
            <span className="mini-mark"><Boxes size={18} /></span>
            <h2>{title}</h2>
          </div>
          {children}
        </div>
        <a className="auth-docs-link" href="/docs/getting-started">
          <BookOpenText size={15} />帮助与文档
        </a>
      </section>
    </div>
  );
}

function PageHeader({
  title,
  titleExtras,
  actions,
  className = ""
}: {
  title: string;
  titleExtras?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`page-header${className ? ` ${className}` : ""}`}>
      <div className="page-header-title-group">
        <h1>{title}</h1>
        {titleExtras}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

function CalendarMachineTags({
  tags,
  className = ""
}: {
  tags: string[];
  className?: string;
}) {
  if (!tags.length) return null;
  const visibleTags = tags.slice(0, 3);
  const remaining = tags.length - visibleTags.length;
  return (
    <span
      className={`calendar-machine-tags${className ? ` ${className}` : ""}`}
      title={tags.join("、")}
    >
      {visibleTags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
      {remaining > 0 && <span>+{remaining}</span>}
    </span>
  );
}

function MouseControlIcon({
  highlight,
  size = 14
}: {
  highlight: "LEFT_BUTTON" | "RIGHT_BUTTON" | "WHEEL";
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        className="mouse-control-base"
        d="M5 10V9a7 7 0 0 1 14 0v1Z"
        stroke="none"
      />
      {(highlight === "LEFT_BUTTON" || highlight === "RIGHT_BUTTON") && (
        <path
          className="mouse-control-accent"
          d={
            highlight === "LEFT_BUTTON"
              ? "M5 10V9a7 7 0 0 1 7-7v8Z"
              : "M12 2a7 7 0 0 1 7 7v1h-7Z"
          }
          stroke="none"
        />
      )}
      <path d="M5 10h14" />
      {highlight === "LEFT_BUTTON" || highlight === "RIGHT_BUTTON" ? (
        <path d="M12 2v8" />
      ) : (
        <rect
          className="mouse-control-accent"
          x="9.25"
          y="2.5"
          width="5.5"
          height="8.5"
          rx="2.75"
          stroke="none"
        />
      )}
      <path
        d="M5 9a7 7 0 0 1 14 0v5a7 7 0 0 1-14 0Z"
        fill="none"
      />
    </svg>
  );
}

function MouseLeftButtonIcon({ size = 14 }: { size?: number }) {
  return <MouseControlIcon highlight="LEFT_BUTTON" size={size} />;
}

function MouseRightButtonIcon({ size = 14 }: { size?: number }) {
  return <MouseControlIcon highlight="RIGHT_BUTTON" size={size} />;
}

function MouseWheelIcon({ size = 14 }: { size?: number }) {
  return <MouseControlIcon highlight="WHEEL" size={size} />;
}

function SectionHeader({
  title,
  id,
  level = 3,
  leadingIcon: LeadingIcon,
  actions,
  className = ""
}: {
  title: string;
  id?: string;
  level?: 2 | 3;
  leadingIcon?: React.ComponentType<{ size?: number }>;
  actions?: React.ReactNode;
  className?: string;
}) {
  const heading = level === 2
    ? <h2 id={id}>{title}</h2>
    : <h3 id={id}>{title}</h3>;
  return (
    <div className={`section-header${className ? ` ${className}` : ""}`}>
      {LeadingIcon && <span className="section-header-icon"><LeadingIcon size={19} /></span>}
      <div className="section-header-title">{heading}</div>
      {actions && <div className="section-header-actions">{actions}</div>}
    </div>
  );
}

function ContextNotice({
  children,
  tone = "info",
  className = ""
}: {
  children: React.ReactNode;
  tone?: "info" | "warning";
  className?: string;
}) {
  const Icon = tone === "warning" ? CircleAlert : Info;
  return (
    <aside
      className={`context-notice ${tone}${className ? ` ${className}` : ""}`}
      role="note"
    >
      <Icon size={15} />
      <span>{children}</span>
    </aside>
  );
}

function BusyButtonContent({
  busy,
  children,
  iconSize = 15
}: {
  busy: boolean;
  children: React.ReactNode;
  iconSize?: number;
}) {
  return (
    <span className="busy-button-content">
      <span className={busy ? "busy-button-label hidden" : "busy-button-label"}>
        {children}
      </span>
      {busy && (
        <span className="busy-button-spinner" aria-hidden="true">
          <RefreshCw size={iconSize} className="spin" />
        </span>
      )}
    </span>
  );
}

function LoginPage({
  onAuthenticated,
  navigate,
  initialIdentifier,
  initialMessage
}: {
  onAuthenticated: (bootstrap: DashboardBootstrap) => Promise<void>;
  navigate: AuthNavigate;
  initialIdentifier: string;
  initialMessage: string;
}) {
  const [loginInfoMessage] = useState(initialMessage);
  const remembered = useMemo(() => readLoginPreference(), []);
  const [method, setMethod] = useState<LoginMethod>(
    initialIdentifier ? "USERNAME" : remembered.method
  );
  const [username, setUsername] = useState(
    initialIdentifier || remembered.username || ""
  );
  const [usernamePassword, setUsernamePassword] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState(
    remembered.employeeNumber ?? ""
  );
  const [employeeNumberPassword, setEmployeeNumberPassword] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [employeeNumberError, setEmployeeNumberError] = useState("");
  const [usernameValidation, setUsernameValidation] =
    useState<LoginFormValidationState>(emptyLoginValidationState);
  const [employeeNumberValidation, setEmployeeNumberValidation] =
    useState<LoginFormValidationState>(emptyLoginValidationState);
  const [busy, setBusy] = useState(false);

  const selectMethod = (next: LoginMethod) => {
    setMethod(next);
    rememberLoginMethod(next);
  };

  const submit = async (
    identifierType: LoginMethod,
    identifier: string,
    password: string,
    setError: (message: string) => void
  ) => {
    setError("");
    setBusy(true);
    try {
      const result = await api<DashboardBootstrap>("/auth/login", {
        method: "POST",
        body: jsonBody({ identifierType, identifier, password })
      });
      rememberSuccessfulLogin(
        identifierType,
        identifier,
        result.user.username
      );
      setCsrfToken(result.csrfToken);
      await onAuthenticated(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="账号登录">
      <div
        className="segmented auth-tabs"
        role="tablist"
        aria-label="登录方式"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            return;
          }
          event.preventDefault();
          const next =
            event.key === "ArrowLeft" || event.key === "Home"
              ? "USERNAME"
              : "EMPLOYEE_NUMBER";
          selectMethod(next);
          window.requestAnimationFrame(() => {
            document
              .getElementById(
                next === "USERNAME"
                  ? "username-login-tab"
                  : "employee-number-login-tab"
              )
              ?.focus();
          });
        }}
      >
        <button
          type="button"
          id="username-login-tab"
          role="tab"
          aria-selected={method === "USERNAME"}
          aria-controls="username-login-form"
          tabIndex={method === "USERNAME" ? 0 : -1}
          className={method === "USERNAME" ? "active" : ""}
          onClick={() => selectMethod("USERNAME")}
        >
          用户名
        </button>
        <button
          type="button"
          id="employee-number-login-tab"
          role="tab"
          aria-selected={method === "EMPLOYEE_NUMBER"}
          aria-controls="employee-number-login-form"
          tabIndex={method === "EMPLOYEE_NUMBER" ? 0 : -1}
          className={method === "EMPLOYEE_NUMBER" ? "active" : ""}
          onClick={() => selectMethod("EMPLOYEE_NUMBER")}
        >
          工号
        </button>
      </div>
      {method === "USERNAME" ? (
        <UsernameLoginForm
          username={username}
          password={usernamePassword}
          busy={busy}
          infoMessage={loginInfoMessage}
          errorMessage={usernameError}
          validation={usernameValidation}
          setValidation={setUsernameValidation}
          onUsernameChange={(value) => {
            setUsername(value);
            setUsernameError("");
          }}
          onPasswordChange={(value) => {
            setUsernamePassword(value);
            setUsernameError("");
          }}
          onSubmit={(password) =>
            submit("USERNAME", username, password, setUsernameError)
          }
        />
      ) : (
        <EmployeeNumberLoginForm
          employeeNumber={employeeNumber}
          password={employeeNumberPassword}
          busy={busy}
          errorMessage={employeeNumberError}
          validation={employeeNumberValidation}
          setValidation={setEmployeeNumberValidation}
          onEmployeeNumberChange={(value) => {
            setEmployeeNumber(value);
            setEmployeeNumberError("");
          }}
          onPasswordChange={(value) => {
            setEmployeeNumberPassword(value);
            setEmployeeNumberError("");
          }}
          onSubmit={(password) =>
            submit(
              "EMPLOYEE_NUMBER",
              employeeNumber,
              password,
              setEmployeeNumberError
            )
          }
        />
      )}
      <button
        type="button"
        className="text-button auth-alt"
        onClick={() => navigate("/forgot-password")}
      >
        忘记密码？
      </button>
      <div className="auth-register-entry">
        <span>还没有账号？</span>
        <button
          type="button"
          className="secondary-button wide"
          onClick={() => navigate("/register")}
        >
          申请注册账号
        </button>
      </div>
    </AuthLayout>
  );
}

type AuthFeedbackTone = "hint" | "warning" | "error";

function AuthFeedback({
  id,
  tone,
  anchored = true,
  className = "",
  children
}: {
  id?: string;
  tone: AuthFeedbackTone;
  anchored?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={`field-bubble ${tone}${anchored ? "" : " form-feedback"}${
        className ? ` ${className}` : ""
      }`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {children}
    </div>
  );
}

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  onFieldFocus?: () => void;
  onFieldBlur?: () => void;
  onCapsLockChange?: (active: boolean) => void;
};

function PasswordInput({
  className,
  onFieldFocus,
  onFieldBlur,
  onCapsLockChange,
  ...inputProps
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const capsLockFeedbackId = useId();
  const actionLabel = visible ? "隐藏密码" : "显示密码";
  const updateCapsLock = (active: boolean) => {
    setCapsLockOn(active);
    onCapsLockChange?.(active);
  };
  const describedBy = [
    inputProps["aria-describedby"],
    focused && capsLockOn ? capsLockFeedbackId : undefined
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className="password-input-control"
      onFocusCapture={() => {
        setFocused(true);
        onFieldFocus?.();
      }}
      onBlurCapture={(event) => {
        if (
          !event.currentTarget.contains(event.relatedTarget as Node | null)
        ) {
          setFocused(false);
          updateCapsLock(false);
          onFieldBlur?.();
        }
      }}
      onKeyDownCapture={(event) =>
        updateCapsLock(event.getModifierState("CapsLock"))
      }
      onKeyUpCapture={(event) =>
        updateCapsLock(event.getModifierState("CapsLock"))
      }
    >
      <div className="password-input-shell">
        <input
          {...inputProps}
          className={className}
          type={visible ? "text" : "password"}
          aria-describedby={describedBy || undefined}
        />
        <button
          type="button"
          className="password-visibility-button"
          tabIndex={-1}
          aria-label={actionLabel}
          aria-pressed={visible}
          title={actionLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {focused && capsLockOn && (
        <AuthFeedback id={capsLockFeedbackId} tone="warning">
          已开启大写锁定。
        </AuthFeedback>
      )}
    </div>
  );
}

function PasswordField({
  label,
  id,
  ...inputProps
}: PasswordInputProps & {
  label: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <PasswordInput {...inputProps} id={inputId} />
    </div>
  );
}

type LoginFormValidationState = {
  focused: LoginField | null;
  errors: LoginFieldErrors;
};

const emptyLoginValidationState: LoginFormValidationState = {
  focused: null,
  errors: {}
};

type LoginValidationSetter = React.Dispatch<
  React.SetStateAction<LoginFormValidationState>
>;

function AuthFieldShell({
  id,
  label,
  focused,
  error,
  hint,
  hintClassName = "",
  errorClassName = "",
  errorContent,
  suppressHint = false,
  children
}: {
  id: string;
  label: string;
  focused: boolean;
  error?: string | string[];
  hint?: React.ReactNode;
  hintClassName?: string;
  errorClassName?: string;
  errorContent?: React.ReactNode;
  suppressHint?: boolean;
  children: React.ReactNode;
}) {
  const hasError = Array.isArray(error) ? error.length > 0 : Boolean(error);
  const showError = !focused && hasError;
  const showHint = focused && !suppressHint && Boolean(hint);
  return (
    <div className={`field auth-field${showError ? " has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {showError && (
        <AuthFeedback
          id={`${id}-error`}
          tone="error"
          className={errorClassName}
        >
          {errorContent ??
            (Array.isArray(error) ? (
              error.length === 1 ? (
                error[0]
              ) : (
                <ul>
                  {error.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              )
            ) : (
              error
            ))}
        </AuthFeedback>
      )}
      {showHint && (
        <AuthFeedback
          id={`${id}-hint`}
          tone="hint"
          className={hintClassName}
        >
          {hint}
        </AuthFeedback>
      )}
    </div>
  );
}

function focusLoginField(
  setValidation: LoginValidationSetter,
  field: LoginField
) {
  setValidation((current) => ({ ...current, focused: field }));
}

function blurLoginField(setValidation: LoginValidationSetter) {
  setValidation((current) => ({ ...current, focused: null }));
}

function clearLoginFieldError(
  setValidation: LoginValidationSetter,
  field: LoginField
) {
  setValidation((current) => {
    if (!current.errors[field]) return current;
    const errors = { ...current.errors };
    delete errors[field];
    return { ...current, errors };
  });
}

function UsernameLoginForm({
  username,
  password,
  busy,
  infoMessage,
  errorMessage,
  validation,
  setValidation,
  onUsernameChange,
  onPasswordChange,
  onSubmit
}: {
  username: string;
  password: string;
  busy: boolean;
  infoMessage: string;
  errorMessage: string;
  validation: LoginFormValidationState;
  setValidation: LoginValidationSetter;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  return (
    <form
      id="username-login-form"
      role="tabpanel"
      aria-labelledby="username-login-tab"
      className="stack-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        const errors = validateLoginForm("USERNAME", username, password);
        setValidation({ focused: null, errors });
        if (Object.keys(errors).length) return;
        void onSubmit(password);
      }}
    >
      <AuthFieldShell
        id="username-login-identifier"
        label="用户名"
        focused={validation.focused === "identifier"}
        error={validation.errors.identifier}
      >
        <input
          id="username-login-identifier"
          name="username"
          autoFocus
          autoComplete="username"
          aria-invalid={Boolean(validation.errors.identifier)}
          aria-describedby={
            validation.focused !== "identifier" &&
            validation.errors.identifier
              ? "username-login-identifier-error"
              : undefined
          }
          value={username}
          onFocus={() => focusLoginField(setValidation, "identifier")}
          onBlur={() => blurLoginField(setValidation)}
          onChange={(event) => {
            clearLoginFieldError(setValidation, "identifier");
            onUsernameChange(event.target.value);
          }}
        />
      </AuthFieldShell>
      <AuthFieldShell
        id="username-login-password"
        label="密码"
        focused={validation.focused === "password"}
        error={validation.errors.password}
      >
        <PasswordInput
          id="username-login-password"
          name="password"
          autoComplete="current-password"
          aria-invalid={Boolean(validation.errors.password)}
          aria-describedby={
            validation.focused !== "password" && validation.errors.password
              ? "username-login-password-error"
              : undefined
          }
          value={password}
          onFieldFocus={() => focusLoginField(setValidation, "password")}
          onFieldBlur={() => blurLoginField(setValidation)}
          onChange={(event) => {
            clearLoginFieldError(setValidation, "password");
            onPasswordChange(event.target.value);
          }}
        />
      </AuthFieldShell>
      {infoMessage && (
        <div className="inline-message"><Info size={16} />{infoMessage}</div>
      )}
      {errorMessage && (
        <AuthFeedback tone="error" anchored={false}>
          {errorMessage}
        </AuthFeedback>
      )}
      <button className="primary-button auth-submit" disabled={busy}>
        <BusyButtonContent busy={busy} iconSize={16}>登录</BusyButtonContent>
      </button>
    </form>
  );
}

function EmployeeNumberLoginForm({
  employeeNumber,
  password,
  busy,
  errorMessage,
  validation,
  setValidation,
  onEmployeeNumberChange,
  onPasswordChange,
  onSubmit
}: {
  employeeNumber: string;
  password: string;
  busy: boolean;
  errorMessage: string;
  validation: LoginFormValidationState;
  setValidation: LoginValidationSetter;
  onEmployeeNumberChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (password: string) => Promise<void>;
}) {
  return (
    <form
      id="employee-number-login-form"
      role="tabpanel"
      aria-labelledby="employee-number-login-tab"
      className="stack-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        const errors = validateLoginForm(
          "EMPLOYEE_NUMBER",
          employeeNumber,
          password
        );
        setValidation({ focused: null, errors });
        if (Object.keys(errors).length) return;
        void onSubmit(password);
      }}
    >
      <AuthFieldShell
        id="employee-number-login-identifier"
        label="工号"
        focused={validation.focused === "identifier"}
        error={validation.errors.identifier}
      >
        <input
          id="employee-number-login-identifier"
          name="employeeNumber"
          autoFocus
          autoComplete="username"
          aria-invalid={Boolean(validation.errors.identifier)}
          aria-describedby={
            validation.focused !== "identifier" &&
            validation.errors.identifier
              ? "employee-number-login-identifier-error"
              : undefined
          }
          value={employeeNumber}
          onFocus={() => focusLoginField(setValidation, "identifier")}
          onBlur={() => blurLoginField(setValidation)}
          onChange={(event) => {
            clearLoginFieldError(setValidation, "identifier");
            onEmployeeNumberChange(event.target.value.toLowerCase());
          }}
        />
      </AuthFieldShell>
      <AuthFieldShell
        id="employee-number-login-password"
        label="密码"
        focused={validation.focused === "password"}
        error={validation.errors.password}
      >
        <PasswordInput
          id="employee-number-login-password"
          name="password"
          autoComplete="current-password"
          aria-invalid={Boolean(validation.errors.password)}
          aria-describedby={
            validation.focused !== "password" && validation.errors.password
              ? "employee-number-login-password-error"
              : undefined
          }
          value={password}
          onFieldFocus={() => focusLoginField(setValidation, "password")}
          onFieldBlur={() => blurLoginField(setValidation)}
          onChange={(event) => {
            clearLoginFieldError(setValidation, "password");
            onPasswordChange(event.target.value);
          }}
        />
      </AuthFieldShell>
      {errorMessage && (
        <AuthFeedback tone="error" anchored={false}>
          {errorMessage}
        </AuthFeedback>
      )}
      <button className="primary-button auth-submit" disabled={busy}>
        <BusyButtonContent busy={busy} iconSize={16}>登录</BusyButtonContent>
      </button>
    </form>
  );
}

type RegistrationErrorState = {
  source: "STATIC" | "SERVER";
  value: string;
  messages: string[];
};

type RegistrationErrorMap = Partial<
  Record<RegistrationField, RegistrationErrorState>
>;

function PasswordChecklist({
  checks
}: {
  checks: ReturnType<typeof getPasswordChecks>;
}) {
  return (
    <ul>
      {checks.map((check) => (
        <li
          key={check.key}
          className={
            check.met === true
              ? "passed"
              : check.met === false
                ? "failed"
                : "pending"
          }
        >
          {check.met === true ? (
            <Check size={13} />
          ) : (
            <span className="check-dot" />
          )}
          <span>{check.label}</span>
        </li>
      ))}
    </ul>
  );
}

function RegistrationFieldShell({
  field,
  label,
  focused,
  error,
  hint,
  passwordChecks,
  suppressHint = false,
  children
}: {
  field: RegistrationField;
  label: string;
  focused: boolean;
  error?: RegistrationErrorState;
  hint?: string;
  passwordChecks?: ReturnType<typeof getPasswordChecks>;
  suppressHint?: boolean;
  children: React.ReactNode;
}) {
  const showHint =
    focused &&
    !suppressHint &&
    (Boolean(hint) || Boolean(passwordChecks));
  const showError = !focused && Boolean(error);
  const bubbleId = `register-${field}-${showError ? "error" : "hint"}`;
  const showPasswordChecklist =
    field === "password" && passwordChecks && (showHint || showError);
  return (
    <div
      className={`field registration-field${showError ? " has-error" : ""}`}
    >
      <label htmlFor={`register-${field}`}>{label}</label>
      {children}
      {(showHint || showError) && (
        <AuthFeedback
          id={bubbleId}
          tone={showError ? "error" : "hint"}
          className={showPasswordChecklist ? "password-checklist" : ""}
        >
          {showPasswordChecklist ? (
            <PasswordChecklist checks={passwordChecks} />
          ) : showError ? (
            error!.messages.length === 1 ? (
              error!.messages[0]
            ) : (
              <ul>
                {error!.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )
          ) : (
            hint
          )}
        </AuthFeedback>
      )}
    </div>
  );
}

function RegisterPage({
  notify,
  navigate,
  successUsername
}: {
  notify: (kind: "success" | "error", message: string) => void;
  navigate: AuthNavigate;
  successUsername: string;
}) {
  const dialog = useAppDialog();
  const [submitting, setSubmitting] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [focusedField, setFocusedField] = useState<RegistrationField | null>(
    null
  );
  const [errors, setErrors] = useState<RegistrationErrorMap>({});
  const [announcement, setAnnouncement] = useState("");
  const [passwordCapsLockOn, setPasswordCapsLockOn] = useState(false);
  const [focusCodeAfterSend, setFocusCodeAfterSend] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [configError, setConfigError] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<RegistrationFormValues>({
    username: "",
    realName: "",
    employeeNumber: "",
    email: "",
    challengeId: "",
    challengeEmail: "",
    code: "",
    password: "",
    confirmPassword: ""
  });

  const loadRegistrationConfig = useCallback(async () => {
    const result = await api<RegistrationConfigPayload>(
      "/auth/registration-config"
    );
    if (
      typeof result.emailEnabled !== "boolean" ||
      typeof result.allowRegistrationWithoutEmail !== "boolean" ||
      !Number.isInteger(result.revision) ||
      !Array.isArray(result.allowedEmailDomains) ||
      !result.allowedEmailDomains.every(
        (domain) => typeof domain === "string"
      )
    ) {
      throw new Error("注册配置格式不正确");
    }
    setRegistrationConfig({
      ...result,
      allowedEmailDomains: result.allowedEmailDomains.map((domain) =>
        domain.toLowerCase()
      )
    });
    if (!result.emailEnabled) {
      setErrors((current) => {
        if (!current.email && !current.code) return current;
        const next = { ...current };
        delete next.email;
        delete next.code;
        return next;
      });
    }
    setConfigError(false);
  }, []);

  useEffect(() => {
    let active = true;
    void loadRegistrationConfig().catch(() => {
      if (active) setConfigError(true);
    });
    return () => {
      active = false;
    };
  }, [loadRegistrationConfig]);

  const allowedEmailDomains =
    registrationConfig?.allowedEmailDomains ?? null;
  const emailEnabled = registrationConfig?.emailEnabled ?? false;
  const allowEmptyEmail =
    registrationConfig?.allowRegistrationWithoutEmail ?? true;

  const passwordChecks = getPasswordChecks(form.password, {
    username: form.username,
    employeeNumbers: [form.employeeNumber]
  });
  const codeEnabled =
    emailEnabled &&
    Boolean(form.challengeId) &&
    form.challengeEmail === normalizeRegistrationEmail(form.email);

  useEffect(() => {
    if (!focusCodeAfterSend || !codeEnabled) return;
    codeInputRef.current?.focus();
    setFocusedField("code");
    setFocusCodeAfterSend(false);
  }, [codeEnabled, focusCodeAfterSend]);

  useEffect(() => {
    if (!resendAvailableAt) {
      setResendSeconds(0);
      return;
    }
    const updateCountdown = () => {
      const remaining = verificationCooldownSeconds(resendAvailableAt);
      setResendSeconds(remaining);
      if (remaining === 0) setResendAvailableAt(null);
    };
    updateCountdown();
    const intervalId = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(intervalId);
  }, [resendAvailableAt]);

  const showBubbleFor = (field: RegistrationField, hasHint: boolean) =>
    focusedField === field
      ? hasHint
        ? `register-${field}-hint`
        : undefined
      : errors[field]
        ? `register-${field}-error`
        : undefined;

  const inputAccessibility = (field: RegistrationField, hasHint = false) => ({
    id: `register-${field}`,
    "aria-invalid": Boolean(errors[field]),
    "aria-describedby": showBubbleFor(field, hasHint)
  });

  const announceErrors = () => {
    setAnnouncement("");
    window.requestAnimationFrame(() => setAnnouncement("请检查标出的内容"));
  };

  const validateOnBlur = (field: RegistrationField) => {
    setFocusedField((current) => (current === field ? null : current));
    if (!allowedEmailDomains || !registrationConfig) return;
    const messages = validateRegistrationField(
      field,
      form,
      allowedEmailDomains,
      emailEnabled,
      allowEmptyEmail
    );
    const value = registrationFieldValue(field, form);
    setErrors((current) => {
      if (messages.length) {
        return {
          ...current,
          [field]: { source: "STATIC", value, messages }
        };
      }
      const existing = current[field];
      if (
        existing?.source === "SERVER" &&
        existing.value === value
      ) {
        return current;
      }
      if (!existing) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const updateFormField = (
    field: Exclude<
      RegistrationField,
      "code" | "confirmPassword"
    >,
    value: string
  ) => {
    if (field === "email") {
      const normalizedEmail = normalizeRegistrationEmail(value);
      const emailChanged =
        normalizedEmail !== normalizeRegistrationEmail(form.email);
      const invalidatesChallenge =
        Boolean(form.challengeId) &&
        normalizedEmail !== form.challengeEmail;

      if (emailChanged) {
        setFocusCodeAfterSend(false);
        setErrors((current) => {
          if (!current.code) return current;
          const next = { ...current };
          delete next.code;
          return next;
        });
      }

      setForm((current) => ({
        ...current,
        email: value,
        ...(invalidatesChallenge
          ? { challengeId: "", challengeEmail: "", code: "" }
          : {})
      }));
      return;
    }

    setForm((current) => {
      return { ...current, [field]: value };
    });
  };

  const applyServerErrors = (fieldErrors: RegistrationFieldErrors) => {
    const next: RegistrationErrorMap = {};
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (!isServerRegistrationField(field) || !messages?.length) continue;
      next[field] = {
        source: "SERVER",
        value: registrationFieldValue(field, form),
        messages
      };
    }
    setErrors(next);
    announceErrors();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!allowedEmailDomains || !registrationConfig || configError) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocusedField(null);
    const staticErrors = validateRegistrationForm(
      form,
      allowedEmailDomains,
      emailEnabled,
      allowEmptyEmail
    );
    if (Object.keys(staticErrors).length) {
      setErrors((current) => {
        const next: RegistrationErrorMap = {};
        for (const field of registrationFields) {
          const messages = staticErrors[field];
          if (messages?.length) {
            next[field] = {
              source: "STATIC",
              value: registrationFieldValue(field, form),
              messages
            };
            continue;
          }
          const existing = current[field];
          if (
            existing?.source === "SERVER" &&
            existing.value === registrationFieldValue(field, form)
          ) {
            next[field] = existing;
          }
        }
        return next;
      });
      announceErrors();
      return;
    }

    const normalizedEmail = normalizeRegistrationEmail(form.email);
    let withoutEmailConfirmed = false;
    if (emailEnabled && allowEmptyEmail && !normalizedEmail) {
      withoutEmailConfirmed = await dialog.confirm({
        title: "不填写邮箱？",
        message:
          "不填写邮箱将无法接收系统邮件提醒，也无法自行通过邮件找回密码。",
        confirmLabel: "仍然提交"
      });
      if (!withoutEmailConfirmed) return;
    }

    setSubmitting(true);
    try {
      await api<{ message: string }>("/auth/register", {
        method: "POST",
        body: jsonBody({
          username: form.username,
          realName: form.realName,
          employeeNumber: form.employeeNumber,
          email: emailEnabled ? normalizedEmail || null : null,
          challengeId:
            emailEnabled && normalizedEmail ? form.challengeId : null,
          code: emailEnabled && normalizedEmail ? form.code : null,
          password: form.password,
          expectedConfigRevision: registrationConfig.revision,
          withoutEmailConfirmed
        })
      });
      const username = form.username.trim().normalize("NFKC");
      rememberUsername(username, true);
      setForm({
        username: "",
        realName: "",
        employeeNumber: "",
        email: "",
        challengeId: "",
        challengeEmail: "",
        code: "",
        password: "",
        confirmPassword: ""
      });
      setErrors({});
      navigate(
        "/register",
        { registrationSuccess: { username } },
        true
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "REGISTRATION_CONFIG_CHANGED" ||
          error.code === "EMAIL_FEATURE_DISABLED")
      ) {
        try {
          await loadRegistrationConfig();
          notify("error", "注册规则已更新，请按当前页面重新确认后提交");
        } catch {
          setConfigError(true);
        }
        return;
      }
      if (
        error instanceof ApiError &&
        (error.status === 400 || error.status === 409) &&
        error.code === "REGISTRATION_VALIDATION_FAILED"
      ) {
        const fieldErrors = parseServerRegistrationErrors(error.fieldErrors);
        if (fieldErrors) {
          applyServerErrors(fieldErrors);
          return;
        }
      }
      notify("error", error instanceof Error ? error.message : "注册提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const requestCode = async () => {
    if (
      !emailEnabled ||
      !allowedEmailDomains ||
      codeSending ||
      resendSeconds > 0
    ) {
      return;
    }
    const emailErrors = validateEmail(form.email, allowedEmailDomains);
    if (emailErrors.length) {
      setErrors((current) => ({
        ...current,
        email: {
          source: "STATIC",
          value: registrationFieldValue("email", form),
          messages: emailErrors
        }
      }));
      return;
    }
    setCodeSending(true);
    try {
      const result = await api<{
        challengeId: string;
        expiresAt: string;
      }>("/auth/registration-email-code", {
        method: "POST",
        body: jsonBody({ email: form.email })
      });
      const challengeEmail = normalizeRegistrationEmail(form.email);
      setForm((current) => ({
        ...current,
        challengeId: result.challengeId,
        challengeEmail,
        code: ""
      }));
      setFocusCodeAfterSend(true);
      setResendAvailableAt(Date.now() + 60_000);
      setResendSeconds(60);
      setErrors((current) => {
        if (!current.email) return current;
        const next = { ...current };
        delete next.email;
        return next;
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "EMAIL_FEATURE_DISABLED"
      ) {
        try {
          await loadRegistrationConfig();
        } catch {
          setConfigError(true);
        }
        return;
      }
      if (error instanceof ApiError && (error.status === 400 || error.status === 409)) {
        const fieldErrors = parseServerRegistrationErrors(error.fieldErrors);
        if (fieldErrors?.email) {
          setErrors((current) => ({
            ...current,
            email: {
              source: "SERVER",
              value: registrationFieldValue("email", form),
              messages: fieldErrors.email!
            }
          }));
          return;
        }
      }
      notify("error", error instanceof Error ? error.message : "验证码发送失败");
    } finally {
      setCodeSending(false);
    }
  };

  if (successUsername) {
    return (
      <AuthLayout title="注册申请已提交" wide>
        <div className="registration-success">
          <div className="success-mark"><Check size={24} /></div>
          <p>注册审核通过前请使用用户名登录。</p>
          <button
            type="button"
            className="primary-button wide auth-submit"
            onClick={() => navigate("/login")}
          >
            返回登录
          </button>
        </div>
      </AuthLayout>
    );
  }

  const emailHasHint = Boolean(allowedEmailDomains?.length);
  const emailHint = emailHasHint
    ? `仅允许以下邮箱域名：${allowedEmailDomains!.join("、")}`
    : undefined;
  const emailIsValid =
    emailEnabled &&
    allowedEmailDomains !== null &&
    Boolean(form.email.trim()) &&
    validateEmail(form.email, allowedEmailDomains).length === 0;
  const emailHasCurrentServerError =
    errors.email?.source === "SERVER" &&
    errors.email.value === registrationFieldValue("email", form);
  const codeButtonLabel = verificationButtonLabel({
    sending: codeSending,
    remainingSeconds: resendSeconds
  });

  return (
    <AuthLayout
      title="用户注册"
      wide
    >
      <form onSubmit={submit} className="stack-form" noValidate>
        <RegistrationFieldShell
          field="username"
          label="用户名"
          focused={focusedField === "username"}
          error={errors.username}
          hint="2–32个字符，支持中文。"
        >
          <input
            {...inputAccessibility("username", true)}
            name="username"
            autoComplete="username"
            value={form.username}
            onFocus={() => setFocusedField("username")}
            onBlur={() => validateOnBlur("username")}
            onChange={(event) => updateFormField("username", event.target.value)}
          />
        </RegistrationFieldShell>
        <div className="two-fields auth-two-fields">
          <RegistrationFieldShell
            field="realName"
            label="姓名"
            focused={focusedField === "realName"}
            error={errors.realName}
          >
            <input
              {...inputAccessibility("realName")}
              name="realName"
              autoComplete="name"
              value={form.realName}
              onFocus={() => setFocusedField("realName")}
              onBlur={() => validateOnBlur("realName")}
              onChange={(event) => updateFormField("realName", event.target.value)}
            />
          </RegistrationFieldShell>
          <RegistrationFieldShell
            field="employeeNumber"
            label="工号"
            focused={focusedField === "employeeNumber"}
            error={errors.employeeNumber}
          >
            <input
              {...inputAccessibility("employeeNumber")}
              name="employeeNumber"
              autoComplete="username"
              value={form.employeeNumber}
              onFocus={() => setFocusedField("employeeNumber")}
              onBlur={() => validateOnBlur("employeeNumber")}
              onChange={(event) =>
                updateFormField("employeeNumber", event.target.value.toLowerCase())
              }
            />
          </RegistrationFieldShell>
        </div>
        {emailEnabled && (
          <>
            <RegistrationFieldShell
              field="email"
              label={allowEmptyEmail ? "邮箱（选填）" : "邮箱"}
              focused={focusedField === "email"}
              error={errors.email}
              hint={emailHint}
            >
              <input
                {...inputAccessibility("email", emailHasHint)}
                name="email"
                type="email"
                disabled={codeSending}
                autoComplete="email"
                value={form.email}
                onFocus={() => setFocusedField("email")}
                onBlur={() => validateOnBlur("email")}
                onChange={(event) => updateFormField("email", event.target.value)}
              />
            </RegistrationFieldShell>
            <div className="verification-row">
              <RegistrationFieldShell
                field="code"
                label="邮箱验证码"
                focused={focusedField === "code"}
                error={errors.code}
              >
                <input
                  {...inputAccessibility("code")}
                  name="code"
                  ref={codeInputRef}
                  disabled={!codeEnabled}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={form.code}
                  onFocus={() => setFocusedField("code")}
                  onBlur={() => validateOnBlur("code")}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      code: event.target.value.replace(/\D/g, "")
                    }))
                  }
                />
              </RegistrationFieldShell>
              <button
                type="button"
                className="secondary-button verification-button"
                disabled={
                  submitting ||
                  codeSending ||
                  resendSeconds > 0 ||
                  configError ||
                  !emailIsValid ||
                  emailHasCurrentServerError
                }
                onClick={() => void requestCode()}
              >
                {codeButtonLabel}
              </button>
            </div>
          </>
        )}
        <RegistrationFieldShell
          field="password"
          label="密码"
          focused={focusedField === "password"}
          error={errors.password}
          passwordChecks={passwordChecks}
          suppressHint={passwordCapsLockOn}
        >
          <PasswordInput
            {...inputAccessibility("password", true)}
            name="password"
            autoComplete="new-password"
            value={form.password}
            onCapsLockChange={setPasswordCapsLockOn}
            onFieldFocus={() => setFocusedField("password")}
            onFieldBlur={() => validateOnBlur("password")}
            onChange={(event) => updateFormField("password", event.target.value)}
          />
        </RegistrationFieldShell>
        <RegistrationFieldShell
          field="confirmPassword"
          label="确认密码"
          focused={focusedField === "confirmPassword"}
          error={errors.confirmPassword}
        >
          <PasswordInput
            {...inputAccessibility("confirmPassword")}
            name="confirmPassword"
            autoComplete="new-password"
            value={form.confirmPassword}
            onFieldFocus={() => setFocusedField("confirmPassword")}
            onFieldBlur={() => validateOnBlur("confirmPassword")}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                confirmPassword: event.target.value
              }))
            }
          />
        </RegistrationFieldShell>
        {configError && (
          <div className="inline-message error">
            <CircleAlert size={16} />
            暂时无法加载注册规则，请刷新页面重试。
          </div>
        )}
        <div className="sr-only" aria-live="assertive">{announcement}</div>
        <button
          className="primary-button auth-submit"
          disabled={
            submitting ||
            codeSending ||
            configError ||
            registrationConfig === null
          }
        >
          <BusyButtonContent busy={submitting} iconSize={16}>
            提交注册
          </BusyButtonContent>
        </button>
      </form>
      <button
        type="button"
        className="text-button auth-alt"
        onClick={() => navigate("/login")}
      >
        返回登录
      </button>
    </AuthLayout>
  );
}

function ForgotPasswordPage({
  navigate
}: {
  navigate: AuthNavigate;
}) {
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [configError, setConfigError] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [emailErrors, setEmailErrors] = useState<string[]>([]);
  const [formError, setFormError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let active = true;
    void api<RegistrationConfigPayload>("/auth/registration-config")
      .then((result) => {
        if (active) setRegistrationConfig(result);
      })
      .catch(() => {
        if (active) {
          setConfigError("暂时无法加载邮件设置，请刷新页面重试。");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!registrationConfig?.emailEnabled) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocused(false);
    setFormError("");
    const staticErrors = validateForgotPasswordEmail(email);
    setEmailErrors(staticErrors);
    if (staticErrors.length) return;

    setBusy(true);
    try {
      await api<{ message: string }>("/auth/forgot-password", {
        method: "POST",
        body: jsonBody({ email })
      });
      setSent(true);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "重置邮件发送失败"
      );
    } finally {
      setBusy(false);
    }
  };

  if (registrationConfig && !registrationConfig.emailEnabled) {
    return (
      <AuthLayout title="找回密码">
        <div className="registration-success">
          <div className="success-mark"><ShieldCheck size={24} /></div>
          <p>邮件功能未启用，请联系系统管理员获取密码重置链接。</p>
          <button
            type="button"
            className="primary-button wide auth-submit"
            onClick={() => navigate("/login")}
          >
            返回登录
          </button>
        </div>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout title="重置邮件已发送">
        <div className="registration-success">
          <div className="success-mark"><Mail size={24} /></div>
          <p>如果该邮箱已绑定有效账号，你将收到密码重置邮件。</p>
          <button
            type="button"
            className="primary-button wide auth-submit"
            onClick={() => navigate("/login")}
          >
            返回登录
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="找回密码">
      <form onSubmit={submit} className="stack-form" noValidate>
        {configError && (
          <AuthFeedback tone="error" anchored={false}>
            {configError}
          </AuthFeedback>
        )}
        <AuthFieldShell
          id="forgot-password-email"
          label="邮箱"
          focused={focused}
          error={emailErrors}
        >
          <input
            id="forgot-password-email"
            name="email"
            type="email"
            autoComplete="email"
            aria-invalid={emailErrors.length > 0}
            aria-describedby={
              !focused && emailErrors.length
                ? "forgot-password-email-error"
                : undefined
            }
            value={email}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailErrors([]);
              setFormError("");
            }}
          />
        </AuthFieldShell>
        {formError && (
          <AuthFeedback tone="error" anchored={false}>
            {formError}
          </AuthFeedback>
        )}
        <button
          className="primary-button auth-submit"
          disabled={busy || !registrationConfig || Boolean(configError)}
        >
          <BusyButtonContent busy={busy} iconSize={16}>
            发送重置邮件
          </BusyButtonContent>
        </button>
      </form>
      <button
        type="button"
        className="text-button auth-alt"
        onClick={() => navigate("/login")}
      >
        返回登录
      </button>
    </AuthLayout>
  );
}

type ResetPasswordFieldError = {
  source: "STATIC" | "SERVER";
  messages: string[];
};
type ResetPasswordFieldErrors = Partial<
  Record<ResetPasswordField, ResetPasswordFieldError>
>;

function ResetPasswordPage({
  token,
  navigate
}: {
  token: string;
  navigate: AuthNavigate;
}) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [focusedField, setFocusedField] =
    useState<ResetPasswordField | null>(null);
  const [errors, setErrors] = useState<ResetPasswordFieldErrors>({});
  const [formError, setFormError] = useState("");
  const [passwordCapsLockOn, setPasswordCapsLockOn] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(!token);
  const passwordChecks = getPasswordChecks(password);

  useEffect(() => {
    setPassword("");
    setConfirmPassword("");
    setErrors({});
    setFormError("");
    setFocusedField(null);
    setLinkInvalid(!token);
  }, [token]);

  const clearFieldErrors = (...fields: ResetPasswordField[]) => {
    setErrors((current) => {
      const next = { ...current };
      let changed = false;
      for (const field of fields) {
        if (!next[field]) continue;
        delete next[field];
        changed = true;
      }
      return changed ? next : current;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!token || linkInvalid) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocusedField(null);
    setFormError("");

    const validationErrors = validateResetPasswordForm(
      password,
      confirmPassword
    );
    const staticErrors: ResetPasswordFieldErrors = {};
    for (const [field, messages] of Object.entries(validationErrors)) {
      staticErrors[field as ResetPasswordField] = {
        source: "STATIC",
        messages
      };
    }
    setErrors(staticErrors);
    if (Object.keys(staticErrors).length) return;

    setBusy(true);
    try {
      const result = await api<{ message: string }>("/auth/reset-password", {
        method: "POST",
        body: jsonBody({ token, password })
      });
      navigate(
        "/login",
        { authFlash: { message: result.message } },
        true
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === "PASSWORD_VALIDATION_FAILED" &&
        error.fieldErrors &&
        typeof error.fieldErrors === "object" &&
        !Array.isArray(error.fieldErrors)
      ) {
        const passwordMessages = (
          error.fieldErrors as Record<string, unknown>
        ).password;
        if (
          Array.isArray(passwordMessages) &&
          passwordMessages.length > 0 &&
          passwordMessages.every(
            (message): message is string =>
              typeof message === "string" && message.trim().length > 0
          )
        ) {
          setErrors({
            password: {
              source: "SERVER",
              messages: passwordMessages
            }
          });
          return;
        }
      }
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === "PASSWORD_RESET_TOKEN_INVALID"
      ) {
        setPassword("");
        setConfirmPassword("");
        setErrors({});
        setFormError("");
        setLinkInvalid(true);
        return;
      }
      setFormError(error instanceof Error ? error.message : "密码重置失败");
    } finally {
      setBusy(false);
    }
  };

  if (linkInvalid) {
    return (
      <AuthLayout title="设置新密码">
        <AuthFeedback tone="error" anchored={false}>
          重置链接无效或已经过期
        </AuthFeedback>
        <button
          type="button"
          className="primary-button wide auth-submit"
          onClick={() => navigate("/forgot-password")}
        >
          重新申请重置链接
        </button>
      </AuthLayout>
    );
  }

  const passwordError = errors.password;
  const confirmPasswordError = errors.confirmPassword;
  const passwordHintVisible =
    focusedField === "password" && !passwordCapsLockOn;

  return (
    <AuthLayout title="设置新密码">
      <form onSubmit={submit} className="stack-form" noValidate>
        <AuthFieldShell
          id="reset-password"
          label="新密码"
          focused={focusedField === "password"}
          error={passwordError?.messages}
          hint={<PasswordChecklist checks={passwordChecks} />}
          hintClassName="password-checklist"
          errorClassName={
            passwordError?.source === "STATIC" ? "password-checklist" : ""
          }
          errorContent={
            passwordError?.source === "STATIC" ? (
              <PasswordChecklist checks={passwordChecks} />
            ) : undefined
          }
          suppressHint={passwordCapsLockOn}
        >
          <PasswordInput
            id="reset-password"
            name="newPassword"
            autoComplete="new-password"
            aria-invalid={Boolean(passwordError)}
            aria-describedby={
              focusedField !== "password" && passwordError
                ? "reset-password-error"
                : passwordHintVisible
                  ? "reset-password-hint"
                  : undefined
            }
            value={password}
            onCapsLockChange={setPasswordCapsLockOn}
            onFieldFocus={() => setFocusedField("password")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "password" ? null : current
              )
            }
            onChange={(event) => {
              setPassword(event.target.value);
              clearFieldErrors("password", "confirmPassword");
              setFormError("");
            }}
          />
        </AuthFieldShell>
        <AuthFieldShell
          id="reset-confirm-password"
          label="确认密码"
          focused={focusedField === "confirmPassword"}
          error={confirmPasswordError?.messages}
        >
          <PasswordInput
            id="reset-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            aria-invalid={Boolean(confirmPasswordError)}
            aria-describedby={
              focusedField !== "confirmPassword" && confirmPasswordError
                ? "reset-confirm-password-error"
                : undefined
            }
            value={confirmPassword}
            onFieldFocus={() => setFocusedField("confirmPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "confirmPassword" ? null : current
              )
            }
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              clearFieldErrors("confirmPassword");
              setFormError("");
            }}
          />
        </AuthFieldShell>
        {formError && (
          <AuthFeedback tone="error" anchored={false}>
            {formError}
          </AuthFeedback>
        )}
        <button className="primary-button auth-submit" disabled={busy}>
          <BusyButtonContent busy={busy} iconSize={16}>
            保存新密码
          </BusyButtonContent>
        </button>
      </form>
      <button
        type="button"
        className="text-button auth-alt"
        onClick={() => navigate("/login")}
      >
        返回登录
      </button>
    </AuthLayout>
  );
}

function AccountProfilePage({
  bootstrap,
  notify,
  reload
}: {
  bootstrap: DashboardBootstrap;
  notify: (kind: "success" | "error", message: string) => void;
  reload: () => Promise<void>;
}) {
  const [usernameOpen, setUsernameOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [emailPreferences, setEmailPreferences] = useState(
    bootstrap.user.emailPreferences
  );
  const [emailPreferenceSaving, setEmailPreferenceSaving] = useState<
    keyof AuthUser["emailPreferences"] | null
  >(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewCloseTimer = useRef<number | null>(null);
  const user = bootstrap.user;
  const editable = user.role !== "SYSTEM_ADMIN";
  const closeReviewLater = () => {
    if (reviewCloseTimer.current !== null) {
      window.clearTimeout(reviewCloseTimer.current);
    }
    reviewCloseTimer.current = window.setTimeout(() => setReviewOpen(false), 140);
  };
  const keepReviewOpen = () => {
    if (reviewCloseTimer.current !== null) {
      window.clearTimeout(reviewCloseTimer.current);
      reviewCloseTimer.current = null;
    }
    setReviewOpen(true);
  };
  useEffect(() => {
    setEmailPreferences(bootstrap.user.emailPreferences);
  }, [bootstrap.user.emailPreferences]);
  useEffect(() => {
    let active = true;
    void api<RegistrationConfigPayload>("/auth/registration-config")
      .then((result) => {
        if (active) setRegistrationConfig(result);
      })
      .catch(() => {
        if (active) setRegistrationConfig(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const updateEmailPreference = async (
    key: keyof AuthUser["emailPreferences"],
    enabled: boolean
  ) => {
    const next = { ...emailPreferences, [key]: enabled };
    setEmailPreferenceSaving(key);
    try {
      await api("/auth/email-preferences", {
        method: "PATCH",
        body: jsonBody(next)
      });
      setEmailPreferences(next);
      notify("success", "邮件接收设置已更新");
      await reload();
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "邮件接收设置更新失败"
      );
    } finally {
      setEmailPreferenceSaving(null);
    }
  };
  const emailPreferenceOptions: Array<{
    key: keyof AuthUser["emailPreferences"];
    label: string;
    details: string[];
  }> = [
    {
      key: "reservationUpdates",
      label: "占用与资源",
      details: [
        "占用取消或调整",
        "资源组配置更新",
        "机器或资源组删除"
      ]
    },
    {
      key: "machineAccessUpdates",
      label: "机器权限",
      details: [
        "机器使用权状态更新",
        "机器管理员身份更新"
      ]
    },
    {
      key: "approvalUpdates",
      label: "审核结果",
      details: [
        "注册申请提交",
        "资料修改审核状态更新"
      ]
    }
  ];
  if (user.role === "SYSTEM_ADMIN") {
    emailPreferenceOptions.push({
      key: "administrationUpdates",
      label: "管理待办",
      details: [
        "新用户注册待审核",
        "资料修改待审核",
        "机器使用权待审核"
      ]
    });
  } else {
    emailPreferenceOptions.push({
      key: "administrationUpdates",
      label: "管理待办",
      details: ["所管理机器的使用权待审核"]
    });
  }

  return (
    <>
      <div className="page-shell narrow-page profile-layout">
        <PageHeader
          title="用户信息"
          actions={
            user.status === "PENDING_APPROVAL" ||
            user.status === "CHANGES_REQUESTED" ? (
              <span
                className={`state-chip ${
                  user.status === "CHANGES_REQUESTED"
                    ? "retiring"
                    : "pending_approval"
                }`}
              >
                {userStatusLabel(user.status)}
              </span>
            ) : undefined
          }
        />
        <section className="card profile-form-card">
          <div className="profile-section">
            <div className="profile-section-head">
              <div className="profile-section-title">
                <span className="profile-section-icon">
                  <UserCheck size={16} />
                </span>
                <h2>账号资料</h2>
              </div>
            </div>
            <div className="profile-fields-grid">
              <div className="profile-field profile-field-third">
                <div className="profile-field-head">
                  <span>用户名</span>
                {editable && (
                  <button
                    type="button"
                    className="icon-button profile-edit"
                    title="修改用户名"
                    aria-label="修改用户名"
                    onClick={() => setUsernameOpen(true)}
                  >
                    <Pencil size={15} />
                  </button>
                )}
                </div>
                <strong>{user.username}</strong>
              </div>
              <div className="profile-field profile-field-third">
                <div className="profile-field-head">
                  <span>姓名</span>
                  {editable && (
                    <button
                      type="button"
                      className="icon-button profile-edit"
                      title={user.pendingProfileChange ? "请先撤回待审修改" : "修改姓名和工号"}
                      aria-label="修改姓名和工号"
                      disabled={Boolean(user.pendingProfileChange)}
                      onClick={() => setIdentityOpen(true)}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                </div>
                <strong>{user.displayName}</strong>
              </div>
              <div className="profile-field profile-field-third">
                <div className="profile-field-head">
                  <span>工号</span>
                  <div className="profile-row-actions">
                    {user.pendingProfileChange && (
                      <div
                        className="profile-review-anchor"
                        onMouseEnter={keepReviewOpen}
                        onMouseLeave={closeReviewLater}
                        onFocus={keepReviewOpen}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget)) {
                            setReviewOpen(false);
                          }
                        }}
                      >
                        <button
                          type="button"
                          className="state-chip pending profile-review-chip"
                          aria-expanded={reviewOpen}
                        >
                          审核中
                        </button>
                        {reviewOpen && (
                          <div className="profile-review-popover" role="dialog" aria-label="待审资料">
                            <div><span>新姓名</span><strong>{user.pendingProfileChange.displayName}</strong></div>
                            <div><span>新工号</span><strong>{user.pendingProfileChange.employeeNumber}</strong></div>
                            <small>提交于 {formatChina(user.pendingProfileChange.requestedAt)}</small>
                            <button
                              type="button"
                              className="text-action danger"
                              onClick={async () => {
                                try {
                                  await api(`/auth/profile-change-requests/${user.pendingProfileChange!.id}`, {
                                    method: "DELETE"
                                  });
                                  notify("success", "资料修改已撤回");
                                  setReviewOpen(false);
                                  await reload();
                                } catch (error) {
                                  notify("error", error instanceof Error ? error.message : "撤回失败");
                                  await reload();
                                }
                              }}
                            >
                              撤回
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {editable && (
                      <button
                        type="button"
                        className="icon-button profile-edit"
                        title={user.pendingProfileChange ? "请先撤回待审修改" : "修改姓名和工号"}
                        aria-label="修改姓名和工号"
                        disabled={Boolean(user.pendingProfileChange)}
                        onClick={() => setIdentityOpen(true)}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                  </div>
                </div>
                <strong>{user.employeeNumber ?? "不适用"}</strong>
              </div>
              <div className="profile-field profile-field-half">
                <div className="profile-field-head">
                  <span>邮箱</span>
                  {editable &&
                    (registrationConfig?.emailEnabled || user.email) && (
                    <button
                      type="button"
                      className="icon-button profile-edit"
                      title="修改邮箱"
                      aria-label="修改邮箱"
                      onClick={() => setEmailOpen(true)}
                    >
                      <Pencil size={15} />
                    </button>
                  )}
                </div>
                <strong title={user.email ?? undefined}>{user.email ?? "未设置"}</strong>
              </div>
              <div className="profile-field profile-field-half profile-id-cell">
                <div className="profile-field-head">
                  <span>账号 ID</span>
                  <button
                    type="button"
                    className="icon-button profile-edit"
                    title="复制账号 ID"
                    aria-label="复制账号 ID"
                    onClick={async () => {
                      try {
                        await copyTextToClipboard(user.id);
                        notify("success", "账号 ID 已复制");
                      } catch {
                        notify("error", "复制失败，请手动选择账号 ID");
                      }
                    }}
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <code title={user.id}>{user.id}</code>
              </div>
            </div>
          </div>

          <div className="profile-section">
            <div className="profile-section-head">
              <div className="profile-section-title">
                <span className="profile-section-icon security">
                  <ShieldCheck size={16} />
                </span>
                <h2>登录与安全</h2>
              </div>
            </div>
            <div className="profile-security-grid">
              <div className="profile-field">
                <div className="profile-field-head">
                  <span>最近登录</span>
                </div>
                <strong>
                  {user.lastLoginAt
                    ? formatChinaFullMinute(user.lastLoginAt)
                    : "暂无记录"}
                </strong>
                {user.lastLoginIp && (
                  <span className="profile-field-meta">IP {user.lastLoginIp}</span>
                )}
              </div>
              <div className="profile-field">
                <div className="profile-field-head">
                  <span>密码</span>
                </div>
                <button
                  type="button"
                  className="secondary-button profile-password-action"
                  onClick={() => setPasswordOpen(true)}
                >
                  <Pencil size={13} />
                  修改密码
                </button>
              </div>
            </div>
          </div>

          <ApiTokenSection notify={notify} />

          {registrationConfig?.emailEnabled && user.email && (
          <div className="profile-section profile-email-preferences">
            <div className="profile-section-head">
              <div className="profile-section-title">
                <span className="profile-section-icon mail">
                  <Mail size={16} aria-hidden="true" />
                </span>
                <h2>邮件通知</h2>
              </div>
              <span
                className="state-chip active profile-required-email"
                tabIndex={0}
                aria-describedby="required-email-detail"
              >
                <ShieldCheck size={13} aria-hidden="true" />
                安全邮件必收
                <span
                  id="required-email-detail"
                  className="profile-required-email-detail"
                  role="tooltip"
                >
                  <ul>
                    <li>验证码与密码重置</li>
                    <li>邮箱或登录信息变更</li>
                    <li>账号安全状态更新</li>
                  </ul>
                </span>
              </span>
            </div>
            <div className="profile-email-preferences-grid">
                {emailPreferenceOptions.map(({ key, label, details }) => (
                  <label className="profile-email-preference" key={key}>
                    <span className="profile-email-preference-label">
                      {label}
                      <Info size={12} aria-hidden="true" />
                    </span>
                    <input
                      type="checkbox"
                      checked={emailPreferences[key]}
                      disabled={emailPreferenceSaving !== null}
                      aria-describedby={`email-preference-${key}-detail`}
                      onChange={(event) =>
                        void updateEmailPreference(key, event.target.checked)
                      }
                    />
                    <i className="profile-email-switch" aria-hidden="true">
                      <i />
                    </i>
                    <span
                      id={`email-preference-${key}-detail`}
                      className="profile-email-preference-detail"
                      role="tooltip"
                    >
                      <ul>
                        {details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </span>
                  </label>
                ))}
              </div>
          </div>
          )}
        </section>
      </div>
      {usernameOpen && (
        <UsernameEditModal
          currentUsername={user.username}
          onClose={() => setUsernameOpen(false)}
          onSaved={async (username) => {
            rememberUsername(username, false);
            setUsernameOpen(false);
            notify("success", "用户名已更新");
            await reload();
          }}
        />
      )}
      {identityOpen && user.employeeNumber && (
        <IdentityEditModal
          displayName={user.displayName}
          employeeNumber={user.employeeNumber}
          registrationPending={user.status !== "ACTIVE"}
          onClose={() => setIdentityOpen(false)}
          onSubmitted={async () => {
            setIdentityOpen(false);
            notify(
              "success",
              user.status === "ACTIVE"
                ? "资料修改已提交审核"
                : "资料已更新，注册信息已重新提交"
            );
            await reload();
          }}
        />
      )}
      {emailOpen && (
        <EmailEditModal
          currentEmail={user.email}
          notify={notify}
          onClose={() => setEmailOpen(false)}
          onSaved={async () => {
            setEmailOpen(false);
            notify("success", "邮箱已更新");
            await reload();
          }}
        />
      )}
      {passwordOpen && (
        <PasswordChangeModal
          username={user.username}
          employeeNumber={user.employeeNumber}
          onClose={() => setPasswordOpen(false)}
          onSaved={async () => {
            setPasswordOpen(false);
            notify("success", "密码已更新");
            await reload();
          }}
        />
      )}
    </>
  );
}

type PersonalApiToken = {
  id: string;
  name: string;
  prefix: string;
  accessLevel: "READ_ONLY" | "READ_WRITE";
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string;
};

function ApiTokenSection({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [tokens, setTokens] = useState<PersonalApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const loadTokens = useCallback(async () => {
    try {
      const result = await api<{
        tokens: PersonalApiToken[];
        maxActiveTokens: number;
      }>("/auth/api-tokens");
      setTokens(result.tokens);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "令牌列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);
  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const tokenState = (token: PersonalApiToken) => {
    if (token.revokedAt) return { label: "已吊销", className: "retiring" };
    if (token.expiresAt && token.expiresAt <= new Date().toISOString()) {
      return { label: "已到期", className: "retiring" };
    }
    return { label: "有效", className: "active" };
  };

  const revoke = async (token: PersonalApiToken) => {
    const confirmed = await dialog.confirm({
      title: "吊销个人访问令牌",
      message: `吊销“${token.name}”后，使用它的 AI 或脚本会立即失去访问权限。`,
      confirmLabel: "吊销令牌",
      tone: "danger"
    });
    if (!confirmed) return;
    try {
      await api(`/auth/api-tokens/${token.id}`, { method: "DELETE" });
      notify("success", "个人访问令牌已吊销");
      await loadTokens();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "令牌吊销失败");
    }
  };

  const activeCount = tokens.filter((token) => tokenState(token).label === "有效").length;
  return (
    <div className="profile-section profile-api-tokens">
      <div className="profile-section-head">
        <div className="profile-section-title">
          <span className="profile-section-icon api-token">
            <KeyRound size={16} />
          </span>
          <div>
            <h2>个人访问令牌</h2>
            <small>供 AI、CLI 和服务端自动化调用官方 API</small>
          </div>
        </div>
        <div className="profile-api-token-actions">
          <a
            className="secondary-button"
            href="/docs/api"
            target="_blank"
            rel="noreferrer"
          >
            API 文档
          </a>
          <button
            type="button"
            className="primary-button"
            disabled={activeCount >= 10}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={14} />
            创建令牌
          </button>
        </div>
      </div>
      {loading ? (
        <div className="mini-empty">正在加载令牌…</div>
      ) : tokens.length ? (
        <div className="profile-api-token-list">
          {tokens.map((token) => {
            const state = tokenState(token);
            return (
              <div className="profile-api-token-row" key={token.id}>
                <div className="profile-api-token-main">
                  <div>
                    <strong>{token.name}</strong>
                    <span className={`state-chip ${state.className}`}>{state.label}</span>
                    <span className="state-chip">
                      {token.accessLevel === "READ_WRITE" ? "读写" : "只读"}
                    </span>
                  </div>
                  <code>{token.prefix}…</code>
                </div>
                <div className="profile-api-token-meta">
                  <span>创建 {formatChinaFullMinute(token.createdAt)}</span>
                  <span>
                    {token.lastUsedAt
                      ? `最近使用 ${formatChinaFullMinute(token.lastUsedAt)}`
                      : "尚未使用"}
                  </span>
                  <span>
                    {token.expiresAt
                      ? `到期 ${formatChinaFullMinute(token.expiresAt)}`
                      : "永不过期"}
                  </span>
                </div>
                {!token.revokedAt && state.label === "有效" && (
                  <button
                    type="button"
                    className="icon-button danger"
                    title="吊销令牌"
                    aria-label={`吊销令牌 ${token.name}`}
                    onClick={() => void revoke(token)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mini-empty">尚未创建个人访问令牌</div>
      )}
      {createOpen && (
        <ApiTokenCreateModal
          notify={notify}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            await loadTokens();
          }}
        />
      )}
    </div>
  );
}

function ApiTokenCreateModal({
  notify,
  onClose,
  onCreated
}: {
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [accessLevel, setAccessLevel] = useState<"READ_ONLY" | "READ_WRITE">(
    "READ_ONLY"
  );
  const [expiry, setExpiry] = useState<"NEVER" | "30" | "90" | "365">("NEVER");
  const [currentPassword, setCurrentPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("请输入令牌名称");
      return;
    }
    if (!currentPassword) {
      setError("请输入当前密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ token: PersonalApiToken; secret: string }>(
        "/auth/api-tokens",
        {
          method: "POST",
          body: jsonBody({
            name: normalizedName,
            accessLevel,
            expiresInDays: expiry === "NEVER" ? null : Number(expiry),
            currentPassword
          })
        }
      );
      setCurrentPassword("");
      setSecret(result.secret);
      await onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "令牌创建失败");
    } finally {
      setBusy(false);
    }
  };

  if (secret) {
    return (
      <Modal title="保存个人访问令牌" onClose={onClose}>
        <div className="api-token-secret-view">
          <div className="context-notice warning">
            <CircleAlert size={15} />
            <span>这是令牌明文唯一一次显示。关闭窗口后无法再次查看，请立即保存到可信的密钥管理工具。</span>
          </div>
          <code>{secret}</code>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={async () => {
                try {
                  await copyTextToClipboard(secret);
                  notify("success", "复制成功");
                } catch {
                  notify("error", "复制失败，请手动选择令牌");
                }
              }}
            >
              <Copy size={14} />
              复制令牌
            </button>
            <button type="button" className="primary-button" onClick={onClose}>
              我已保存
            </button>
          </div>
          {error && <AuthFeedback tone="error">{error}</AuthFeedback>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="创建个人访问令牌" onClose={onClose}>
      <form className="stack-form api-token-create-form" onSubmit={submit}>
        <Field label="令牌名称">
          <input
            autoFocus
            value={name}
            maxLength={80}
            placeholder="例如：AI 排期助手"
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
        </Field>
        <Field label="访问权限">
          <select
            value={accessLevel}
            onChange={(event) =>
              setAccessLevel(event.target.value as "READ_ONLY" | "READ_WRITE")
            }
          >
            <option value="READ_ONLY">只读：查询资源和本人占用</option>
            <option value="READ_WRITE">读写：可预检并提交本人占用操作</option>
          </select>
        </Field>
        <Field label="有效期">
          <select
            value={expiry}
            onChange={(event) =>
              setExpiry(event.target.value as "NEVER" | "30" | "90" | "365")
            }
          >
            <option value="NEVER">永不过期</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">365 天</option>
          </select>
        </Field>
        <Field label="当前密码">
          <PasswordInput
            autoComplete="current-password"
            value={currentPassword}
            maxLength={256}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setError("");
            }}
          />
        </Field>
        {error && <AuthFeedback tone="error" anchored={false}>{error}</AuthFeedback>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>创建令牌</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function profileUsernameError(value: string, currentUsername: string) {
  const username = value.trim().normalize("NFKC");
  const length = Array.from(username).length;
  if (length < 2 || length > 32) return "用户名必须为 2–32 个字符";
  const edge = "[\\p{Script=Han}A-Za-z0-9]";
  const body = "[\\p{Script=Han}A-Za-z0-9._-]";
  if (!new RegExp(`^${edge}${body}*${edge}$`, "u").test(username)) {
    return "用户名仅支持中文、字母、数字、点、下划线和短横线，且首尾须为文字或数字";
  }
  if (username.toLocaleLowerCase("zh-CN") === "administrator") {
    return "该用户名为系统保留名称";
  }
  if (
    username.toLocaleLowerCase("zh-CN") ===
    currentUsername.normalize("NFKC").toLocaleLowerCase("zh-CN")
  ) {
    return "新用户名与当前用户名相同";
  }
  return "";
}

function fieldErrorFromApi(error: unknown, field: string) {
  if (!(error instanceof ApiError) || !error.fieldErrors || typeof error.fieldErrors !== "object") {
    return "";
  }
  const value = (error.fieldErrors as Record<string, unknown>)[field];
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

function validationDetailFromApi(error: unknown, field: string) {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return "";
  const issue = error.details.find(
    (item): item is { path: string; message: string } =>
      Boolean(
        item &&
          typeof item === "object" &&
          "path" in item &&
          item.path === field &&
          "message" in item &&
          typeof item.message === "string"
      )
  );
  return issue?.message ?? "";
}

function UsernameEditModal({
  currentUsername,
  onClose,
  onSaved
}: {
  currentUsername: string;
  onClose: () => void;
  onSaved: (username: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(currentUsername);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const staticError = profileUsernameError(username, currentUsername);
    setError(staticError);
    if (staticError) return;
    setBusy(true);
    try {
      await api("/auth/change-username", {
        method: "POST",
        body: jsonBody({ username })
      });
      await onSaved(username.trim().normalize("NFKC"));
    } catch (caught) {
      const fieldError = fieldErrorFromApi(caught, "username");
      if (fieldError) setError(fieldError);
      else setError(caught instanceof Error ? caught.message : "修改失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="修改用户名" onClose={onClose}>
      <form className="stack-form profile-edit-form" noValidate onSubmit={submit}>
        <label className={`field${error ? " has-error" : ""}`}>
          <span>用户名</span>
          <input
            autoFocus
            name="username"
            autoComplete="username"
            value={username}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setUsername(event.target.value);
              setError("");
            }}
          />
          {error && <AuthFeedback tone="error">{error}</AuthFeedback>}
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>保存</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function IdentityEditModal({
  displayName,
  employeeNumber,
  registrationPending,
  onClose,
  onSubmitted
}: {
  displayName: string;
  employeeNumber: string;
  registrationPending: boolean;
  onClose: () => void;
  onSubmitted: () => Promise<void>;
}) {
  const [name, setName] = useState(displayName);
  const [number, setNumber] = useState(employeeNumber);
  const [errors, setErrors] = useState<{ displayName?: string; employeeNumber?: string }>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    const nextNumber = number.trim().toLowerCase();
    const nextErrors: typeof errors = {};
    if (Array.from(nextName).length < 2 || Array.from(nextName).length > 60) {
      nextErrors.displayName = "姓名必须为 2–60 个字符";
    }
    if (!isEmployeeNumberValid(nextNumber)) {
      nextErrors.employeeNumber = EMPLOYEE_NUMBER_MESSAGE;
    }
    if (nextName === displayName && nextNumber === employeeNumber) {
      nextErrors.displayName = "姓名或工号至少需要修改一项";
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    try {
      await api("/auth/profile-change-requests", {
        method: "POST",
        body: jsonBody({ displayName: nextName, employeeNumber: nextNumber })
      });
      await onSubmitted();
    } catch (caught) {
      const displayNameError = fieldErrorFromApi(caught, "displayName");
      const employeeNumberError = fieldErrorFromApi(caught, "employeeNumber");
      if (displayNameError || employeeNumberError) {
        setErrors({
          ...(displayNameError ? { displayName: displayNameError } : {}),
          ...(employeeNumberError ? { employeeNumber: employeeNumberError } : {})
        });
      } else {
        setErrors({ displayName: caught instanceof Error ? caught.message : "提交失败" });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="修改姓名和工号" onClose={onClose}>
      <form className="stack-form profile-edit-form" noValidate onSubmit={submit}>
        <div className="two-fields">
          <label className={`field${errors.displayName ? " has-error" : ""}`}>
            <span>姓名</span>
            <input
              autoFocus
              name="displayName"
              value={name}
              aria-invalid={Boolean(errors.displayName)}
              onChange={(event) => {
                setName(event.target.value);
                setErrors((current) => ({ ...current, displayName: undefined }));
              }}
            />
            {errors.displayName && <AuthFeedback tone="error">{errors.displayName}</AuthFeedback>}
          </label>
          <label className={`field${errors.employeeNumber ? " has-error" : ""}`}>
            <span>工号</span>
            <input
              name="employeeNumber"
              value={number}
              aria-invalid={Boolean(errors.employeeNumber)}
              onChange={(event) => {
                setNumber(event.target.value.toLowerCase());
                setErrors((current) => ({ ...current, employeeNumber: undefined }));
              }}
            />
            {errors.employeeNumber && <AuthFeedback tone="error">{errors.employeeNumber}</AuthFeedback>}
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>
              {registrationPending ? "保存" : "提交审核"}
            </BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EmailEditModal({
  currentEmail,
  notify,
  onClose,
  onSaved
}: {
  currentEmail: string | null;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [step, setStep] = useState<"EDIT" | "CONFIRM_CLEAR">("EDIT");
  const [email, setEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [registrationConfig, setRegistrationConfig] =
    useState<RegistrationConfigPayload | null>(null);
  const [configError, setConfigError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [currentPasswordError, setCurrentPasswordError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [focusCodeAfterSend, setFocusCodeAfterSend] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const loadConfig = useCallback(async () => {
    const result = await api<RegistrationConfigPayload>(
      "/auth/registration-config"
    );
    setRegistrationConfig({
      ...result,
      allowedEmailDomains: result.allowedEmailDomains.map((item) =>
        item.toLowerCase()
      )
    });
    if (!result.emailEnabled) {
      setEmail("");
      setCode("");
      setChallengeId("");
    }
    setConfigError("");
  }, []);
  useEffect(() => {
    void loadConfig().catch(() =>
      setConfigError("暂时无法加载邮箱规则，请稍后重试。")
    );
  }, [loadConfig]);
  useEffect(() => {
    if (!resendAvailableAt) {
      setResendSeconds(0);
      return;
    }
    const update = () => setResendSeconds(verificationCooldownSeconds(resendAvailableAt));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [resendAvailableAt]);
  useEffect(() => {
    if (!focusCodeAfterSend || !challengeId) return;
    codeRef.current?.focus();
    setFocusCodeAfterSend(false);
  }, [challengeId, focusCodeAfterSend]);

  const emailEnabled = registrationConfig?.emailEnabled ?? false;
  const allowedDomains = registrationConfig?.allowedEmailDomains ?? null;
  const validateCurrentEmail = () => {
    if (!email.trim()) {
      return currentEmail ? "" : "当前账号尚未设置邮箱";
    }
    if (!emailEnabled) return "邮件功能未启用，暂时不能绑定邮箱";
    const normalized = normalizeRegistrationEmail(email);
    const errors = validateEmail(normalized, allowedDomains ?? []);
    if (errors.length) return errors[0];
    if (
      currentEmail &&
      normalized === normalizeRegistrationEmail(currentEmail)
    ) {
      return "新邮箱与当前邮箱相同";
    }
    return "";
  };
  const sendCode = async () => {
    if (!emailEnabled) return;
    const nextError = validateCurrentEmail();
    setEmailError(nextError);
    if (nextError || sending || resendSeconds > 0 || allowedDomains === null) return;
    setSending(true);
    try {
      const result = await api<{ challengeId: string; expiresAt: string }>("/auth/email-change-code", {
        method: "POST",
        body: jsonBody({ email: normalizeRegistrationEmail(email) })
      });
      setChallengeId(result.challengeId);
      setCode("");
      setCodeError("");
      setResendAvailableAt(Date.now() + 60_000);
      setFocusCodeAfterSend(true);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.code === "EMAIL_FEATURE_DISABLED"
      ) {
        await loadConfig().catch(() =>
          setConfigError("暂时无法加载邮箱规则，请稍后重试。")
        );
        return;
      }
      const message = caught instanceof Error ? caught.message : "发送失败";
      if (/邮箱|域名|占用/.test(message)) setEmailError(message);
      else notify("error", message);
    } finally {
      setSending(false);
    }
  };
  const performChange = async ({
    clearing,
    password
  }: {
    clearing: boolean;
    password?: string;
  }) => {
    if (!registrationConfig) return;
    const normalizedEmail = normalizeRegistrationEmail(email);
    setBusy(true);
    try {
      await api("/auth/change-email", {
        method: "POST",
        body: jsonBody({
          email: clearing ? null : normalizedEmail,
          challengeId: clearing ? null : challengeId,
          code: clearing ? null : code,
          clearEmailConfirmed: clearing,
          expectedConfigRevision: registrationConfig.revision,
          ...(clearing ? { currentPassword: password } : {})
        })
      });
      await onSaved();
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.code === "REGISTRATION_CONFIG_CHANGED" ||
          caught.code === "EMAIL_FEATURE_DISABLED")
      ) {
        setStep("EDIT");
        await loadConfig().catch(() =>
          setConfigError("暂时无法加载邮箱规则，请稍后重试。")
        );
        notify("error", "邮件设置已更新，请按当前规则重新确认");
        return;
      }
      const message = caught instanceof Error ? caught.message : "更换失败";
      const passwordMessage = fieldErrorFromApi(caught, "currentPassword");
      const codeMessage = fieldErrorFromApi(caught, "code");
      const emailMessage = fieldErrorFromApi(caught, "email");
      if (passwordMessage) {
        setCurrentPasswordError(passwordMessage);
        setStep("CONFIRM_CLEAR");
      } else if (codeMessage) {
        setCodeError(codeMessage);
        setStep("EDIT");
      } else if (emailMessage) {
        setEmailError(emailMessage);
        setStep("EDIT");
      } else if (/验证码/.test(message)) {
        setCodeError(message);
        setStep("EDIT");
      } else if (/邮箱|域名|占用/.test(message)) {
        setEmailError(message);
        setStep("EDIT");
      } else {
        notify("error", message);
      }
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!registrationConfig) return;
    const normalizedEmail = normalizeRegistrationEmail(email);
    const clearing = !normalizedEmail;
    const nextEmailError = validateCurrentEmail();
    const nextCodeError = clearing
      ? ""
      : /^\d{6}$/.test(code)
        ? challengeId
          ? ""
          : "验证码无效，请重新输入"
        : "请输入6位验证码";
    setEmailError(nextEmailError);
    setCodeError(nextCodeError);
    if (nextEmailError || nextCodeError) return;
    if (clearing) {
      setCurrentPassword("");
      setCurrentPasswordError("");
      setStep("CONFIRM_CLEAR");
      return;
    }
    await performChange({ clearing: false });
  };
  const confirmClear = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentPassword) {
      setCurrentPasswordError("请输入当前密码");
      return;
    }
    await performChange({ clearing: true, password: currentPassword });
  };
  const buttonLabel = verificationButtonLabel({
    sending,
    remainingSeconds: resendSeconds
  });
  return (
    <Modal
      title={step === "CONFIRM_CLEAR" ? "确认清空邮箱" : "修改邮箱"}
      onClose={
        step === "CONFIRM_CLEAR"
          ? () => {
              setStep("EDIT");
              setCurrentPassword("");
              setCurrentPasswordError("");
            }
          : onClose
      }
    >
      {step === "CONFIRM_CLEAR" ? (
        <form
          className="stack-form profile-edit-form"
          noValidate
          onSubmit={confirmClear}
        >
          <AuthFeedback tone="warning" anchored={false}>
            清空邮箱后将无法接收系统邮件提醒，也无法自行通过邮件找回密码。
          </AuthFeedback>
          <label className={`field${currentPasswordError ? " has-error" : ""}`}>
            <span>当前密码</span>
            <PasswordInput
              autoFocus
              name="currentPassword"
              autoComplete="current-password"
              value={currentPassword}
              aria-invalid={Boolean(currentPasswordError)}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                setCurrentPasswordError("");
              }}
            />
            {currentPasswordError && (
              <AuthFeedback tone="error">{currentPasswordError}</AuthFeedback>
            )}
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setStep("EDIT");
                setCurrentPassword("");
                setCurrentPasswordError("");
              }}
            >
              返回
            </button>
            <button className="danger-button" disabled={busy}>
              <BusyButtonContent busy={busy}>确认清空</BusyButtonContent>
            </button>
          </div>
        </form>
      ) : (
        <form className="stack-form profile-edit-form" noValidate onSubmit={submit}>
          {configError && (
            <AuthFeedback tone="error" anchored={false}>
              {configError}
            </AuthFeedback>
          )}
          {currentEmail && (
            <label className="field">
              <span>当前邮箱</span>
              <input readOnly value={currentEmail} />
            </label>
          )}
          {registrationConfig && !emailEnabled && (
            currentEmail ? (
            <AuthFeedback tone="warning" anchored={false}>
              邮件功能未启用，只能清空当前邮箱。
            </AuthFeedback>
          ) : (
            <AuthFeedback tone="warning" anchored={false}>
              邮件功能未启用，当前账号没有可修改的邮箱。
            </AuthFeedback>
          )
          )}
          <label className={`field${emailError ? " has-error" : ""}`}>
            <span>新邮箱（留空表示清空）</span>
            <input
              autoFocus
              type="email"
              name="email"
              autoComplete="email"
              disabled={!emailEnabled}
              value={email}
              aria-invalid={Boolean(emailError)}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError("");
                setCode("");
                setCodeError("");
                setChallengeId("");
              }}
            />
            {emailEnabled && allowedDomains?.length ? (
              <small>仅允许以下邮箱域名：{allowedDomains.join("、")}。</small>
            ) : null}
            {emailError && <AuthFeedback tone="error">{emailError}</AuthFeedback>}
          </label>
          <div className="verification-row">
            <label className={`field${codeError ? " has-error" : ""}`}>
              <span>验证码</span>
              <input
                ref={codeRef}
                name="code"
                inputMode="numeric"
                maxLength={6}
                disabled={!emailEnabled || !email.trim() || !challengeId}
                value={code}
                aria-invalid={Boolean(codeError)}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, ""));
                  setCodeError("");
                }}
              />
              {codeError && <AuthFeedback tone="error">{codeError}</AuthFeedback>}
            </label>
            <button
              type="button"
              className="secondary-button verification-button"
              disabled={
                !emailEnabled ||
                !email.trim() ||
                sending ||
                resendSeconds > 0 ||
                allowedDomains === null ||
                Boolean(configError) ||
                Boolean(validateCurrentEmail())
              }
              onClick={() => void sendCode()}
            >
              {buttonLabel}
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              取消
            </button>
            <button
              className="primary-button"
              disabled={
                busy ||
                Boolean(configError) ||
                !registrationConfig ||
                (!emailEnabled && !currentEmail)
              }
            >
              <BusyButtonContent busy={busy}>确认修改</BusyButtonContent>
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

type PasswordChangeField =
  | "currentPassword"
  | "newPassword"
  | "confirmPassword";

type PasswordChangeErrors = Partial<
  Record<PasswordChangeField, { messages: string[]; checklist?: boolean }>
>;

function PasswordChangeModal({
  title = "修改密码",
  username,
  employeeNumber,
  onClose,
  onSaved
}: {
  title?: string;
  username: string;
  employeeNumber: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [focusedField, setFocusedField] =
    useState<PasswordChangeField | null>(null);
  const [newPasswordCapsLockOn, setNewPasswordCapsLockOn] = useState(false);
  const [errors, setErrors] = useState<PasswordChangeErrors>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordChecks = getPasswordChecks(newPassword, {
    username,
    employeeNumbers: employeeNumber ? [employeeNumber] : []
  });

  const clearErrors = (...fields: PasswordChangeField[]) => {
    setErrors((current) => {
      const next = { ...current };
      let changed = false;
      for (const field of fields) {
        if (!next[field]) continue;
        delete next[field];
        changed = true;
      }
      return changed ? next : current;
    });
    setFormError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setFocusedField(null);
    setFormError("");

    const nextErrors: PasswordChangeErrors = {};
    if (!currentPassword) {
      nextErrors.currentPassword = { messages: ["请输入当前密码"] };
    }
    if (passwordChecks.some((check) => check.met === false)) {
      nextErrors.newPassword = {
        messages: ["请满足全部密码要求"],
        checklist: true
      };
    }
    if (!confirmPassword) {
      nextErrors.confirmPassword = { messages: ["请再次输入新密码"] };
    } else if (confirmPassword !== newPassword) {
      nextErrors.confirmPassword = { messages: ["两次输入的密码不一致"] };
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setBusy(true);
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: jsonBody({ currentPassword, newPassword })
      });
      await onSaved();
    } catch (caught) {
      const currentPasswordError = fieldErrorFromApi(
        caught,
        "currentPassword"
      );
      const newPasswordError =
        fieldErrorFromApi(caught, "newPassword") ||
        fieldErrorFromApi(caught, "password");
      if (currentPasswordError || newPasswordError) {
        setErrors({
          ...(currentPasswordError
            ? {
                currentPassword: {
                  messages: [currentPasswordError]
                }
              }
            : {}),
          ...(newPasswordError
            ? {
                newPassword: {
                  messages: [newPasswordError]
                }
              }
            : {})
        });
      } else {
        setFormError(
          caught instanceof Error ? caught.message : "密码修改失败，请重试"
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const newPasswordError = errors.newPassword;
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="stack-form profile-edit-form profile-password-form"
        noValidate
        onSubmit={submit}
      >
        <AuthFieldShell
          id="change-current-password"
          label="当前密码"
          focused={focusedField === "currentPassword"}
          error={errors.currentPassword?.messages}
        >
          <PasswordInput
            id="change-current-password"
            autoFocus
            name="currentPassword"
            autoComplete="current-password"
            value={currentPassword}
            aria-invalid={Boolean(errors.currentPassword)}
            aria-describedby={
              focusedField !== "currentPassword" && errors.currentPassword
                ? "change-current-password-error"
                : undefined
            }
            onFieldFocus={() => setFocusedField("currentPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "currentPassword" ? null : current
              )
            }
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              clearErrors("currentPassword");
            }}
          />
        </AuthFieldShell>
        <AuthFieldShell
          id="change-new-password"
          label="新密码"
          focused={focusedField === "newPassword"}
          error={newPasswordError?.messages}
          hint={<PasswordChecklist checks={passwordChecks} />}
          hintClassName="password-checklist"
          errorClassName={
            newPasswordError?.checklist ? "password-checklist" : ""
          }
          errorContent={
            newPasswordError?.checklist ? (
              <PasswordChecklist checks={passwordChecks} />
            ) : undefined
          }
          suppressHint={newPasswordCapsLockOn}
        >
          <PasswordInput
            id="change-new-password"
            name="newPassword"
            autoComplete="new-password"
            value={newPassword}
            aria-invalid={Boolean(newPasswordError)}
            aria-describedby={
              focusedField !== "newPassword" && newPasswordError
                ? "change-new-password-error"
                : focusedField === "newPassword" && !newPasswordCapsLockOn
                  ? "change-new-password-hint"
                  : undefined
            }
            onCapsLockChange={setNewPasswordCapsLockOn}
            onFieldFocus={() => setFocusedField("newPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "newPassword" ? null : current
              )
            }
            onChange={(event) => {
              setNewPassword(event.target.value);
              clearErrors("newPassword", "confirmPassword");
            }}
          />
        </AuthFieldShell>
        <AuthFieldShell
          id="change-confirm-password"
          label="确认新密码"
          focused={focusedField === "confirmPassword"}
          error={errors.confirmPassword?.messages}
        >
          <PasswordInput
            id="change-confirm-password"
            name="confirmPassword"
            autoComplete="new-password"
            value={confirmPassword}
            aria-invalid={Boolean(errors.confirmPassword)}
            aria-describedby={
              focusedField !== "confirmPassword" && errors.confirmPassword
                ? "change-confirm-password-error"
                : undefined
            }
            onFieldFocus={() => setFocusedField("confirmPassword")}
            onFieldBlur={() =>
              setFocusedField((current) =>
                current === "confirmPassword" ? null : current
              )
            }
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              clearErrors("confirmPassword");
            }}
          />
        </AuthFieldShell>
        {formError && (
          <AuthFeedback tone="error" anchored={false}>
            {formError}
          </AuthFeedback>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
          >
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            <BusyButtonContent busy={busy}>保存密码</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Topbar({
  user,
  restricted,
  showAdmin,
  page,
  unreadNotificationCount,
  feedbackUnreadCount,
  navigate,
  onLogout
}: {
  user: AuthUser;
  restricted: boolean;
  showAdmin: boolean;
  page: Page;
  unreadNotificationCount: number;
  feedbackUnreadCount: number;
  navigate: (page: Page) => void;
  onLogout: () => void;
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setUserMenuOpen(false);
        (userMenuRef.current?.querySelector(".topbar-user-trigger") as HTMLElement | null)?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [userMenuOpen]);
  const nav = restricted
    ? []
    : [
        { id: "calendar" as const, label: "资源日历", icon: CalendarDays },
        { id: "my" as const, label: "我的占用", icon: Clock3 },
        ...(showAdmin
          ? [{ id: "admin" as const, label: "管理", icon: Settings }]
          : [])
      ];
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-icon"><Boxes size={20} /></div>
        <span>Allocube</span>
      </div>
      <nav className="main-nav">
        {nav.map((item) => (
          <button
            key={item.id}
            className={
              page === item.id || (item.id === "calendar" && page === "resources")
                ? "active"
                : ""
            }
            onClick={() => navigate(item.id)}
          >
            <item.icon size={17} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="topbar-user" ref={userMenuRef}>
        <button
          type="button"
          className={`topbar-user-trigger${userMenuOpen ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={userMenuOpen}
          aria-label={`打开用户菜单${
            unreadNotificationCount
              ? `，${unreadNotificationCount} 条未读通知`
              : ""
          }`}
          onClick={() => setUserMenuOpen((open) => !open)}
        >
          <span className="topbar-avatar-wrap">
            <span className="avatar">{user.displayName.slice(0, 1)}</span>
            {unreadNotificationCount > 0 && (
              <span className="notification-avatar-badge" aria-hidden="true">
                {notificationBadgeText(unreadNotificationCount)}
              </span>
            )}
          </span>
          <span className="topbar-user-copy">
            <strong>{user.displayName}</strong>
            <small>
              {user.role === "SYSTEM_ADMIN"
                ? "系统管理员"
                : `${user.username}${user.employeeNumber ? ` · ${user.employeeNumber}` : ""}`}
            </small>
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        {userMenuOpen && (
          <div className="topbar-user-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              className={page === "profile" ? "active" : ""}
              onClick={() => {
                navigate("profile");
                setUserMenuOpen(false);
              }}
            >
              <UserCheck size={16} />用户信息
            </button>
            {!restricted && (
              <button
                type="button"
                role="menuitem"
                className={page === "announcements" ? "active" : ""}
                onClick={() => {
                  navigate("announcements");
                  setUserMenuOpen(false);
                }}
              >
                <Megaphone size={16} />系统公告
              </button>
            )}
            {!restricted && (
              <button
                type="button"
                role="menuitem"
                className={page === "feedback" ? "active" : ""}
                onClick={() => {
                  navigate("feedback");
                  setUserMenuOpen(false);
                }}
              >
                <MessageSquare size={16} />
                <span>反馈</span>
                {feedbackUnreadCount > 0 && (
                  <span
                    className="notification-menu-indicator"
                    aria-label={`${feedbackUnreadCount} 条反馈未读更新`}
                  >
                    {notificationBadgeText(feedbackUnreadCount)}
                  </span>
                )}
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className={page === "notifications" ? "active" : ""}
              onClick={() => {
                navigate("notifications");
                setUserMenuOpen(false);
              }}
            >
              <Bell size={16} />
              <span>通知</span>
              {unreadNotificationCount > 0 && (
                <span
                  className="notification-menu-indicator"
                  aria-label={`${unreadNotificationCount} 条未读通知`}
                >
                  {notificationBadgeText(unreadNotificationCount)}
                </span>
              )}
            </button>
            <a
              href="/docs"
              role="menuitem"
              onClick={() => setUserMenuOpen(false)}
            >
              <BookOpenText size={16} />文档中心
            </a>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setUserMenuOpen(false);
                onLogout();
              }}
            >
              <LogOut size={16} />退出登录
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function notificationBadgeText(count: number) {
  return count > 99 ? "99+" : String(count);
}

function PasswordBanner({
  onModify,
  onDismiss
}: {
  onModify: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="password-banner">
      <CircleAlert size={17} />
      当前仍在使用初始或恢复密码，建议尽快修改。
      <button onClick={onModify}>现在修改</button>
      <button onClick={onDismiss}>本次稍后提醒</button>
    </div>
  );
}

type CatalogManager = {
  displayName: string;
  employeeNumber: string | null;
};

type CatalogMachine = {
  id: string;
  name: string;
  address: string;
  status: "ACTIVE" | "DISABLED";
  availabilityStatus: "ACTIVE" | "DISABLED" | "MAINTENANCE";
  resourceSummary: string;
  tags: string[];
  managers: CatalogManager[];
  hasAccess: boolean;
  isManager: boolean;
  request: {
    id: string;
    status: "PENDING";
    reason: string;
    createdAt: string;
  } | null;
};

function catalogManagerLabel(manager: CatalogManager) {
  return `${manager.displayName} · ${manager.employeeNumber || "暂无工号"}`;
}

function AdaptiveManagerList({ managers }: { managers: CatalogManager[] }) {
  const popoverId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const labels = useMemo(() => managers.map(catalogManagerLabel), [managers]);
  const [visibleCount, setVisibleCount] = useState(labels.length);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const measure = measureRef.current;
    if (!summary || !measure || !labels.length) return;

    const recalculate = () => {
      const itemWidths = Array.from(
        measure.querySelectorAll<HTMLElement>("[data-manager-measure]")
      ).map((item) => item.getBoundingClientRect().width);
      const overflowButton = measure.querySelector<HTMLElement>(
        "[data-manager-overflow-measure]"
      );
      if (itemWidths.length !== labels.length || !overflowButton) return;

      const nextVisibleCount = calculateVisibleManagerCount(
        summary.clientWidth,
        itemWidths,
        overflowButton.getBoundingClientRect().width,
        10
      );
      setVisibleCount((current) =>
        current === nextVisibleCount ? current : nextVisibleCount
      );
      if (nextVisibleCount === labels.length) setOpen(false);
    };

    recalculate();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(recalculate);
    resizeObserver?.observe(summary);
    if (!resizeObserver) window.addEventListener("resize", recalculate);

    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) recalculate();
    });
    document.fonts?.addEventListener("loadingdone", recalculate);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", recalculate);
      document.fonts?.removeEventListener("loadingdone", recalculate);
    };
  }, [labels]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    []
  );

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const openPopover = () => {
    cancelClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 140);
  };

  if (!labels.length) {
    return (
      <div className="catalog-manager-list">
        <ShieldCheck size={14} />
        <span>管理员</span>
        <em>暂无机器管理员</em>
      </div>
    );
  }

  const hasOverflow = visibleCount < labels.length;

  return (
    <div className="catalog-manager-list">
      <ShieldCheck size={14} />
      <span>管理员</span>
      <div className="catalog-manager-summary" ref={summaryRef}>
        <div className="catalog-manager-visible">
          {labels.slice(0, visibleCount).map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
          {hasOverflow && (
            <div
              className="catalog-manager-overflow"
              onMouseEnter={openPopover}
              onMouseLeave={scheduleClose}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  scheduleClose();
                }
              }}
            >
              <button
                ref={triggerRef}
                type="button"
                className="catalog-manager-count"
                aria-label={`共 ${labels.length} 位管理员，查看完整名单`}
                aria-expanded={open}
                aria-controls={popoverId}
                onFocus={openPopover}
                onClick={openPopover}
              >
                共 {labels.length} 人
              </button>
              {open && (
                <div
                  className="catalog-manager-popover"
                  id={popoverId}
                  role="tooltip"
                  onMouseEnter={cancelClose}
                  onMouseLeave={scheduleClose}
                >
                  <strong>机器管理员</strong>
                  <div>
                    {labels.map((label, index) => (
                      <span key={`${label}-full-${index}`}>{label}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="catalog-manager-measure" aria-hidden="true" ref={measureRef}>
          {labels.map((label, index) => (
            <span data-manager-measure key={`${label}-measure-${index}`}>
              {label}
            </span>
          ))}
          <button
            type="button"
            className="catalog-manager-count"
            data-manager-overflow-measure
            tabIndex={-1}
          >
            共 {labels.length} 人
          </button>
        </div>
      </div>
    </div>
  );
}

function ResourceSummary({
  value,
  className = ""
}: {
  value: string;
  className?: string;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      left: Math.min(window.innerWidth - 340, Math.max(12, rect.left)),
      top: rect.bottom + 7
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <span
        ref={anchorRef}
        className={`resource-summary ${className}`.trim()}
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {value || "尚未配置资源"}
      </span>
      {open && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className="resource-summary-popover"
          style={position}
        >
          {value || "尚未配置资源"}
        </span>,
        document.body
      )}
    </>
  );
}

function ResourceCatalogPage({
  user,
  notify,
  navigate
}: {
  user: AuthUser;
  notify: (kind: "success" | "error", message: string) => void;
  navigate: (page: Page) => void;
}) {
  const dialog = useAppDialog();
  const [machines, setMachines] = useState<CatalogMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<CatalogMachine | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ machines: CatalogMachine[] }>("/machines/catalog");
      setMachines(result.machines);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "机器目录加载失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
    const events = new EventSource("/api/v1/events");
    events.addEventListener("revision", () => void load());
    return () => events.close();
  }, [load]);

  return (
    <div className="page-shell resource-catalog-page">
      <PageHeader
        title="全部资源"
        actions={(
          <button className="secondary-button" onClick={() => navigate("calendar")}>
            <ChevronLeft size={16} />
            返回资源日历
          </button>
        )}
      />
      {loading ? (
        <div className="content-loading"><RefreshCw className="spin" />正在载入</div>
      ) : machines.length ? (
        <div className="resource-catalog-grid">
          {machines.map((machine) => {
            const accessDisplay = resolveCatalogAccessDisplay({
              userRole: user.role,
              isManager: machine.isManager,
              hasAccess: machine.hasAccess,
              hasPendingRequest: Boolean(machine.request)
            });
            return (
              <article
                className="card resource-catalog-card"
                key={machine.id}
              >
                <div className="catalog-machine-icon"><Server size={21} /></div>
                <div className="catalog-machine-copy">
                  <div className="catalog-machine-heading">
                    <h2 title={machine.name}>{machine.name}</h2>
                    <span
                      className={`state-chip ${
                        machine.availabilityStatus === "DISABLED"
                          ? "disabled"
                          : machine.availabilityStatus === "MAINTENANCE"
                            ? "scheduled"
                            : "active"
                      }`}
                    >
                      {machine.availabilityStatus === "DISABLED"
                        ? "停用"
                        : machine.availabilityStatus === "MAINTENANCE"
                          ? "维护"
                          : "启用"}
                    </span>
                  </div>
                  <p title={machine.resourceSummary || "尚未配置资源"}>
                    {machine.resourceSummary || "尚未配置资源"}
                  </p>
                  <div
                    className="catalog-machine-login-ip"
                    title={machine.address || "未填写登录 IP"}
                  >
                    <Globe2 size={13} />
                    <span>登录 IP</span>
                    <code>{machine.address || "未填写"}</code>
                  </div>
                  <AdaptiveManagerList managers={machine.managers} />
                  <div className="tag-row">
                    {machine.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                </div>
                <div className="catalog-card-controls">
                  <span
                    className={`state-chip catalog-access-chip ${accessDisplay.state.toLowerCase()}`}
                  >
                    {accessDisplay.label}
                  </span>
                  {accessDisplay.action === "EXIT" && (
                    <button
                      className="secondary-button compact catalog-card-action danger"
                      onClick={async () => {
                        const confirmation = machine.isManager
                          ? `退出 ${machine.name} 后，你将同时失去管理员身份；进行中和未来占用都会被释放。确定退出？`
                          : `退出 ${machine.name} 后，进行中和未来占用都会被释放。确定退出？`;
                        if (!(await dialog.confirm({
                          title: "退出机器",
                          message: confirmation,
                          confirmLabel: "确认退出",
                          tone: "danger"
                        }))) return;
                        try {
                          await api(`/machines/${machine.id}/membership`, {
                            method: "DELETE"
                          });
                          notify("success", `已退出 ${machine.name}`);
                          await load();
                        } catch (error) {
                          notify(
                            "error",
                            error instanceof Error ? error.message : "退出失败"
                          );
                        }
                      }}
                    >
                      {accessDisplay.actionLabel}
                    </button>
                  )}
                  {accessDisplay.action === "WITHDRAW" && machine.request && (
                    <button
                      className="secondary-button compact catalog-card-action"
                      onClick={async () => {
                        if (!(await dialog.confirm({
                          title: "撤回申请",
                          message: `确认撤回对 ${machine.name} 的使用权申请？`,
                          confirmLabel: "撤回"
                        }))) return;
                        try {
                          await api(`/machine-access/requests/${machine.request!.id}`, {
                            method: "DELETE"
                          });
                          notify("success", "使用权申请已撤回");
                          await load();
                        } catch (error) {
                          notify(
                            "error",
                            error instanceof Error ? error.message : "撤回失败"
                          );
                        }
                      }}
                    >
                      {accessDisplay.actionLabel}
                    </button>
                  )}
                  {accessDisplay.action === "APPLY" && (
                    <button
                      className="primary-button compact catalog-card-action"
                      onClick={() => {
                        setReason("");
                        setRequesting(machine);
                      }}
                    >
                      {accessDisplay.actionLabel}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={Server} title="暂时没有可申请的机器" />
      )}
      {requesting && (
        <Modal title={`申请使用 ${requesting.name}`} onClose={() => setRequesting(null)}>
          <div className="stack-form">
            <Field label="申请理由（选填）">
              <textarea
                rows={5}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <div className="field-counter">{reason.length}/500</div>
            <button
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/machines/${requesting.id}/access-requests`, {
                    method: "POST",
                    body: jsonBody({ reason })
                  });
                  notify("success", "使用权申请已提交");
                  setRequesting(null);
                  await load();
                } catch (error) {
                  notify(
                    "error",
                    error instanceof Error ? error.message : "申请提交失败"
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              提交申请
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CalendarPage({
  user,
  settings,
  notify,
  navigate
}: {
  user: AuthUser;
  settings: DashboardBootstrap["settings"];
  notify: (kind: "success" | "error", message: string) => void;
  navigate: (page: Page) => void;
}) {
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
  const requestedEditReservationId =
    calendarEditRoute.kind === "EDIT"
      ? calendarEditRoute.reservationId
      : "";
  const initialCalendarPreference = useMemo(
    () => readCalendarPreference(),
    []
  );
  const [view, setView] = useState<CalendarView>(initialQuery.view);
  const [date, setDate] = useState(initialQuery.date);
  const [search, setSearch] = useState(initialQuery.search);
  const [debouncedSearch, setDebouncedSearch] = useState(initialQuery.search);
  const [selectedMachine, setSelectedMachine] = useState(
    initialQuery.machineId || initialCalendarPreference.machineId || ""
  );
  const calendarStateRef = useRef({
    ...initialQuery,
    machineId:
      initialQuery.machineId || initialCalendarPreference.machineId || ""
  });
  const initialCalendarRouteAppliedRef = useRef(false);
  const serverDateCorrectionAppliedRef = useRef(false);
  const [machineOptions, setMachineOptions] = useState<
    Array<
      Pick<
        Machine,
        "id" | "name" | "address" | "resourceSummary" | "status" | "tags" | "isManager"
      >
    >
  >([]);
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null);
  const [visibleHours, setVisibleHours] = useState(
    initialCalendarPreference.visibleHours
  );
  const [timelineWindowStartMinutes, setTimelineWindowStartMinutes] = useState(
    () => defaultDayWindowStartMinutes(currentTime)
  );
  const [timelineScrollTarget, setTimelineScrollTarget] = useState(() => ({
    startMinutes: defaultDayWindowStartMinutes(currentTime),
    revision: 0
  }));
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionState, setConnectionState] = useState<
    "CONNECTING" | "CONNECTED" | "DISCONNECTED"
  >("CONNECTING");
  const [reservationMode, setReservationMode] = useState<
    "RESOURCE_GROUP" | "MACHINE"
  >(initialCalendarPreference.reservationMode);
  const [collapsedMachineIds, setCollapsedMachineIds] = useState<Set<string>>(
    () => new Set()
  );
  const [drafts, setDrafts] = useState<CalendarDraft[]>([]);
  const [editingReservation, setEditingReservation] = useState<{
    id: string;
    scope: "RESOURCE_GROUP" | "MACHINE";
    endAt: string;
  } | null>(null);
  const [editingDraftTime, setEditingDraftTime] = useState(false);
  const [metadata, setMetadata] = useState<CalendarMetadata>({
    title: "",
    purpose: "",
    note: ""
  });
  const [previewByDraft, setPreviewByDraft] = useState<
    Map<string, ReservationPreviewItem>
  >(new Map());
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
  const [reservationDetail, setReservationDetail] = useState<{
    item: TimelineReservation;
    machineName: string;
    groupName: string;
    anchor: DOMRect;
  } | null>(null);
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
  const dragAutoScrollFrameRef = useRef<number | null>(null);
  const dragAutoScrollTickRef = useRef<FrameRequestCallback>(() => undefined);
  const requestIdRef = useRef(0);
  const previewRequestIdRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<TimelinePayload | null>(null);
  const timelineFrameRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const timelineHorizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const bookingDrawerRef = useRef<HTMLElement | null>(null);
  const lastAltZoomAtRef = useRef(0);
  const timelineStartMinutesRef = useRef(
    defaultDayWindowStartMinutes(currentTime)
  );
  const loadTimelineRef = useRef<(background?: boolean) => void>(() => undefined);

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

  const stopDragAutoScroll = useCallback(() => {
    if (dragAutoScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(dragAutoScrollFrameRef.current);
    dragAutoScrollFrameRef.current = null;
  }, []);

  dragAutoScrollTickRef.current = () => {
    dragAutoScrollFrameRef.current = null;
    const active = dragState.current;
    const shell = timelineShellRef.current;
    if (!active?.engaged || !shell) return;
    const shellRect = shell.getBoundingClientRect();
    const delta = timelineDragAutoScrollDelta({
      pointer: active.lastX,
      viewportStart: shellRect.left + TIMELINE_RESOURCE_COLUMN_WIDTH,
      viewportEnd: shellRect.left + shell.clientWidth
    });
    if (delta === 0) return;
    const maximum = Math.max(0, shell.scrollWidth - shell.clientWidth);
    const nextScrollLeft = Math.max(
      0,
      Math.min(maximum, shell.scrollLeft + delta)
    );
    if (Math.abs(nextScrollLeft - shell.scrollLeft) < 0.5) return;
    shell.scrollLeft = nextScrollLeft;
    if (timelineHorizontalScrollRef.current) {
      timelineHorizontalScrollRef.current.scrollLeft = nextScrollLeft;
    }
    dragPreviewUpdaterRef.current(active, active.lastX);
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(
      dragAutoScrollTickRef.current
    );
  };

  const startDragAutoScroll = useCallback(() => {
    if (dragAutoScrollFrameRef.current !== null) return;
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(
      dragAutoScrollTickRef.current
    );
  }, []);

  useEffect(() => stopDragAutoScroll, [stopDragAutoScroll]);

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
    writeCalendarPreference({ visibleHours: nextHours });
    setTimelineScrollTarget((current) => ({
      startMinutes: nextStartMinutes,
      revision: current.revision + 1
    }));
  }, [visibleHours]);

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
      ? `calc(${timelineZoom * 100}% - ${
          (timelineZoom - 1) * TIMELINE_RESOURCE_COLUMN_WIDTH
        }px)`
      : "100%";

  const writeCalendarRoute = useCallback(
    (
      next: Partial<{
        date: string;
        view: CalendarView;
        machineId: string;
        search: string;
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
    const machineId = initialCalendarRouteAppliedRef.current
      ? next.machineId
      : next.machineId || initialCalendarPreference.machineId || "";
    initialCalendarRouteAppliedRef.current = true;
    const hydrated = { ...next, machineId };
    calendarStateRef.current = hydrated;
    setDate((current) => (current === next.date ? current : next.date));
    setView((current) => (current === next.view ? current : next.view));
    setSelectedMachine((current) =>
      current === machineId ? current : machineId
    );
    setSearch((current) => (current === next.search ? current : next.search));
  }, [initialCalendarPreference.machineId, routeLocation.searchStr]);

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
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadMachineOptions = useCallback(async () => {
    try {
      const result = await api<{ machines: typeof machineOptions }>(
        "/timeline/machines"
      );
      setMachineOptions(result.machines);
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "机器列表加载失败"
      );
    }
  }, [notify]);

  useEffect(() => {
    if (
      selectedMachine &&
      machineOptions.length > 0 &&
      !machineOptions.some((machine) => machine.id === selectedMachine)
    ) {
      setSelectedMachine("");
      writeCalendarPreference({ machineId: undefined });
      writeCalendarRoute({ machineId: "" }, true);
    }
  }, [machineOptions, selectedMachine, writeCalendarRoute]);

  const loadTimeline = useCallback(async (_background = false) => {
    const requestId = ++requestIdRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    if (timelineRef.current) setRefreshing(true);
    else if (!timelineRef.current) setInitialLoading(true);
    try {
      const requestStartedAt = performance.now();
      const query = new URLSearchParams({
        from: range.from,
        to: range.to,
        ...(selectedMachine ? { machineIds: selectedMachine } : {}),
        ...(debouncedSearch ? { search: debouncedSearch } : {})
      });
      const result = await api<TimelinePayload>(`/timeline?${query}`, {
        signal: controller.signal
      });
      if (requestId !== requestIdRef.current) return;
      synchronizeServerClock(result.serverNow, requestStartedAt);
      timelineRef.current = result;
      setTimeline(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      notify("error", error instanceof Error ? error.message : "时间轴加载失败");
    } finally {
      if (requestId === requestIdRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [
    debouncedSearch,
    notify,
    range.from,
    range.to,
    selectedMachine,
    synchronizeServerClock
  ]);

  useEffect(() => {
    void loadMachineOptions();
  }, [loadMachineOptions]);

  useEffect(() => {
    void loadTimeline(false);
    return () => requestControllerRef.current?.abort();
  }, [loadTimeline]);

  useEffect(() => {
    loadTimelineRef.current = (background = true) => {
      void loadTimeline(background);
    };
  }, [loadTimeline]);

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

  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    events.onopen = () => setConnectionState("CONNECTED");
    events.onerror = () => setConnectionState("DISCONNECTED");
    const reload = () => {
      loadTimelineRef.current(true);
      void loadMachineOptions();
    };
    events.addEventListener("revision", reload);
    return () => {
      events.removeEventListener("revision", reload);
      events.close();
    };
  }, [loadMachineOptions]);

  useEffect(() => {
    if (connectionState !== "DISCONNECTED") return;
    const timer = window.setInterval(() => {
      loadTimelineRef.current(true);
      void loadMachineOptions();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [connectionState, loadMachineOptions]);

  const reservationsByGroup = useMemo(() => {
    const map = new Map<string, TimelineReservation[]>();
    for (const item of timeline?.reservations ?? []) {
      if (item.scope === "MACHINE") continue;
      const bucket = map.get(item.resourceGroupId) ?? [];
      bucket.push(item);
      map.set(item.resourceGroupId, bucket);
    }
    return map;
  }, [timeline]);

  const machineReservationsByMachine = useMemo(() => {
    const map = new Map<string, TimelineReservation[]>();
    for (const item of timeline?.reservations ?? []) {
      if (item.scope !== "MACHINE") continue;
      const bucket = map.get(item.machineId) ?? [];
      bucket.push(item);
      map.set(item.machineId, bucket);
    }
    return map;
  }, [timeline]);

  const unavailabilityByGroup = useMemo(() => {
    const map = new Map<string, UnavailabilityWindow[]>();
    for (const item of timeline?.unavailability ?? []) {
      if (!item.resourceGroupId) continue;
      const bucket = map.get(item.resourceGroupId) ?? [];
      bucket.push(item);
      map.set(item.resourceGroupId, bucket);
    }
    return map;
  }, [timeline]);

  const machineUnavailability = useMemo(() => {
    const map = new Map<string, UnavailabilityWindow[]>();
    for (const item of timeline?.unavailability ?? []) {
      if (item.resourceGroupId) continue;
      const bucket = map.get(item.machineId) ?? [];
      bucket.push(item);
      map.set(item.machineId, bucket);
    }
    return map;
  }, [timeline]);

  const groupsByMachine = useMemo(() => {
    const map = new Map<string, Array<Omit<ResourceGroup, "version">>>();
    for (const group of timeline?.groups ?? []) {
      const list = map.get(group.machineId) ?? [];
      list.push(group);
      map.set(group.machineId, list);
    }
    return map;
  }, [timeline]);

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
                item.id !== editingReservation?.id
            )
          : [
              ...(reservationsByGroup.get(target.resourceGroupId) ?? []),
              ...(machineReservationsByMachine.get(target.machineId) ?? [])
            ].filter((item) => item.id !== editingReservation?.id);
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
      editingReservation,
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
        : calendarDraftIssues(drafts, settings, currentTime),
    [currentTime, drafts, editingDraftTime, settings]
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
    [currentTime, drafts, editingDraftTime, settings]
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
          ? "已跳过过去或被占用的部分，并保留可用时段"
          : `已跳过过去或被占用的部分，并保留 ${projection.available.length} 个可用时段`
      );
    }
    invalidatePreview();
  };

  const resetReservationDetailsState = () => {
    setDrafts([]);
    setEditingReservation(null);
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

  const requestEditingReservation = async (item: TimelineReservation) => {
    if (!item.mine || new Date(item.endAt).getTime() <= currentTime) return;
    if (
      requestedEditReservationId === item.id &&
      editingReservation?.id === item.id
    ) {
      setReservationDetail(null);
      return;
    }
    if (
      (drafts.length || editingReservation) &&
      !(await dialog.confirm({
        title: "开始编辑占用",
        message: "当前未提交的占用草稿将被替换，原占用仍会保留到你提交修改为止。",
        confirmLabel: "继续编辑"
      }))
    ) {
      return;
    }
    setReservationDetail(null);
    void calendarRouteNavigate({
      href: calendarUrlWithEditRequest(routeLocation.searchStr, item.id),
      replace: true
    });
  };

  const activateEditingReservation = (item: TimelineReservation) => {
    const currentMinute = currentMinuteStart(currentTime);
    const startAt =
      new Date(item.startAt).getTime() < new Date(currentMinute).getTime()
        ? currentMinute
        : item.startAt;
    if (
      minuteDifference(startAt, item.endAt) < settings.minBookingMinutes
    ) {
      notify("error", "该占用剩余时间过短，无法进入编辑状态");
      return false;
    }
    setReservationMode(item.scope);
    setEditingReservation({
      id: item.id,
      scope: item.scope,
      endAt: item.endAt
    });
    setDrafts([
      {
        id: createClientId(),
        scope: item.scope,
        machineId: item.machineId,
        resourceGroupId: item.resourceGroupId,
        startMode:
          new Date(startAt).getTime() <= new Date(currentMinute).getTime()
            ? "IMMEDIATE"
            : "SCHEDULED",
        startAt,
        endAt: item.endAt
      }
    ]);
    setMetadata({
      title: item.title ?? "",
      purpose: item.purpose ?? "",
      note: item.note ?? ""
    });
    setEditingDraftTime(false);
    setPreviewByDraft(new Map());
    setReservationDetail(null);
    window.requestAnimationFrame(() => {
      if (bookingDrawerRef.current) bookingDrawerRef.current.scrollTop = 0;
    });
    return true;
  };

  useEffect(() => {
    if (!timeline) return;
    if (calendarEditRoute.kind === "NONE") {
      if (editingReservation) resetReservationDetailsState();
      return;
    }
    if (calendarEditRoute.kind === "INVALID") {
      if (editingReservation) resetReservationDetailsState();
      notify("error", "占用编辑地址无效");
      void calendarRouteNavigate({
        href: calendarUrlWithoutEditRequest(routeLocation.searchStr),
        replace: true
      });
      return;
    }
    const reservationId = calendarEditRoute.reservationId;
    if (editingReservation?.id === reservationId) return;
    const item = timeline.reservations.find(
      (reservation) => reservation.id === reservationId
    );
    if (
      !item ||
      !item.mine ||
      new Date(item.endAt).getTime() <= currentTime
    ) {
      if (editingReservation) resetReservationDetailsState();
      notify("error", "该占用已经结束或无法修改");
      void calendarRouteNavigate({
        href: calendarUrlWithoutEditRequest(routeLocation.searchStr),
        replace: true
      });
      return;
    }
    if (!activateEditingReservation(item)) {
      void calendarRouteNavigate({
        href: calendarUrlWithoutEditRequest(routeLocation.searchStr),
        replace: true
      });
    }
  }, [
    calendarRouteNavigate,
    calendarEditRoute,
    currentTime,
    editingReservation,
    notify,
    routeLocation.searchStr,
    settings.minBookingMinutes,
    timeline,
  ]);

  useEffect(() => {
    if (editingDraftTime) return;
    const currentMinute = currentMinuteStart(currentTime);
    const originalEnded =
      Boolean(editingReservation) &&
      new Date(editingReservation!.endAt).getTime() <=
        new Date(currentMinute).getTime();
    if (!drafts.length) {
      if (originalEnded) {
        setEditingReservation(null);
        void calendarRouteNavigate({
          href: calendarUrlWithoutEditRequest(routeLocation.searchStr),
          replace: true
        });
        setMetadata({ title: "", purpose: "", note: "" });
        setPreviewByDraft(new Map());
        notify("success", "原占用已结束，本次编辑已结束");
      }
      return;
    }
    const advanced = advanceCalendarDrafts(
      drafts,
      currentMinute,
      settings.minBookingMinutes
    );
    const merged = advanced.changed
      ? mergeCalendarDrafts(
          advanced.drafts,
          [],
          () => createClientId(),
          currentMinute
        )
      : advanced.drafts;
    if (advanced.changed) {
      setDrafts(merged);
      setPreviewByDraft(new Map());
      if (!originalEnded && merged.length < drafts.length) {
        notify(
          "success",
          merged.length
            ? "部分未提交时段已经结束并被移除"
            : "未提交的占用时段已结束"
        );
      }
    }
    if (originalEnded) {
      setEditingReservation(null);
      void calendarRouteNavigate({
        href: calendarUrlWithoutEditRequest(routeLocation.searchStr),
        replace: true
      });
      setPreviewByDraft(new Map());
      notify(
        "success",
        merged.length
          ? "原占用已结束，剩余时段已转为新的占用草稿"
          : "原占用已结束，本次编辑已结束"
      );
    }
    if (!merged.length) {
      setMetadata({ title: "", purpose: "", note: "" });
    }
  }, [
    currentTime,
    calendarRouteNavigate,
    drafts,
    editingReservation,
    editingDraftTime,
    notify,
    routeLocation.searchStr,
    settings.minBookingMinutes
  ]);

  const clearReservationDetailsWithConfirmation = async () => {
    if (
      (drafts.length || editingReservation) &&
      !(await dialog.confirm({
        title: editingReservation ? "放弃编辑" : "清空占用详情",
        message: editingReservation
          ? "当前修改不会提交，原占用将保持不变。"
          : "当前未提交的占用时段和填写内容将被清除。",
        confirmLabel: editingReservation ? "确认放弃" : "确认清空",
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
          ? "该时段内机器已有资源被占用"
          : "所选时段已被占用，没有可加入的空闲片段"
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
          ? "已跳过过去或被占用的部分，并保留可用时段"
          : `已跳过过去或被占用的部分，并保留 ${projection.available.length} 个可用时段`
      );
    }
    return true;
  };

  const runPreview = useCallback(async (silent = false) => {
    if (!drafts.length || draftIssues.length) return new Map<string, ReservationPreviewItem>();
    const previewRequestId = ++previewRequestIdRef.current;
    setPreviewing(true);
    try {
      const requestStartedAt = performance.now();
      const segments = drafts.map((draft) => reservationInput(draft, metadata));
      const result = await api<{
        items: ReservationPreviewItem[];
        serverNow: string;
      }>(
        "/reservations/preview",
        {
          method: "POST",
          body: jsonBody({
            segments,
            ...(editingReservation
              ? { replaceReservationId: editingReservation.id }
              : {})
          })
        }
      );
      synchronizeServerClock(result.serverNow, requestStartedAt);
      const mapped = previewsByDraftId(drafts, result.items);
      if (previewRequestId === previewRequestIdRef.current) {
        setPreviewByDraft(mapped);
      }
      return mapped;
    } catch (error) {
      if (!silent) {
        notify("error", error instanceof Error ? error.message : "预览失败");
      }
      return null;
    } finally {
      if (previewRequestId === previewRequestIdRef.current) {
        setPreviewing(false);
      }
    }
  }, [
    draftIssues.length,
    drafts,
    editingReservation,
    metadata,
    notify,
    synchronizeServerClock
  ]);

  useEffect(() => {
    if (
      !drafts.length ||
      draftIssues.length ||
      editingDraftTime ||
      submitting
    ) {
      return;
    }
    previewRequestIdRef.current += 1;
    setPreviewing(false);
    setPreviewByDraft(new Map());
    const timer = window.setTimeout(() => {
      void runPreview(true);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    draftIssues.length,
    drafts,
    editingDraftTime,
    runPreview,
    submitting,
    timeline?.revision
  ]);

  const applySplit = () => {
    if (!previewByDraft.size) return;
    const next = splitDrafts(
      drafts,
      previewByDraft,
      () => createClientId()
    );
    setDrafts(next);
    setPreviewByDraft(new Map());
    if (next.length) {
      notify("success", `已生成 ${next.length} 个可用时段，请重新确认`);
    } else {
      notify("error", "目标时间内没有符合最短时长的可用片段");
    }
  };

  const submitDrafts = async () => {
    if (!drafts.length || draftIssues.length) return;
    setSubmitting(true);
    try {
      const checked = await runPreview();
      if (checked === null) return;
      if ([...checked.values()].some((item) => !item.available)) {
        notify("error", "仍有冲突，请调整或自动拆分后再提交");
        return;
      }
      const segments = drafts.map((draft) => reservationInput(draft, metadata));
      const requestStartedAt = performance.now();
      const result = await api<{ serverNow?: string }>("/reservations/batch", {
        method: "POST",
        body: jsonBody({
          segments,
          ...(editingReservation
            ? { replaceReservationId: editingReservation.id }
            : {})
          })
      });
      if (result.serverNow) {
        synchronizeServerClock(result.serverNow, requestStartedAt);
      }
      notify(
        "success",
        editingReservation
          ? `已更新为 ${drafts.length} 条资源占用`
          : `已提交 ${drafts.length} 条资源占用`
      );
      clearReservationDetails();
      await loadTimeline(true);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "提交失败");
      if (error instanceof ApiError && Array.isArray(error.details)) {
        setPreviewByDraft(
          previewsByDraftId(
            drafts,
            error.details as ReservationPreviewItem[]
          )
        );
      }
    } finally {
      setSubmitting(false);
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

  const syncLabel = refreshing
    ? "正在更新"
    : connectionState === "CONNECTED"
      ? "实时同步"
      : connectionState === "CONNECTING"
        ? "正在连接"
        : "同步已断开";

  return (
    <div className="calendar-layout composer-open">
      <section className="calendar-main">
        <PageHeader
          title="资源日历"
          actions={(
            <div className="calendar-header-actions">
              <button className="secondary-button" onClick={() => navigate("resources")}>
                <Server size={16} />全部资源
              </button>
            </div>
          )}
        />
        <div className="calendar-utility-row">
          <div className="calendar-title-status">
            <div
              className={`server-clock${serverClockReady ? "" : " synchronizing"}`}
              title={formatChina(new Date(currentTime).toISOString(), {
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
              <span>服务器时间</span>
              <strong>
                {serverClockReady
                  ? formatChina(new Date(currentTime).toISOString(), {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false
                    })
                  : "同步中"}
              </strong>
            </div>
            <div className={`live-state ${connectionState.toLowerCase()}${refreshing ? " refreshing" : ""}`}>
              <span />{syncLabel}
            </div>
          </div>
          <div
            className="calendar-wheel-hint"
            title="左键拖动：新增占用；右键拖动或 Ctrl + 左键拖动：删除草稿时段；滚轮：上下滚动；Shift + 滚轮：左右滚动；Alt + 滚轮：缩放时间轴"
            aria-label="时间轴操作：鼠标左键拖动新增占用，鼠标右键拖动或 Control 加鼠标左键拖动删除草稿时段，滚轮上下滚动，Shift 加滚轮左右滚动，Alt 加滚轮缩放"
          >
            <span><MouseLeftButtonIcon />拖动 新增</span>
            <i />
            <span>
              <MouseRightButtonIcon />拖动
              <b>/</b>
              <kbd>Ctrl</kbd>+<MouseLeftButtonIcon />拖动 删除
            </span>
            <i />
            <span><MouseWheelIcon />上下</span>
            <i />
            <span><kbd>Shift</kbd> + <MouseWheelIcon />左右</span>
            <i />
            <span><kbd>Alt</kbd> + <MouseWheelIcon />缩放</span>
          </div>
        </div>
        <div className="toolbar">
          <div className="toolbar-group">
            <button className="icon-button" aria-label="上一时间范围" onClick={() => changeDate(addDays(date, view === "week" ? -7 : -1))}><ChevronLeft size={18} /></button>
            <CalendarDateButton
              date={date}
              today={serverToday}
              label={
                view === "day"
                  ? formatChina(range.from, {
                      year: "numeric",
                      month: "long",
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
            <button className="icon-button" aria-label="下一时间范围" onClick={() => changeDate(addDays(date, view === "week" ? 7 : 1))}><ChevronRight size={18} /></button>
          </div>
          <div className="segmented">
            <button className={view === "day" ? "active" : ""} onClick={() => changeView("day")}>一天</button>
            <button className={view === "week" ? "active" : ""} onClick={() => changeView("week")}>一周</button>
          </div>
          {view === "day" && (
            <div className="segmented reservation-mode">
              <button
                className={reservationMode === "RESOURCE_GROUP" ? "active" : ""}
                disabled={
                  Boolean(editingReservation) ||
                  drafts.some((draft) => draft.scope === "MACHINE")
                }
                title={
                  editingReservation
                    ? "编辑占用时不能更改占用模式"
                    : drafts.length
                      ? "清空当前草稿后可以切换占用模式"
                      : undefined
                }
                onClick={() => {
                  setReservationMode("RESOURCE_GROUP");
                  writeCalendarPreference({
                    reservationMode: "RESOURCE_GROUP"
                  });
                }}
              >
                资源组
              </button>
              <button
                className={reservationMode === "MACHINE" ? "active" : ""}
                disabled={
                  Boolean(editingReservation) ||
                  drafts.some((draft) => draft.scope !== "MACHINE")
                }
                title={
                  editingReservation
                    ? "编辑占用时不能更改占用模式"
                    : drafts.length
                      ? "清空当前草稿后可以切换占用模式"
                      : undefined
                }
                onClick={() => {
                  setReservationMode("MACHINE");
                  writeCalendarPreference({ reservationMode: "MACHINE" });
                }}
              >
                整机
              </button>
            </div>
          )}
          {view === "day" && (
            <div className="timeline-zoom-control" aria-label="时间轴缩放">
              <button
                type="button"
                aria-label="缩小时间轴"
                disabled={visibleHours === 24}
                onClick={() => changeTimelineZoom("OUT")}
              >
                <ZoomOut size={15} />
              </button>
              <span>{visibleHours}小时</span>
              <button
                type="button"
                aria-label="放大时间轴"
                disabled={visibleHours === 6}
                onClick={() => changeTimelineZoom("IN")}
              >
                <ZoomIn size={15} />
              </button>
            </div>
          )}
          <div className="search-box">
            <Search size={16} />
            <input
              aria-label="搜索资源组或标签"
              value={search}
              onChange={(event) => {
                const next = event.target.value;
                setSearch(next);
                writeCalendarRoute({ search: next }, true);
              }}
              placeholder="搜索资源组或标签"
            />
            {search && (
              <button
                type="button"
                className="search-clear-button"
                aria-label="清除搜索"
                title="清除搜索"
                onClick={() => {
                  setSearch("");
                  writeCalendarRoute({ search: "" }, true);
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          <select
            aria-label="筛选机器"
            value={selectedMachine}
            onChange={(event) => {
              setSelectedMachine(event.target.value);
              writeCalendarPreference({
                machineId: event.target.value || undefined
              });
              writeCalendarRoute({ machineId: event.target.value });
            }}
          >
            <option value="">全部机器</option>
            {machineOptions.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
          </select>
          <button className="secondary-button" disabled={refreshing} onClick={() => void loadTimeline(true)}>
            {refreshing ? <RefreshCw size={16} className="spin" /> : <RefreshCw size={16} />}
            刷新
          </button>
        </div>
        <div ref={timelineFrameRef} className="timeline-scroll-frame">
          {initialLoading && !timeline ? (
            <div className="timeline-loading calendar-panel-state">
              <RefreshCw className="spin" />
              正在同步资源状态
            </div>
          ) : !timeline?.machines.length ? (
            <CalendarEmptyState
              icon={Server}
              title="暂无可用资源"
              text="可以前往全部资源查看完整机器列表并申请使用权。"
              onOpenResourceCatalog={() => navigate("resources")}
            />
          ) : !timeline.groups.length ? (
            <CalendarEmptyState
              icon={debouncedSearch ? Search : Server}
              title="没有符合条件的资源组"
              text={
                debouncedSearch
                  ? "可以调整搜索或筛选条件，或前往全部资源查看完整机器列表。"
                  : selectedMachine
                    ? "可以切换机器，或前往全部资源查看完整机器列表。"
                    : "可以前往全部资源查看完整机器列表。"
              }
              onOpenResourceCatalog={() => navigate("resources")}
            />
          ) : view === "week" ? (
            <CalendarWeekOverview
              timeline={timeline}
              range={range}
              today={serverToday}
              refreshing={refreshing}
              onSelectDay={(selectedDate) => changeView("day", selectedDate)}
            />
          ) : (
            <>
          <div
            ref={timelineShellRef}
            className={`timeline-scroll-shell ${view}`}
            onScroll={handleTimelineScroll}
          >
            <div className="timeline-card" style={{ width: timelineCardWidth }}>
          <div className="timeline-head">
            <div className="resource-head">
              <span>资源组</span>
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
                  className={`machine-strip${machineCollapsed ? " collapsed" : ""}`}
                  aria-expanded={!machineCollapsed}
                  aria-controls={machineContentsId}
                  aria-label={`${machineCollapsed ? "展开" : "收起"}${machine.name}的资源组`}
                  onClick={() => {
                    setCollapsedMachineIds((current) => {
                      const next = new Set(current);
                      if (next.has(machine.id)) next.delete(machine.id);
                      else next.add(machine.id);
                      return next;
                    });
                    setHoveredTime(null);
                    setDragPreview(null);
                  }}
                >
                  <span className="machine-strip-main">
                    <ChevronDown className="machine-collapse-icon" size={15} />
                    <Server size={16} />
                    <strong>{machine.name}</strong>
                    <code>{machine.address}</code>
                    <span className="machine-group-count">
                      {machineGroups.length} 组
                    </span>
                    <CalendarMachineTags tags={machine.tags} />
                  </span>
                  <span className="machine-strip-summary">
                    <span
                      className={`state-chip ${
                        machine.status === "DISABLED"
                          ? "disabled"
                          : machineMaintenanceNow
                            ? "scheduled"
                            : "active"
                      }`}
                    >
                      {machine.status === "DISABLED"
                        ? "停用"
                        : machineMaintenanceNow
                          ? "维护"
                          : "启用"}
                    </span>
                    <span className="machine-resource-summary">
                      {machine.resourceSummary || "尚未配置资源"}
                    </span>
                  </span>
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
                    if (item.id !== editingReservation?.id) return [item];
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
                      className={`timeline-row${longTermDisabled ? " long-term-disabled" : ""}`}
                      key={group.id}
                    >
                      <div className="resource-cell">
                        <span className="resource-copy">
                          <strong>{group.name}</strong>
                          <ResourceSummary value={group.resourceSummary} />
                        </span>
                        <span
                          className={`state-chip ${
                            longTermDisabled
                              ? "disabled"
                              : groupMaintenanceNow
                                ? "scheduled"
                                : "active"
                          }`}
                        >
                          {longTermDisabled
                            ? "停用"
                            : groupMaintenanceNow
                              ? "维护"
                              : "启用"}
                        </span>
                      </div>
                      <div
                        className={`time-track${!selectable ? " not-selectable" : ""}${longTermDisabled ? " long-term-disabled" : ""}`}
                        title={
                          !selectable
                            ? machine.status !== "ACTIVE"
                              ? "机器当前停用"
                              : group.status !== "ACTIVE"
                                ? "资源组当前停用"
                                : reservationMode === "MACHINE"
                                  ? "机器内存在停用的资源组，当前不能整机占用"
                                  : undefined
                            : undefined
                        }
                        onPointerDown={(event) => {
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
                                ? "机器已停用"
                                : "资源组已停用"}
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
                        {visibleResourceWindows.map((item) => {
                          const isDisableHistory =
                            item.sources[0]?.window.kind === "LONG_TERM";
                          const onlySource =
                            item.sources.length === 1
                              ? item.sources[0]
                              : null;
                          const label =
                            item.sources.length > 1
                              ? `${isDisableHistory ? "停用" : "维护"} · ${item.sources.length}项`
                              : onlySource?.window.reason ||
                                (onlySource?.scope === "MACHINE"
                                  ? isDisableHistory
                                    ? "整机停用"
                                    : "整机维护"
                                  : isDisableHistory
                                    ? "资源组停用"
                                    : "资源组维护");
                          return (
                          <TimelineBar
                            key={`${group.id}-${item.startAt}-${item.endAt}-${item.sources.map((source) => source.window.id).join("-")}`}
                            start={item.startAt}
                            end={item.endAt}
                            range={range}
                            className={`unavailability-bar${isDisableHistory ? " disable-history-bar" : ""}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setReservationDetail(null);
                              setUnavailabilityDetail({
                                item,
                                machineName: machine.name,
                                groupName: group.name,
                                anchor:
                                  event.currentTarget.getBoundingClientRect()
                              });
                            }}
                          >
                            <PowerOff className="unavailability-icon" size={11} />
                            <span className="booking-bar-copy">
                              <span>{label}</span>
                              {view === "day" && (
                                <small>
                                  {formatTimelineDayPeriod(
                                    item.startAt,
                                    item.endAt,
                                    range
                                  )}
                                </small>
                              )}
                            </span>
                          </TimelineBar>
                          );
                        })}
                        {visibleReservations.map((item) => (
                          <TimelineBar
                            key={item.id}
                            start={item.startAt}
                            end={item.endAt}
                            range={range}
                            className={`${item.mine ? "booking-bar mine" : "booking-bar"}${item.scope === "MACHINE" ? " machine-scope" : ""}${item.id === editingReservation?.id ? " editing-history" : ""}`}
                            onClick={
                                  longTermDisabled ||
                                  item.id === editingReservation?.id
                                ? undefined
                                : (event) => {
                                    event.stopPropagation();
                                    setUnavailabilityDetail(null);
                                    setReservationDetail({
                                      item,
                                      machineName: machine.name,
                                      groupName:
                                        item.scope === "MACHINE"
                                          ? `${machine.name} · 整机`
                                          : group.name,
                                      anchor:
                                        event.currentTarget.getBoundingClientRect()
                                    });
                                  }
                            }
                          >
                            <span className="booking-dot" />
                            <span className="booking-bar-copy">
                              <span>
                                {item.scope === "MACHINE" && "整机 · "}
                                {item.applicantName}
                                {item.applicantEmployeeNumber
                                  ? ` · ${item.applicantEmployeeNumber}`
                                  : ""}
                              </span>
                              {view === "day" && (
                                <small>
                                  {formatTimelineDayPeriod(
                                    item.startAt,
                                    item.endAt,
                                    range
                                  )}
                                </small>
                              )}
                            </span>
                          </TimelineBar>
                        ))}
                        {timelineDrafts
                          .filter(
                            (draft) =>
                              draft.startAt < range.to &&
                              draft.endAt > range.from
                          )
                          .map((draft, index) => (
                            <TimelineBar
                              key={`${group.id}-${draft.startAt}-${draft.endAt}-${index}`}
                              start={draft.startAt}
                              end={draft.endAt}
                              range={range}
                              className={`draft-timeline-bar${isDragTarget && dragPreview?.action === "ADD" ? " preview" : ""}${draft.scope === "MACHINE" ? " machine-scope" : ""}`}
                            >
                              <span className="booking-dot" />
                              <span className="booking-bar-copy">
                                <span>
                                  {draft.scope === "MACHINE" && "整机 · "}
                                  {user.displayName}
                                  {user.employeeNumber
                                    ? ` · ${user.employeeNumber}`
                                    : ""}
                                </span>
                                {view === "day" && (
                                  <small>
                                    {formatTimelineDayPeriod(
                                      draft.startAt,
                                      draft.endAt,
                                      range
                                    )}
                                  </small>
                                )}
                              </span>
                            </TimelineBar>
                          ))}
                        {dragPreview &&
                          isDragTarget &&
                          dragPreview.action === "ERASE" && (
                            <TimelineBar
                              start={dragPreview.requested.startAt}
                              end={dragPreview.requested.endAt}
                              range={range}
                              className="drag-erase-bar"
                            >
                              <X size={12} />
                              删除草稿
                            </TimelineBar>
                          )}
                        {dragPreview &&
                          isDragTarget &&
                          dragPreview.action === "ADD" &&
                          dragPreview.blocked && (
                            <TimelineBar
                              start={dragPreview.requested.startAt}
                              end={dragPreview.requested.endAt}
                              range={range}
                              className="drag-blocked-bar"
                            >
                              <CircleAlert size={12} />
                              {dragPreview.target.scope === "MACHINE"
                                ? "机器已有资源被占用"
                                : "已被占用"}
                            </TimelineBar>
                          )}
                      </div>
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
              <RefreshCw size={14} className="spin" />正在更新
            </div>
          )}
            </div>
          </div>
          {view === "day" && visibleHours < 24 && (
            <div className="timeline-horizontal-scroll-row">
              <div
                ref={timelineHorizontalScrollRef}
                className="timeline-horizontal-scroll"
                onScroll={handleTimelineHorizontalScroll}
                aria-label="横向滚动时间轴"
                tabIndex={0}
              >
                <div style={{ width: `${timelineZoom * 100}%` }} />
              </div>
            </div>
          )}
            </>
          )}
        </div>
      </section>
      <aside className="booking-drawer" ref={bookingDrawerRef}>
        <div className="drawer-head">
          <h2>占用详情</h2>
          {(drafts.length > 0 || editingReservation) && (
            <div className="drawer-head-actions">
              <button
                type="button"
                className="drawer-manual-add-button"
                onClick={() => setManualBookingOpen(true)}
              >
                <Plus size={14} />
                新增
              </button>
              <button
                type="button"
                className="drawer-clear-button"
                onClick={() => void clearReservationDetailsWithConfirmation()}
              >
                <X size={14} />
                放弃
              </button>
            </div>
          )}
        </div>
        {!drafts.length && (
          <div className="drawer-empty">
            <Clock3 className="drawer-empty-icon" size={28} />
            <strong>暂无占用时段</strong>
            <p>在日历时间轴上拖动，以添加一段占用。</p>
            <button
              type="button"
              className="secondary-button drawer-add-button"
              onClick={() => setManualBookingOpen(true)}
            >
              <Plus size={14} />
              新增占用
            </button>
          </div>
        )}
        {!!drafts.length && (
          <>
            {editingReservation && (
              <div className="editing-reservation-banner">
                <Pencil size={14} />
                <span>正在编辑占用，原时段会保留到提交成功。</span>
              </div>
            )}
            <div className="selected-summary">
              <span>{new Set(drafts.map(reservationTargetKey)).size}</span>
              <div><strong>个占用目标，{drafts.length} 条占用</strong></div>
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
                    ? `${machine?.name ?? "机器"} · 整机`
                    : group?.name ?? "资源组";
                return (
                  <div
                    className={`draft-card ${
                      fieldIssues?.startAt || fieldIssues?.endAt
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
                          <span className="immediate-start-label">立即开始</span>
                        )}
                      </div>
                      <button
                        className="icon-button tiny"
                        aria-label={`删除 ${targetName} 草稿`}
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
                        : "时间有误"}
                    </div>
                    {result && (
                      result.available
                        ? <span className="status-label success"><Check size={13} />完整时段可用</span>
                        : <span className="status-label danger"><CircleAlert size={13} />{result.conflicts.length} 处冲突</span>
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
            <div className="section-label"><span>占用信息</span></div>
            <CalendarReservationMetadataFields
              values={metadata}
              onChange={(field, value) =>
                setMetadata((current) => ({ ...current, [field]: value }))
              }
            />
              <div className="drawer-actions">
                {[...previewByDraft.values()].some((item) => !item.available) && (
                  <button className="secondary-button accent" onClick={applySplit}><Sparkles size={16} />自动拆分</button>
                )}
                <button className="primary-button" disabled={submitting || previewing || !!draftIssues.length} onClick={() => void submitDrafts()}>
                  {submitting ? <RefreshCw size={16} className="spin" /> : <Check size={16} />}
                  {editingReservation ? "提交修改" : "提交占用"}
                </button>
              </div>
          </>
        )}
      </aside>
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
            onChanged={() => loadTimeline(true)}
            onEdit={() =>
              void requestEditingReservation(reservationDetail.item)
            }
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

function CalendarWeekOverview({
  timeline,
  range,
  today,
  refreshing,
  onSelectDay
}: {
  timeline: TimelinePayload;
  range: { from: string; to: string; startDate: string; days: number };
  today: string;
  refreshing: boolean;
  onSelectDay: (date: string) => void;
}) {
  const days = Array.from({ length: 7 }, (_, index) =>
    addDays(range.startDate, index)
  );
  const groupsByMachine = new Map<
    string,
    Array<Omit<ResourceGroup, "version">>
  >();
  for (const group of timeline.groups) {
    const groups = groupsByMachine.get(group.machineId) ?? [];
    groups.push(group);
    groupsByMachine.set(group.machineId, groups);
  }

  return (
    <div className="week-overview-scroll">
      <div className="week-overview">
        <div className="week-overview-head">
          <strong>资源组</strong>
          {days.map((day) => (
            <button
              type="button"
              key={day}
            className={day === today ? "today" : ""}
              onClick={() => onSelectDay(day)}
            >
              <span>
                {formatChina(chinaLocalToIso(`${day}T00:00`), {
                  month: "numeric",
                  day: "numeric"
                })}
              </span>
              <small>
                {formatChina(chinaLocalToIso(`${day}T00:00`), {
                  weekday: "short"
                })}
              </small>
            </button>
          ))}
        </div>
        {timeline.machines.map((machine) => {
          const groups = groupsByMachine.get(machine.id) ?? [];
          if (!groups.length) return null;
          return (
            <div className="week-machine-block" key={machine.id}>
              <div className="week-machine-strip">
                <Server size={15} />
                <strong>{machine.name}</strong>
                <code>{machine.address}</code>
                <CalendarMachineTags tags={machine.tags} className="week" />
              </div>
              {groups.map((group) => (
                <div className="week-overview-row" key={group.id}>
                  <div className="week-resource-cell">
                    <strong>{group.name}</strong>
                    <ResourceSummary value={group.resourceSummary} />
                  </div>
                  {days.map((day) => {
                    const dayStart = chinaLocalToIso(`${day}T00:00`);
                    const dayEnd = chinaLocalToIso(
                      `${addDays(day, 1)}T00:00`
                    );
                    const reservations = timeline.reservations.filter(
                      (item) =>
                        item.machineId === machine.id &&
                        (item.scope === "MACHINE" ||
                          item.resourceGroupId === group.id) &&
                        item.startAt < dayEnd &&
                        item.endAt > dayStart
                    );
                    const unavailable = timeline.unavailability.filter(
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
                        today={today}
                        dayStart={dayStart}
                        dayEnd={dayEnd}
                        groupName={group.name}
                        reservations={reservations}
                        unavailable={unavailable}
                        onSelect={() => onSelectDay(day)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
        {refreshing && (
          <div className="timeline-refreshing" aria-live="polite">
            <RefreshCw size={14} className="spin" />
            正在更新
          </div>
        )}
      </div>
    </div>
  );
}

function CalendarManualBookingModal({
  mode: initialMode,
  machines,
  groups,
  settings,
  currentTime,
  lockMode = false,
  initialMachineId,
  onClose,
  onAdd
}: {
  mode: "RESOURCE_GROUP" | "MACHINE";
  machines: Machine[];
  groups: Array<Omit<ResourceGroup, "version">>;
  settings: DashboardBootstrap["settings"];
  currentTime: number;
  lockMode?: boolean;
  initialMachineId?: string;
  onClose: () => void;
  onAdd: (
    target: CalendarReservationTarget,
    startAt: string,
    endAt: string
  ) => boolean;
}) {
  const [initialTime] = useState(() => initialReservationTime(currentTime));
  const [mode, setMode] = useState(initialMode);
  const [machineId, setMachineId] = useState(initialMachineId ?? "");
  const [targetId, setTargetId] = useState("");
  const [startAt, setStartAt] = useState(initialTime.start);
  const [endAt, setEndAt] = useState(initialTime.end);
  const [submitted, setSubmitted] = useState(false);
  const machineGroups = new Map<string, typeof groups>();
  for (const group of groups) {
    const list = machineGroups.get(group.machineId) ?? [];
    list.push(group);
    machineGroups.set(group.machineId, list);
  }
  const activeGroups = groups.filter(
    (group) =>
      group.status === "ACTIVE" &&
      machines.some(
        (machine) =>
          machine.id === group.machineId && machine.status === "ACTIVE"
      )
  );
  const groupMachineOptions = machines.filter(
    (machine) =>
      machine.status === "ACTIVE" &&
      activeGroups.some((group) => group.machineId === machine.id)
  );
  const wholeMachineOptions = machines.filter(
    (machine) =>
      machine.status === "ACTIVE" &&
      (machineGroups.get(machine.id)?.length ?? 0) > 0 &&
      machineGroups
        .get(machine.id)!
        .every((group) => group.status === "ACTIVE")
  );
  const availableMachines =
    mode === "RESOURCE_GROUP"
      ? groupMachineOptions
      : wholeMachineOptions;
  const selectedMachineId =
    machineId &&
    availableMachines.some((machine) => machine.id === machineId)
      ? machineId
      : availableMachines[0]?.id ?? "";
  const groupOptions = activeGroups.filter(
    (group) => group.machineId === selectedMachineId
  );
  const selectedResourceGroupId =
    targetId && groupOptions.some((group) => group.id === targetId)
      ? targetId
      : groupOptions[0]?.id ?? "";
  const selectedResourceOptionId =
    mode === "MACHINE" ? "MACHINE" : selectedResourceGroupId;
  const resourceOptions =
    mode === "MACHINE"
      ? [{ id: "MACHINE", label: "整机" }]
      : groupOptions.map((group) => ({ id: group.id, label: group.name }));
  const selectedTargetId =
    mode === "MACHINE" ? selectedMachineId : selectedResourceGroupId;
  const draft: CalendarDraft = {
    id: "manual",
    scope: mode,
    machineId: selectedMachineId,
    resourceGroupId:
      mode === "MACHINE"
        ? activeGroups.find((group) => group.machineId === selectedMachineId)
            ?.id ?? ""
        : selectedResourceGroupId,
    startMode:
      startAt &&
      new Date(chinaLocalToIso(startAt)).getTime() <=
        new Date(currentMinuteStart(currentTime)).getTime()
        ? "IMMEDIATE"
        : "SCHEDULED",
    startAt: startAt ? chinaLocalToIso(startAt) : "",
    endAt: endAt ? chinaLocalToIso(endAt) : ""
  };
  const issues = calendarDraftFieldIssues(draft, settings, currentTime);

  return (
    <Modal title="新增占用" onClose={onClose}>
      <form
        className="stack-form calendar-manual-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!selectedTargetId || issues.startAt || issues.endAt) return;
          onAdd(
            {
              scope: mode,
              machineId: draft.machineId ?? "",
              resourceGroupId: draft.resourceGroupId
            },
            draft.startAt,
            draft.endAt
          );
        }}
      >
        <div className="segmented calendar-manual-mode">
          <button
            type="button"
            className={mode === "RESOURCE_GROUP" ? "active" : ""}
            disabled={lockMode}
            onClick={() => {
              setMode("RESOURCE_GROUP");
              setMachineId("");
              setTargetId("");
              setSubmitted(false);
            }}
          >
            资源组
          </button>
          <button
            type="button"
            className={mode === "MACHINE" ? "active" : ""}
            disabled={lockMode}
            onClick={() => {
              setMode("MACHINE");
              setMachineId("");
              setTargetId("");
              setSubmitted(false);
            }}
          >
            整机
          </button>
        </div>
        <CalendarTargetFields
          machines={availableMachines}
          machineId={selectedMachineId}
          resourceOptions={resourceOptions}
          resourceId={selectedResourceOptionId}
          onMachineChange={(nextMachineId) => {
            setMachineId(nextMachineId);
            setTargetId("");
            setSubmitted(false);
          }}
          onResourceChange={(nextResourceId) => {
            if (mode === "RESOURCE_GROUP") setTargetId(nextResourceId);
            setSubmitted(false);
          }}
        />
        {!availableMachines.length && (
          <div className="auth-form-feedback error" role="alert">
            当前没有可占用的机器
          </div>
        )}
        <Field
          label="开始时间"
          error={submitted ? issues.startAt : undefined}
        >
          <input
            type="datetime-local"
            name="manualStartAt"
            value={startAt}
            onChange={(event) => {
              setStartAt(event.target.value);
              setSubmitted(false);
            }}
          />
        </Field>
        <Field
          label="结束时间"
          error={submitted ? issues.endAt : undefined}
        >
          <input
            type="datetime-local"
            name="manualEndAt"
            value={endAt}
            onChange={(event) => {
              setEndAt(event.target.value);
              setSubmitted(false);
            }}
          />
        </Field>
        <button
          className="primary-button"
          type="submit"
          disabled={!selectedTargetId}
        >
          <Plus size={15} />
          加入占用详情
        </button>
      </form>
    </Modal>
  );
}

function CalendarTargetFields({
  machines,
  machineId,
  resourceOptions,
  resourceId,
  onMachineChange,
  onResourceChange
}: {
  machines: Machine[];
  machineId: string;
  resourceOptions: Array<{ id: string; label: string }>;
  resourceId: string;
  onMachineChange: (machineId: string) => void;
  onResourceChange: (resourceId: string) => void;
}) {
  return (
    <>
      <Field label="机器">
        <select
          value={machineId}
          onChange={(event) => onMachineChange(event.target.value)}
        >
          {machines.map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="资源组">
        <select
          value={resourceId}
          disabled={!machineId}
          onChange={(event) => onResourceChange(event.target.value)}
        >
          {resourceOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function CalendarWeekDayCell({
  day,
  today,
  dayStart,
  dayEnd,
  groupName,
  reservations,
  unavailable,
  onSelect
}: {
  day: string;
  today: string;
  dayStart: string;
  dayEnd: string;
  groupName: string;
  reservations: TimelineReservation[];
  unavailable: UnavailabilityWindow[];
  onSelect: () => void;
}) {
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({
    left: 0,
    top: 0,
    placement: "below" as "above" | "below"
  });
  const from = new Date(dayStart).getTime();
  const to = new Date(dayEnd).getTime();
  const occupiedRanges = mergeTimeRanges(
    reservations.map((item) => ({
      startAt:
        new Date(item.startAt).getTime() < from ? dayStart : item.startAt,
      endAt: new Date(item.endAt).getTime() > to ? dayEnd : item.endAt
    }))
  );
  const occupiedMinutes = occupiedRanges.reduce(
    (sum, item) => sum + minuteDifference(item.startAt, item.endAt),
    0
  );
  const summary = occupiedMinutes
    ? `${(occupiedMinutes / 60).toFixed(1)}小时 · ${reservations.length}段`
    : unavailable.length
      ? "不可用"
      : "空闲";
  const details = [
    ...reservations.map((item) => ({
      id: item.id,
      kind: item.mine ? "mine" as const : "reservation" as const,
      startAt: item.startAt,
      endAt: item.endAt,
      persistent: false,
      label: `${item.applicantName}${
        item.applicantEmployeeNumber
          ? ` · ${item.applicantEmployeeNumber}`
          : ""
      }`
    })),
    ...unavailable.map((item) => ({
      id: item.id,
      kind:
        item.kind === "LONG_TERM"
          ? "disabled" as const
          : "unavailable" as const,
      startAt: item.startAt,
      endAt: item.endAt,
      persistent: item.kind === "LONG_TERM" && item.endAt >= dayEnd,
      label: item.reason || (item.kind === "LONG_TERM" ? "停用" : "维护")
    }))
  ].sort((left, right) => left.startAt.localeCompare(right.startAt));

  const rangeStyle = (startAt: string, endAt: string) => {
    const start = Math.max(from, new Date(startAt).getTime());
    const end = Math.min(to, new Date(endAt).getTime());
    return {
      left: `${((start - from) / (to - from)) * 100}%`,
      width: `${Math.max(1.2, ((end - start) / (to - from)) * 100)}%`
    };
  };

  const updatePopoverPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const containerRect =
      button.closest(".week-overview-scroll")?.getBoundingClientRect() ??
      new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const width = 280;
    const estimatedHeight = Math.min(280, 48 + details.length * 29);
    const placement =
      rect.bottom + estimatedHeight + 10 > window.innerHeight &&
      rect.top > estimatedHeight + 10
        ? "above"
        : "below";
    setPopoverPosition({
      left: Math.min(
        containerRect.right - width - 8,
        Math.max(containerRect.left + 8, rect.left + rect.width / 2 - width / 2)
      ),
      top:
        placement === "above"
          ? Math.max(10, rect.top - estimatedHeight - 8)
          : Math.min(
              window.innerHeight - estimatedHeight - 10,
              rect.bottom + 8
            ),
      placement
    });
  }, [details.length]);

  useLayoutEffect(() => {
    if (!popoverOpen) return;
    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [popoverOpen, updatePopoverPosition]);

  return (
    <>
      <div
        className="week-day-cell"
        onMouseEnter={() => details.length && setPopoverOpen(true)}
        onMouseLeave={() => setPopoverOpen(false)}
      >
        <button
          ref={buttonRef}
          type="button"
          className={`${day === today ? "today" : ""}${
            occupiedMinutes ? " occupied" : ""
          }${unavailable.length ? " unavailable" : ""}`}
          aria-label={`${day} ${groupName}，${summary}，点击查看日视图`}
          aria-describedby={
            popoverOpen && details.length ? tooltipId : undefined
          }
          onFocus={() => details.length && setPopoverOpen(true)}
          onBlur={() => setPopoverOpen(false)}
          onClick={onSelect}
        >
          <span className="week-day-summary">{summary}</span>
          <span className="week-mini-track" aria-hidden="true">
            {unavailable.map((item) => (
              <i
                key={`unavailable-${item.id}`}
                className={
                  item.kind === "LONG_TERM"
                    ? "unavailable disabled"
                    : "unavailable"
                }
                style={rangeStyle(item.startAt, item.endAt)}
              />
            ))}
            {reservations.map((item) => (
              <i
                key={`reservation-${item.id}`}
                className={item.mine ? "mine" : ""}
                style={rangeStyle(item.startAt, item.endAt)}
              />
            ))}
          </span>
        </button>
      </div>
      {popoverOpen &&
        !!details.length &&
        createPortal(
          <div
            id={tooltipId}
            className={`week-day-popover ${popoverPosition.placement}`}
            role="tooltip"
            style={{
              left: popoverPosition.left,
              top: popoverPosition.top
            }}
          >
            <strong>{day} · {groupName}</strong>
            {details.map((item) => (
              <div key={`${item.kind}-${item.id}`}>
                <span className={item.kind} />
                <time>
                  {formatWeekDayDetailPeriod({
                    startAt: item.startAt,
                    endAt: item.endAt,
                    dayStart,
                    dayEnd,
                    persistent: item.persistent
                  })}
                </time>
                <em>{item.label}</em>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

function formatWeekDayDetailPeriod({
  startAt,
  endAt,
  dayStart,
  dayEnd,
  persistent
}: {
  startAt: string;
  endAt: string;
  dayStart: string;
  dayEnd: string;
  persistent: boolean;
}) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const from = new Date(dayStart).getTime();
  const to = new Date(dayEnd).getTime();
  const time = (value: number) =>
    formatChina(new Date(value).toISOString(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

  if (persistent) {
    return start <= from ? "全天停用" : `${time(Math.max(start, from))}–24:00`;
  }

  const startLabel = start <= from ? "00:00" : time(Math.max(start, from));
  const endLabel = end >= to ? "24:00" : time(Math.min(end, to));
  return `${startLabel}–${endLabel}`;
}

function TimelineScale({
  range,
  view,
  visibleHours,
  windowStartMinutes,
  currentTime,
  onSelectDay
}: {
  range: { from: string; to: string; startDate: string; days: number };
  view: CalendarView;
  visibleHours: number;
  windowStartMinutes: number;
  currentTime: number;
  onSelectDay?: (date: string) => void;
}) {
  const marks =
    view === "day"
      ? (() => {
          const start = clampDayWindowStartMinutes(
            windowStartMinutes,
            visibleHours
          );
          const end = start + visibleHours * 60;
          const step =
            visibleHours === 6 ? 30 : visibleHours === 12 ? 60 : 120;
          const minutes = [start];
          for (
            let minute = Math.ceil(start / step) * step;
            minute < end;
            minute += step
          ) {
            if (minute - start >= 30 && end - minute >= 30) {
              minutes.push(minute);
            }
          }
          minutes.push(end);
          return Array.from(new Set(minutes)).map((minute, index) => ({
            key: `${minute}-${index}`,
            label: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
              minute % 60
            ).padStart(2, "0")}`,
            left: (minute / (24 * 60)) * 100,
            date: null
          }));
        })()
      : Array.from({ length: 7 }, (_, index) => {
          const date = addDays(range.startDate, index);
          return {
            key: index,
            label: formatChina(chinaLocalToIso(`${date}T00:00`), { month: "numeric", day: "numeric", weekday: "short" }),
            left: ((index + 0.5) / 7) * 100,
            date
          };
        });
  return (
    <div className={`scale-head ${view}`}>
      {marks.map((mark) =>
        mark.date ? (
          <button
            type="button"
            key={mark.key}
            style={{ left: `${mark.left}%` }}
            onClick={() => onSelectDay?.(mark.date!)}
            aria-label={`查看 ${mark.label} 的日视图`}
          >
            {mark.label}
          </button>
        ) : (
          <span key={mark.key} style={{ left: `${mark.left}%` }}>
            {mark.label}
          </span>
        )
      )}
      <CurrentTimeLine
        range={range}
        currentTime={currentTime}
        showLabel
      />
    </div>
  );
}

function CurrentTimeLine({
  range,
  currentTime,
  showLabel = false
}: {
  range: { from: string; to: string };
  currentTime: number;
  showLabel?: boolean;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (currentTime < from || currentTime >= to || to <= from) return null;
  const left = ((currentTime - from) / (to - from)) * 100;
  return (
    <div
      className={`current-time-line${showLabel ? " with-label" : ""}`}
      style={{ left: `${left}%` }}
      aria-hidden={!showLabel}
    >
      {showLabel && (
        <span>
          {formatChina(new Date(currentTime).toISOString(), {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          })}
        </span>
      )}
    </div>
  );
}

function PastTimeShade({
  range,
  currentTime
}: {
  range: { from: string; to: string };
  currentTime: number;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (currentTime <= from) return null;
  const width =
    currentTime >= to ? 100 : ((currentTime - from) / (to - from)) * 100;
  return (
    <div
      className="past-time-shade"
      style={{ width: `${Math.max(0, Math.min(100, width))}%` }}
      aria-hidden="true"
    />
  );
}

function TimelineHoverGuide({
  range,
  at,
  label
}: {
  range: { from: string; to: string };
  at: string;
  label: string;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const time = new Date(at).getTime();
  if (!Number.isFinite(time) || time < from || time > to || to <= from) {
    return null;
  }
  const left = ((time - from) / (to - from)) * 100;
  return (
    <div
      className="timeline-hover-guide"
      style={{ left: `${left}%` }}
      aria-hidden="true"
    >
      <span>{label}</span>
    </div>
  );
}

function CalendarDateButton({
  date,
  today,
  label,
  onSelect
}: {
  date: string;
  today: string;
  label: string;
  onSelect: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => shiftCalendarMonth(date, 0));
  const [focusedDate, setFocusedDate] = useState(date);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dateButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const dates = calendarMonthDates(month);

  useEffect(() => {
    if (!open) return;
    setMonth(shiftCalendarMonth(date, 0));
    setFocusedDate(date);
    const focusFrame = window.requestAnimationFrame(() =>
      dateButtonRefs.current.get(date)?.focus()
    );
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [date, open]);

  const selectDate = (nextDate: string) => {
    onSelect(nextDate);
    setOpen(false);
  };

  const focusDate = (nextDate: string) => {
    setFocusedDate(nextDate);
    setMonth(nextDate.slice(0, 7) + "-01");
    window.requestAnimationFrame(() =>
      dateButtonRefs.current.get(nextDate)?.focus()
    );
  };

  return (
    <div className="calendar-date-control" ref={rootRef}>
      <button
        type="button"
        className="date-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarDays size={16} />
        {label}
      </button>
      {open && (
        <div
          className="calendar-date-popover"
          role="dialog"
          aria-label="选择日期"
        >
          <div className="calendar-date-popover-head">
            <button
              type="button"
              aria-label="上个月"
              onClick={() =>
                setMonth((current) => shiftCalendarMonth(current, -1))
              }
            >
              <ChevronLeft size={16} />
            </button>
            <strong>{calendarMonthLabel(month)}</strong>
            <button
              type="button"
              aria-label="下个月"
              onClick={() =>
                setMonth((current) => shiftCalendarMonth(current, 1))
              }
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="calendar-date-weekdays" aria-hidden="true">
            {"一二三四五六日".split("").map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="calendar-date-grid">
            {dates.map((item) => {
              const outside = item.slice(0, 7) !== month.slice(0, 7);
              return (
                <button
                  type="button"
                  key={item}
                  ref={(element) => {
                    if (element) dateButtonRefs.current.set(item, element);
                    else dateButtonRefs.current.delete(item);
                  }}
                  className={[
                    outside ? "outside" : "",
                    item === today ? "today" : "",
                    item === date ? "selected" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={item === today ? "date" : undefined}
                  aria-pressed={item === date}
                  aria-label={formatChina(
                    chinaLocalToIso(`${item}T00:00`),
                    {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      weekday: "long"
                    }
                  )}
                  tabIndex={item === focusedDate ? 0 : -1}
                  onFocus={() => setFocusedDate(item)}
                  onKeyDown={(event) => {
                    const offsets: Partial<Record<string, number>> = {
                      ArrowLeft: -1,
                      ArrowRight: 1,
                      ArrowUp: -7,
                      ArrowDown: 7
                    };
                    const offset = offsets[event.key];
                    if (offset) {
                      event.preventDefault();
                      focusDate(addDays(item, offset));
                    } else if (event.key === "PageUp") {
                      event.preventDefault();
                      focusDate(shiftCalendarMonth(item, -1));
                    } else if (event.key === "PageDown") {
                      event.preventDefault();
                      focusDate(shiftCalendarMonth(item, 1));
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectDate(item);
                    }
                  }}
                  onClick={() => selectDate(item)}
                >
                  {Number(item.slice(-2))}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="calendar-date-today"
            onClick={() => selectDate(today)}
          >
            今天
          </button>
        </div>
      )}
    </div>
  );
}

function TrackGrid({
  view,
  visibleHours
}: {
  view: "day" | "week";
  visibleHours: number;
}) {
  const intervalMinutes =
    visibleHours === 6 ? 30 : visibleHours === 12 ? 60 : 120;
  const count = view === "day" ? (24 * 60) / intervalMinutes : 7;
  return <>{Array.from({ length: count + 1 }, (_, index) => <i key={index} style={{ left: `${(index / count) * 100}%` }} />)}</>;
}

function TimelineBar({
  start,
  end,
  range,
  className,
  children,
  onClick
}: {
  start: string;
  end: string;
  range: { from: string; to: string };
  className: string;
  children: React.ReactNode;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    to <= from ||
    endTime <= startTime
  ) {
    return null;
  }
  const left = ((Math.max(from, startTime) - from) / (to - from)) * 100;
  const right = ((Math.min(to, endTime) - from) / (to - from)) * 100;
  const style = {
    left: `${left}%`,
    width: `${Math.max(0.5, right - left)}%`
  };
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        style={style}
        onClick={onClick}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {children}
      </button>
    );
  }
  return <div className={className} style={style}>{children}</div>;
}

function formatTimelineDayPeriod(
  startAt: string,
  endAt: string,
  range: { from: string; to: string }
) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const time = (value: number) =>
    formatChina(new Date(value).toISOString(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  const startLabel = start <= from ? "00:00" : time(start);
  const endLabel = end >= to ? "24:00" : time(end);
  return `${startLabel}–${endLabel}`;
}

function CalendarReservationTimeFields({
  startValue,
  endValue,
  fieldKey,
  readOnly = false,
  className = "calendar-reservation-time-fields",
  onStartBlur,
  onEndBlur,
  onFocusCapture,
  onBlurCapture,
  startError,
  endError
}: {
  startValue: string;
  endValue: string;
  fieldKey: string;
  readOnly?: boolean;
  className?: string;
  onStartBlur?: (value: string) => void;
  onEndBlur?: (value: string) => void;
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
  onBlurCapture?: React.FocusEventHandler<HTMLDivElement>;
  startError?: string;
  endError?: string;
}) {
  return (
    <div
      className={className}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <Field label="开始时间" error={startError}>
        <input
          key={`start-${fieldKey}`}
          type="datetime-local"
          name="startAt"
          defaultValue={startValue}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onBlur={(event) => onStartBlur?.(event.currentTarget.value)}
        />
      </Field>
      <Field label="结束时间" error={endError}>
        <input
          key={`end-${fieldKey}`}
          type="datetime-local"
          name="endAt"
          defaultValue={endValue}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onBlur={(event) => onEndBlur?.(event.currentTarget.value)}
        />
      </Field>
    </div>
  );
}

function CalendarReservationMetadataFields({
  values,
  readOnly = false,
  onChange
}: {
  values: CalendarMetadata;
  readOnly?: boolean;
  onChange?: (field: keyof CalendarMetadata, value: string) => void;
}) {
  return (
    <div className="calendar-reservation-metadata-fields">
      <Field label="标题（选填）">
        <input
          name="title"
          maxLength={120}
          value={values.title}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onChange={(event) => onChange?.("title", event.target.value)}
        />
      </Field>
      <Field label="用途（选填）">
        <textarea
          name="purpose"
          maxLength={500}
          rows={3}
          value={values.purpose}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onChange={(event) => onChange?.("purpose", event.target.value)}
        />
      </Field>
      <Field label="备注（选填）">
        <textarea
          name="note"
          maxLength={1000}
          rows={3}
          value={values.note}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onChange={(event) => onChange?.("note", event.target.value)}
        />
      </Field>
    </div>
  );
}

function CalendarReservationPopover({
  detail,
  currentTime,
  canManage,
  notify,
  onClose,
  onChanged,
  onEdit
}: {
  detail: {
    item: TimelineReservation;
    machineName: string;
    groupName: string;
    anchor: DOMRect;
  };
  currentTime: number;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onEdit: () => void;
}) {
  const { item } = detail;
  const dialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLElement | null>(null);
  const now = currentTime;
  const startTime = new Date(item.startAt).getTime();
  const upcoming = startTime > now;
  const active =
    startTime <= now &&
    new Date(item.endAt).getTime() > now;
  const withinFirstMinute = active && now - startTime < 60_000;
  const canRelease = item.mine || canManage;
  const status = upcoming ? "未开始" : active ? "进行中" : "已结束";
  const popoverWidth = 320;
  const viewportPadding = 12;
  const anchorGap = 8;
  const preferredLeft = detail.anchor.right + anchorGap;
  const left =
    preferredLeft + popoverWidth <= window.innerWidth - viewportPadding
      ? preferredLeft
      : Math.max(
          viewportPadding,
          detail.anchor.left - popoverWidth - anchorGap
        );
  const top = Math.min(
    Math.max(viewportPadding, detail.anchor.top - 8),
    Math.max(viewportPadding, window.innerHeight - 420)
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleViewportChange = () => onClose();
    const handleViewportScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportScroll, true);
    window.requestAnimationFrame(() => popoverRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportScroll, true);
    };
  }, [onClose]);

  const performAction = async (action: "cancel" | "end") => {
    const releasingAnotherUser = !item.mine && canManage;
    const confirmed = await dialog.confirm({
      title: releasingAnotherUser
        ? "释放占用"
        : action === "cancel"
          ? "取消占用"
          : "提前结束占用",
      message:
        releasingAnotherUser
          ? action === "cancel"
            ? "释放后会取消该占用、立即腾出时段，并通知使用人。"
            : withinFirstMinute
              ? "该占用开始不足一分钟，释放后会撤销整条记录并通知使用人。"
              : "释放后会立即腾出剩余时段，并通知使用人。"
          : action === "cancel"
            ? "取消后会立即释放该时段，且无法自动恢复。"
            : withinFirstMinute
              ? "该占用开始不足一分钟，确认后会撤销整条占用记录并立即释放资源。"
              : "结束后会立即释放剩余时段，且无法自动恢复。",
      confirmLabel:
        releasingAnotherUser
          ? "确认释放"
          : action === "cancel"
            ? "确认取消"
            : withinFirstMinute
              ? "确认撤销"
              : "确认结束",
      tone: "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await api<{ message?: string }>(
        `/reservations/${item.id}/${action}`,
        {
          method: "POST",
          body: "{}"
        }
      );
      notify(
        "success",
        releasingAnotherUser
          ? "占用已释放"
          : result.message ??
            (action === "cancel" ? "占用已取消" : "占用已提前结束")
      );
      onClose();
      await onChanged();
    } catch (error) {
      notify(
        "error",
        error instanceof Error
          ? error.message
          : releasingAnotherUser
            ? "释放失败"
            : action === "cancel"
              ? "取消失败"
              : "提前结束失败"
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="reservation-popover-layer"
      onPointerDown={onClose}
    >
      <article
        ref={popoverRef}
        className="reservation-popover"
        role="dialog"
        aria-label="占用详情"
        tabIndex={-1}
        style={{ left, top }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="reservation-popover-head">
          <div>
            <strong>占用详情</strong>
            <span className={`state-chip ${active ? "active" : ""}`}>
              {status}
            </span>
          </div>
          <div className="reservation-popover-actions">
            {item.mine && (upcoming || active) && (
              <button
                className="reservation-popover-action edit"
                type="button"
                disabled={busy}
                aria-label="编辑占用"
                title="编辑占用"
                onClick={onEdit}
              >
                <Pencil size={16} />
              </button>
            )}
            {upcoming && canRelease && (
              <button
                className="reservation-popover-action danger"
                type="button"
                disabled={busy}
                aria-label={item.mine ? "取消占用" : "释放占用"}
                title={item.mine ? "取消占用" : "释放占用"}
                onClick={() => void performAction("cancel")}
              >
                <Trash2 size={16} />
              </button>
            )}
            {active && canRelease && (
              <button
                className="reservation-popover-action danger"
                type="button"
                disabled={busy}
                aria-label={
                  item.mine
                    ? withinFirstMinute
                      ? "撤销占用"
                      : "提前结束"
                    : "释放占用"
                }
                title={
                  item.mine
                    ? withinFirstMinute
                      ? "撤销占用"
                      : "提前结束"
                    : "释放占用"
                }
                onClick={() => void performAction("end")}
              >
                {withinFirstMinute
                  ? <Trash2 size={16} />
                  : <PowerOff size={16} />}
              </button>
            )}
            <button
              className="reservation-popover-action"
              type="button"
              disabled={busy}
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <dl className="reservation-popover-details">
          <div>
            <dt>使用人</dt>
            <dd>
              {item.applicantName}
              {item.applicantEmployeeNumber
                ? ` · ${item.applicantEmployeeNumber}`
                : ""}
            </dd>
          </div>
          <div><dt>机器</dt><dd>{detail.machineName}</dd></div>
          <div><dt>范围</dt><dd>{detail.groupName}</dd></div>
          <div>
            <dt>时间</dt>
            <dd>
              {formatChina(item.startAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
              <span className="reservation-popover-time-separator">至</span>
              {formatChina(item.endAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </dd>
          </div>
          {item.adjustmentType && (
            <div>
              <dt>原始时间</dt>
              <dd>
                {formatChina(item.initialStartAt, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
                <span className="reservation-popover-time-separator">至</span>
                {formatChina(item.initialEndAt, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
              </dd>
            </div>
          )}
        </dl>
        {(item.title || item.purpose || item.note || item.adjustmentReason) && (
          <div className="reservation-popover-content">
            {item.title && <div><span>标题</span><p>{item.title}</p></div>}
            {item.purpose && <div><span>用途</span><p>{item.purpose}</p></div>}
            {item.note && <div><span>备注</span><p>{item.note}</p></div>}
            {item.adjustmentReason && <div><span>调整原因</span><p>{item.adjustmentReason}</p></div>}
          </div>
        )}
      </article>
    </div>
  );
}

function CalendarUnavailabilityPopover({
  detail,
  onClose
}: {
  detail: {
    item: ProjectedUnavailability;
    machineName: string;
    groupName: string;
    anchor: DOMRect;
  };
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLElement | null>(null);
  const isDisableHistory =
    detail.item.sources[0]?.window.kind === "LONG_TERM";
  const popoverWidth = 360;
  const viewportPadding = 12;
  const anchorGap = 8;
  const preferredLeft = detail.anchor.right + anchorGap;
  const left =
    preferredLeft + popoverWidth <= window.innerWidth - viewportPadding
      ? preferredLeft
      : Math.max(
          viewportPadding,
          detail.anchor.left - popoverWidth - anchorGap
        );
  const top = Math.min(
    Math.max(viewportPadding, detail.anchor.top - 8),
    Math.max(viewportPadding, window.innerHeight - 440)
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleViewportChange = () => onClose();
    const handleViewportScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportScroll, true);
    window.requestAnimationFrame(() => popoverRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportScroll, true);
    };
  }, [onClose]);

  return (
    <div className="reservation-popover-layer">
      <article
        ref={popoverRef}
        className={`reservation-popover unavailability-popover${isDisableHistory ? " disable-history-popover" : ""}`}
        style={{ left, top }}
        role="dialog"
        aria-modal="false"
        aria-label={isDisableHistory ? "停用详情" : "维护详情"}
        tabIndex={-1}
      >
        <div className="reservation-popover-head">
          <div>
            <strong>{isDisableHistory ? "停用详情" : "维护详情"}</strong>
            <span
              className={`state-chip ${isDisableHistory ? "disabled" : "scheduled"}`}
            >
              {detail.item.sources.length}项{isDisableHistory ? "记录" : "安排"}
            </span>
          </div>
          <div className="reservation-popover-actions">
            <button
              className="reservation-popover-action"
              type="button"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <dl className="reservation-popover-details">
          <div><dt>机器</dt><dd>{detail.machineName}</dd></div>
          <div><dt>资源组</dt><dd>{detail.groupName}</dd></div>
          <div>
            <dt>有效时间</dt>
            <dd>
              {formatChina(detail.item.startAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
              <span className="reservation-popover-time-separator">至</span>
              {formatChina(detail.item.endAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </dd>
          </div>
        </dl>
        <div className="unavailability-source-list">
          {detail.item.sources.map((source) => (
            <section
              key={`${source.scope}-${source.window.id}`}
              className="unavailability-source-item"
            >
              <div>
                <strong>
                  {source.scope === "MACHINE"
                    ? isDisableHistory
                      ? "整机停用"
                      : "整机维护"
                    : isDisableHistory
                      ? "资源组停用"
                      : "资源组维护"}
                </strong>
              </div>
              <time>
                {formatChina(source.window.startAt, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
                <span>至</span>
                {formatChina(source.window.endAt, {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit"
                })}
              </time>
              <p>{source.window.reason || "未填写原因"}</p>
            </section>
          ))}
        </div>
      </article>
    </div>
  );
}

function initialReservationTime(nowTime: number) {
  const startAt = currentMinuteStart(nowTime);
  const endAt = new Date(
    new Date(startAt).getTime() + 2 * 60 * 60 * 1000
  ).toISOString();
  return {
    start: isoToChinaLocal(startAt),
    end: isoToChinaLocal(endAt)
  };
}

function MyReservationsPage({
  notify,
  onEditReservation
}: {
  notify: (kind: "success" | "error", message: string) => void;
  onEditReservation: (reservation: {
    id: string;
    startAt: string;
    machineId: string;
  }) => void;
}) {
  const dialog = useAppDialog();
  const { currentTime } = useServerClock();
  const [category, setCategory] = useState<"CURRENT" | "HISTORY">("CURRENT");
  const [reservations, setReservations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const reservationResult = await api<{ reservations: any[] }>(
        "/reservations/mine"
      );
      setReservations(reservationResult.reservations);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const categorizedReservations = useMemo(() => {
    const current: any[] = [];
    const history: any[] = [];
    for (const reservation of reservations) {
      const state = bookingState(reservation, currentTime);
      if (state === "进行中" || state === "未开始") {
        current.push(reservation);
      } else {
        history.push(reservation);
      }
    }
    current.sort((left, right) => {
      const leftState = bookingState(left, currentTime);
      const rightState = bookingState(right, currentTime);
      if (leftState !== rightState) return leftState === "进行中" ? -1 : 1;
      return new Date(left.startAt).getTime() - new Date(right.startAt).getTime();
    });
    history.sort(
      (left, right) =>
        new Date(right.endAt).getTime() - new Date(left.endAt).getTime()
    );
    return { current, history };
  }, [currentTime, reservations]);

  const visibleReservations =
    category === "CURRENT"
      ? categorizedReservations.current
      : categorizedReservations.history;

  const action = async (path: string, message: string) => {
    try {
      const result = await api<{ message?: string }>(path, {
        method: "POST",
        body: "{}"
      });
      notify("success", result.message ?? message);
      await load();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <div className="page-shell my-reservations-page">
      <PageHeader title="我的占用" />
      <section className="card reservation-list-panel">
        <div className="reservation-list-toolbar">
          <div
            className="segmented reservation-category-tabs"
            role="tablist"
            aria-label="占用记录分类"
          >
            <button
              type="button"
              role="tab"
              aria-selected={category === "CURRENT"}
              className={category === "CURRENT" ? "active" : ""}
              onClick={() => setCategory("CURRENT")}
            >
              <Clock3 size={16} />
              当前占用
              <span className="reservation-tab-count">
                {categorizedReservations.current.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={category === "HISTORY"}
              className={category === "HISTORY" ? "active" : ""}
              onClick={() => setCategory("HISTORY")}
            >
              <CalendarDays size={16} />
              历史记录
              <span className="reservation-tab-count">
                {categorizedReservations.history.length}
              </span>
            </button>
          </div>
        </div>
        {loading ? (
          <div className="content-loading reservation-list-loading">
            <RefreshCw className="spin" />正在载入
          </div>
        ) : visibleReservations.length ? (
          <div className="booking-table">
            <div className="table-row table-head">
              <span>机器 / 资源组</span>
              <span>占用时间</span>
              <span>占用时长</span>
              <span>占用信息</span>
              <span>状态</span>
              <span />
            </div>
            {visibleReservations.map((item) => {
              const state = bookingState(item, currentTime);
              const endDayOffset = chinaDateDayOffset(
                item.startAt,
                item.endAt
              );
              const withinFirstMinute =
                state === "进行中" &&
                currentTime - new Date(item.startAt).getTime() < 60_000;
              return (
                <div className="table-row" key={item.id}>
                  <div className="resource-title">
                    <span className="machine-glyph"><Server size={17} /></span>
                    <div>
                      <strong>{item.machineName}</strong>
                      <span>{item.resourceGroupName}</span>
                    </div>
                  </div>
                  <div className="time-copy">
                    <strong>{formatChinaDate(item.startAt)}</strong>
                    <span>
                      {formatChina(item.startAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false
                      })}
                      {" — "}
                      {endDayOffset > 0 && `(+${endDayOffset}) `}
                      {formatChina(item.endAt, {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false
                      })}
                    </span>
                    {item.adjustmentType && (
                      <small className="change-note">
                        <PowerOff size={12} />因维护或停用调整
                      </small>
                    )}
                  </div>
                  <div className="reservation-duration">
                    <strong>
                      {durationHoursText(
                        minuteDifference(item.startAt, item.endAt)
                      )}
                    </strong>
                  </div>
                  <div className="booking-copy">
                    <strong>{item.title || "未填写标题"}</strong>
                    <span>{item.purpose || "—"}</span>
                  </div>
                  <span className={`state-chip ${stateClass(state)}`}>{state}</span>
                  <div className="row-actions">
                    {state === "未开始" && (
                      <>
                        <button
                          type="button"
                          className="icon-button tiny reservation-action-button edit"
                          title="修改占用"
                          aria-label="修改占用"
                          onClick={() => onEditReservation(item)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-button tiny reservation-action-button danger"
                          title="取消占用"
                          aria-label="取消占用"
                          onClick={async () => {
                          if (await dialog.confirm({
                            title: "取消占用",
                            message: "确认取消这条占用？取消后该时段会立即释放。",
                            confirmLabel: "确认取消",
                            tone: "danger"
                          })) {
                            await action(`/reservations/${item.id}/cancel`, "占用已取消");
                          }
                        }}>
                          <X size={15} />
                        </button>
                      </>
                    )}
                    {state === "进行中" && (
                      <>
                        <button
                          type="button"
                          className="icon-button tiny reservation-action-button edit"
                          title="修改占用"
                          aria-label="修改占用"
                          onClick={() => onEditReservation(item)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-button tiny reservation-action-button danger"
                          title={withinFirstMinute ? "撤销占用" : "提前结束"}
                          aria-label={withinFirstMinute ? "撤销占用" : "提前结束"}
                          onClick={async () => {
                            if (await dialog.confirm({
                              title: withinFirstMinute
                                ? "撤销占用"
                                : "提前结束占用",
                              message: withinFirstMinute
                                ? "该占用开始不足一分钟，确认后会撤销整条占用记录并立即释放资源。"
                                : "确认现在结束占用并释放剩余时段？",
                              confirmLabel: withinFirstMinute
                                ? "确认撤销"
                                : "提前结束",
                              tone: "danger"
                            })) {
                              await action(`/reservations/${item.id}/end`, "资源已提前释放");
                            }
                          }}
                        >
                          {withinFirstMinute
                            ? <X size={15} />
                            : <PowerOff size={15} />}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="reservation-empty-state">
            <div>
              {category === "CURRENT"
                ? <Clock3 size={24} />
                : <CalendarDays size={24} />}
            </div>
            <h3>
              {category === "CURRENT" ? "暂无当前占用" : "暂无历史记录"}
            </h3>
          </div>
        )}
      </section>
    </div>
  );
}

function bookingState(item: any, now: number) {
  return reservationStatusLabel(item.status, item.startAt, item.endAt, now);
}

function stateClass(state: string) {
  return ({ "未开始": "upcoming", "进行中": "active", "已结束": "done", "已取消": "cancelled", "因维护取消": "cancelled" } as Record<string, string>)[state] ?? "";
}

type FeedbackNotify = (kind: "success" | "error", message: string) => void;

function feedbackMultipart(metadata: unknown, images: File[]) {
  const data = new FormData();
  data.append("metadata", JSON.stringify(metadata));
  for (const image of images) data.append("images", image, image.name);
  return data;
}

const FEEDBACK_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FEEDBACK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const FEEDBACK_IMAGE_MESSAGE_MAX_BYTES = 20 * 1024 * 1024;

function FeedbackImagePicker({
  files,
  onChange,
  onError,
  maxFiles = 5,
  maxTotalBytes = FEEDBACK_IMAGE_MESSAGE_MAX_BYTES,
  compact = false
}: {
  files: File[];
  onChange: (files: File[]) => void;
  onError: (message: string) => void;
  maxFiles?: number;
  maxTotalBytes?: number;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const selectedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const canAdd = files.length < maxFiles && selectedBytes < maxTotalBytes;
  const previews = useMemo(
    () => files.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [files]
  );
  useEffect(
    () => () => previews.forEach((preview) => URL.revokeObjectURL(preview.url)),
    [previews]
  );

  const addFiles = (candidates: File[]) => {
    let next = [...files];
    let rejectedType = false;
    let rejectedSize = false;
    let rejectedCount = false;
    let rejectedTotal = false;
    for (const candidate of candidates) {
      if (!FEEDBACK_IMAGE_TYPES.has(candidate.type)) {
        rejectedType = true;
        continue;
      }
      if (candidate.size <= 0 || candidate.size > FEEDBACK_IMAGE_MAX_BYTES) {
        rejectedSize = true;
        continue;
      }
      if (
        next.some(
          (file) =>
            file.name === candidate.name &&
            file.size === candidate.size &&
            file.lastModified === candidate.lastModified
        )
      ) {
        continue;
      }
      if (next.length >= maxFiles) {
        rejectedCount = true;
        continue;
      }
      if (next.reduce((sum, file) => sum + file.size, 0) + candidate.size > maxTotalBytes) {
        rejectedTotal = true;
        continue;
      }
      next.push(candidate);
    }
    onChange(next);
    if (rejectedType) onError("仅支持 PNG、JPEG 或 WebP 图片");
    else if (rejectedSize) onError("每张图片必须小于等于 5 MB");
    else if (rejectedCount) onError(`最多还能选择 ${Math.max(0, maxFiles - files.length)} 张图片`);
    else if (rejectedTotal) onError("本次图片合计不能超过 20 MB");
  };

  const openPicker = () => {
    if (canAdd) inputRef.current?.click();
  };

  return (
    <div className={`feedback-image-picker${compact ? " compact" : ""}`}>
      <input
        ref={inputRef}
        className="feedback-image-native-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div
        className={`feedback-image-dropzone${dragging ? " dragging" : ""}${canAdd ? "" : " full"}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <span className="feedback-image-dropzone-icon"><Plus size={18} /></span>
        <span className="feedback-image-dropzone-copy">
          <strong>{dragging ? "松开即可添加图片" : compact ? "添加评论图片" : "拖拽图片到这里"}</strong>
          <small>PNG、JPEG、WebP · 单张 5 MB · 合计 20 MB</small>
        </span>
        <button
          type="button"
          className="secondary-button compact"
          disabled={!canAdd}
          onClick={openPicker}
        >
          选择图片
        </button>
      </div>
      {previews.length > 0 && (
        <div className="feedback-selected-images" aria-label="已选择的图片">
          {previews.map(({ file, url }, index) => (
            <div className="feedback-selected-image" key={`${file.name}-${file.lastModified}-${index}`}>
              <img src={url} alt="" />
              <span>
                <strong title={file.name}>{file.name}</strong>
                <small>{feedbackFileSize(file.size)}</small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`移除 ${file.name}`}
                onClick={() => onChange(files.filter((_, fileIndex) => fileIndex !== index))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function feedbackFileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function FeedbackPage({
  feedbackId,
  refreshToken,
  notify,
  onUnreadCountRefresh,
  onOpen,
  onBack
}: {
  feedbackId?: string;
  refreshToken: number;
  notify: FeedbackNotify;
  onUnreadCountRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const load = useCallback(async () => {
    if (feedbackId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(
        `/feedback${params.size ? `?${params}` : ""}`
      );
      setTickets(result.tickets);
      setNextCursor(result.nextCursor);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "反馈加载失败");
    } finally {
      setLoading(false);
    }
  }, [feedbackId, notify, statusFilter, typeFilter]);
  useEffect(() => { void load(); }, [load, refreshToken]);

  if (feedbackId) {
    return (
      <FeedbackDetailView
        id={feedbackId}
        admin={false}
        refreshToken={refreshToken}
        notify={notify}
        onBack={onBack}
        onRead={() => void onUnreadCountRefresh()}
      />
    );
  }

  return (
    <div className="page-shell feedback-page">
      <PageHeader
        title="我的反馈"
        actions={
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={16} />提交反馈
          </button>
        }
      />
      <div className="feedback-filter-bar card">
        <select aria-label="反馈类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
          <option value="">全部类型</option>
          <option value="ISSUE">问题单</option>
          <option value="REQUIREMENT">需求单</option>
        </select>
        <select aria-label="反馈状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(feedbackStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {loading ? (
        <div className="content-loading"><RefreshCw className="spin" />正在载入</div>
      ) : tickets.length ? (
        <>
        <div className="feedback-ticket-list">
          {tickets.map((ticket) => (
            <button type="button" className="card feedback-ticket-card" key={ticket.id} onClick={() => onOpen(ticket.id)}>
              <span className="feedback-ticket-main">
                <span className="feedback-ticket-number">{ticket.displayNumber}</span>
                <span className="feedback-ticket-title-row">
                  <strong>{ticket.title}</strong>
                  <span className="feedback-intrinsic-badges">
                    <FeedbackPill value={ticket.type}>{feedbackTypeLabels[ticket.type]}</FeedbackPill>
                    <FeedbackPill tone="level" value={ticket.level}>{feedbackLevelLabels[ticket.level]}</FeedbackPill>
                  </span>
                </span>
                <small>{formatChina(ticket.updatedAt)} 更新</small>
              </span>
              <span className="feedback-ticket-status">
                <FeedbackPill tone="status" value={ticket.status}>{feedbackStatusLabels[ticket.status]}</FeedbackPill>
                <ChevronRight size={18} />
              </span>
            </button>
          ))}
        </div>
        {nextCursor && (
          <button type="button" className="secondary-button feedback-load-more" onClick={async () => {
            const params = new URLSearchParams({ cursor: nextCursor });
            if (typeFilter) params.set("type", typeFilter);
            if (statusFilter) params.set("status", statusFilter);
            try {
              const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(`/feedback?${params}`);
              setTickets((current) => [...current, ...result.tickets]);
              setNextCursor(result.nextCursor);
            } catch (error) {
              notify("error", error instanceof Error ? error.message : "更多反馈加载失败");
            }
          }}>加载更多</button>
        )}
        </>
      ) : (
        <EmptyState icon={MessageSquare} title="还没有反馈" />
      )}
      {creating && (
        <FeedbackEditorModal
          notify={notify}
          onClose={() => setCreating(false)}
          onSaved={(ticket) => {
            setCreating(false);
            notify("success", "反馈已提交");
            onOpen(ticket.id);
          }}
        />
      )}
    </div>
  );
}

function FeedbackPill({
  children,
  tone = "type",
  value
}: {
  children: React.ReactNode;
  tone?: "type" | "level" | "status";
  value: FeedbackType | FeedbackLevel | FeedbackStatus;
}) {
  return <span className={`feedback-pill ${tone} ${tone}-${value.toLowerCase().replaceAll("_", "-")}`}>{children}</span>;
}

function FeedbackEditorModal({
  ticket,
  notify,
  onClose,
  onSaved
}: {
  ticket?: FeedbackTicketDetail;
  notify: FeedbackNotify;
  onClose: () => void;
  onSaved: (ticket: FeedbackTicketDetail) => void;
}) {
  const editing = Boolean(ticket);
  const [type, setType] = useState<FeedbackType>(ticket?.type ?? "ISSUE");
  const [level, setLevel] = useState<FeedbackLevel>(ticket?.level ?? "NORMAL");
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [bodyMarkdown, setBodyMarkdown] = useState(ticket?.bodyMarkdown ?? feedbackTemplates.ISSUE);
  const [retainedIds, setRetainedIds] = useState(() => new Set(ticket?.attachments.map((item) => item.id) ?? []));
  const [images, setImages] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const changeType = (next: FeedbackType) => {
    setType(next);
    setLevel("NORMAL");
    if (!editing && (bodyMarkdown === feedbackTemplates.ISSUE || bodyMarkdown === feedbackTemplates.REQUIREMENT)) {
      setBodyMarkdown(feedbackTemplates[next]);
    }
  };
  const currentAttachments = ticket?.attachments.filter((item) => retainedIds.has(item.id)) ?? [];
  const totalImages = currentAttachments.length + images.length;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !bodyMarkdown.trim()) return;
    if (totalImages > 5) {
      notify("error", "正文最多包含 5 张图片");
      return;
    }
    setBusy(true);
    try {
      const metadata = editing
        ? { expectedVersion: ticket!.version, level, title, bodyMarkdown, retainedAttachmentIds: currentAttachments.map((item) => item.id) }
        : { type, level, title, bodyMarkdown };
      const result = await api<{ ticket: FeedbackTicketDetail }>(
        editing ? `/feedback/${ticket!.id}` : "/feedback",
        { method: editing ? "PUT" : "POST", body: feedbackMultipart(metadata, images) }
      );
      onSaved(result.ticket);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "反馈保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={editing ? `编辑 ${ticket!.displayNumber}` : "提交反馈"} onClose={onClose} large className="feedback-editor-modal">
      <form className="feedback-editor-form" onSubmit={(event) => void submit(event)}>
        <div className="feedback-editor-scroll">
          <div className="feedback-editor-fields">
            <div className="feedback-editor-row">
              <Field label="类型">
                <select disabled={editing} value={type} onChange={(event) => changeType(event.target.value as FeedbackType)}>
                  <option value="ISSUE">问题单</option>
                  <option value="REQUIREMENT">需求单</option>
                </select>
              </Field>
              <Field label="等级">
                <select value={level} onChange={(event) => setLevel(event.target.value as FeedbackLevel)}>
                  {feedbackLevelsFor(type).map((value) => <option key={value} value={value}>{feedbackLevelLabels[value]}</option>)}
                </select>
              </Field>
            </div>
            <Field label="标题">
              <input autoFocus maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label="正文">
              <textarea maxLength={10000} value={bodyMarkdown} onChange={(event) => setBodyMarkdown(event.target.value)} />
            </Field>
            <div className="field">
              <span>图片（{totalImages}/5）</span>
              <FeedbackImagePicker
                files={images}
                onChange={setImages}
                onError={(message) => notify("error", message)}
                maxFiles={Math.max(0, 5 - currentAttachments.length)}
                maxTotalBytes={Math.max(
                  0,
                  FEEDBACK_IMAGE_MESSAGE_MAX_BYTES -
                    currentAttachments.reduce((sum, attachment) => sum + attachment.byteSize, 0)
                )}
              />
            </div>
            {currentAttachments.length > 0 && (
              <div className="feedback-retained-images">
                {currentAttachments.map((attachment) => (
                  <button type="button" key={attachment.id} onClick={() => setRetainedIds((current) => {
                    const next = new Set(current); next.delete(attachment.id); return next;
                  })}>
                    <img src={attachment.contentUrl} alt="" />
                    <span><X size={13} />移除</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="feedback-editor-preview">
            <strong>预览</strong>
            <AnnouncementMarkdown markdown={bodyMarkdown} />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || !title.trim() || !bodyMarkdown.trim()}>
            <BusyButtonContent busy={busy}>{editing ? "保存修改" : "提交反馈"}</BusyButtonContent>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FeedbackDetailView({
  id,
  admin,
  refreshToken,
  notify,
  onBack,
  onRead
}: {
  id: string;
  admin: boolean;
  refreshToken: number;
  notify: FeedbackNotify;
  onBack: () => void;
  onRead?: () => void;
}) {
  const dialog = useAppDialog();
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const [ticket, setTicket] = useState<FeedbackTicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [commentImages, setCommentImages] = useState<File[]>([]);
  const [commenting, setCommenting] = useState(false);
  const [nextStatus, setNextStatus] = useState<FeedbackStatus | "">("");
  const [processingNote, setProcessingNote] = useState("");
  const [changing, setChanging] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`${admin ? "/admin" : ""}/feedback/${id}`);
      setTicket(result.ticket);
      setNextStatus("");
      onReadRef.current?.();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "反馈加载失败");
    } finally {
      setLoading(false);
    }
  }, [admin, id, notify]);
  useEffect(() => { void load(); }, [load, refreshToken]);

  if (loading) return <div className="content-loading"><RefreshCw className="spin" />正在载入</div>;
  if (!ticket) return <div className="page-shell"><EmptyState icon={CircleAlert} title="反馈不存在" /></div>;

  const withdraw = async () => {
    if (!(await dialog.confirm({ title: "撤回反馈", message: "撤回后反馈将完全只读，且管理员不能恢复。", confirmLabel: "确认撤回", tone: "danger" }))) return;
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`/feedback/${id}/withdraw`, {
        method: "POST", body: jsonBody({ expectedVersion: ticket.version })
      });
      setTicket(result.ticket);
      notify("success", "反馈已撤回");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "撤回失败");
      if (error instanceof ApiError && error.status === 409) void load();
    }
  };

  const submitComment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!comment.trim()) return;
    setCommenting(true);
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`${admin ? "/admin" : ""}/feedback/${id}/comments`, {
        method: "POST", body: feedbackMultipart({ bodyMarkdown: comment }, commentImages)
      });
      setTicket(result.ticket);
      setComment("");
      setCommentImages([]);
      notify("success", "评论已发送");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "评论发送失败");
    } finally {
      setCommenting(false);
    }
  };

  const changeStatus = async () => {
    if (!nextStatus || !processingNote.trim()) return;
    setChanging(true);
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`/admin/feedback/${id}/status`, {
        method: "PUT",
        body: jsonBody({ expectedVersion: ticket.version, status: nextStatus, processingNote })
      });
      setTicket(result.ticket);
      setNextStatus("");
      setProcessingNote("");
      notify("success", "反馈状态已更新");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "状态更新失败");
      if (error instanceof ApiError && error.status === 409) void load();
    } finally {
      setChanging(false);
    }
  };

  const changeLevel = async (level: FeedbackLevel) => {
    if (level === ticket.level) return;
    setChanging(true);
    try {
      const result = await api<{ ticket: FeedbackTicketDetail }>(`/admin/feedback/${id}/level`, {
        method: "PUT", body: jsonBody({ expectedVersion: ticket.version, level })
      });
      setTicket(result.ticket);
      notify("success", "反馈等级已更新");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "等级更新失败");
      if (error instanceof ApiError && error.status === 409) void load();
    } finally {
      setChanging(false);
    }
  };

  return (
    <div className={`page-shell feedback-detail-page${admin ? " admin-feedback-detail" : ""}`}>
      <button type="button" className="feedback-back-button" onClick={onBack}><ChevronLeft size={16} />返回反馈列表</button>
      <section className="card feedback-detail-header">
        <div>
          <span className="feedback-ticket-number">{ticket.displayNumber}</span>
          <div className="feedback-detail-title-row">
            <h1>{ticket.title}</h1>
            <div className="feedback-intrinsic-badges">
              <FeedbackPill value={ticket.type}>{feedbackTypeLabels[ticket.type]}</FeedbackPill>
              <FeedbackPill tone="level" value={ticket.level}>{feedbackLevelLabels[ticket.level]}</FeedbackPill>
            </div>
          </div>
          <p>{ticket.submittedByName} · {formatChina(ticket.createdAt)} 提交</p>
        </div>
        <div className="feedback-detail-status">
          <FeedbackPill tone="status" value={ticket.status}>{feedbackStatusLabels[ticket.status]}</FeedbackPill>
        </div>
        {!admin && (ticket.canEdit || ticket.canWithdraw) && (
          <div className="feedback-detail-actions">
            {ticket.canEdit && <button type="button" className="secondary-button" onClick={() => setEditing(true)}><Pencil size={15} />编辑</button>}
            {ticket.canWithdraw && <button type="button" className="danger-button" onClick={() => void withdraw()}>撤回</button>}
          </div>
        )}
      </section>
      {admin && ticket.status !== "WITHDRAWN" && (
        <section className="card feedback-admin-actions">
          <div>
            <Field label="调整等级">
              <select disabled={changing} value={ticket.level} onChange={(event) => void changeLevel(event.target.value as FeedbackLevel)}>
                {feedbackLevelsFor(ticket.type).map((value) => <option key={value} value={value}>{feedbackLevelLabels[value]}</option>)}
              </select>
            </Field>
          </div>
          <div className="feedback-status-change">
            <Field label="变更状态">
              <select disabled={changing} value={nextStatus} onChange={(event) => setNextStatus(event.target.value as FeedbackStatus)}>
                <option value="">选择新状态</option>
                {feedbackStatusesFor(ticket.type).filter((value) => value !== ticket.status).map((value) => <option key={value} value={value}>{feedbackStatusLabels[value]}</option>)}
              </select>
            </Field>
            <Field label="处理说明">
              <textarea maxLength={10000} value={processingNote} onChange={(event) => setProcessingNote(event.target.value)} />
            </Field>
            <button type="button" className="primary-button" disabled={changing || !nextStatus || !processingNote.trim()} onClick={() => void changeStatus()}>
              <BusyButtonContent busy={changing}>更新状态</BusyButtonContent>
            </button>
          </div>
        </section>
      )}
      <section className="card feedback-current-content">
        <h2>反馈内容</h2>
        <AnnouncementMarkdown markdown={ticket.bodyMarkdown} />
        <FeedbackAttachments attachments={ticket.attachments} />
      </section>
      <section className="feedback-timeline">
        <h2>处理时间线</h2>
        {ticket.activities.map((activity) => (
          <article className="card feedback-activity" key={activity.id}>
            <div className="feedback-activity-marker"><MessageSquare size={15} /></div>
            <div>
              <header>
                <strong>{activity.actorName}</strong>
                <span>{feedbackActivityTitle(activity)}</span>
                <time>{formatChina(activity.createdAt)}</time>
              </header>
              {activity.bodyMarkdown && <AnnouncementMarkdown markdown={activity.bodyMarkdown} />}
              {activity.changedFields.length > 0 && <p className="feedback-changed-fields">已更新：{activity.changedFields.map(feedbackChangedFieldLabel).join("、")}</p>}
              <FeedbackAttachments attachments={activity.attachments} />
            </div>
          </article>
        ))}
      </section>
      {ticket.canComment && (
        <form className="card feedback-comment-form" onSubmit={(event) => void submitComment(event)}>
          <Field label={admin ? "管理员回复" : "追加评论"}>
            <textarea maxLength={10000} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Field>
          <FeedbackImagePicker
            compact
            files={commentImages}
            onChange={setCommentImages}
            onError={(message) => notify("error", message)}
          />
          <div className="feedback-comment-actions">
            <button className="primary-button" disabled={commenting || !comment.trim()}><Send size={15} /><BusyButtonContent busy={commenting}>发送评论</BusyButtonContent></button>
          </div>
        </form>
      )}
      {editing && (
        <FeedbackEditorModal
          ticket={ticket}
          notify={notify}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setTicket(updated); setEditing(false); notify("success", "反馈已更新"); }}
        />
      )}
    </div>
  );
}

function FeedbackAttachments({ attachments }: { attachments: FeedbackAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="feedback-attachments">
      {attachments.map((attachment) => (
        <a key={attachment.id} href={attachment.contentUrl} target="_blank" rel="noreferrer">
          <img src={attachment.contentUrl} alt={attachment.originalName} />
          <span>{attachment.originalName}</span>
        </a>
      ))}
    </div>
  );
}

function feedbackActivityTitle(activity: FeedbackTicketDetail["activities"][number]) {
  if (activity.kind === "CREATED") return "提交了反馈";
  if (activity.kind === "COMMENT") return "追加了评论";
  if (activity.kind === "CONTENT_UPDATED") return "更新了反馈内容";
  if (activity.kind === "WITHDRAWN") return "撤回了反馈";
  if (activity.kind === "STATUS_CHANGED" && activity.toStatus) return `将状态改为“${feedbackStatusLabels[activity.toStatus]}”`;
  if (activity.kind === "LEVEL_CHANGED" && activity.toLevel) return `将等级改为“${feedbackLevelLabels[activity.toLevel]}”`;
  return "更新了反馈";
}

function feedbackChangedFieldLabel(value: string) {
  return ({ title: "标题", bodyMarkdown: "正文", level: "等级", attachments: "图片" } as Record<string, string>)[value] ?? value;
}

function FeedbackAdminPanel({
  feedbackId,
  refreshToken,
  notify,
  onOpen,
  onUnreadCountRefresh
}: {
  feedbackId?: string;
  refreshToken: number;
  notify: FeedbackNotify;
  onOpen: (id?: string) => void;
  onUnreadCountRefresh: () => Promise<void>;
}) {
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [level, setLevel] = useState("");
  const load = useCallback(async () => {
    if (feedbackId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      if (level) params.set("level", level);
      const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(`/admin/feedback${params.size ? `?${params}` : ""}`);
      setTickets(result.tickets);
      setNextCursor(result.nextCursor);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "反馈队列加载失败");
    } finally {
      setLoading(false);
    }
  }, [feedbackId, level, notify, search, status, type]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 180); return () => window.clearTimeout(timer); }, [load, refreshToken]);
  if (feedbackId) {
    return <FeedbackDetailView id={feedbackId} admin refreshToken={refreshToken} notify={notify} onBack={() => onOpen()} onRead={() => void onUnreadCountRefresh()} />;
  }
  return (
    <div className="feedback-admin-page">
      <PageHeader title="反馈处理" />
      <div className="feedback-filter-bar card feedback-admin-filters">
        <label className="feedback-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索编号或标题" /></label>
        <select aria-label="类型" value={type} onChange={(event) => setType(event.target.value)}><option value="">全部类型</option><option value="ISSUE">问题单</option><option value="REQUIREMENT">需求单</option></select>
        <select aria-label="状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(feedbackStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select aria-label="等级" value={level} onChange={(event) => setLevel(event.target.value)}><option value="">全部等级</option>{Object.entries(feedbackLevelLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </div>
      {loading ? <div className="content-loading"><RefreshCw className="spin" />正在载入</div> : tickets.length ? (
        <>
        <div className="card feedback-admin-table">
          {tickets.map((ticket) => (
            <button type="button" key={ticket.id} onClick={() => onOpen(ticket.id)}>
              <span className="feedback-ticket-number">{ticket.displayNumber}</span>
              <span>
                <span className="feedback-ticket-title-row">
                  <strong>{ticket.title}</strong>
                  <span className="feedback-intrinsic-badges">
                    <FeedbackPill value={ticket.type}>{feedbackTypeLabels[ticket.type]}</FeedbackPill>
                    <FeedbackPill tone="level" value={ticket.level}>{feedbackLevelLabels[ticket.level]}</FeedbackPill>
                  </span>
                </span>
                <small>{ticket.submittedByName} · {formatChina(ticket.updatedAt)}</small>
              </span>
              <span className="feedback-ticket-status">
                <FeedbackPill tone="status" value={ticket.status}>{feedbackStatusLabels[ticket.status]}</FeedbackPill>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
        {nextCursor && (
          <button type="button" className="secondary-button feedback-load-more" onClick={async () => {
            const params = new URLSearchParams({ cursor: nextCursor });
            if (search.trim()) params.set("search", search.trim());
            if (type) params.set("type", type);
            if (status) params.set("status", status);
            if (level) params.set("level", level);
            try {
              const result = await api<{ tickets: FeedbackTicketSummary[]; nextCursor: string | null }>(`/admin/feedback?${params}`);
              setTickets((current) => [...current, ...result.tickets]);
              setNextCursor(result.nextCursor);
            } catch (error) {
              notify("error", error instanceof Error ? error.message : "更多反馈加载失败");
            }
          }}>加载更多</button>
        )}
        </>
      ) : <EmptyState icon={MessageSquare} title="没有匹配的反馈" />}
    </div>
  );
}

function NotificationsPage({
  notify,
  onUnreadCountChange,
  onFeedbackUnreadCountChange,
  navigate
}: {
  notify: (kind: "success" | "error", message: string) => void;
  onUnreadCountChange: (count: number) => void;
  onFeedbackUnreadCountChange: (count: number) => void;
  navigate: (path: AppPath) => void;
}) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const markingReadIds = useRef(new Set<string>());
  const load = useCallback(async () => {
    try {
      const result = await api<{
        unreadCount: number;
        feedbackUnreadCount: number;
        notifications: NotificationItem[];
      }>("/notifications");
      setItems(result.notifications);
      setUnreadCount(result.unreadCount);
      onUnreadCountChange(result.unreadCount);
      onFeedbackUnreadCountChange(result.feedbackUnreadCount);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "通知加载失败");
    } finally {
      setLoading(false);
    }
  }, [notify, onFeedbackUnreadCountChange, onUnreadCountChange]);
  useEffect(() => { void load(); }, [load]);

  const markRead = async (item: NotificationItem) => {
    if (item.readAt || markingReadIds.current.has(item.id)) return;
    markingReadIds.current.add(item.id);
    try {
      await api(`/notifications/${item.id}/read`, { method: "POST", body: "{}" });
      const readAt = new Date().toISOString();
      setItems((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, readAt } : candidate
        )
      );
      setUnreadCount((current) => {
        const next = Math.max(0, current - 1);
        onUnreadCountChange(next);
        return next;
      });
      if (item.entityType === "FEEDBACK") {
        const counts = await api<{ unreadCount: number; feedbackUnreadCount: number }>(
          "/notifications/unread-count"
        );
        setUnreadCount(counts.unreadCount);
        onUnreadCountChange(counts.unreadCount);
        onFeedbackUnreadCountChange(counts.feedbackUnreadCount);
      }
    } finally {
      markingReadIds.current.delete(item.id);
    }
  };

  const openDestination = async (
    item: NotificationItem,
    destination: NotificationDestination
  ) => {
    try {
      await markRead(item);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "通知状态更新失败");
    }
    navigate(destination.path);
  };

  const markAllRead = async () => {
    if (!unreadCount || markingAllRead) return;
    setMarkingAllRead(true);
    try {
      const result = await api<{
        updatedCount: number;
        readAt: string;
      }>("/notifications/read-all", {
        method: "POST",
        body: "{}"
      });
      setItems((current) =>
        current.map((item) =>
          item.readAt ? item : { ...item, readAt: result.readAt }
        )
      );
      setUnreadCount(0);
      onUnreadCountChange(0);
      onFeedbackUnreadCountChange(0);
      notify("success", "全部通知已标为已读");
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "通知状态更新失败"
      );
    } finally {
      setMarkingAllRead(false);
    }
  };

  return (
    <div className="page-shell narrow-page">
      <PageHeader
        title="通知中心"
        actions={
          <div className="notification-header-actions">
            <span className="unread-big">
              {unreadCount}
              <small>未读</small>
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                className="secondary-button compact notification-read-all-button"
                disabled={markingAllRead}
                onClick={() => void markAllRead()}
              >
                {markingAllRead
                  ? <RefreshCw size={14} className="spin" />
                  : <Check size={14} />}
                {markingAllRead ? "处理中" : "一键已读"}
              </button>
            )}
          </div>
        }
      />
      {loading ? <div className="content-loading"><RefreshCw className="spin" />正在载入</div> : items.length ? (
        <div className="notification-list card">
          {items.map((item) => {
            const destination = resolveNotificationDestination(item);
            const copy = (
              <div className="notification-copy">
                <div className="notification-title"><strong>{item.title}</strong><span>{formatChina(item.createdAt)}</span></div>
                <p>{item.body}</p>
              </div>
            );
            return (
              <article className={`notification-row ${item.readAt ? "" : "unread"}`} key={item.id}>
                <div className="notification-icon">{notificationIcon(item.type)}</div>
                {destination ? (
                  <button
                    type="button"
                    className="notification-destination"
                    onClick={() => void openDestination(item, destination)}
                  >
                    {copy}
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                ) : copy}
                {!item.readAt && (
                  <button
                    className="secondary-button compact"
                    disabled={markingAllRead}
                    onClick={async () => {
                      try {
                        await markRead(item);
                      } catch (error) {
                        notify(
                          "error",
                          error instanceof Error ? error.message : "通知状态更新失败"
                        );
                      }
                    }}
                  >
                    <Check size={14} />标为已读
                  </button>
                )}
              </article>
            );
          })}
        </div>
      ) : <EmptyState icon={Bell} title="暂时没有通知" />}
    </div>
  );
}

function notificationIcon(type: string) {
  if (type.includes("FEEDBACK")) return <MessageSquare size={18} />;
  if (type.includes("UNAVAILABILITY") || type.includes("DISABLED")) {
    return <PowerOff size={18} />;
  }
  if (type.includes("USER") || type.includes("ACCOUNT")) return <UserCheck size={18} />;
  if (type.includes("WATCH")) return <Bell size={18} />;
  return <Info size={18} />;
}

function AdminPage({
  bootstrap,
  notify,
  tab,
  onTabChange,
  onOpenResourceCatalog,
  machineId,
  machineSection,
  onMachineRoute,
  feedbackId,
  feedbackRefreshToken,
  onFeedbackRoute,
  onUnreadCountRefresh
}: {
  bootstrap: DashboardBootstrap;
  notify: (kind: "success" | "error", message: string) => void;
  tab: AdminTab;
  onTabChange: (tab: AdminTab) => void;
  onOpenResourceCatalog: () => void;
  machineId?: string;
  machineSection?: MachineAdminSection;
  feedbackId?: string;
  feedbackRefreshToken: number;
  onFeedbackRoute: (feedbackId?: string) => void;
  onUnreadCountRefresh: () => Promise<void>;
  onMachineRoute: (
    machineId: string,
    section: MachineAdminSection,
    replace?: boolean
  ) => void;
}) {
  const isSystemAdmin = bootstrap.user.role === "SYSTEM_ADMIN";
  const visibleTab =
    !isSystemAdmin && ["announcements", "feedback", "settings", "audit"].includes(tab)
      ? "machines"
      : tab;
  const [machines, setMachines] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [newMachineOpen, setNewMachineOpen] = useState(false);
  const [machineSearch, setMachineSearch] = useState("");
  const [machinesLoaded, setMachinesLoaded] = useState(false);
  const [feedbackOpenCount, setFeedbackOpenCount] = useState(0);

  const loadMachines = useCallback(async () => {
    try {
      const result = await api<{ machines: any[] }>("/admin/machines");
      setMachines(result.machines);
      return result.machines;
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "机器加载失败");
      return [];
    } finally {
      setMachinesLoaded(true);
    }
  }, [notify]);
  const loadUsers = useCallback(async () => {
    try {
      const result = await api<{ users: any[] }>(
        isSystemAdmin ? "/admin/users" : "/users/directory"
      );
      setUsers(result.users);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "用户加载失败");
    }
  }, [isSystemAdmin, notify]);

  useEffect(() => {
    void loadMachines();
    void loadUsers();
  }, [loadMachines, loadUsers]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    void api<{ openCount: number }>("/admin/feedback/summary")
      .then((result) => setFeedbackOpenCount(result.openCount))
      .catch(() => undefined);
  }, [feedbackRefreshToken, isSystemAdmin]);

  useEffect(() => {
    if (visibleTab !== "machines") return;
    const events = new EventSource("/api/v1/events");
    events.addEventListener("revision", () => void loadMachines());
    return () => events.close();
  }, [loadMachines, visibleTab]);

  useEffect(() => {
    if (visibleTab !== "machines" || !machinesLoaded || !machines.length) return;
    if (machineId && machines.some((machine) => machine.id === machineId)) return;
    onMachineRoute(machines[0].id, machineSection ?? "info", true);
  }, [
    machineId,
    machineSection,
    machines,
    machinesLoaded,
    onMachineRoute,
    visibleTab
  ]);

  const tabs = [
    { id: "machines" as const, label: "资源管理", icon: Server, show: true },
    { id: "users" as const, label: "用户管理", icon: Users, show: true },
    { id: "report" as const, label: "使用统计", icon: Activity, show: true },
    { id: "announcements" as const, label: "系统公告", icon: Megaphone, show: isSystemAdmin },
    { id: "feedback" as const, label: "反馈处理", icon: MessageSquare, show: isSystemAdmin, badge: feedbackOpenCount },
    { id: "settings" as const, label: "系统设置", icon: Settings, show: isSystemAdmin },
    { id: "audit" as const, label: "审计记录", icon: ShieldCheck, show: isSystemAdmin }
  ];

  return (
    <div className={`admin-shell${visibleTab === "feedback" ? " feedback-admin-shell" : ""}`}>
      <aside className="admin-sidebar">
        <div>
          <h2>管理控制台</h2>
        </div>
        <nav>
          {tabs.filter((item) => item.show).map((item) => (
            <button key={item.id} className={visibleTab === item.id ? "active" : ""} onClick={() => onTabChange(item.id)}>
              <item.icon size={17} />{item.label}
              {"badge" in item && typeof item.badge === "number" && item.badge > 0 && (
                <span className="admin-tab-badge">{notificationBadgeText(item.badge)}</span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <section
        className={`admin-content${visibleTab === "machines" ? " machine-management-content" : ""}${visibleTab === "report" ? " report-management-content" : ""}${visibleTab === "feedback" ? " feedback-management-content" : ""}`}
      >
        {visibleTab === "machines" && (
          <>
            <PageHeader
              title="资源管理"
              actions={isSystemAdmin ? <button className="primary-button" onClick={() => setNewMachineOpen(true)}><Plus size={16} />新增机器</button> : undefined}
            />
            {!machinesLoaded ? (
              <div className="card machine-management-loading" aria-live="polite">
                <RefreshCw size={18} className="spin" />
                正在加载机器
              </div>
            ) : !machines.length ? (
              <section className="card machine-management-empty">
                <div className="machine-management-empty-icon">
                  <Server size={25} />
                </div>
                <h2>暂无可查看的机器</h2>
                <p>获得机器使用权后，可在这里查看和管理相关资源。</p>
                <button
                  type="button"
                  className="secondary-button accent"
                  onClick={onOpenResourceCatalog}
                >
                  查看全部资源
                  <ChevronRight size={16} />
                </button>
              </section>
            ) : (
            <div className="machine-admin-layout">
              <div className="machine-list card">
                <label className="machine-list-search">
                  <Search size={15} />
                  <input
                    value={machineSearch}
                    onChange={(event) => setMachineSearch(event.target.value)}
                    placeholder="搜索名称或地址"
                  />
                </label>
                <div className="machine-list-scroll">
                  {machines
                    .filter((machine) => {
                      const query = machineSearch.trim().toLowerCase();
                      return (
                        !query ||
                        String(machine.name).toLowerCase().includes(query) ||
                        String(machine.address ?? "").toLowerCase().includes(query)
                      );
                    })
                    .map((machine) => (
                      <button
                        key={machine.id}
                        className={machineId === machine.id ? "active" : ""}
                        onClick={() =>
                          onMachineRoute(
                            machine.id,
                            machineSection ?? "info"
                          )
                        }
                      >
                        <span className="machine-list-icon"><Server size={18} /></span>
                        <span>
                          <strong>{machine.name}</strong>
                          <small>{machine.address || "未填写地址"} ｜ {machine.resourceSummary || "尚未配置资源"}</small>
                        </span>
                        <ChevronRight size={17} />
                      </button>
                    ))}
                  {machines.length > 0 &&
                    !machines.some((machine) => {
                      const query = machineSearch.trim().toLowerCase();
                      return (
                        !query ||
                        String(machine.name).toLowerCase().includes(query) ||
                        String(machine.address ?? "").toLowerCase().includes(query)
                      );
                    }) && <div className="mini-empty">没有匹配的机器</div>}
                </div>
              </div>
              {machineId && machines.some((machine) => machine.id === machineId) && (
                <MachineAdminPanel
                  key={machineId}
                  machine={machines.find((item) => item.id === machineId)}
                  isSystemAdmin={isSystemAdmin}
                  canManage={Boolean(
                    machines.find((item) => item.id === machineId)?.canManage
                  )}
                  notify={notify}
                  reloadMachines={loadMachines}
                  section={machineSection ?? "info"}
                  onSectionChange={(nextSection) =>
                    onMachineRoute(machineId, nextSection)
                  }
                />
              )}
            </div>
            )}
          </>
        )}
        {visibleTab === "users" && (
          <UserAdminPanel
            users={users}
            canManage={isSystemAdmin}
            notify={notify}
            reload={loadUsers}
          />
        )}
        {visibleTab === "report" && <ReportPanel machines={machines} notify={notify} />}
        {visibleTab === "announcements" && <AnnouncementAdminPanel notify={notify} />}
        {visibleTab === "feedback" && (
          <FeedbackAdminPanel
            feedbackId={feedbackId}
            refreshToken={feedbackRefreshToken}
            notify={notify}
            onOpen={onFeedbackRoute}
            onUnreadCountRefresh={onUnreadCountRefresh}
          />
        )}
        {visibleTab === "settings" && <SettingsPanel notify={notify} />}
        {visibleTab === "audit" && <AuditPanel notify={notify} />}
      </section>
      {newMachineOpen && (
        <MachineFormModal
          onClose={() => setNewMachineOpen(false)}
          onSaved={async (createdMachineId) => {
            setNewMachineOpen(false);
            notify("success", "机器已创建");
            await loadMachines();
            if (createdMachineId) onMachineRoute(createdMachineId, "info");
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function MachineAdminPanel({
  machine,
  isSystemAdmin,
  canManage,
  notify,
  reloadMachines,
  section,
  onSectionChange
}: {
  machine: any;
  isSystemAdmin: boolean;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
  section: MachineAdminSection;
  onSectionChange: (section: MachineAdminSection) => void;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const sections: Array<{ id: MachineAdminSection; label: string }> = [
    { id: "info", label: "机器信息" },
    { id: "resources", label: "资源设置" },
    { id: "users", label: "用户与权限" }
  ];

  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [machine.id, section]);

  const moveTab = (current: MachineAdminSection, delta: number) => {
    const index = sections.findIndex((item) => item.id === current);
    const next = sections[(index + delta + sections.length) % sections.length];
    onSectionChange(next.id);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-machine-section="${next.id}"]`
        )
        ?.focus();
    });
  };

  return (
    <div className="machine-detail" ref={detailRef}>
      <div className="machine-context-bar card">
        <div className="machine-section-tabs" role="tablist" aria-label={`${machine.name} 详情页面`}>
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              tabIndex={section === item.id ? 0 : -1}
              data-machine-section={item.id}
              className={section === item.id ? "active" : ""}
              onClick={() => onSectionChange(item.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveTab(item.id, -1);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  moveTab(item.id, 1);
                }
              }}
            >
              {item.label}
              {item.id === "users" && machine.pendingAccessRequestCount > 0 && (
                <span>{machine.pendingAccessRequestCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="machine-context-identity">
          <span className="machine-list-icon"><Server size={18} /></span>
          <div className="machine-context-copy">
            <strong>{machine.name}</strong>
            <small>{machine.address || "未填写地址"}</small>
          </div>
        </div>
      </div>
      <div className="machine-section-content" role="tabpanel">
        {section === "info" && (
          <MachineInfoSection
            machine={machine}
            isSystemAdmin={isSystemAdmin}
            canManage={canManage}
            notify={notify}
            reloadMachines={reloadMachines}
          />
        )}
        {section === "resources" && (
          <MachineResourcesSection
            machine={machine}
            canManage={canManage}
            notify={notify}
            reloadMachines={reloadMachines}
          />
        )}
        {section === "users" && (
          <MachineUsersSection
            machine={machine}
            isSystemAdmin={isSystemAdmin}
            canManage={canManage}
            notify={notify}
            reloadMachines={reloadMachines}
          />
        )}
      </div>
    </div>
  );
}

function ExpandableMachineText({ value }: { value: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      if (!expanded) setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    observer?.observe(element);
    if (!observer) window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", measure);
    };
  }, [expanded, value]);

  return (
    <div className="machine-info-text">
      <p ref={textRef} className={expanded ? "expanded" : ""}>{value || "未填写"}</p>
      {(overflowing || expanded) && (
        <button type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

function formatUnavailabilityPeriod(
  startAt: string,
  endAt: string
) {
  const start = formatChinaFullMinute(startAt);
  const end =
    formatChinaDate(startAt) === formatChinaDate(endAt)
      ? formatChina(endAt, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        })
      : formatChinaFullMinute(endAt);
  return `${start} — ${end}`;
}

function MachineInfoSection({
  machine,
  isSystemAdmin,
  canManage,
  notify,
  reloadMachines
}: {
  machine: any;
  isSystemAdmin: boolean;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
}) {
  const dialog = useAppDialog();
  const { currentTime } = useServerClock();
  const [detail, setDetail] = useState<any | null>(null);
  const [unavailabilityWindows, setUnavailabilityWindows] = useState<any[]>([]);
  const [maintenanceGroups, setMaintenanceGroups] = useState<ResourceGroup[]>([]);
  const [editMachine, setEditMachine] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenanceInitialTime, setMaintenanceInitialTime] = useState<
    number | null
  >(null);
  const [stopOpen, setStopOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [machineResult, maintenanceResult, groupResult] = await Promise.all([
        api<{ machine: any }>(`/admin/machines/${machine.id}`),
        api<{ maintenance: any[] }>(
          `/admin/machines/${machine.id}/maintenance`
        ),
        api<{ groups: ResourceGroup[] }>(
          `/admin/machines/${machine.id}/groups`
        )
      ]);
      setDetail(machineResult.machine);
      setUnavailabilityWindows(maintenanceResult.maintenance);
      setMaintenanceGroups(groupResult.groups);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "机器信息加载失败");
    }
  }, [machine.id, notify]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    events.addEventListener("revision", () => void load());
    return () => events.close();
  }, [load]);

  const openMaintenance = () => {
    setMaintenanceInitialTime(currentTime);
    setMaintenanceOpen(true);
  };

  const closeMaintenance = () => {
    setMaintenanceOpen(false);
    setMaintenanceInitialTime(null);
  };

  if (!detail) {
    return <div className="content-loading"><RefreshCw className="spin" />正在载入</div>;
  }

  const currentMaintenance = unavailabilityWindows.filter(
    (item) =>
      item.status === "ACTIVE" &&
      new Date(item.endAt).getTime() > currentTime
  ).sort((left, right) => left.startAt.localeCompare(right.startAt));
  const machineMaintenanceNow = currentMaintenance.some(
    (item) =>
      item.resourceGroupId === null &&
      new Date(item.startAt).getTime() <= currentTime
  );
  const machineStatus = detail.status === "DISABLED"
    ? { label: "停用", className: "disabled" }
    : machineMaintenanceNow
      ? { label: "维护", className: "scheduled" }
      : { label: "启用", className: "active" };

  const handleEnable = async () => {
    try {
      await api(`/admin/machines/${machine.id}/enable`, {
        method: "POST",
        body: jsonBody({ expectedVersion: detail.version })
      });
      notify("success", "机器已重新启用");
      await Promise.all([load(), reloadMachines()]);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "重新启用失败");
    }
  };

  const handleDelete = async () => {
    try {
      const impact = await api<{
        counts: Record<string, number>;
      }>(`/admin/machines/${machine.id}/deletion-impact`);
      const total = Object.values(impact.counts).reduce(
        (sum, value) => sum + value,
        0
      );
      const countLines = [
        `资源配置 ${impact.counts.resourcePools ?? 0} 项`,
        `设备条目 ${impact.counts.resourceItems ?? 0} 项`,
        `资源组 ${impact.counts.resourceGroups ?? 0} 个`,
        `成员 ${impact.counts.members ?? 0} 人`,
        `机器管理员 ${impact.counts.managers ?? 0} 人`,
        `使用权申请 ${impact.counts.accessRequests ?? 0} 条`,
        `占用 ${impact.counts.reservations ?? 0} 条`,
        `维护记录 ${impact.counts.unavailability ?? 0} 条`
      ].join("\n");
      if (!(await dialog.confirm({
        title: "永久删除机器",
        message: `删除后无法恢复 ${detail.name} 的配置和权限。\n${countLines}\n共涉及 ${total} 条记录；占用、审批、维护和审计历史会继续保留，并以“机器已删除”“资源组已删除”等名称显示。`,
        confirmLabel: "永久删除",
        tone: "danger"
      }))) return;
      await api(`/admin/machines/${machine.id}`, {
        method: "DELETE",
        body: jsonBody({ expectedVersion: detail.version })
      });
      notify("success", "机器已永久删除");
      await reloadMachines();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "删除机器失败");
    }
  };

  return (
    <div className="machine-section-stack">
      <section className="card panel-card machine-info-panel">
        <SectionHeader
          title="机器信息"
          actions={canManage ? (
            <button className="secondary-button compact" onClick={() => setEditMachine(true)}>
              <Pencil size={14} />编辑
            </button>
          ) : undefined}
        />
        <div className="machine-info-overview">
          <div className="machine-info-identity">
            <span className="machine-info-symbol"><Server size={20} /></span>
            <div>
              <span>机器名称</span>
              <strong>{detail.name}</strong>
              <small>连接地址：{detail.address || "未填写"}</small>
            </div>
            <span className={`state-chip ${machineStatus.className}`}>
              {machineStatus.label}
            </span>
          </div>
          <div className="machine-info-resource">
            <span><Gauge size={14} />资源摘要</span>
            <strong>{detail.resourceSummary || "尚未配置资源"}</strong>
          </div>
        </div>
        <div className="machine-info-tags">
          <span>标签</span>
          <div className="tag-row">
            {detail.tags.length
              ? detail.tags.map((tag: string) => <span key={tag}>{tag}</span>)
              : <em>未填写</em>}
          </div>
        </div>
        <div className="machine-info-details">
          <div className="machine-info-detail">
            <span><Cpu size={14} />硬件说明</span>
            <ExpandableMachineText value={detail.hardwareNotes} />
          </div>
          <div className="machine-info-detail">
            <span><Info size={14} />连接说明</span>
            <ExpandableMachineText value={detail.connectionGuide} />
          </div>
          {canManage && (
            <div className="machine-info-detail management">
              <span><ShieldCheck size={14} />管理备注</span>
              <ExpandableMachineText value={detail.managementNotes} />
            </div>
          )}
        </div>
      </section>

      <section className="card panel-card machine-unavailability-panel maintenance-panel">
        <SectionHeader
          title="维护管理"
          actions={
            canManage && detail.status === "ACTIVE" ? (
              <button
                type="button"
                className="secondary-button compact"
                onClick={openMaintenance}
              >
                <Plus size={14} />安排维护
              </button>
            ) : undefined
          }
        />
        {currentMaintenance.length > 0 && (
          <div className="unavailability-table machine-unavailability-table">
            <div className="unavailability-table-row machine-unavailability-table-row head">
              <span>范围</span>
              <span>维护时间</span>
              <span>原因</span>
              <span />
            </div>
            {currentMaintenance.map((item) => (
              <div
                className="unavailability-table-row machine-unavailability-table-row"
                key={item.id}
              >
                <span
                  className={`unavailability-kind-chip ${
                    item.resourceGroupId ? "group" : "planned"
                  }`}
                  title={item.resourceGroupName || "整机"}
                >
                  {item.resourceGroupName || "整机"}
                </span>
                <span
                  className="unavailability-period"
                  title={formatUnavailabilityPeriod(
                    item.startAt,
                    item.endAt
                  )}
                >
                  {formatUnavailabilityPeriod(
                    item.startAt,
                    item.endAt
                  )}
                </span>
                <span
                  className={`unavailability-reason${item.reason ? "" : " empty"}`}
                  title={item.reason || "未填写"}
                >
                  {item.reason || "未填写"}
                </span>
                {canManage ? (
                  <span className="unavailability-row-action">
                    <button className="icon-button tiny danger" title="取消维护" onClick={async () => {
                      if (!(await dialog.confirm({
                        title: "取消维护",
                        message: "此前因维护被取消或调整的占用不会自动恢复。",
                        confirmLabel: "取消维护",
                        tone: "danger"
                      }))) return;
                      try {
                        await api(`/admin/maintenance/${item.id}`, { method: "DELETE" });
                        notify("success", "维护安排已取消");
                        await load();
                      } catch (error) {
                        notify("error", error instanceof Error ? error.message : "取消维护失败");
                      }
                    }}><X size={14} /></button>
                  </span>
                ) : <span className="unavailability-row-action" />}
              </div>
            ))}
          </div>
        )}
        {currentMaintenance.length === 0 && (
          <div className="unavailability-empty">暂无维护安排</div>
        )}
      </section>

      <section className="card panel-card machine-state-panel">
        <SectionHeader title="机器状态" />
        <div className={`machine-disabled-state${detail.status === "ACTIVE" ? " active" : ""}`}>
          <div>
            {detail.status === "ACTIVE" ? <Power size={17} /> : <PowerOff size={17} />}
            <strong>{detail.status === "ACTIVE" ? "启用" : "停用"}</strong>
          </div>
          {canManage && (
            <div className="section-header-actions">
              {detail.status === "ACTIVE" ? (
                <button
                  className="secondary-button compact danger"
                  onClick={() => setStopOpen(true)}
                >
                  <PowerOff size={14} />停用
                </button>
              ) : (
                <>
                  <button
                    className="secondary-button compact"
                    onClick={() => void handleEnable()}
                  >
                    <Power size={14} />重新启用
                  </button>
                  {isSystemAdmin && (
                    <button
                      className="secondary-button compact danger"
                      title="永久删除机器"
                      aria-label={`永久删除 ${detail.name}`}
                      onClick={() => void handleDelete()}
                    >
                      <Trash2 size={14} />永久删除
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>
      {maintenanceOpen && maintenanceInitialTime !== null && canManage && (
        <MaintenanceModal
          machine={detail}
          groups={maintenanceGroups}
          openingTime={maintenanceInitialTime}
          onClose={closeMaintenance}
          onCompleted={async () => {
            closeMaintenance();
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
      {stopOpen && canManage && (
        <MachineStopModal
          machine={detail}
          onClose={() => setStopOpen(false)}
          onCompleted={async () => {
            setStopOpen(false);
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
      {editMachine && canManage && (
        <MachineFormModal
          machine={detail}
          onClose={() => setEditMachine(false)}
          onSaved={async () => {
            setEditMachine(false);
            notify("success", "机器资料已更新");
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

type MaintenancePreview = {
  affectedReservations: any[];
  startAt: string;
  endAt: string;
  revision: number;
  summary: {
    total: number;
    cancelled: number;
    trimmed: number;
    split: number;
  };
};

function MaintenanceModal({
  machine,
  groups,
  openingTime,
  onClose,
  onCompleted,
  notify
}: {
  machine: any;
  groups: ResourceGroup[];
  openingTime: number;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const { currentTime } = useServerClock();
  const [initial] = useState(() => initialReservationTime(openingTime));
  const [targetId, setTargetId] = useState("MACHINE");
  const [form, setForm] = useState({
    startAt: initial.start,
    endAt: initial.end,
    reason: ""
  });
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startFocused, setStartFocused] = useState(false);
  const [timeRangeEdited, setTimeRangeEdited] = useState(false);
  const currentMinuteLocal = isoToChinaLocal(currentMinuteStart(currentTime));
  const timeRangeError =
    form.startAt && form.endAt && form.endAt <= form.startAt
      ? "结束时间必须晚于开始时间"
      : "";

  useEffect(() => {
    if (startFocused) return;
    if (!timeRangeEdited) {
      const next = initialReservationTime(currentTime);
      if (form.startAt === next.start && form.endAt === next.end) return;
      setForm((current) => ({
        ...current,
        startAt: next.start,
        endAt: next.end
      }));
      setPreview(null);
      return;
    }
    if (!form.startAt || form.startAt > currentMinuteLocal) return;
    if (form.startAt === currentMinuteLocal) return;
    setForm((current) => ({ ...current, startAt: currentMinuteLocal }));
    setPreview(null);
  }, [
    currentMinuteLocal,
    currentTime,
    form.endAt,
    form.startAt,
    startFocused,
    timeRangeEdited
  ]);

  const updateForm = (
    field: "startAt" | "endAt" | "reason",
    value: string
  ) => {
    setForm((current) => ({ ...current, [field]: value }));
    setPreview(null);
  };

  const updateTimeField = (
    field: "startAt" | "endAt",
    value: string
  ) => {
    setTimeRangeEdited(true);
    updateForm(field, value);
  };

  const runPreview = async () => {
    if (timeRangeError) return;
    setPreviewing(true);
    try {
      const result = await api<MaintenancePreview>(
        `/admin/machines/${machine.id}/maintenance/preview`,
        {
          method: "POST",
          body: jsonBody({
            resourceGroupId: targetId === "MACHINE" ? null : targetId,
            startAt: chinaLocalToIso(form.startAt),
            endAt: chinaLocalToIso(form.endAt)
          })
        });
      setForm((current) => ({
        ...current,
        startAt: isoToChinaLocal(result.startAt),
        endAt: isoToChinaLocal(result.endAt)
      }));
      setPreview(result);
    } catch (error) {
      setPreview(null);
      notify("error", error instanceof Error ? error.message : "维护影响加载失败");
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      await api(`/admin/machines/${machine.id}/maintenance`, {
        method: "POST",
        body: jsonBody({
          resourceGroupId: targetId === "MACHINE" ? null : targetId,
          startAt: chinaLocalToIso(form.startAt),
          endAt: chinaLocalToIso(form.endAt),
          reason: form.reason,
          expectedRevision: preview.revision
        })
      });
      notify("success", "维护安排已创建");
      await onCompleted();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setPreview(null);
      }
      notify(
        "error",
        error instanceof Error ? error.message : "创建维护失败"
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`安排维护：${machine.name}`}
      onClose={onClose}
      wide
    >
      <div className="stack-form machine-disable-modal">
        <Field label="维护范围">
          <select
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setPreview(null);
            }}
          >
            <option value="MACHINE">整机</option>
            {groups
              .filter((group) => group.status === "ACTIVE")
              .map((group) => (
                <option key={group.id} value={group.id}>
                  资源组 · {group.name}
                </option>
              ))}
          </select>
        </Field>
        <div className="machine-disable-time-grid">
          <Field label="开始时间">
            <input
              type="datetime-local"
              value={form.startAt}
              onFocus={() => setStartFocused(true)}
              onChange={(event) =>
                updateTimeField("startAt", event.target.value)
              }
              onBlur={(event) => {
                setStartFocused(false);
                const value = event.currentTarget.value;
                if (value && value <= currentMinuteLocal) {
                  updateForm("startAt", currentMinuteLocal);
                }
              }}
            />
          </Field>
          <Field label="结束时间" error={timeRangeError}>
            <input
              type="datetime-local"
              value={form.endAt}
              aria-invalid={Boolean(timeRangeError)}
              onChange={(event) =>
                updateTimeField("endAt", event.target.value)
              }
            />
          </Field>
        </div>
        <Field label="原因（选填）">
          <textarea
            value={form.reason}
            maxLength={1000}
            rows={3}
            onChange={(event) => updateForm("reason", event.target.value)}
          />
        </Field>
        {preview && (
          <div className={`unavailability-impact-bar ${preview.summary.total ? "warning" : "safe"}`}>
            <div>
              {preview.summary.total ? <CircleAlert size={16} /> : <Check size={16} />}
              <span>
                <strong>
                  {preview.summary.total
                    ? `影响 ${preview.summary.total} 条占用`
                    : "没有受影响的占用"}
                </strong>
                {preview.summary.total > 0 && (
                  <small>
                    取消 {preview.summary.cancelled} 条 · 裁切 {preview.summary.trimmed} 条 ·
                    拆分 {preview.summary.split} 条
                  </small>
                )}
                  {preview.affectedReservations.slice(0, 3).map((item) => (
                  <small key={item.id}>
                    {item.applicantName} · {item.resourceGroupName || "整机"} ·
                    {" "}{formatChinaFullMinute(item.startAt)}
                  </small>
                ))}
                {preview.summary.total > 3 && (
                  <small>另有 {preview.summary.total - 3} 条占用</small>
                )}
              </span>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={previewing || submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="secondary-button machine-disable-modal-action"
            onClick={() => void runPreview()}
            disabled={Boolean(timeRangeError) || previewing || submitting}
          >
            <Eye size={15} />查看影响
          </button>
          <button
            type="button"
            className="primary-button machine-disable-modal-action"
            onClick={() => void submit()}
            disabled={
              Boolean(timeRangeError) || !preview || previewing || submitting
            }
          >
            创建维护
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MachineStopModal({
  machine,
  onClose,
  onCompleted,
  notify
}: {
  machine: any;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(
        await api<MaintenancePreview>(
          `/admin/machines/${machine.id}/disable/preview`,
          { method: "POST" }
        )
      );
    } catch (error) {
      setPreview(null);
      notify("error", error instanceof Error ? error.message : "停用影响加载失败");
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      await api(`/admin/machines/${machine.id}/disable`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: machine.version,
          expectedRevision: preview.revision,
          reason
        })
      });
      notify("success", "机器已停用");
      await onCompleted();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setPreview(null);
      notify("error", error instanceof Error ? error.message : "停用机器失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={`停用机器：${machine.name}`} onClose={onClose} wide>
      <div className="stack-form machine-disable-modal">
        <div className="modal-note warning">
          <CircleAlert size={15} />
          <span>停用后将持续不可用，重新启用前不能创建新的占用。</span>
        </div>
        <Field label="原因（选填）">
          <textarea
            value={reason}
            maxLength={1000}
            rows={3}
            onChange={(event) => {
              setReason(event.target.value);
              setPreview(null);
            }}
          />
        </Field>
        {preview && (
          <div className={`unavailability-impact-bar ${preview.summary.total ? "warning" : "safe"}`}>
            <div>
              {preview.summary.total ? <CircleAlert size={16} /> : <Check size={16} />}
              <span>
                <strong>
                  {preview.summary.total
                    ? `影响 ${preview.summary.total} 条占用`
                    : "没有受影响的占用"}
                </strong>
                {preview.summary.total > 0 && (
                  <small>
                    取消 {preview.summary.cancelled} 条 · 裁切 {preview.summary.trimmed} 条 ·
                    拆分 {preview.summary.split} 条
                  </small>
                )}
              </span>
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={previewing || submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="secondary-button machine-disable-modal-action"
            onClick={() => void runPreview()}
            disabled={previewing || submitting}
          >
            <Eye size={15} />查看影响
          </button>
          <button
            type="button"
            className="danger-button machine-disable-modal-action"
            onClick={() => void submit()}
            disabled={!preview || previewing || submitting}
          >
            确认停用
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MachineResourcesSection({
  machine,
  canManage,
  notify,
  reloadMachines
}: {
  machine: any;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
}) {
  const dialog = useAppDialog();
  const [groups, setGroups] = useState<ResourceGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [pools, setPools] = useState<ResourcePool[]>([]);
  const [resourceEditorOpen, setResourceEditorOpen] = useState(false);
  const [openingResourceEditor, setOpeningResourceEditor] = useState(false);

  const load = useCallback(async () => {
    try {
      const groupResult = await api<{ groups: ResourceGroup[] }>(
        `/admin/machines/${machine.id}/groups`
      );
      setGroups(groupResult.groups);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "资源设置加载失败");
    } finally {
      setGroupsLoaded(true);
    }
  }, [machine.id, notify]);

  const openResourceEditor = async () => {
    setOpeningResourceEditor(true);
    try {
      const [poolResult, groupResult] = await Promise.all([
        api<{ pools: ResourcePool[] }>(
          `/admin/machines/${machine.id}/resource-pools`
        ),
        api<{ groups: ResourceGroup[] }>(
          `/admin/machines/${machine.id}/groups`
        )
      ]);
      setPools(poolResult.pools);
      setGroups(groupResult.groups);
      setResourceEditorOpen(true);
    } catch (error) {
      notify(
        "error",
        error instanceof Error ? error.message : "资源配置加载失败"
      );
    } finally {
      setOpeningResourceEditor(false);
    }
  };

  useEffect(() => {
    setGroups([]);
    setGroupsLoaded(false);
    void load();
  }, [load]);
  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    events.addEventListener("revision", () => void load());
    return () => events.close();
  }, [load]);

  const disableGroup = async (group: ResourceGroup) => {
    const reason = await dialog.prompt({
      title: "停用资源组",
      message: `停用 ${group.name} 会立即处理进行中和未来的占用。`,
      label: "原因（选填）",
      multiline: true,
      maxLength: 1000
    });
    if (reason === null) return;
    try {
      const preview = await api<{
        revision: number;
        summary: { total: number; cancelled: number; trimmed: number; split: number };
      }>(`/admin/groups/${group.id}/disable/preview`, { method: "POST" });
      const summary = preview.summary;
      if (!(await dialog.confirm({
        title: "确认停用",
        message: summary.total
          ? `将影响 ${summary.total} 条占用：取消 ${summary.cancelled} 条、裁切 ${summary.trimmed} 条、拆分 ${summary.split} 条。`
          : "当前没有受影响的占用。",
        confirmLabel: "停用",
        tone: "danger"
      }))) return;
      await api(`/admin/groups/${group.id}/disable`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: group.version,
          expectedRevision: preview.revision,
          reason
        })
      });
      notify("success", "资源组已停用");
      await load();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "停用失败");
    }
  };

  const enableGroup = async (group: ResourceGroup) => {
    try {
      await api(`/admin/groups/${group.id}/enable`, {
        method: "POST",
        body: jsonBody({ expectedVersion: group.version })
      });
      notify("success", "资源组已重新启用");
      await load();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "重新启用失败");
    }
  };

  const deleteGroup = async (group: ResourceGroup) => {
    try {
      const impact = await api<{ counts: Record<string, number> }>(
        `/admin/groups/${group.id}/deletion-impact`
      );
      const total = Object.values(impact.counts).reduce(
        (sum, value) => sum + value,
        0
      );
      const countLines = [
        `资源分配 ${impact.counts.allocations ?? 0} 项`,
        `占用 ${impact.counts.reservations ?? 0} 条`,
        `维护记录 ${impact.counts.unavailability ?? 0} 条`,
        `配置历史 ${impact.counts.revisions ?? 0} 条`
      ].join("\n");
      if (!(await dialog.confirm({
        title: "永久删除资源组",
        message: `删除后无法恢复 ${group.name} 的配置。\n${countLines}\n共涉及 ${total} 条记录；占用、维护和审计历史会继续保留，并以“资源组已删除”“资源已删除”等名称显示。`,
        confirmLabel: "永久删除",
        tone: "danger"
      }))) return;
      await api(`/admin/groups/${group.id}`, {
        method: "DELETE",
        body: jsonBody({ expectedVersion: group.version })
      });
      notify("success", "资源组已永久删除");
      await Promise.all([load(), reloadMachines()]);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "删除资源组失败");
    }
  };

  return (
    <div className="machine-section-stack">
      <section className="card panel-card resource-group-panel">
        <SectionHeader
          title="资源组"
          actions={canManage ? (
            <button
              className="secondary-button compact"
              onClick={() => void openResourceEditor()}
              disabled={openingResourceEditor}
            >
              <Pencil size={14} />编辑资源
            </button>
          ) : undefined}
        />
        <div className="group-admin-table">
          <div className="group-admin-row head" aria-hidden="true">
            <span>资源组信息</span><span>状态</span><span />
          </div>
          {groups.map((group) => {
            const effectiveStatus =
              group.status === "DISABLED" ||
              machine.availabilityStatus === "LONG_TERM"
                ? "DISABLED"
                : group.hasCurrentPlannedUnavailability ||
                    machine.availabilityStatus === "PLANNED"
                  ? "MAINTENANCE"
                  : "ACTIVE";
            return (
              <div className={`group-admin-row ${group.status.toLowerCase()}`} key={group.id}>
                <div className="group-admin-info">
                  <span className="group-admin-copy">
                    <strong className="group-admin-name" title={group.name}>{group.name}</strong>
                    <ResourceSummary value={group.resourceSummary} />
                  </span>
                </div>
                <span className="group-status-cell">
                  <span
                    className={`state-chip ${
                      effectiveStatus === "DISABLED"
                        ? "disabled"
                        : effectiveStatus === "MAINTENANCE"
                          ? "scheduled"
                          : "active"
                    }`}
                  >
                    {effectiveStatus === "DISABLED"
                      ? "停用"
                      : effectiveStatus === "MAINTENANCE"
                        ? "维护"
                        : "启用"}
                  </span>
                </span>
                <div className="group-admin-actions">
                  {canManage && group.status === "ACTIVE" && (
                    <button className="icon-button tiny danger" title="停用" onClick={() => void disableGroup(group)}><PowerOff size={14} /></button>
                  )}
                  {canManage && group.status === "DISABLED" && (
                    <>
                      <button className="icon-button tiny" title="重新启用" onClick={() => void enableGroup(group)}><Power size={14} /></button>
                      <button className="icon-button tiny danger" title="永久删除" onClick={() => void deleteGroup(group)}><Trash2 size={14} /></button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {!groupsLoaded && <div className="mini-empty">正在加载资源组</div>}
          {groupsLoaded && !groups.length && (
            <div className="mini-empty">尚未配置资源组</div>
          )}
        </div>
      </section>
      {resourceEditorOpen && canManage && (
        <ResourceConfigurationModal
          machine={machine}
          pools={pools}
          groups={groups}
          onClose={() => setResourceEditorOpen(false)}
          onSaved={async () => {
            setResourceEditorOpen(false);
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}


function MachineUsersSection({
  machine,
  isSystemAdmin,
  canManage,
  notify,
  reloadMachines
}: {
  machine: any;
  isSystemAdmin: boolean;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
}) {
  const dialog = useAppDialog();
  const [access, setAccess] = useState<{ members: any[]; requests: any[] }>({
    members: [],
    requests: []
  });
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ members: any[]; requests: any[] }>(
        `/admin/machines/${machine.id}/access`
      );
      setAccess(result);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "用户权限加载失败");
    }
  }, [machine.id, notify]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const events = new EventSource("/api/v1/events");
    events.addEventListener("revision", () => void load());
    return () => events.close();
  }, [load]);

  const refresh = async () => {
    await Promise.all([load(), reloadMachines()]);
  };

  return (
    <div className="machine-section-stack">
      {canManage && access.requests.length > 0 && (
        <section className="card panel-card machine-requests-panel">
          <SectionHeader title="申请列表" actions={<span className="request-count">{access.requests.length}</span>} />
          <div className="machine-request-list">
            {access.requests.map((item) => (
              <div className="machine-request-row" key={item.id}>
                <div className="member-identity">
                  <div className="avatar small">{item.displayName.slice(0, 1)}</div>
                  <span><strong>{item.displayName}</strong><small>@{item.username} · {item.employeeNumber || "暂无工号"}</small></span>
                </div>
                <p>{item.reason || "未填写申请理由"}</p>
                <time>{formatChinaFullMinute(item.createdAt)}</time>
                <div className="row-actions">
                  <button className="icon-button tiny list-icon-action approve" title="通过申请" onClick={async () => {
                    try {
                      await api(`/admin/machine-access/requests/${item.id}/approve`, {
                        method: "POST",
                        body: jsonBody({ expectedVersion: item.expectedVersion })
                      });
                      notify("success", `${item.displayName} 已获得机器使用权`);
                    } catch (error) {
                      notify("error", error instanceof Error ? error.message : "审批失败");
                    } finally {
                      await refresh();
                    }
                  }}><Check size={15} /></button>
                  <button className="icon-button tiny list-icon-action danger" title="拒绝申请" onClick={async () => {
                    const reason = await dialog.prompt({
                      title: "拒绝使用权申请",
                      message: `拒绝 ${item.displayName} 对 ${machine.name} 的使用权申请。`,
                      label: "原因（选填）",
                      multiline: true,
                      maxLength: 500,
                      confirmLabel: "确认拒绝",
                      tone: "danger"
                    });
                    if (reason === null) return;
                    try {
                      await api(`/admin/machine-access/requests/${item.id}/reject`, {
                        method: "POST",
                        body: jsonBody({ expectedVersion: item.expectedVersion, reason })
                      });
                      notify("success", "使用权申请已拒绝");
                    } catch (error) {
                      notify("error", error instanceof Error ? error.message : "操作失败");
                    } finally {
                      await refresh();
                    }
                  }}><X size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card panel-card machine-access-panel">
        <SectionHeader
          title="用户列表"
          actions={canManage ? <button className="secondary-button compact" onClick={() => setInviteOpen(true)}><UserPlus size={15} />邀请用户</button> : undefined}
        />
        <div className="machine-member-list">
          <div className="machine-member-row machine-member-head">
            <span>用户</span><span>身份</span><span>加入时间</span><span />
          </div>
          {access.members.map((member) => (
            <div
              className="machine-member-row"
              key={member.id ?? `${member.username}:${member.grantedAt}`}
            >
              <div className="member-identity">
                <div className="avatar small">{member.displayName.slice(0, 1)}</div>
                <span><strong>{member.displayName}</strong><small>@{member.username} · {member.employeeNumber || "暂无工号"}</small></span>
              </div>
              <span className={`state-chip ${member.role === "MACHINE_ADMIN" ? "active" : "member"}`}>
                {member.role === "MACHINE_ADMIN" ? "管理员" : "使用者"}
              </span>
              <span>{formatChinaFullMinute(member.grantedAt)}</span>
              <div className="row-actions">
                {canManage && isSystemAdmin && member.role === "MEMBER" && (
                  <button className="icon-button tiny list-icon-action" title="设为管理员" onClick={async () => {
                    try {
                      await api(`/admin/machines/${machine.id}/managers/${member.id}`, { method: "PUT", body: "{}" });
                      notify("success", `${member.displayName} 已设为机器管理员`);
                      await refresh();
                    } catch (error) {
                      notify("error", error instanceof Error ? error.message : "设置管理员失败");
                    }
                  }}><ShieldCheck size={15} /></button>
                )}
                {canManage && isSystemAdmin && member.role === "MACHINE_ADMIN" && (
                  <button className="icon-button tiny list-icon-action" title="取消管理员" onClick={async () => {
                    if (!(await dialog.confirm({
                      title: "取消管理员身份",
                      message: `确认取消 ${member.displayName} 的机器管理员身份？该用户仍保留普通使用权。`,
                      confirmLabel: "确认取消"
                    }))) return;
                    try {
                      await api(`/admin/machines/${machine.id}/managers/${member.id}`, { method: "DELETE" });
                      notify("success", "管理员身份已取消");
                      await refresh();
                    } catch (error) {
                      notify("error", error instanceof Error ? error.message : "取消管理员失败");
                    }
                  }}><ShieldOff size={15} /></button>
                )}
                {canManage && (member.role === "MEMBER" || isSystemAdmin) && (
                  <button className="icon-button tiny list-icon-action danger" title="移除用户" onClick={async () => {
                    const impact = member.impact;
                    const detail = [
                      impact.activeReservations && `${impact.activeReservations} 条进行中占用`,
                      impact.futureReservations && `${impact.futureReservations} 条未来占用`
                    ].filter(Boolean).join("、");
                    if (!(await dialog.confirm({
                      title: "移除用户",
                      message: `确认将 ${member.displayName} 移出 ${machine.name}？${detail ? `此操作会释放${detail}。` : ""}`,
                      confirmLabel: "确认移除",
                      tone: "danger"
                    }))) return;
                    try {
                      await api(`/admin/machines/${machine.id}/members/${member.id}`, { method: "DELETE" });
                      notify("success", `${member.displayName} 已被移出机器`);
                      await refresh();
                    } catch (error) {
                      notify("error", error instanceof Error ? error.message : "移除失败");
                    }
                  }}><UserMinus size={15} /></button>
                )}
              </div>
            </div>
          ))}
          {!access.members.length && <div className="mini-empty">暂时没有显式授权用户</div>}
        </div>
      </section>
      {inviteOpen && canManage && (
        <InviteMachineMemberModal
          machine={machine}
          onClose={() => setInviteOpen(false)}
          onInvited={async () => {
            setInviteOpen(false);
            await refresh();
          }}
          notify={notify}
        />
      )}
    </div>
  );
}

function InviteMachineMemberModal({
  machine,
  onClose,
  onInvited,
  notify
}: {
  machine: any;
  onClose: () => void;
  onInvited: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api<{ users: any[] }>(
          `/admin/machines/${machine.id}/member-candidates?q=${encodeURIComponent(query)}`
        );
        setUsers(result.users);
      } catch (error) {
        notify(
          "error",
          error instanceof Error ? error.message : "候选用户加载失败"
        );
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [machine.id, notify, query]);

  return (
    <Modal title="邀请用户" onClose={onClose}>
      <div className="stack-form invite-member-modal">
        <label className="search-box">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索姓名、用户名或工号"
          />
        </label>
        <ContextNotice>添加后，该用户将立即获得这台机器的使用权。</ContextNotice>
        <div className="invite-candidate-list">
          {loading ? (
            <div className="mini-empty"><RefreshCw size={15} className="spin" />正在查找</div>
          ) : users.length ? users.map((user) => (
            <div key={user.id}>
              <div className="member-identity">
                <div className="avatar small">{user.displayName.slice(0, 1)}</div>
                <span>
                  <strong>{user.displayName}</strong>
                  <small>@{user.username} · {user.employeeNumber || "暂无工号"}</small>
                </span>
              </div>
              <button
                type="button"
                className="icon-button tiny list-icon-action invite"
                title="邀请用户"
                aria-label={`邀请 ${user.displayName}`}
                disabled={Boolean(busyId)}
                onClick={async () => {
                  if (!(await dialog.confirm({
                    title: "邀请用户",
                    message: `添加后，${user.displayName} 将立即获得 ${machine.name} 的使用权。`,
                    confirmLabel: "确认邀请"
                  }))) return;
                  setBusyId(user.id);
                  try {
                    await api(`/admin/machines/${machine.id}/members`, {
                      method: "POST",
                      body: jsonBody({ userId: user.id })
                    });
                    notify("success", `${user.displayName} 已加入机器`);
                    await onInvited();
                  } catch (error) {
                    if (
                      error instanceof ApiError &&
                      ["MACHINE_MEMBER_ALREADY_EXISTS", "MACHINE_ACCESS_REQUEST_PENDING"].includes(
                        error.code ?? ""
                      )
                    ) {
                      notify("error", error.message);
                      await onInvited();
                    } else {
                      notify(
                        "error",
                        error instanceof Error ? error.message : "邀请失败"
                      );
                    }
                  } finally {
                    setBusyId("");
                  }
                }}
              >
                {busyId === user.id ? <RefreshCw size={14} className="spin" /> : <UserPlus size={14} />}
              </button>
            </div>
          )) : <div className="mini-empty">没有可邀请的用户</div>}
        </div>
      </div>
    </Modal>
  );
}

function TagEditor({
  tags,
  input,
  onChange,
  invalid = false
}: {
  tags: string[];
  input: string;
  onChange: (tags: string[], input: string) => void;
  invalid?: boolean;
}) {
  const addTag = () => {
    const tag = input.trim();
    if (!tag) {
      onChange(tags, "");
      return;
    }
    if (
      resourceTagDraftIssue(tags, tag) !==
      "按回车或点击添加当前标签"
    ) {
      return;
    }
    onChange([...tags, tag], "");
  };
  return (
    <div className="resource-tag-editor">
      <div className="resource-tag-entry">
        <div
          className={[
            "resource-tag-input-shell",
            invalid ? "resource-config-invalid" : ""
          ].filter(Boolean).join(" ")}
          aria-invalid={invalid}
        >
          <input
            aria-label="输入标签"
            value={input}
            onChange={(event) => onChange(tags, event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                event.nativeEvent.isComposing
              ) {
                return;
              }
              event.preventDefault();
              addTag();
            }}
          />
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={!input.trim()}
          onClick={addTag}
        >
          添加
        </button>
      </div>
      {tags.length > 0 && (
        <div className="resource-tag-list">
          {tags.map((tag, index) => (
            <span className="resource-tag-token" key={`${tag}:${index}`}>
              <span>{tag}</span>
              <button
                type="button"
                aria-label={`删除标签 ${tag}`}
                onClick={() =>
                  onChange(
                    tags.filter(
                      (_, candidateIndex) => candidateIndex !== index
                    ),
                    input
                  )}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MachineFormModal({
  machine,
  onClose,
  onSaved,
  notify
}: {
  machine?: any;
  onClose: () => void;
  onSaved: (machineId?: string) => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const [form, setForm] = useState({
    name: machine?.name ?? "",
    address: machine?.address ?? "",
    hardwareNotes: machine?.hardwareNotes ?? "",
    connectionGuide: machine?.connectionGuide ?? "",
    managementNotes: machine?.managementNotes ?? "",
    tags: [...(machine?.tags ?? [])],
    tagInput: ""
  });
  const tagIssue = resourceTagDraftIssue(form.tags, form.tagInput);
  return (
    <Modal title={machine ? "编辑机器" : "新增机器"} onClose={onClose} wide>
      <div className="stack-form machine-form">
        <div className="machine-form-primary">
          <Field label="机器名称">
            <input
              autoFocus
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="连接地址">
            <input
              value={form.address}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
              placeholder="IP 或主机名"
            />
          </Field>
        </div>
        <div className="field">
          <span>标签</span>
          <TagEditor
            tags={form.tags}
            input={form.tagInput}
            invalid={Boolean(tagIssue)}
            onChange={(tags, tagInput) =>
              setForm({ ...form, tags, tagInput })}
          />
          {tagIssue && (
            <span className="resource-tag-error" role="alert">
              <CircleAlert size={12} />
              {tagIssue}
            </span>
          )}
        </div>
        <div className="machine-form-public-notes">
          <Field label="硬件说明（用户可见）">
            <textarea
              rows={4}
              value={form.hardwareNotes}
              onChange={(event) => setForm({ ...form, hardwareNotes: event.target.value })}
            />
          </Field>
          <Field label="连接说明（用户可见）">
            <textarea
              rows={4}
              value={form.connectionGuide}
              onChange={(event) => setForm({ ...form, connectionGuide: event.target.value })}
            />
          </Field>
        </div>
        <label className="field machine-form-management">
          <span className="machine-form-label">
            <span>管理备注（仅管理员可见）</span>
            <small><CircleAlert size={12} />请勿填写密码或密钥</small>
          </span>
          <textarea
            rows={4}
            maxLength={5000}
            value={form.managementNotes}
            onChange={(event) => setForm({ ...form, managementNotes: event.target.value })}
          />
          <span className="field-counter">{form.managementNotes.length}/5000</span>
        </label>
        <div className="modal-actions machine-form-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            disabled={Boolean(tagIssue)}
            onClick={async () => {
            try {
              const { tagInput: _tagInput, ...formValues } = form;
              const body = {
                ...formValues,
                ...(machine ? { expectedVersion: machine.version } : {}),
                tags: form.tags
              };
              const result = await api<{ id?: string }>(
                machine ? `/admin/machines/${machine.id}` : "/admin/machines",
                {
                method: machine ? "PATCH" : "POST",
                body: jsonBody(body)
                }
              );
              await onSaved(result.id ?? machine?.id);
            } catch (error) {
              notify("error", error instanceof Error ? error.message : "保存失败");
            }
          }}>{machine ? "保存修改" : "创建机器"}</button>
        </div>
      </div>
    </Modal>
  );
}

type EditableAllocation =
  | {
      poolId: string;
      kind: "INDEX_RANGE";
      ranges: Array<{ start: number; end: number; label: string }>;
    }
  | { poolId: string; kind: "ITEM_LIST"; itemIds: string[] }
  | { poolId: string; kind: "CAPACITY"; quantity: number };

function resourcePoolKindLabel(kind: ResourcePool["kind"]) {
  return {
    INDEX_RANGE: "编号范围",
    ITEM_LIST: "设备列表",
    CAPACITY: "容量"
  }[kind];
}

function allocationInput(allocation: ResourceAllocation): EditableAllocation {
  if (allocation.kind === "INDEX_RANGE") {
    return {
      poolId: allocation.poolId,
      kind: "INDEX_RANGE",
      ranges: allocation.ranges.map((range) => ({
        start: range.start,
        end: range.end,
        label: range.label ?? ""
      }))
    };
  }
  if (allocation.kind === "ITEM_LIST") {
    return {
      poolId: allocation.poolId,
      kind: "ITEM_LIST",
      itemIds: allocation.items.map((item) => item.id)
    };
  }
  return {
    poolId: allocation.poolId,
    kind: "CAPACITY",
    quantity: allocation.quantity
  };
}

type ResourcePoolDraft = {
  id: string;
  expectedVersion: number;
  name: string;
  kind: ResourcePool["kind"];
  sharingMode: ResourcePool["sharingMode"];
  unit: string;
  description: string;
  sortOrder: number;
  rangeStart: number;
  rangeEnd: number;
  capacity: number;
  items: Array<{ id: string; key: string; label: string }>;
};

type ResourceGroupDraft = {
  id: string;
  expectedVersion: number;
  name: string;
  description: string;
  tags: string[];
  tagInput: string;
  sortOrder: number;
  status: ResourceGroup["status"];
  allocations: EditableAllocation[];
};

function resourcePoolDraft(pool: ResourcePool): ResourcePoolDraft {
  return {
    id: pool.id,
    expectedVersion: pool.version,
    name: pool.name,
    kind: pool.kind,
    sharingMode: pool.sharingMode,
    unit: pool.unit,
    description: pool.description,
    sortOrder: pool.sortOrder,
    rangeStart: pool.kind === "INDEX_RANGE" ? pool.rangeStart : 0,
    rangeEnd: pool.kind === "INDEX_RANGE" ? pool.rangeEnd : 0,
    capacity: pool.kind === "CAPACITY" ? pool.capacity : 1,
    items: pool.kind === "ITEM_LIST"
      ? pool.items.map((item) => ({
          id: item.id,
          key: item.key,
          label: item.label
        }))
      : []
  };
}

function resourceGroupDraft(group: ResourceGroup): ResourceGroupDraft {
  return {
    id: group.id,
    expectedVersion: group.version,
    name: group.name,
    description: group.description,
    tags: [...group.tags],
    tagInput: "",
    sortOrder: group.sortOrder,
    status: group.status,
    allocations: group.allocations.map(allocationInput)
  };
}

function resourcePoolDraftSummary(pool: ResourcePoolDraft) {
  const sharingSuffix = pool.sharingMode === "SHARED" ? " · 共享" : "";
  if (pool.kind === "INDEX_RANGE") {
    return `${pool.rangeStart}–${pool.rangeEnd} ${pool.unit}${sharingSuffix}`;
  }
  if (pool.kind === "ITEM_LIST") {
    return `${pool.items.length} ${pool.unit}${sharingSuffix}`;
  }
  return `${pool.capacity} ${pool.unit}${sharingSuffix}`;
}

function ResourceConfigurationModal({
  machine,
  pools,
  groups,
  onClose,
  onSaved,
  notify
}: {
  machine: any;
  pools: ResourcePool[];
  groups: ResourceGroup[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [section, setSection] = useState<"POOLS" | "GROUPS">("POOLS");
  const [draftPools, setDraftPools] = useState<ResourcePoolDraft[]>(
    () => pools.map(resourcePoolDraft)
  );
  const [draftGroups, setDraftGroups] = useState<ResourceGroupDraft[]>(
    () => groups.map(resourceGroupDraft)
  );
  const [deletedPools, setDeletedPools] = useState<
    Array<{ id: string; expectedVersion: number }>
  >([]);
  const [selectedPoolId, setSelectedPoolId] = useState(pools[0]?.id ?? "");
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id ?? "");
  const [draggingItemId, setDraggingItemId] = useState("");
  const [dragIndicator, setDragIndicator] = useState<{
    targetId: string;
    position: "BEFORE" | "AFTER";
  } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const selectedPool = draftPools.find((pool) => pool.id === selectedPoolId);
  const selectedGroup = draftGroups.find((group) => group.id === selectedGroupId);
  const validationIssues = useMemo(
    () => validateResourceConfigurationDraft(draftPools, draftGroups),
    [draftGroups, draftPools]
  );
  const issuesForPool = (poolId: string) =>
    validationIssues.filter(
      (issue) => issue.target === "POOL" && issue.poolId === poolId
    );
  const issuesForGroup = (groupId: string) =>
    validationIssues.filter((issue) => issue.groupId === groupId);
  const issuesForAllocation = (groupId: string, poolId: string) =>
    validationIssues.filter(
      (issue) =>
        issue.target === "ALLOCATION" &&
        issue.groupId === groupId &&
        issue.poolId === poolId
    );
  const hasPoolFieldIssue = (poolId: string, field: string) =>
    validationIssues.some(
      (issue) =>
        issue.target === "POOL" &&
        issue.poolId === poolId &&
        issue.field === field
    );
  const hasGroupFieldIssue = (groupId: string, field: string) =>
    validationIssues.some(
      (issue) =>
        issue.target === "GROUP" &&
        issue.groupId === groupId &&
        issue.field === field
    );

  const updatePool = (
    poolId: string,
    updater: (pool: ResourcePoolDraft) => ResourcePoolDraft
  ) => {
    setSaveError("");
    setDraftPools((current) =>
      current.map((pool) => pool.id === poolId ? updater(pool) : pool)
    );
  };

  const updateGroup = (
    groupId: string,
    updater: (group: ResourceGroupDraft) => ResourceGroupDraft
  ) => {
    setSaveError("");
    setDraftGroups((current) =>
      current.map((group) => group.id === groupId ? updater(group) : group)
    );
  };

  const dropResource = (
    targetId: string,
    position: "BEFORE" | "AFTER"
  ) => {
    if (!draggingItemId) return;
    if (section === "POOLS") {
      setDraftPools((current) =>
        reorderResourceDrafts(current, draggingItemId, targetId, position)
      );
    } else {
      setDraftGroups((current) =>
        reorderResourceDrafts(current, draggingItemId, targetId, position)
      );
    }
    setSaveError("");
    setDraggingItemId("");
    setDragIndicator(null);
  };

  const moveResourceByKeyboard = (itemId: string, direction: -1 | 1) => {
    const move = <T extends { id: string; sortOrder: number },>(current: T[]) => {
      const sourceIndex = current.findIndex((item) => item.id === itemId);
      const target = current[sourceIndex + direction];
      return target
        ? reorderResourceDrafts(
            current,
            itemId,
            target.id,
            direction < 0 ? "BEFORE" : "AFTER"
          )
        : current;
    };
    if (section === "POOLS") {
      setDraftPools(move);
    } else {
      setDraftGroups(move);
    }
    setSaveError("");
  };

  const addPool = () => {
    const id = createClientId();
    setSaveError("");
    setDraftPools((current) => [
      ...current,
      {
        id,
        expectedVersion: 0,
        name: "",
        kind: "INDEX_RANGE",
        sharingMode: "EXCLUSIVE",
        unit: "",
        description: "",
        sortOrder: current.length,
        rangeStart: 0,
        rangeEnd: 0,
        capacity: 1,
        items: []
      }
    ]);
    setSelectedPoolId(id);
  };

  const addGroup = () => {
    const id = createClientId();
    setSaveError("");
    setDraftGroups((current) => [
      ...current,
      {
        id,
        expectedVersion: 0,
        name: "",
        description: "",
        tags: [],
        tagInput: "",
        sortOrder: current.length,
        status: "ACTIVE",
        allocations: []
      }
    ]);
    setSelectedGroupId(id);
  };

  const removePool = async (poolId: string) => {
    const pool = draftPools.find((candidate) => candidate.id === poolId);
    if (!pool) return;
    if (
      pool.expectedVersion > 0 &&
      !(await dialog.confirm({
        title: "删除资源项",
        message: `保存配置后将永久删除 ${pool.name}。使用该资源项的资源组也需要在本次编辑中调整。`,
        confirmLabel: "删除资源项",
        tone: "danger"
      }))
    ) {
      return;
    }
    const remaining = draftPools.filter((pool) => pool.id !== poolId);
    setDraftPools(remaining);
    if (pool.expectedVersion > 0) {
      setDeletedPools((current) => [
        ...current,
        { id: pool.id, expectedVersion: pool.expectedVersion }
      ]);
    }
    setDraftGroups((current) =>
      current.map((group) => ({
        ...group,
        allocations: group.allocations.filter(
          (allocation) => allocation.poolId !== poolId
        )
      }))
    );
    setSelectedPoolId(remaining[0]?.id ?? "");
    setSaveError("");
  };

  const removeNewGroup = (groupId: string) => {
    const remaining = draftGroups.filter((group) => group.id !== groupId);
    setDraftGroups(remaining);
    setSelectedGroupId(remaining[0]?.id ?? "");
    setSaveError("");
  };

  const toggleAllocation = (
    group: ResourceGroupDraft,
    pool: ResourcePoolDraft
  ) => {
    updateGroup(group.id, (current) => {
      const exists = current.allocations.some(
        (allocation) => allocation.poolId === pool.id
      );
      if (exists) {
        return {
          ...current,
          allocations: current.allocations.filter(
            (allocation) => allocation.poolId !== pool.id
          )
        };
      }
      const allocation: EditableAllocation = pool.kind === "INDEX_RANGE"
        ? {
            poolId: pool.id,
            kind: "INDEX_RANGE",
            ranges: [{
              start: pool.rangeStart,
              end: pool.rangeStart,
              label: ""
            }]
          }
        : pool.kind === "ITEM_LIST"
          ? { poolId: pool.id, kind: "ITEM_LIST", itemIds: [] }
          : {
              poolId: pool.id,
              kind: "CAPACITY",
              quantity:
                pool.sharingMode === "SHARED" ? pool.capacity : 0
            };
      return {
        ...current,
        allocations: [...current.allocations, allocation]
      };
    });
  };

  const updateAllocation = (
    groupId: string,
    poolId: string,
    updater: (allocation: EditableAllocation) => EditableAllocation
  ) => {
    updateGroup(groupId, (group) => ({
      ...group,
      allocations: group.allocations.map((allocation) =>
        allocation.poolId === poolId ? updater(allocation) : allocation
      )
    }));
  };

  const save = async () => {
    if (validationIssues.length) return;
    setSaving(true);
    setSaveError("");
    try {
      await api(`/admin/machines/${machine.id}/resource-configuration`, {
        method: "PUT",
        body: jsonBody({
          pools: draftPools.map((pool) => ({
            id: pool.id,
            expectedVersion: pool.expectedVersion,
            name: pool.name,
            kind: pool.kind,
            sharingMode: pool.sharingMode,
            unit: pool.unit,
            description: pool.description,
            sortOrder: pool.sortOrder,
            ...(pool.kind === "INDEX_RANGE"
              ? {
                  rangeStart: pool.rangeStart,
                  rangeEnd: pool.rangeEnd
                }
              : {}),
            ...(pool.kind === "ITEM_LIST" ? { items: pool.items } : {}),
            ...(pool.kind === "CAPACITY"
              ? { capacity: pool.capacity }
              : {})
          })),
          groups: draftGroups.map((group) => ({
            id: group.id,
            expectedVersion: group.expectedVersion,
            name: group.name,
            description: group.description,
            tags: group.tags,
            sortOrder: group.sortOrder,
            allocations: group.allocations
          })),
          deletedPools
        })
      });
      notify("success", "资源配置已保存");
      await onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "资源配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`编辑资源：${machine.name}`} onClose={onClose} large>
      <div className="resource-config-editor">
        <div className="resource-config-tabs" role="tablist" aria-label="资源编辑内容">
          <button
            type="button"
            role="tab"
            aria-selected={section === "POOLS"}
            className={section === "POOLS" ? "active" : ""}
            onClick={() => setSection("POOLS")}
          >
            资源配置
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === "GROUPS"}
            className={section === "GROUPS" ? "active" : ""}
            onClick={() => setSection("GROUPS")}
          >
            资源组
          </button>
        </div>

        <div className="resource-config-workspace">
          <aside className="resource-config-list">
            <button
              type="button"
              className="secondary-button compact resource-config-add"
              onClick={section === "POOLS" ? addPool : addGroup}
            >
              <Plus size={14} />
              {section === "POOLS" ? "新增资源项" : "新增资源组"}
            </button>
            <div
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (
                  nextTarget instanceof Node &&
                  event.currentTarget.contains(nextTarget)
                ) {
                  return;
                }
                setDragIndicator(null);
              }}
            >
              {(section === "POOLS" ? draftPools : draftGroups).map((item) => {
                const active = section === "POOLS"
                  ? selectedPoolId === item.id
                  : selectedGroupId === item.id;
                const secondary = "kind" in item
                  ? resourcePoolDraftSummary(item)
                  : `${item.allocations.length} 项资源`;
                const issueCount = section === "POOLS"
                  ? issuesForPool(item.id).length
                  : issuesForGroup(item.id).length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={[
                      active ? "active" : "",
                      issueCount ? "has-errors" : "",
                      "draggable",
                      draggingItemId === item.id ? "dragging" : "",
                      dragIndicator?.targetId === item.id &&
                      draggingItemId !== item.id
                        ? dragIndicator.position === "BEFORE"
                          ? "drop-before"
                          : "drop-after"
                        : ""
                    ].filter(Boolean).join(" ")}
                    draggable
                    title="拖动调整顺序；也可以按 Alt + 上下方向键"
                    onDragStart={(event) => {
                      setDraggingItemId(item.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.id);
                    }}
                    onDragOver={(event) => {
                      if (
                        !draggingItemId ||
                        draggingItemId === item.id
                      ) {
                        setDragIndicator(null);
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      setDragIndicator({
                        targetId: item.id,
                        position:
                          event.clientY < bounds.top + bounds.height / 2
                            ? "BEFORE"
                            : "AFTER"
                      });
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (
                        dragIndicator?.targetId === item.id &&
                        draggingItemId !== item.id
                      ) {
                        dropResource(item.id, dragIndicator.position);
                      }
                    }}
                    onDragEnd={() => {
                      setDraggingItemId("");
                      setDragIndicator(null);
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey) return;
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveResourceByKeyboard(item.id, -1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveResourceByKeyboard(item.id, 1);
                      }
                    }}
                    onClick={() => {
                      if (section === "POOLS") setSelectedPoolId(item.id);
                      else setSelectedGroupId(item.id);
                    }}
                  >
                    <span className="resource-config-list-name">
                      <GripVertical size={13} aria-hidden="true" />
                      <strong>{item.name || "未命名"}</strong>
                    </span>
                    <small>{secondary}</small>
                    {issueCount > 0 && (
                      <span className="resource-config-error-count">
                        <i />
                        {issueCount} 个问题
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="resource-config-form">
            {section === "POOLS" && selectedPool ? (
              <>
                <div className="resource-config-form-head">
                  <strong>{selectedPool.name || "新资源项"}</strong>
                  <div>
                    {issuesForPool(selectedPool.id).length > 0 && (
                      <span className="resource-config-conflict-chip">
                        {issuesForPool(selectedPool.id).length} 个问题
                      </span>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact danger"
                      onClick={() => void removePool(selectedPool.id)}
                    >
                      <Trash2 size={14} />
                      {selectedPool.expectedVersion === 0
                        ? "删除草稿"
                        : "删除资源项"}
                    </button>
                  </div>
                </div>
                <div className="two-fields">
                  <Field label="资源项名称">
                    <input
                      className={
                        hasPoolFieldIssue(selectedPool.id, "name")
                          ? "resource-config-invalid"
                          : ""
                      }
                      aria-invalid={hasPoolFieldIssue(selectedPool.id, "name")}
                      value={selectedPool.name}
                      onChange={(event) =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          name: event.target.value
                        }))}
                    />
                  </Field>
                  <Field label="分配方式">
                    <select
                      value={selectedPool.kind}
                      disabled={selectedPool.expectedVersion > 0}
                      onChange={(event) => {
                        const kind = event.target.value as ResourcePool["kind"];
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          kind,
                          items: kind === "ITEM_LIST" && !pool.items.length
                            ? [{
                                id: createClientId(),
                                key: "",
                                label: ""
                              }]
                            : pool.items
                        }));
                        setDraftGroups((current) =>
                          current.map((group) => ({
                            ...group,
                            allocations: group.allocations.filter(
                              (allocation) =>
                                allocation.poolId !== selectedPool.id
                            )
                          }))
                        );
                      }}
                    >
                      <option value="INDEX_RANGE">编号范围</option>
                      <option value="ITEM_LIST">设备列表</option>
                      <option value="CAPACITY">容量</option>
                    </select>
                  </Field>
                </div>
                <div className="two-fields">
                  <Field label="单位">
                    <input
                      className={
                        hasPoolFieldIssue(selectedPool.id, "unit")
                          ? "resource-config-invalid"
                          : ""
                      }
                      aria-invalid={hasPoolFieldIssue(selectedPool.id, "unit")}
                      value={selectedPool.unit}
                      onChange={(event) =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          unit: event.target.value
                        }))}
                    />
                  </Field>
                  <Field label="使用方式">
                    <select
                      value={selectedPool.sharingMode}
                      onChange={(event) => {
                        const sharingMode =
                          event.target.value as ResourcePool["sharingMode"];
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          sharingMode
                        }));
                        if (
                          sharingMode === "SHARED" &&
                          selectedPool.kind === "CAPACITY"
                        ) {
                          setDraftGroups((current) =>
                            current.map((group) => ({
                              ...group,
                              allocations: group.allocations.map((allocation) =>
                                allocation.poolId === selectedPool.id &&
                                allocation.kind === "CAPACITY"
                                  ? {
                                      ...allocation,
                                      quantity: selectedPool.capacity
                                    }
                                  : allocation
                              )
                            }))
                          );
                        }
                      }}
                    >
                      <option value="EXCLUSIVE">独占分配</option>
                      <option value="SHARED">共享使用</option>
                    </select>
                  </Field>
                </div>
                {selectedPool.kind === "INDEX_RANGE" && (
                  <div className="two-fields">
                    <Field label="起始编号">
                      <input
                        type="number"
                        className={
                          hasPoolFieldIssue(selectedPool.id, "range")
                            ? "resource-config-invalid"
                            : ""
                        }
                        aria-invalid={hasPoolFieldIssue(
                          selectedPool.id,
                          "range"
                        )}
                        value={selectedPool.rangeStart}
                        onChange={(event) =>
                          updatePool(selectedPool.id, (pool) => ({
                            ...pool,
                            rangeStart: Number(event.target.value)
                          }))}
                      />
                    </Field>
                    <Field label="结束编号（包含）">
                      <input
                        type="number"
                        className={
                          hasPoolFieldIssue(selectedPool.id, "range")
                            ? "resource-config-invalid"
                            : ""
                        }
                        aria-invalid={hasPoolFieldIssue(
                          selectedPool.id,
                          "range"
                        )}
                        value={selectedPool.rangeEnd}
                        onChange={(event) =>
                          updatePool(selectedPool.id, (pool) => ({
                            ...pool,
                            rangeEnd: Number(event.target.value)
                          }))}
                      />
                    </Field>
                  </div>
                )}
                {selectedPool.kind === "CAPACITY" && (
                  <Field label={`总容量${selectedPool.unit ? `（${selectedPool.unit}）` : ""}`}>
                    <input
                      type="number"
                      step="0.001"
                      className={
                        hasPoolFieldIssue(selectedPool.id, "capacity")
                          ? "resource-config-invalid"
                          : ""
                      }
                      aria-invalid={hasPoolFieldIssue(
                        selectedPool.id,
                        "capacity"
                      )}
                      value={selectedPool.capacity}
                      onChange={(event) =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          capacity: Number(event.target.value)
                        }))}
                    />
                  </Field>
                )}
                {selectedPool.kind === "ITEM_LIST" && (
                  <div
                    className={[
                      "resource-item-editor",
                      hasPoolFieldIssue(selectedPool.id, "items")
                        ? "resource-config-invalid-region"
                        : ""
                    ].filter(Boolean).join(" ")}
                  >
                    <div className="section-label"><span>设备</span></div>
                    {selectedPool.items.map((item, index) => (
                      <div className="resource-item-row" key={item.id}>
                        <input
                          aria-label={`设备 ${index + 1} 标识`}
                          value={item.key}
                          onChange={(event) =>
                            updatePool(selectedPool.id, (pool) => ({
                              ...pool,
                              items: pool.items.map((candidate) =>
                                candidate.id === item.id
                                  ? { ...candidate, key: event.target.value }
                                  : candidate
                              )
                            }))}
                        />
                        <input
                          aria-label={`设备 ${index + 1} 名称`}
                          value={item.label}
                          onChange={(event) =>
                            updatePool(selectedPool.id, (pool) => ({
                              ...pool,
                              items: pool.items.map((candidate) =>
                                candidate.id === item.id
                                  ? { ...candidate, label: event.target.value }
                                  : candidate
                              )
                            }))}
                        />
                        <button
                          type="button"
                          className="icon-button tiny danger"
                          aria-label={`删除设备 ${index + 1}`}
                          onClick={() =>
                            updatePool(selectedPool.id, (pool) => ({
                              ...pool,
                              items: pool.items.filter(
                                (candidate) => candidate.id !== item.id
                              )
                            }))}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          items: [
                            ...pool.items,
                            {
                              id: createClientId(),
                              key: "",
                              label: ""
                            }
                          ]
                        }))}
                    >
                      <Plus size={14} />添加设备
                    </button>
                  </div>
                )}
                <Field label="说明">
                  <textarea
                    rows={3}
                    className={
                      hasPoolFieldIssue(selectedPool.id, "description")
                        ? "resource-config-invalid"
                        : ""
                    }
                    aria-invalid={hasPoolFieldIssue(
                      selectedPool.id,
                      "description"
                    )}
                    value={selectedPool.description}
                    onChange={(event) =>
                      updatePool(selectedPool.id, (pool) => ({
                        ...pool,
                        description: event.target.value
                      }))}
                  />
                </Field>
                {issuesForPool(selectedPool.id).length > 0 && (
                  <div className="resource-config-inline-errors" role="alert">
                    {issuesForPool(selectedPool.id).map((issue) => (
                      <span key={`${issue.field}:${issue.message}`}>
                        <CircleAlert size={13} />
                        {issue.message}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : section === "GROUPS" && selectedGroup ? (
              <>
                <div className="resource-config-form-head">
                  <strong>{selectedGroup.name || "新资源组"}</strong>
                  <div>
                    {issuesForGroup(selectedGroup.id).length > 0 && (
                      <span className="resource-config-conflict-chip">
                        {issuesForGroup(selectedGroup.id).length} 个问题
                      </span>
                    )}
                    {selectedGroup.expectedVersion === 0 && (
                      <button
                        type="button"
                        className="secondary-button compact danger"
                        onClick={() => removeNewGroup(selectedGroup.id)}
                      >
                        <Trash2 size={14} />删除草稿
                      </button>
                    )}
                  </div>
                </div>
                <Field label="资源组名称">
                  <input
                    className={
                      hasGroupFieldIssue(selectedGroup.id, "name")
                        ? "resource-config-invalid"
                        : ""
                    }
                    aria-invalid={hasGroupFieldIssue(
                      selectedGroup.id,
                      "name"
                    )}
                    value={selectedGroup.name}
                    onChange={(event) =>
                      updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        name: event.target.value
                      }))}
                  />
                </Field>
                <div className="field">
                  <span>标签</span>
                  <TagEditor
                    tags={selectedGroup.tags}
                    input={selectedGroup.tagInput}
                    invalid={hasGroupFieldIssue(selectedGroup.id, "tags")}
                    onChange={(tags, tagInput) =>
                      updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        tags,
                        tagInput
                      }))}
                  />
                </div>
                <div className="resource-allocation-editor">
                  <div className="section-label"><span>资源组成</span></div>
                  {draftPools.map((pool) => {
                    const allocation = selectedGroup.allocations.find(
                      (candidate) => candidate.poolId === pool.id
                    );
                    const allocationIssues = issuesForAllocation(
                      selectedGroup.id,
                      pool.id
                    );
                    return (
                      <section
                        className={[
                          "resource-allocation-card",
                          allocation ? "selected" : "",
                          allocationIssues.length ? "conflict" : ""
                        ].filter(Boolean).join(" ")}
                        key={pool.id}
                      >
                        <label className="resource-allocation-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(allocation)}
                            onChange={() => toggleAllocation(selectedGroup, pool)}
                          />
                          <span>
                            <strong>{pool.name || "未命名资源项"}</strong>
                            <small>
                              {resourcePoolKindLabel(pool.kind)} ·
                              {" "}{resourcePoolDraftSummary(pool)}
                            </small>
                          </span>
                        </label>
                        {allocation?.kind === "INDEX_RANGE" &&
                          pool.kind === "INDEX_RANGE" && (
                          <div className="range-allocation-list">
                            {allocation.ranges.map((range, index) => (
                              <div className="range-allocation-row" key={index}>
                                <input
                                  aria-label="起始编号"
                                  type="number"
                                  value={range.start}
                                  onChange={(event) =>
                                    updateAllocation(
                                      selectedGroup.id,
                                      pool.id,
                                      (value) => value.kind === "INDEX_RANGE"
                                        ? {
                                            ...value,
                                            ranges: value.ranges.map(
                                              (candidate, candidateIndex) =>
                                                candidateIndex === index
                                                  ? {
                                                      ...candidate,
                                                      start: Number(event.target.value)
                                                    }
                                                  : candidate
                                            )
                                          }
                                        : value
                                    )}
                                />
                                <span>—</span>
                                <input
                                  aria-label="结束编号"
                                  type="number"
                                  value={range.end}
                                  onChange={(event) =>
                                    updateAllocation(
                                      selectedGroup.id,
                                      pool.id,
                                      (value) => value.kind === "INDEX_RANGE"
                                        ? {
                                            ...value,
                                            ranges: value.ranges.map(
                                              (candidate, candidateIndex) =>
                                                candidateIndex === index
                                                  ? {
                                                      ...candidate,
                                                      end: Number(event.target.value)
                                                    }
                                                  : candidate
                                            )
                                          }
                                        : value
                                    )}
                                />
                                <input
                                  aria-label="拓扑标签"
                                  value={range.label}
                                  onChange={(event) =>
                                    updateAllocation(
                                      selectedGroup.id,
                                      pool.id,
                                      (value) => value.kind === "INDEX_RANGE"
                                        ? {
                                            ...value,
                                            ranges: value.ranges.map(
                                              (candidate, candidateIndex) =>
                                                candidateIndex === index
                                                  ? {
                                                      ...candidate,
                                                      label: event.target.value
                                                    }
                                                  : candidate
                                            )
                                          }
                                        : value
                                    )}
                                />
                                <button
                                  type="button"
                                  className="icon-button tiny danger"
                                  aria-label={`删除区间 ${index + 1}`}
                                  onClick={() =>
                                    updateAllocation(
                                      selectedGroup.id,
                                      pool.id,
                                      (value) => value.kind === "INDEX_RANGE"
                                        ? {
                                            ...value,
                                            ranges: value.ranges.filter(
                                              (_, candidateIndex) =>
                                                candidateIndex !== index
                                            )
                                          }
                                        : value
                                    )}
                                >
                                  <X size={14} />
                                </button>
                              </div>
                            ))}
                            <button
                              type="button"
                              className="secondary-button compact"
                              onClick={() =>
                                updateAllocation(
                                  selectedGroup.id,
                                  pool.id,
                                  (value) => value.kind === "INDEX_RANGE"
                                    ? {
                                        ...value,
                                        ranges: [
                                          ...value.ranges,
                                          {
                                            start: pool.rangeStart,
                                            end: pool.rangeStart,
                                            label: ""
                                          }
                                        ]
                                      }
                                    : value
                                )}
                            >
                              <Plus size={14} />添加区间
                            </button>
                          </div>
                        )}
                        {allocation?.kind === "ITEM_LIST" &&
                          pool.kind === "ITEM_LIST" && (
                          <div className="device-choice-grid">
                            {pool.items.map((item) => (
                              <label key={item.id}>
                                <input
                                  type="checkbox"
                                  checked={allocation.itemIds.includes(item.id)}
                                  onChange={() =>
                                    updateAllocation(
                                      selectedGroup.id,
                                      pool.id,
                                      (value) => value.kind === "ITEM_LIST"
                                        ? {
                                            ...value,
                                            itemIds: value.itemIds.includes(item.id)
                                              ? value.itemIds.filter(
                                                  (id) => id !== item.id
                                                )
                                              : [...value.itemIds, item.id]
                                          }
                                        : value
                                    )}
                                />
                                <span>
                                  <strong>{item.key || "未命名设备"}</strong>
                                  <small>{item.label || "未填写名称"}</small>
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                        {allocation?.kind === "CAPACITY" &&
                          pool.kind === "CAPACITY" &&
                          pool.sharingMode === "EXCLUSIVE" && (
                          <Field label={`分配数量（${pool.unit || "未填写单位"}）`}>
                            <input
                              type="number"
                              step="0.001"
                              value={allocation.quantity || ""}
                              onChange={(event) =>
                                updateAllocation(
                                  selectedGroup.id,
                                  pool.id,
                                  (value) => value.kind === "CAPACITY"
                                    ? {
                                        ...value,
                                        quantity: Number(event.target.value)
                                      }
                                    : value
                                )}
                            />
                          </Field>
                        )}
                        {allocationIssues.length > 0 && (
                          <div
                            className="resource-allocation-errors"
                            role="alert"
                          >
                            {allocationIssues.map((issue) => (
                              <span key={`${issue.field}:${issue.message}`}>
                                <CircleAlert size={12} />
                                {issue.message}
                              </span>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
                <Field label="说明">
                  <textarea
                    rows={3}
                    className={
                      hasGroupFieldIssue(selectedGroup.id, "description")
                        ? "resource-config-invalid"
                        : ""
                    }
                    aria-invalid={hasGroupFieldIssue(
                      selectedGroup.id,
                      "description"
                    )}
                    value={selectedGroup.description}
                    onChange={(event) =>
                      updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        description: event.target.value
                      }))}
                  />
                </Field>
                {issuesForGroup(selectedGroup.id).some(
                  (issue) => issue.target === "GROUP"
                ) && (
                  <div className="resource-config-inline-errors" role="alert">
                    {issuesForGroup(selectedGroup.id)
                      .filter((issue) => issue.target === "GROUP")
                      .map((issue) => (
                        <span key={`${issue.field}:${issue.message}`}>
                          <CircleAlert size={13} />
                          {issue.message}
                        </span>
                      ))}
                  </div>
                )}
              </>
            ) : (
              <div className="mini-empty">
                {section === "POOLS" ? "请新增资源项" : "请新增资源组"}
              </div>
            )}
          </div>
        </div>

        {validationIssues.length > 0 && (
          <div className="resource-config-validation-summary" role="status">
            <CircleAlert size={15} />
            <span>
              当前有 {validationIssues.length} 个问题，请检查红色标记。
            </span>
          </div>
        )}
        {saveError && (
          <div className="resource-config-save-error" role="alert">
            <CircleAlert size={15} />
            <span>{saveError}</span>
          </div>
        )}
        <div className="modal-actions resource-config-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void save()}
            disabled={saving || validationIssues.length > 0}
          >
            <BusyButtonContent busy={saving}>保存配置</BusyButtonContent>
          </button>
        </div>
      </div>
    </Modal>
  );
}

function UserAdminPanel({
  users,
  canManage,
  notify,
  reload
}: {
  users: any[];
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reload: () => Promise<void>;
}) {
  const dialog = useAppDialog();
  const [passwordResetLink, setPasswordResetLink] = useState<{
    displayName: string;
    resetUrl: string;
    expiresAt: string;
  } | null>(null);
  const processRegistration = async (
    action: () => Promise<unknown>,
    successMessage: string
  ) => {
    try {
      await action();
      notify("success", successMessage);
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        notify("error", "注册信息已被更新，用户列表已刷新。");
        await reload();
        return;
      }
      notify("error", error instanceof Error ? error.message : "处理失败");
    }
  };

  const disableUser = async (user: any) => {
    try {
      const preview = await api<{
        user: {
          id: string;
          displayName: string;
          status: string;
          version: number;
        };
        counts: {
          activeReservations: number;
          futureReservations: number;
          machineMemberships: number;
          machineAdminRoles: number;
          pendingProfileChanges: number;
        };
        revision: number;
      }>(`/admin/users/${user.id}/disable/preview`, {
        method: "POST",
        body: "{}"
      });
      const reason = await dialog.prompt({
        title: "停用账号",
        message:
          `停用 ${preview.user.displayName} 后将结束 ${preview.counts.activeReservations} 条当前占用，并取消 ${preview.counts.futureReservations} 条未来占用。\n` +
          `该用户在 ${preview.counts.machineMemberships} 台机器中拥有使用权，其中管理 ${preview.counts.machineAdminRoles} 台；这些关系会保留，但停用期间不可使用。` +
          (preview.counts.pendingProfileChanges
            ? `\n另有 ${preview.counts.pendingProfileChanges} 条资料修改申请将被取消。`
            : ""),
        label: "原因（选填）",
        multiline: true,
        maxLength: 500,
        confirmLabel: "确认停用",
        tone: "danger"
      });
      if (reason === null) return;
      await api(`/admin/users/${user.id}/disable`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: preview.user.version,
          expectedRevision: preview.revision,
          reason: reason.trim()
        })
      });
      notify("success", "账号已停用，相关占用已释放");
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reload();
      }
      notify("error", error instanceof Error ? error.message : "更新失败");
    }
  };
  const enableUser = async (user: any) => {
    try {
      await api(`/admin/users/${user.id}/enable`, {
        method: "POST",
        body: jsonBody({ expectedVersion: Number(user.version) })
      });
      notify("success", "账号已重新启用");
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reload();
      }
      notify("error", error instanceof Error ? error.message : "更新失败");
    }
  };
  const deleteUser = async (user: any) => {
    try {
      const impact = await api<{
        user: {
          id: string;
          displayName: string;
          status: string;
          version: number;
        };
        counts: {
          machineMemberships: number;
          machineAdminRoles: number;
          accessRequests: number;
          reservations: number;
          notifications: number;
          auditLogs: number;
          feedbackTickets: number;
          feedbackActivities: number;
        };
      }>(`/admin/users/${user.id}/deletion-impact`);
      if (impact.user.status !== "DISABLED") {
        notify("error", "请先停用账号，再进行删除");
        await reload();
        return;
      }
      const permissionCount =
        impact.counts.machineMemberships + impact.counts.machineAdminRoles;
      if (!(await dialog.confirm({
        title: "永久删除用户",
        message:
          `删除 ${impact.user.displayName} 后无法恢复，用户名、邮箱和工号将被释放。\n` +
          `将清除 ${permissionCount} 项机器权限、${impact.counts.accessRequests} 条使用权申请和 ${impact.counts.notifications} 条通知。\n` +
          `将保留 ${impact.counts.reservations} 条占用记录、${impact.counts.feedbackTickets} 条反馈及 ${impact.counts.feedbackActivities} 条反馈活动和 ${impact.counts.auditLogs} 条审计记录，其中用户统一显示为“用户已删除”。`,
        confirmLabel: "永久删除",
        tone: "danger"
      }))) {
        return;
      }
      await api(`/admin/users/${user.id}`, {
        method: "DELETE",
        body: jsonBody({ expectedVersion: impact.user.version })
      });
      notify("success", "用户已永久删除");
      await reload();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reload();
      }
      notify(
        "error",
        error instanceof Error ? error.message : "删除用户失败"
      );
    }
  };
  const processProfileChange = async (
    user: any,
    action: "approve" | "reject"
  ) => {
    const request = user.pendingProfileChange;
    if (!request) return;
    let reason = "";
    if (action === "reject") {
      const enteredReason = await dialog.prompt({
        title: "不通过资料修改",
        message: `确认不通过 ${user.displayName} 提交的资料修改？`,
        label: "原因（选填）",
        multiline: true,
        maxLength: 500,
        confirmLabel: "确认不通过"
      });
      if (enteredReason === null) return;
      reason = enteredReason.trim();
    }
    try {
      await api(`/admin/profile-change-requests/${request.id}/${action}`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: Number(request.expectedVersion),
          ...(action === "reject" ? { reason } : {})
        })
      });
      notify("success", action === "approve" ? "资料修改已通过" : "资料修改未通过");
      await reload();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "PROFILE_CHANGE_ALREADY_PROCESSED"
      ) {
        notify("error", "该资料修改已被处理，申请列表已刷新。");
        await reload();
        return;
      }
      notify("error", error instanceof Error ? error.message : "处理失败");
    }
  };
  const accountUsers = canManage
    ? users.filter((user) => ["ACTIVE", "DISABLED"].includes(user.status))
    : users;
  const applications = canManage ? [
    ...users
      .filter((user) =>
        ["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(user.status)
      )
      .map((user) => ({
        key: `registration-${user.id}`,
        type: "REGISTRATION" as const,
        user,
        submittedAt: user.lastSubmittedAt ?? user.createdAt
      })),
    ...accountUsers
      .filter((user) => user.pendingProfileChange)
      .map((user) => ({
        key: `profile-${user.pendingProfileChange.id}`,
        type: "PROFILE_CHANGE" as const,
        user,
        submittedAt: user.pendingProfileChange.requestedAt
      }))
  ].sort(
    (left, right) =>
      new Date(right.submittedAt).getTime() -
      new Date(left.submittedAt).getTime()
  ) : [];
  return (
    <div className="user-management-page">
      <PageHeader title="用户管理" />
      <div className="user-management-sections">
        <section className="card panel-card user-list-panel">
          <SectionHeader
            title="用户列表"
            actions={<span className="request-count">{accountUsers.length}</span>}
          />
          <div className="admin-table user-account-table">
            <div className={`admin-table-row user-account-row head${canManage ? "" : " directory"}`}>
              <span>用户</span><span>工号</span>
              {canManage && (
                <>
                  <span>邮箱</span>
                  <span>最后登录时间</span>
                  <span>状态</span>
                  <span />
                </>
              )}
              {!canManage && <span>状态</span>}
            </div>
            {accountUsers.map((user) => (
              <div
                className={`admin-table-row user-account-row${canManage ? "" : " directory"}`}
                key={user.id ?? user.username}
              >
                <div className="member-identity">
                  <div className="avatar small">{user.displayName.slice(0, 1)}</div>
                  <span>
                    <strong>{user.displayName}</strong>
                    <small>@{user.username}</small>
                  </span>
                </div>
                <strong className="user-account-employee-number">
                  {user.employeeNumber ?? "暂无工号"}
                </strong>
                {!canManage && (
                  <span className={`state-chip ${user.status.toLowerCase()}`}>
                    {userStatusLabel(user.status)}
                  </span>
                )}
                {canManage && (
                  <>
                    <span className="user-account-email" title={user.email || undefined}>
                      {user.email || "未填写邮箱"}
                    </span>
                    <time className="user-account-last-login">
                      {user.lastLoginAt
                        ? formatChinaFullMinute(user.lastLoginAt)
                        : "从未登录"}
                    </time>
                    <span className={`state-chip ${user.status.toLowerCase()}`}>
                      <span
                        title={
                          user.status === "DISABLED"
                            ? [
                                user.disabledAt
                                  ? `停用于 ${formatChinaFullMinute(user.disabledAt)}`
                                  : "账号已停用",
                                user.disableReason || ""
                              ].filter(Boolean).join(" · ")
                            : undefined
                        }
                      >
                        {userStatusLabel(user.status)}
                      </span>
                    </span>
                    <div className="row-actions">
                      {user.status === "ACTIVE" && user.role !== "SYSTEM_ADMIN" && (
                        <button
                          type="button"
                          className="icon-button tiny list-icon-action danger"
                          title="停用账号"
                          aria-label={`停用 ${user.displayName} 并释放相关占用`}
                          onClick={() => void disableUser(user)}
                        >
                          <UserX size={14} />
                        </button>
                      )}
                      {user.status === "DISABLED" && (
                        <>
                          <button
                            type="button"
                            className="icon-button tiny list-icon-action approve"
                            title="重新启用"
                            aria-label={`重新启用 ${user.displayName}`}
                            onClick={() => void enableUser(user)}
                          >
                            <UserCheck size={14} />
                          </button>
                          {user.role !== "SYSTEM_ADMIN" && (
                            <button
                              type="button"
                              className="icon-button tiny list-icon-action danger destructive"
                              title="永久删除用户"
                              aria-label={`永久删除 ${user.displayName}`}
                              onClick={() => void deleteUser(user)}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                      {user.status === "ACTIVE" &&
                        user.role !== "SYSTEM_ADMIN" && (
                        <button
                          type="button"
                          className="icon-button tiny list-icon-action"
                          title="生成重置链接"
                          aria-label={`为 ${user.displayName} 生成密码重置链接`}
                          onClick={async () => {
                            try {
                              const result = await api<{
                                resetUrl: string;
                                expiresAt: string;
                              }>(
                                `/admin/users/${user.id}/password-reset-link`,
                                {
                                  method: "POST",
                                  body: "{}"
                                }
                              );
                              setPasswordResetLink({
                                displayName: user.displayName,
                                ...result
                              });
                            } catch (error) {
                              notify(
                                "error",
                                error instanceof Error
                                  ? error.message
                                  : "重置链接生成失败"
                              );
                            }
                          }}
                        >
                          <KeyRound size={14} />
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
            {!accountUsers.length && <div className="mini-empty">暂无正式用户</div>}
          </div>
        </section>

        {applications.length > 0 && (
        <section className="card panel-card user-application-panel">
          <SectionHeader
            title="申请列表"
            actions={<span className="request-count">{applications.length}</span>}
          />
          <div className="user-application-list">
            <div className="user-application-row head">
              <span>申请人</span><span>工号</span><span>邮箱</span>
              <span>提交时间</span><span>状态</span><span />
            </div>
            {applications.map((application) => {
              const user = application.user;
              const profileRequest = user.pendingProfileChange;
              const isRegistration = application.type === "REGISTRATION";
              return (
                <div className="user-application-row" key={application.key}>
                  <div className="member-identity">
                    <div className="avatar small">{user.displayName.slice(0, 1)}</div>
                    <span>
                      <strong>
                        {isRegistration ? user.displayName : profileRequest.displayName}
                      </strong>
                      <small className="application-user-meta">
                        <span>
                          {!isRegistration && profileRequest.displayName !== user.displayName
                            ? `原姓名：${user.displayName} · @${user.username}`
                            : `@${user.username}`}
                        </span>
                        {isRegistration && (
                          <span className="application-new-user-tag">新用户</span>
                        )}
                      </small>
                    </span>
                  </div>
                  {!isRegistration && profileRequest.employeeNumber !== user.employeeNumber ? (
                    <div className="application-field-change">
                      <del>{user.employeeNumber || "无"}</del>
                      <ChevronRight size={13} />
                      <strong>{profileRequest.employeeNumber}</strong>
                    </div>
                  ) : (
                    <strong className="application-employee-number">
                      {isRegistration
                        ? user.pendingEmployeeNumber ?? user.employeeNumber ?? "未填写"
                        : profileRequest.employeeNumber}
                    </strong>
                  )}
                  <span className="application-email" title={user.email || undefined}>
                    {user.email || "未填写邮箱"}
                  </span>
                  <time>{formatChinaFullMinute(application.submittedAt)}</time>
                  <span className={`state-chip ${
                    isRegistration && user.status === "CHANGES_REQUESTED"
                      ? "retiring"
                      : "pending"
                  }`}>
                    {isRegistration && user.status === "CHANGES_REQUESTED"
                      ? "待修改"
                      : "待审核"}
                  </span>
                  <div className="row-actions application-actions">
                    {isRegistration && (
                      <>
                        {user.status === "PENDING_APPROVAL" ? (
                          <>
                            <button
                              type="button"
                              className="icon-button tiny list-icon-action approve"
                              title="通过注册"
                              aria-label={`通过 ${user.displayName} 的注册`}
                              onClick={() => void processRegistration(
                                () => api(`/admin/users/${user.id}/approve`, {
                                  method: "POST",
                                  body: jsonBody({
                                    expectedRevision: Number(user.applicationRevision)
                                  })
                                }),
                                "账号已批准"
                              )}
                            >
                              <Check size={15} />
                            </button>
                            <button
                              type="button"
                              className="icon-button tiny list-icon-action danger"
                              title="不通过，要求修改"
                              aria-label={`${user.displayName} 的注册不通过，要求修改`}
                              onClick={async () => {
                                const reason = await dialog.prompt({
                                  title: "要求修改注册信息",
                                  message: `提交后，${user.displayName} 可以更新资料并重新进入审核。`,
                                  label: "需要修改的内容（选填）",
                                  multiline: true,
                                  maxLength: 500,
                                  confirmLabel: "发送要求"
                                });
                                if (reason === null) return;
                                await processRegistration(
                                  () => api(`/admin/users/${user.id}/return`, {
                                    method: "POST",
                                    body: jsonBody({
                                      expectedRevision: Number(user.applicationRevision),
                                      reason: reason.trim()
                                    })
                                  }),
                                  "已要求用户修改注册信息"
                                );
                              }}
                            >
                              <X size={15} />
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="application-action-placeholder" aria-hidden="true" />
                            <span className="application-action-placeholder" aria-hidden="true" />
                          </>
                        )}
                        <button
                          type="button"
                          className="icon-button tiny list-icon-action danger destructive"
                          title="拒绝注册"
                          aria-label={`拒绝 ${user.displayName} 的注册`}
                          onClick={async () => {
                            const reason = await dialog.prompt({
                              title: "拒绝注册",
                              message: "拒绝后将立即释放该用户占用的用户名、邮箱和工号。",
                              label: "原因（选填）",
                              multiline: true,
                              maxLength: 500,
                              confirmLabel: "确认拒绝",
                              tone: "danger"
                            });
                            if (reason === null) return;
                            await processRegistration(
                              () => api(`/admin/users/${user.id}/reject`, {
                                method: "POST",
                                body: jsonBody({
                                  expectedRevision: Number(user.applicationRevision),
                                  reason: reason.trim()
                                })
                              }),
                              "注册已拒绝"
                            );
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    )}
                    {!isRegistration && (
                      <>
                        <button
                          type="button"
                          className="icon-button tiny list-icon-action approve"
                          title="通过资料修改"
                          aria-label={`通过 ${user.displayName} 的资料修改`}
                          onClick={() => void processProfileChange(user, "approve")}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-button tiny list-icon-action danger"
                          title="不通过资料修改"
                          aria-label={`不通过 ${user.displayName} 的资料修改`}
                          onClick={() => void processProfileChange(user, "reject")}
                        >
                          <X size={15} />
                        </button>
                        <span className="application-action-placeholder" aria-hidden="true" />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        )}
      </div>
      {canManage && passwordResetLink && (
        <Modal
          title="密码重置链接"
          onClose={() => setPasswordResetLink(null)}
        >
          <div className="stack-form profile-edit-form">
            <AuthFeedback tone="warning" anchored={false}>
              请通过可信渠道将链接转交给
              {passwordResetLink.displayName}。关闭后无法再次查看。
            </AuthFeedback>
            <label className="field">
              <span>重置链接</span>
              <div className="copy-value-row">
                <input
                  readOnly
                  value={passwordResetLink.resetUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  className="secondary-button"
                  onClick={async () => {
                    try {
                      await copyTextToClipboard(passwordResetLink.resetUrl);
                      notify("success", "重置链接已复制");
                    } catch {
                      notify("error", "复制失败，请手动复制链接");
                    }
                  }}
                >
                  <Copy size={14} />
                  复制
                </button>
              </div>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => setPasswordResetLink(null)}
              >
                完成
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReportPanel({
  machines,
  notify
}: {
  machines: any[];
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const [fromDate, setFromDate] = useState(addDays(todayChina(), -7));
  const [toDate, setToDate] = useState(addDays(todayChina(), 1));
  const [machineId, setMachineId] = useState("");
  const [report, setReport] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({
        from: chinaLocalToIso(`${fromDate}T00:00`),
        to: chinaLocalToIso(`${toDate}T00:00`),
        ...(machineId ? { machineId } : {})
      });
      setReport(await api(`/admin/report?${query}`));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "统计加载失败");
    }
  }, [fromDate, machineId, notify, toDate]);
  useEffect(() => { void load(); }, [load]);

  const exportUrl = `/api/v1/admin/report.csv?${new URLSearchParams({
    from: chinaLocalToIso(`${fromDate}T00:00`),
    to: chinaLocalToIso(`${toDate}T00:00`),
    ...(machineId ? { machineId } : {})
  })}`;

  return (
    <div className="report-page">
      <PageHeader
        title="使用统计"
        actions={<a className="secondary-button" href={exportUrl}><Download size={16} />导出 CSV</a>}
      />
      <div className="report-filters card">
        <Field label="开始日期"><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></Field>
        <Field label="结束日期"><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></Field>
        <Field label="机器"><select value={machineId} onChange={(e) => setMachineId(e.target.value)}><option value="">全部已授权机器</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></Field>
        <button className="primary-button" onClick={() => void load()}><RefreshCw size={15} />刷新统计</button>
      </div>
      {report && (
        <div className="report-results">
          <div className="metric-grid">
            <MetricCard icon={Gauge} label="资源占用率" value={`${report.summary.utilization}%`} />
            <MetricCard icon={CalendarDays} label="有效占用" value={`${report.summary.reservationCount} 条`} />
            <MetricCard icon={Clock3} label="占用时长" value={durationHoursText(report.summary.reservedMinutes)} />
          </div>
          <div className="report-layout">
            <section className="card report-card">
              <SectionHeader title="资源组占用率" leadingIcon={Activity} />
              <div className="utilization-list">
                {report.groups.map((row: any) => (
                  <div key={row.resourceGroupId}>
                    <div className="util-label"><span><strong>{row.groupName}</strong><small>{row.machineName} ｜ {row.resourceSummary}</small></span><b>{row.utilization}%</b></div>
                    <div className="progress"><span style={{ width: `${Math.min(100, row.utilization)}%` }} /></div>
                  </div>
                ))}
                {!report.groups.length && <div className="mini-empty">当前范围内没有资源组</div>}
              </div>
            </section>
            <section className="card report-card">
              <SectionHeader title="用户占用排行" leadingIcon={Users} />
              <div className="ranking-list">
                {report.users.map((row: any, index: number) => (
                    <div key={`${row.displayName}-${row.employeeNumber ?? index}`}><span className="rank">{index + 1}</span><div><strong>{row.displayName}{row.employeeNumber ? ` · ${row.employeeNumber}` : ""}</strong></div><b>{durationHoursText(row.reservedMinutes)}</b></div>
                ))}
                {!report.users.length && <div className="mini-empty">当前范围内没有有效占用</div>}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value
}: {
  icon: React.ComponentType<{ size?: number }>;
  label: string;
  value: string;
}) {
  return (
    <article className="metric-card card">
      <div className="metric-icon"><Icon size={22} /></div>
      <div className="metric-copy"><span>{label}</span><strong>{value}</strong></div>
    </article>
  );
}

function AnnouncementAdminPanel({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [announcements, setAnnouncements] = useState<SystemAnnouncement[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [editorState, setEditorState] = useState<AnnouncementEditorState | null>(null);
  const [showWithdrawn, setShowWithdrawn] = useState(false);

  const visibleAnnouncements = showWithdrawn
    ? announcements
    : announcements.filter((announcement) => announcement.status === "ACTIVE");

  const load = useCallback(async () => {
    try {
      const result = await api<{ announcements: SystemAnnouncement[] }>(
        "/admin/announcements"
      );
      setAnnouncements(result.announcements);
      setLoadError(false);
    } catch (error) {
      setLoadError(true);
      notify("error", error instanceof Error ? error.message : "公告加载失败");
    } finally {
      setLoaded(true);
    }
  }, [notify]);

  useEffect(() => {
    void load();
    const events = new EventSource("/api/v1/events");
    events.addEventListener("announcement", () => void load());
    return () => events.close();
  }, [load]);

  const withdraw = async (announcement: SystemAnnouncement) => {
    if (!(await dialog.confirm({
      title: "撤下系统公告",
      message: `撤下“${announcement.title}”后，尚未查看的用户将不再收到此公告。`,
      confirmLabel: "确认撤下",
      tone: "danger"
    }))) return;
    try {
      await api(`/admin/announcements/${announcement.id}/withdraw`, {
        method: "POST",
        body: jsonBody({ expectedVersion: announcement.version })
      });
      notify("success", "系统公告已撤下");
      await load();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await load();
      notify("error", error instanceof Error ? error.message : "公告撤下失败");
    }
  };

  return (
    <div className="announcement-management-page">
      <PageHeader
        title="系统公告"
        actions={
          <div className="announcement-page-actions">
            <label className="settings-toggle-control announcement-history-toggle">
              <strong>显示已撤下</strong>
              <input
                type="checkbox"
                checked={showWithdrawn}
                onChange={(event) => setShowWithdrawn(event.target.checked)}
              />
              <i className="settings-toggle" aria-hidden="true"><i /></i>
            </label>
            <button
              type="button"
              className="primary-button"
              onClick={() => setEditorState({ mode: "CREATE" })}
            >
              <Plus size={16} />创建公告
            </button>
          </div>
        }
      />
      {!loaded ? (
        <div className="card announcement-admin-empty">正在加载系统公告…</div>
      ) : loadError ? (
        <div className="card announcement-load-error" role="alert">
          <span>系统公告加载失败，当前列表可能不是最新状态</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setLoaded(false);
              void load();
            }}
          >
            重试
          </button>
        </div>
      ) : visibleAnnouncements.length ? (
        <div className="announcement-admin-list">
          {visibleAnnouncements.map((announcement) => (
            <article className="card announcement-admin-card" key={announcement.id}>
              <header>
                <div>
                  <span className={`state-chip ${announcement.status === "ACTIVE" ? "active" : ""}`}>
                    {announcement.status === "ACTIVE" ? "展示中" : "已撤下"}
                  </span>
                  <h2>{announcement.title}</h2>
                </div>
                <div className="announcement-card-actions">
                  {announcement.status === "ACTIVE" ? (
                    <>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setEditorState({ mode: "EDIT", announcement })}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="danger-button"
                        onClick={() => void withdraw(announcement)}
                      >
                        撤下
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => setEditorState({ mode: "REACTIVATE", announcement })}
                    >
                      重新启用
                    </button>
                  )}
                </div>
              </header>
              <AnnouncementMarkdown
                markdown={announcement.bodyMarkdown}
                onInternalNavigate={(href) => window.location.assign(href)}
              />
              <footer>
                <span>{announcement.createdByName}</span>
                <time>发布于 {formatChinaFullMinute(announcement.publishedAt)}</time>
                {announcement.withdrawnAt && (
                  <span>撤下于 {formatChinaFullMinute(announcement.withdrawnAt)}</span>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Megaphone}
          title={announcements.length ? "暂无展示中的公告" : "暂无系统公告"}
          text={
            announcements.length
              ? "打开“显示已撤下”可查看历史公告，或创建一条新公告。"
              : "创建后，用户下次进入系统时会依次看到公告。"
          }
        />
      )}
      {editorState && (
        <AnnouncementEditorModal
          key={`${editorState.mode}:${editorState.mode === "CREATE" ? "new" : editorState.announcement.id}`}
          state={editorState}
          notify={notify}
          onClose={() => setEditorState(null)}
          onSaved={async (message) => {
            setEditorState(null);
            notify("success", message);
            await load();
          }}
        />
      )}
    </div>
  );
}

function AnnouncementEditorModal({
  state,
  notify,
  onClose,
  onSaved
}: {
  state: AnnouncementEditorState;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const existing = state.mode === "CREATE" ? null : state.announcement;
  const [title, setTitle] = useState(existing?.title ?? "");
  const [bodyMarkdown, setBodyMarkdown] = useState(existing?.bodyMarkdown ?? "");
  const [expectedVersion, setExpectedVersion] = useState(existing?.version ?? 1);
  const [serverStatus, setServerStatus] = useState<"ACTIVE" | "WITHDRAWN">(
    existing?.status ?? "ACTIVE"
  );
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    bodyMarkdown?: string;
  }>({});
  const [conflictMessage, setConflictMessage] = useState("");
  const [conflictLoadFailed, setConflictLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const effectiveMode =
    state.mode === "CREATE"
      ? "CREATE"
      : serverStatus === "WITHDRAWN"
        ? "REACTIVATE"
        : "EDIT";

  const modalTitle =
    effectiveMode === "CREATE"
      ? "创建系统公告"
      : effectiveMode === "EDIT"
        ? "编辑系统公告"
        : "重新启用系统公告";
  const submitLabel =
    effectiveMode === "CREATE"
      ? "发布公告"
      : effectiveMode === "EDIT"
        ? "保存并重新发布"
        : "重新启用";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !bodyMarkdown.trim()) return;
    setFieldErrors({});
    setConflictMessage("");
    setConflictLoadFailed(false);
    setSaving(true);
    try {
      if (effectiveMode === "CREATE") {
        await api("/admin/announcements", {
          method: "POST",
          body: jsonBody({ title, bodyMarkdown })
        });
        await onSaved("系统公告已发布");
      } else if (existing) {
        await api(`/admin/announcements/${existing.id}`, {
          method: "PUT",
          body: jsonBody({
            title,
            bodyMarkdown,
            expectedVersion,
            reactivate: effectiveMode === "REACTIVATE"
          })
        });
        await onSaved(
          effectiveMode === "REACTIVATE" ? "系统公告已重新启用" : "系统公告已更新"
        );
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && existing) {
        try {
          const result = await api<{ announcements: SystemAnnouncement[] }>(
            "/admin/announcements"
          );
          const latest = result.announcements.find(
            (announcement) => announcement.id === existing.id
          );
          if (!latest) {
            setConflictLoadFailed(true);
            setConflictMessage("公告已不存在，请关闭编辑器后刷新列表。");
            return;
          }
          setExpectedVersion(latest.version);
          setServerStatus(latest.status);
          setConflictMessage(
            latest.status === "WITHDRAWN"
              ? "公告已被其他管理员撤下。当前草稿已保留；核对后再次提交将重新启用公告。"
              : "公告已被其他管理员更新。当前草稿已保留；核对后再次提交将覆盖最新版本。"
          );
        } catch {
          setConflictLoadFailed(true);
          setConflictMessage("公告状态已变化，但最新状态加载失败，请关闭编辑器后重试。");
        }
        return;
      }
      const titleError = validationDetailFromApi(error, "title");
      const bodyMarkdownError = validationDetailFromApi(error, "bodyMarkdown");
      if (titleError || bodyMarkdownError) {
        setFieldErrors({
          ...(titleError ? { title: titleError } : {}),
          ...(bodyMarkdownError ? { bodyMarkdown: bodyMarkdownError } : {})
        });
        return;
      }
      notify("error", error instanceof Error ? error.message : "公告保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={modalTitle} onClose={onClose} large className="announcement-editor-modal">
      <form className="announcement-create-form" onSubmit={(event) => void submit(event)}>
        <div className="announcement-create-fields">
          <Field label="公告标题" error={fieldErrors.title}>
            <input
              autoFocus
              maxLength={120}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                setFieldErrors((current) => ({ ...current, title: undefined }));
              }}
            />
          </Field>
          <Field label="公告内容" error={fieldErrors.bodyMarkdown}>
            <textarea
              maxLength={10_000}
              value={bodyMarkdown}
              onChange={(event) => {
                setBodyMarkdown(event.target.value);
                setFieldErrors((current) => ({
                  ...current,
                  bodyMarkdown: undefined
                }));
              }}
              placeholder={"支持 Markdown。外链：[说明](https://example.org)\n站内跳转：[查看资源日历](allocube:/calendar)"}
            />
            <small>
              支持段落、列表、粗体、行内代码和链接；站内链接使用
              <code>[文字](allocube:/路径)</code>，原始 HTML 和其他协议不会渲染。
            </small>
          </Field>
        </div>
        <section className="announcement-preview" aria-label="公告预览">
          <strong>预览</strong>
          {bodyMarkdown.trim() ? (
            <AnnouncementMarkdown markdown={bodyMarkdown} interactive={false} />
          ) : (
            <span>输入内容后在这里预览</span>
          )}
        </section>
        {conflictMessage && (
          <AuthFeedback
            tone={conflictLoadFailed ? "error" : "warning"}
            anchored={false}
            className="announcement-editor-feedback"
          >
            {conflictMessage}
          </AuthFeedback>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button
            type="submit"
            className="primary-button"
            disabled={saving || !title.trim() || !bodyMarkdown.trim()}
          >
            {saving ? "保存中" : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SettingsPanel({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const dialog = useAppDialog();
  const [bookingForm, setBookingForm] = useState({
    minBookingMinutes: 1,
    maxBookingMinutes: 1440,
    advanceDays: 30
  });
  const [adminSettings, setAdminSettings] =
    useState<AdminSettingsPayload | null>(null);
  const [allowedEmailDomains, setAllowedEmailDomains] = useState<string[]>([]);
  const [emailDomainInput, setEmailDomainInput] = useState("");
  const [emailDomainError, setEmailDomainError] = useState("");
  const [siteOrigin, setSiteOrigin] = useState("");
  const [siteOriginError, setSiteOriginError] = useState("");
  const [savingBooking, setSavingBooking] = useState(false);
  const [savingEmailDomains, setSavingEmailDomains] = useState(false);
  const [togglingEmptyEmail, setTogglingEmptyEmail] = useState(false);
  const [savingSiteOrigin, setSavingSiteOrigin] = useState(false);
  const [smtp, setSmtp] = useState<SmtpSettingsPayload | null>(null);
  const [smtpForm, setSmtpForm] = useState({
    enabled: false,
    host: "",
    port: 465,
    security: "IMPLICIT_TLS" as "IMPLICIT_TLS" | "STARTTLS",
    username: "",
    fromName: "Allocube",
    fromAddress: ""
  });
  const [smtpPassword, setSmtpPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [togglingSmtp, setTogglingSmtp] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);

  const applySmtpSettings = useCallback((value: SmtpSettingsPayload) => {
    setSmtp(value);
    setSmtpForm({
      enabled: value.enabled,
      host: value.host,
      port: value.port,
      security: value.security,
      username: value.username,
      fromName: value.fromName,
      fromAddress: value.fromAddress
    });
    setSmtpPassword("");
    setClearPassword(false);
  }, []);

  const loadSmtp = useCallback(async () => {
    const value = await api<SmtpSettingsPayload>("/admin/smtp-settings");
    applySmtpSettings(value);
  }, [applySmtpSettings]);

  const loadAdminSettings = useCallback(async () => {
    const value = await api<AdminSettingsPayload>("/admin/settings");
    setAdminSettings(value);
    setBookingForm({
      minBookingMinutes: value.minBookingMinutes,
      maxBookingMinutes: value.maxBookingMinutes,
      advanceDays: value.advanceDays
    });
    setAllowedEmailDomains(value.allowedEmailDomains);
    setSiteOrigin(value.siteOrigin);
    setSiteOriginError("");
    setEmailDomainInput("");
    setEmailDomainError("");
  }, []);

  useEffect(() => {
    loadAdminSettings().catch((error) => notify("error", error.message));
    loadSmtp().catch((error) => notify("error", error.message));
  }, [loadAdminSettings, loadSmtp, notify]);

  const updateEmailDomains = async (
    nextDomains: string[],
    successMessage: string,
    showFieldError = false
  ) => {
    if (!adminSettings || savingEmailDomains) return false;
    setSavingEmailDomains(true);
    try {
      const result = await api<{ settings: AdminSettingsPayload }>(
        "/admin/settings/email-domains",
        {
          method: "PATCH",
          body: jsonBody({
            allowedEmailDomains: nextDomains,
            expectedVersion: adminSettings.version
          })
        }
      );
      setAdminSettings(result.settings);
      setAllowedEmailDomains(result.settings.allowedEmailDomains);
      setEmailDomainError("");
      notify("success", successMessage);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadAdminSettings();
      }
      const message = error instanceof Error ? error.message : "更新白名单失败";
      if (showFieldError) setEmailDomainError(message);
      notify("error", message);
      return false;
    } finally {
      setSavingEmailDomains(false);
    }
  };

  const appendEmailDomain = async () => {
    if (!emailDomainInput.trim() || savingEmailDomains) return;
    try {
      const domain = normalizeAllowedEmailDomain(emailDomainInput);
      if (allowedEmailDomains.includes(domain)) {
        setEmailDomainError("该邮箱域名已经在白名单中");
        return;
      }
      if (allowedEmailDomains.length >= 100) {
        setEmailDomainError("最多可以配置100个邮箱域名");
        return;
      }
      const next = [...allowedEmailDomains, domain];
      if (await updateEmailDomains(next, "邮箱域名已添加", true)) {
        setEmailDomainInput("");
      }
    } catch {
      setEmailDomainError(EMAIL_DOMAIN_MESSAGE);
    }
  };

  const removeEmailDomain = async (domain: string) => {
    if (savingEmailDomains) return;
    await updateEmailDomains(
      allowedEmailDomains.filter((item) => item !== domain),
      "邮箱域名已移除"
    );
  };

  const saveBookingSettings = async () => {
    if (!adminSettings || savingBooking) return;
    setSavingBooking(true);
    try {
      const result = await api<{ settings: AdminSettingsPayload }>(
        "/admin/settings",
        {
          method: "PATCH",
          body: jsonBody({
            ...bookingForm,
            expectedVersion: adminSettings.version
          })
        }
      );
      setAdminSettings(result.settings);
      setBookingForm({
        minBookingMinutes: result.settings.minBookingMinutes,
        maxBookingMinutes: result.settings.maxBookingMinutes,
        advanceDays: result.settings.advanceDays
      });
      notify("success", "全局占用规则已更新");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadAdminSettings();
      }
      notify("error", error instanceof Error ? error.message : "保存失败");
    } finally {
      setSavingBooking(false);
    }
  };

  const saveSiteOrigin = async () => {
    if (!adminSettings || savingSiteOrigin) return;
    const issue = siteOriginValidationError(siteOrigin);
    if (issue) {
      setSiteOriginError(issue);
      return;
    }
    setSavingSiteOrigin(true);
    try {
      const normalized = normalizeSiteOrigin(siteOrigin);
      const result = await api<{ settings: AdminSettingsPayload }>(
        "/admin/settings/site-origin",
        {
          method: "PATCH",
          body: jsonBody({
            siteOrigin: normalized,
            expectedVersion: adminSettings.version
          })
        }
      );
      setAdminSettings(result.settings);
      setSiteOrigin(result.settings.siteOrigin);
      setSiteOriginError("");
      notify("success", "站点地址已更新");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadAdminSettings();
      }
      const message =
        error instanceof Error ? error.message : "保存站点地址失败";
      setSiteOriginError(message);
      notify("error", message);
    } finally {
      setSavingSiteOrigin(false);
    }
  };

  const toggleEmptyRegistrationEmail = async (allowed: boolean) => {
    if (!adminSettings || togglingEmptyEmail) return;
    if (allowed === adminSettings.allowRegistrationWithoutEmail) return;
    setTogglingEmptyEmail(true);
    try {
      const result = await api<{ settings: AdminSettingsPayload }>(
        "/admin/settings/registration-email",
        {
          method: "PATCH",
          body: jsonBody({
            allowRegistrationWithoutEmail: allowed,
            expectedVersion: adminSettings.version
          })
        }
      );
      setAdminSettings(result.settings);
      notify(
        "success",
        allowed ? "已允许注册时不填写邮箱" : "注册时必须填写邮箱"
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await loadAdminSettings();
      }
      notify(
        "error",
        error instanceof Error ? error.message : "注册邮箱规则更新失败"
      );
    } finally {
      setTogglingEmptyEmail(false);
    }
  };

  const smtpConfigurationDirty =
    !smtp ||
    smtp.host !== smtpForm.host ||
    smtp.port !== smtpForm.port ||
    smtp.security !== smtpForm.security ||
    smtp.username !== smtpForm.username ||
    smtp.fromName !== smtpForm.fromName ||
    smtp.fromAddress !== smtpForm.fromAddress ||
    Boolean(smtpPassword) ||
    clearPassword;
  const smtpDirty =
    smtpConfigurationDirty ||
    Boolean(smtp && smtp.enabled !== smtpForm.enabled);
  const bookingDirty = Boolean(
    adminSettings &&
      (bookingForm.minBookingMinutes !== adminSettings.minBookingMinutes ||
        bookingForm.maxBookingMinutes !== adminSettings.maxBookingMinutes ||
        bookingForm.advanceDays !== adminSettings.advanceDays)
  );
  const siteOriginDirty = Boolean(
    adminSettings && siteOrigin.trim() !== adminSettings.siteOrigin
  );

  const toggleSmtp = async (enabled: boolean) => {
    if (!smtp || enabled === smtp.enabled || togglingSmtp) return;
    if (
      !enabled &&
      !(await dialog.confirm({
        title: "停用邮件服务",
        message: "停用后，全部尚未发送的邮件都会被取消。",
        confirmLabel: "确认停用",
        tone: "danger"
      }))
    ) {
      return;
    }
    setSmtpForm((current) => ({ ...current, enabled }));
    setTogglingSmtp(true);
    try {
      const result = await api<{ settings: SmtpSettingsPayload }>(
        "/admin/smtp-settings",
        {
          method: "PATCH",
          body: jsonBody({
            host: smtp.host,
            port: smtp.port,
            security: smtp.security,
            username: smtp.username,
            fromName: smtp.fromName,
            fromAddress: smtp.fromAddress,
            enabled,
            clearPassword: false,
            expectedVersion: smtp.version
          })
        }
      );
      setSmtp(result.settings);
      setSmtpForm((current) => ({
        ...current,
        enabled: result.settings.enabled
      }));
      notify("success", enabled ? "邮件服务已启用" : "邮件服务已停用");
    } catch (error) {
      setSmtpForm((current) => ({ ...current, enabled: smtp.enabled }));
      if (error instanceof ApiError && error.status === 409) {
        const latest = await api<SmtpSettingsPayload>("/admin/smtp-settings");
        setSmtp(latest);
        setSmtpForm((current) => ({
          ...current,
          enabled: latest.enabled
        }));
      }
      notify(
        "error",
        error instanceof Error ? error.message : "邮件服务状态更新失败"
      );
    } finally {
      setTogglingSmtp(false);
    }
  };

  return (
    <div className="settings-management-page">
      <PageHeader title="系统设置" />
      <div className="settings-page">
      <section className="settings-card card" aria-labelledby="booking-settings-title">
        <SectionHeader
          id="booking-settings-title"
          title="资源占用规则"
          leadingIcon={Clock3}
          className="settings-intro"
        />
        <div className="settings-fields">
          <Field label="最短占用时长（分钟）"><input type="number" min={1} value={bookingForm.minBookingMinutes} onChange={(e) => setBookingForm({ ...bookingForm, minBookingMinutes: Number(e.target.value) })} /><small>自动拆分时，小于该值的时段会被丢弃。</small></Field>
          <Field label="单次最长时长（分钟）"><input type="number" min={1} value={bookingForm.maxBookingMinutes} onChange={(e) => setBookingForm({ ...bookingForm, maxBookingMinutes: Number(e.target.value) })} /></Field>
          <Field label="最远可占用天数"><input type="number" min={1} value={bookingForm.advanceDays} onChange={(e) => setBookingForm({ ...bookingForm, advanceDays: Number(e.target.value) })} /><small>以占用结束时间为准。</small></Field>
        </div>
        <div className="settings-card-footer">
          <ContextNotice className="settings-rule-note">
            保存后仅影响新的占用，不会改变已经确认的占用。
          </ContextNotice>
          <button
            className="primary-button"
            disabled={!adminSettings || savingBooking || !bookingDirty}
            onClick={() => void saveBookingSettings()}
          >
            保存规则
          </button>
        </div>
      </section>
      <section
        className="settings-card site-origin-settings-card card"
        aria-labelledby="site-origin-settings-title"
      >
        <SectionHeader
          id="site-origin-settings-title"
          title="站点地址"
          leadingIcon={Globe2}
          className="settings-intro"
          actions={
            <span
              className={`email-domain-policy-badge${
                adminSettings?.siteOrigin ? " is-restricted" : ""
              }`}
            >
              {adminSettings?.siteOrigin ? "已配置" : "未配置"}
            </span>
          }
        />
        <div className="site-origin-settings">
          <div
            className={`site-origin-entry${
              siteOriginError ? " is-invalid" : ""
            }`}
          >
            <input
              name="site-origin"
              aria-label="站点地址"
              placeholder="https://allocube.your-company.com"
              value={siteOrigin}
              aria-invalid={Boolean(siteOriginError)}
              aria-describedby={
                siteOriginError ? "site-origin-error" : undefined
              }
              onChange={(event) => {
                setSiteOrigin(event.target.value);
                setSiteOriginError("");
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.nativeEvent.isComposing
                ) {
                  return;
                }
                event.preventDefault();
                void saveSiteOrigin();
              }}
            />
            <button
              type="button"
              className="secondary-button"
              disabled={
                !adminSettings || savingSiteOrigin || !siteOriginDirty
              }
              onClick={() => void saveSiteOrigin()}
            >
              {savingSiteOrigin ? "保存中" : "保存"}
            </button>
          </div>
          {siteOriginError && (
            <div
              id="site-origin-error"
              className="email-domain-error"
              role="alert"
            >
              {siteOriginError}
            </div>
          )}
        </div>
      </section>
      <section
        className={`settings-card smtp-settings-card card${
          smtp && !smtpForm.enabled ? " is-disabled" : ""
        }`}
        aria-labelledby="smtp-settings-title"
      >
        <SectionHeader
          id="smtp-settings-title"
          title="邮件服务"
          leadingIcon={Mail}
          className="settings-intro"
          actions={smtp ? (
            <div className="smtp-header-controls">
              <span
                className={`smtp-state ${
                  !smtpForm.enabled
                    ? "off"
                    : smtp.operational
                      ? "ready"
                      : "warning"
                }`}
              >
                {togglingSmtp
                  ? smtpForm.enabled
                    ? "正在启用"
                    : "正在停用"
                  : !smtp.enabled
                    ? "已停用"
                  : smtp.operational
                    ? "运行正常"
                    : "配置不可用"}
              </span>
              <label className="settings-toggle-control">
                <strong>启用邮件服务</strong>
                <input
                  type="checkbox"
                  checked={smtpForm.enabled}
                  disabled={togglingSmtp}
                  aria-busy={togglingSmtp}
                  onChange={(event) => void toggleSmtp(event.target.checked)}
                />
                <i className="settings-toggle" aria-hidden="true"><i /></i>
              </label>
            </div>
          ) : undefined}
        />
        {smtp ? (
          <div className="smtp-settings-body">
            <div className="smtp-summary" aria-label="邮件服务状态摘要">
              <div><span>等待发送</span><strong>{smtp.queue.pending}</strong></div>
              <div><span>发送失败</span><strong>{smtp.queue.failed}</strong></div>
              <div><span>密码状态</span><strong>{smtp.passwordStatus === "READY" ? "已安全保存" : smtp.passwordStatus === "UNREADABLE" ? "需要重新输入" : "尚未设置"}</strong></div>
              <div><span>最近测试</span><strong>{smtp.lastTest ? (smtp.lastTest.status === "SUCCESS" ? "成功" : "失败") : "尚未测试"}</strong></div>
            </div>
            {(smtp.lastTest?.error || smtp.queue.lastError) && (
              <div className="smtp-warning" role="alert">
                <CircleAlert size={16} />
                <span>{smtp.lastTest?.error || smtp.queue.lastError}</span>
              </div>
            )}
            <div className="mail-service-section registration-email-section">
              <div className="mail-service-section-heading">
                <ShieldCheck size={16} />
                <strong>注册邮箱</strong>
              </div>
              <div className="email-domain-settings">
                <div className="registration-email-policy">
                  <span className="registration-email-field-title">邮箱要求</span>
                  <div className="registration-email-policy-control">
                    <strong>允许空邮箱</strong>
                    <label className="settings-toggle-control">
                      <input
                        type="checkbox"
                        aria-label="允许空邮箱"
                        checked={Boolean(
                          adminSettings?.allowRegistrationWithoutEmail
                        )}
                        disabled={!adminSettings || togglingEmptyEmail}
                        aria-busy={togglingEmptyEmail}
                        onChange={(event) =>
                          void toggleEmptyRegistrationEmail(event.target.checked)
                        }
                      />
                      <i className="settings-toggle" aria-hidden="true"><i /></i>
                    </label>
                  </div>
                </div>
                <div className="registration-email-domains">
                  <label className="registration-email-field-title" htmlFor="allowed-email-domain">
                    邮箱域名白名单
                  </label>
                  <div
                    className={`email-domain-entry${
                      emailDomainError ? " is-invalid" : ""
                    }`}
                  >
                    <input
                      id="allowed-email-domain"
                      name="allowed-email-domain"
                      aria-label="邮箱域名"
                      placeholder="example.com"
                      value={emailDomainInput}
                      aria-invalid={Boolean(emailDomainError)}
                      aria-describedby={
                        emailDomainError ? "email-domain-error" : undefined
                      }
                      onChange={(event) => {
                        setEmailDomainInput(event.target.value);
                        setEmailDomainError("");
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.nativeEvent.isComposing
                        ) {
                          return;
                        }
                        event.preventDefault();
                        void appendEmailDomain();
                      }}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!emailDomainInput.trim() || savingEmailDomains}
                      onClick={() => void appendEmailDomain()}
                    >
                      {savingEmailDomains ? "处理中" : "添加"}
                    </button>
                  </div>
                  {emailDomainError && (
                    <div
                      id="email-domain-error"
                      className="email-domain-error"
                      role="alert"
                    >
                      {emailDomainError}
                    </div>
                  )}
                  {allowedEmailDomains.length > 0 && (
                    <div className="email-domain-list" aria-label="邮箱域名白名单">
                      {allowedEmailDomains.map((domain) => (
                        <span className="email-domain-token" key={domain}>
                          <span>{domain}</span>
                          <button
                            type="button"
                            disabled={savingEmailDomains}
                            aria-label={`移除邮箱域名 ${domain}`}
                            onClick={() => void removeEmailDomain(domain)}
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mail-service-section smtp-configuration-section">
              <div className="mail-service-section-heading">
                <Settings size={16} />
                <strong>发送配置</strong>
              </div>
              <div className="smtp-form-grid">
              <div className="smtp-connection-fields">
                <Field label="SMTP 服务器">
                  <input
                    name="smtp-host"
                    value={smtpForm.host}
                    onChange={(event) =>
                      setSmtpForm({ ...smtpForm, host: event.target.value })
                    }
                  />
                </Field>
                <div className="smtp-connection-options">
                  <Field label="端口">
                    <input
                      name="smtp-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={smtpForm.port}
                      onChange={(event) =>
                        setSmtpForm({ ...smtpForm, port: Number(event.target.value) })
                      }
                    />
                  </Field>
                  <Field label="连接加密">
                    <select
                      name="smtp-security"
                      value={smtpForm.security}
                      onChange={(event) =>
                        setSmtpForm({
                          ...smtpForm,
                          security: event.target.value as "IMPLICIT_TLS" | "STARTTLS"
                        })
                      }
                    >
                      <option value="IMPLICIT_TLS">SSL/TLS</option>
                      <option value="STARTTLS">STARTTLS</option>
                    </select>
                  </Field>
                </div>
              </div>
              <div className="smtp-paired-fields">
                <Field label="SMTP 登录账号">
                  <input
                    name="smtp-username"
                    autoComplete="off"
                    value={smtpForm.username}
                    onChange={(event) =>
                      setSmtpForm({ ...smtpForm, username: event.target.value })
                    }
                  />
                </Field>
                <PasswordField
                  label="SMTP 密码"
                  name="smtp-password"
                  autoComplete="new-password"
                  value={smtpPassword}
                  disabled={clearPassword}
                  onChange={(event) => setSmtpPassword(event.target.value)}
                  placeholder={
                    smtp.passwordStatus === "UNREADABLE"
                      ? "请重新输入密码"
                      : smtp.hasPassword && !clearPassword
                        ? "已保存密码"
                        : ""
                  }
                />
              </div>
              <div className="smtp-paired-fields">
                <Field label="发件人名称">
                  <input
                    name="smtp-from-name"
                    value={smtpForm.fromName}
                    onChange={(event) =>
                      setSmtpForm({ ...smtpForm, fromName: event.target.value })
                    }
                  />
                </Field>
                <Field label="发件邮箱">
                  <input
                    name="smtp-from-address"
                    type="email"
                    value={smtpForm.fromAddress}
                    onChange={(event) =>
                      setSmtpForm({ ...smtpForm, fromAddress: event.target.value })
                    }
                  />
                </Field>
              </div>
              </div>
              <div className="smtp-test">
              <div className="smtp-test-copy">
                <strong>发送测试邮件</strong>
              </div>
              <div
                className="smtp-test-control"
                title={smtpDirty ? "请先保存当前修改" : undefined}
              >
                <input
                  type="email"
                  value={testRecipient}
                  onChange={(event) => setTestRecipient(event.target.value)}
                  aria-label="测试收件地址"
                />
                <button
                  className="secondary-button async-button smtp-test-button"
                  disabled={smtpDirty || !smtp.testable || !testRecipient || testingSmtp}
                  aria-busy={testingSmtp}
                  aria-label={smtpDirty ? "发送测试，请先保存当前修改" : "发送测试"}
                  onClick={async () => {
                    try {
                      setTestingSmtp(true);
                      await api("/admin/smtp-settings/test", {
                        method: "POST",
                        body: jsonBody({ recipient: testRecipient })
                      });
                      await loadSmtp();
                      notify("success", "测试邮件已发送，请检查收件箱");
                    } catch (error) {
                      await loadSmtp().catch(() => undefined);
                      notify("error", error instanceof Error ? error.message : "测试邮件发送失败");
                    } finally {
                      setTestingSmtp(false);
                    }
                  }}
                >
                  {testingSmtp ? (
                    <span className="async-button-spinner" aria-hidden="true">
                      <RefreshCw size={15} className="spin" />
                    </span>
                  ) : (
                    <span>发送测试</span>
                  )}
                </button>
              </div>
              </div>
              <div className="settings-card-footer smtp-footer">
              <div className="smtp-footer-meta">
                {smtp.hasPassword && (
                  <button
                    className="text-action danger smtp-password-action"
                    disabled={smtpForm.enabled}
                    onClick={() => {
                      setClearPassword((current) => !current);
                      setSmtpPassword("");
                    }}
                  >
                    {clearPassword ? "保留现有密码" : "清除已保存密码"}
                  </button>
                )}
                <span className="smtp-updated-at">
                  更新于 {formatChina(smtp.updatedAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
              </div>
              <button
                className="primary-button async-button smtp-save-button"
                disabled={savingSmtp}
                aria-busy={savingSmtp}
                onClick={async () => {
                  try {
                    setSavingSmtp(true);
                    const result = await api<{ settings: SmtpSettingsPayload }>(
                      "/admin/smtp-settings",
                      {
                        method: "PATCH",
                        body: jsonBody({
                          ...smtpForm,
                          enabled: smtp.enabled,
                          password: smtpPassword || undefined,
                          clearPassword,
                          expectedVersion: smtp.version
                        })
                      }
                    );
                    applySmtpSettings(result.settings);
                    notify(
                      "success",
                      smtp.enabled
                        ? "邮件配置已保存并立即生效"
                        : "邮件配置已保存"
                    );
                  } catch (error) {
                    if (error instanceof ApiError && error.status === 409) {
                      await loadSmtp();
                    }
                    notify("error", error instanceof Error ? error.message : "邮件配置保存失败");
                  } finally {
                    setSavingSmtp(false);
                  }
                }}
              >
                {savingSmtp ? (
                  <span className="async-button-spinner" aria-hidden="true">
                    <RefreshCw size={15} className="spin" />
                  </span>
                ) : (
                  <span>保存邮件配置</span>
                )}
              </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="mini-empty">正在加载邮件配置…</div>
        )}
      </section>
      </div>
    </div>
  );
}

function AuditPanel({
  notify
}: {
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const [logs, setLogs] = useState<any[]>([]);
  useEffect(() => {
    api<{ logs: any[] }>("/admin/audit").then((result) => setLogs(result.logs)).catch((error) => notify("error", error.message));
  }, [notify]);
  return (
    <div className="audit-management-page">
      <PageHeader title="审计记录" />
      <div className="card audit-list">
        {logs.map((log) => (
          <div className="audit-row" key={log.id}>
            <span className="audit-dot" />
            <div><strong>{auditActionLabel(log.action)}</strong><p>{log.actorName}{log.apiTokenName ? ` · API：${log.apiTokenName}` : ""} · {log.entityName ?? log.entityType} · {log.entityId.slice(0, 8)}</p></div>
            <time>{formatChina(log.createdAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</time>
          </div>
        ))}
        {!logs.length && <div className="mini-empty">暂无审计记录</div>}
      </div>
    </div>
  );
}

type DialogRequest =
  | {
      id: number;
      kind: "confirm";
      options: ConfirmDialogOptions;
      resolve: (value: boolean) => void;
    }
  | {
      id: number;
      kind: "prompt";
      options: PromptDialogOptions;
      resolve: (value: string | null) => void;
    };

function DialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const requestId = useRef(0);
  const confirm = useCallback(
    (options: ConfirmDialogOptions) =>
      new Promise<boolean>((resolve) => {
        requestId.current += 1;
        setRequest({ id: requestId.current, kind: "confirm", options, resolve });
      }),
    []
  );
  const prompt = useCallback(
    (options: PromptDialogOptions) =>
      new Promise<string | null>((resolve) => {
        requestId.current += 1;
        setRequest({ id: requestId.current, kind: "prompt", options, resolve });
      }),
    []
  );
  const controller = useMemo(() => ({ confirm, prompt }), [confirm, prompt]);
  const close = (value: boolean | string | null) => {
    if (!request) return;
    if (request.kind === "confirm") {
      request.resolve(Boolean(value));
    } else {
      request.resolve(typeof value === "string" ? value : null);
    }
    setRequest(null);
  };
  return (
    <DialogContext.Provider value={controller}>
      {children}
      {request && <AppActionDialog key={request.id} request={request} onClose={close} />}
    </DialogContext.Provider>
  );
}

function AppActionDialog({
  request,
  onClose
}: {
  request: DialogRequest;
  onClose: (value: boolean | string | null) => void;
}) {
  const options = request.options;
  const [value, setValue] = useState(
    request.kind === "prompt" ? request.options.initialValue ?? "" : ""
  );
  const [error, setError] = useState("");
  const submit = () => {
    if (request.kind === "confirm") {
      onClose(true);
      return;
    }
    const normalized = value.trim();
    if (request.options.required && !normalized) {
      setError(`请输入${request.options.label.replace(/（.*?）/g, "")}`);
      return;
    }
    const validationError = request.options.validate?.(normalized) ?? "";
    if (validationError) {
      setError(validationError);
      return;
    }
    onClose(normalized);
  };
  return (
    <Modal title={options.title} onClose={() => onClose(request.kind === "confirm" ? false : null)}>
      <form
        className="action-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className={`action-dialog-message ${options.tone === "danger" ? "danger" : ""}`}>
          {options.message}
        </p>
        {request.kind === "prompt" && (
          <Field label={request.options.label}>
            {request.options.multiline ? (
              <textarea
                autoFocus
                value={value}
                maxLength={request.options.maxLength}
                placeholder={request.options.placeholder}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError("");
                }}
              />
            ) : (
              <input
                autoFocus
                value={value}
                maxLength={request.options.maxLength}
                placeholder={request.options.placeholder}
                inputMode={request.options.inputMode}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError("");
                }}
              />
            )}
            {error && <AuthFeedback tone="error">{error}</AuthFeedback>}
          </Field>
        )}
        <div className="modal-actions action-dialog-actions">
          <button
            type="button"
            className="secondary-button"
            autoFocus={request.kind === "confirm"}
            onClick={() => onClose(request.kind === "confirm" ? false : null)}
          >
            {options.cancelLabel ?? "取消"}
          </button>
          <button
            type="submit"
            className={options.tone === "danger" ? "danger-button" : "primary-button"}
          >
            {options.confirmLabel ?? "确认"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  children,
  error
}: {
  label: string;
  children: React.ReactNode;
  error?: string;
}) {
  return (
    <label className={`field${error ? " has-error" : ""}`}>
      <span>{label}</span>
      {children}
      {error && <small className="field-inline-error" role="alert">{error}</small>}
    </label>
  );
}

function Modal({
  title,
  onClose,
  wide,
  large,
  className,
  children
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  large?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "textarea:not([disabled])",
      "select:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusDialog = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const preferred = dialog?.querySelector<HTMLElement>("[autofocus]");
      const first = dialog?.querySelector<HTMLElement>(focusableSelector);
      (preferred ?? first)?.focus();
    });
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.cancelAnimationFrame(focusDialog);
      window.removeEventListener("keydown", handleKeyboard);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className={`modal ${large ? "large" : wide ? "wide" : ""}${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header>
          <h2 id={headingId}>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  text?: string;
}) {
  return (
    <div className="empty-state card">
      <div><Icon size={25} /></div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
    </div>
  );
}

function CalendarEmptyState({
  icon: Icon,
  title,
  text,
  onOpenResourceCatalog
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  text: string;
  onOpenResourceCatalog: () => void;
}) {
  return (
    <div className="calendar-empty-state">
      <div className="calendar-empty-state-icon">
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      <button
        type="button"
        className="secondary-button"
        onClick={onOpenResourceCatalog}
      >
        <Server size={15} />
        全部资源
      </button>
    </div>
  );
}

function Toast({ kind, message }: { kind: "success" | "error"; message: string }) {
  return <div className={`toast ${kind}`}>{kind === "success" ? <Check size={17} /> : <CircleAlert size={17} />}{message}</div>;
}

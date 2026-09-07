import { useRealtimeRefresh } from "./useRealtimeRefresh";
import "./reports.css";
import { ServerClockProvider } from "./ServerClock";
import { useTranslation } from "react-i18next";
import { useMemo, useState, useCallback, useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { api, setCsrfToken } from "./api";
import { subscribeRealtimeEvent } from "./realtime";
import { DocumentationRoute } from "./DocumentationRoute";
import { resolveAppRoute, type Page, type AdminTab, appPath, feedbackPath, machineAdminPath } from "./app-routing";
import { resolveAuthLocation } from "./auth-routing";
import { resolveDocsRoute } from "./docs-routing";
import { setBeijingTimeMode as setDateBeijingTimeMode } from "./date";
import { Toast, LoadingScreen } from "./components/feedback";
import { type AuthNavigate } from "./features/auth/types";
import { DialogProvider } from "./components/dialogs";
import { AuthRouter } from "./features/auth/AuthPages";
import { Topbar, PasswordBanner } from "./app/AppShell";
import { CalendarPage } from "./features/calendar/CalendarPage";
import { ResourceCatalogPage } from "./features/catalog/ResourceCatalogPage";
import { AccountProfilePage } from "./features/account/AccountProfilePage";
import { NotificationsPage } from "./features/notifications/NotificationsPage";
import { AnnouncementListPage, AnnouncementCenter } from "./features/announcements/AnnouncementPages";
import { FeedbackPage } from "./features/feedback/FeedbackPages";
import { AdminPage } from "./features/admin/AdminPage";
import { useSession } from "./app/useSession";
import { useToast } from "./app/useToast";
import { useNumberInputWheel } from "./app/useNumberInputWheel";

export function App() {
  useTranslation();
  const routeLocation = useLocation();
  const routeNavigate = useNavigate();
  const docsRoute = useMemo(
    () => resolveDocsRoute(routeLocation.pathname),
    [routeLocation.pathname]
  );
  const { bootstrap, setBootstrap, loading, sessionReadError, loadSession, acceptAuthenticatedSession } = useSession(Boolean(docsRoute));
  const { toast, notify } = useToast();
  useNumberInputWheel();
  const [passwordReminderDismissed, setPasswordReminderDismissed] = useState(false);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [feedbackUnreadCount, setFeedbackUnreadCount] = useState(0);
  const [feedbackRefreshToken, setFeedbackRefreshToken] = useState(0);
  const [announcementRefreshToken, setAnnouncementRefreshToken] = useState(0);
  const [beijingTimeMode, setBeijingTimeMode] = useState(false);

  const updateBeijingTimeMode = useCallback((enabled: boolean) => {
    setDateBeijingTimeMode(enabled);
    setBeijingTimeMode(enabled);
  }, []);

  const fetchLoadUnreadNotificationCount = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ unreadCount: number; feedbackUnreadCount: number }>("/notifications/unread-count", { signal });
      if (signal.aborted) return;
      setUnreadNotificationCount(Math.max(0, result.unreadCount));
      setFeedbackUnreadCount(Math.max(0, result.feedbackUnreadCount));
    } catch {
      // 通知数量属于辅助状态，短暂加载失败不应干扰当前页面。
    }
  }, []);
  const loadUnreadNotificationCount = useRealtimeRefresh(fetchLoadUnreadNotificationCount, ["notifications"], { enabled: !docsRoute && bootstrap?.user.status === "ACTIVE" });

  useEffect(() => {
    if (docsRoute || !bootstrap || bootstrap.user.status !== "ACTIVE") return;
    const unsubscribeAnnouncement = subscribeRealtimeEvent("announcement", () => {
      setAnnouncementRefreshToken((current) => current + 1);
    });
    const unsubscribeFeedback = subscribeRealtimeEvent("feedback", () => {
      setFeedbackRefreshToken((current) => current + 1);
      void loadUnreadNotificationCount();
    });
    return () => {
      unsubscribeAnnouncement();
      unsubscribeFeedback();
    };
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
    const refreshOnFocus = () => void loadUnreadNotificationCount();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [bootstrap?.user.id, docsRoute, loadUnreadNotificationCount]);

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
        <DocumentationRoute route={docsRoute} notify={notify} />
        {toast && <Toast {...toast} />}
      </>
    );
  }

  if (loading || canonicalRedirect) {
    return <LoadingScreen failed={sessionReadError} onRetry={() => void loadSession()} />;
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
      updateBeijingTimeMode(false);
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
                beijingTimeMode={beijingTimeMode}
                onBeijingTimeModeChange={updateBeijingTimeMode}
              />
            )}
            {visiblePage === "resources" && (
              <ResourceCatalogPage
                user={bootstrap.user}
                notify={notify}
                navigate={navigate}
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

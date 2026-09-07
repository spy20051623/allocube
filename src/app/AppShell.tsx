import { notificationBadgeText } from "../notification-navigation";
import { tr } from "../i18n/index";
import { DisplayPreferences } from "../components/DisplayPreferences";
import {
  CalendarDays,
  Settings,
  Boxes,
  ChevronDown,
  UserCheck,
  Megaphone,
  MessageSquare,
  Bell,
  BookOpenText,
  LogOut,
  CircleAlert
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { type Page } from "../app-routing";
import type { AuthUser } from "../shared/types";

export function Topbar({
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
      { id: "calendar" as const, label: tr("资源日历"), icon: CalendarDays },
      ...(showAdmin
        ? [{ id: "admin" as const, label: tr("管理"), icon: Settings }]
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
      <div className="topbar-actions">
        <DisplayPreferences compact />
        <div className="topbar-user" ref={userMenuRef}>
          <button
            type="button"
            className={`topbar-user-trigger${userMenuOpen ? " open" : ""}`}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            aria-label={tr("打开用户菜单{{v0}}", {
              v0: unreadNotificationCount
                ? tr("，{{v0}} 条未读通知", { v0: unreadNotificationCount })
                : ""
            })}
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
                  ? tr("系统管理员")
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
                <UserCheck size={16} />{tr("用户信息")}</button>
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
                  <Megaphone size={16} />{tr("系统公告")}</button>
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
                  <span>{tr("反馈")}</span>
                  {feedbackUnreadCount > 0 && (
                    <span
                      className="notification-menu-indicator"
                      aria-label={tr("{{v0}} 条反馈未读更新", { v0: feedbackUnreadCount })}
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
                <span>{tr("通知")}</span>
                {unreadNotificationCount > 0 && (
                  <span
                    className="notification-menu-indicator"
                    aria-label={tr("{{v0}} 条未读通知", { v0: unreadNotificationCount })}
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
                <BookOpenText size={16} />{tr("文档中心")}</a>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false);
                  onLogout();
                }}
              >
                <LogOut size={16} />{tr("退出登录")}</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}



export function PasswordBanner({
  onModify,
  onDismiss
}: {
  onModify: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="password-banner">
      <CircleAlert size={17} />
      {tr("当前仍在使用初始或恢复密码，建议尽快修改。")}<button onClick={onModify}>{tr("现在修改")}</button>
      <button onClick={onDismiss}>{tr("本次稍后提醒")}</button>
    </div>
  );
}

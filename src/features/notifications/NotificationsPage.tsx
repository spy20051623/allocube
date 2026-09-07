import { EditCancelled } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { PageHeader } from "../../PageHeader";
import { tr, currentLocale, translateSystemMessageCode, translateServerMessage, trDynamic } from "../../i18n/index";
import { RefreshCw, Check, ChevronRight, Bell, MessageSquare, PowerOff, UserCheck, Info } from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../../api";
import { type AppPath } from "../../app-routing";
import { type NotificationDestination, resolveNotificationDestination } from "../../notification-navigation";
import { formatChina } from "../../date";
import type { NotificationItem } from "../../shared/types";
import { EmptyState } from "../../components/feedback";

export function NotificationsPage({
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
  const fetchLoad = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{
        unreadCount: number;
        feedbackUnreadCount: number;
        notifications: NotificationItem[];
      }>("/notifications", { signal });
      if (signal.aborted) return;
      setItems(result.notifications);
      setUnreadCount(result.unreadCount);
      onUnreadCountChange(result.unreadCount);
      onFeedbackUnreadCountChange(result.feedbackUnreadCount);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("通知加载失败"));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [notify, onFeedbackUnreadCountChange, onUnreadCountChange]);
  const load = useRealtimeRefresh(fetchLoad, ["notifications"], {});
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
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("通知状态更新失败"));
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
      notify("success", tr("全部通知已标为已读"));
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify(
        "error",
        error instanceof Error ? error.message : tr("通知状态更新失败")
      );
    } finally {
      setMarkingAllRead(false);
    }
  };

  return (
    <div className="page-shell narrow-page">
      <PageHeader
        title={tr("通知中心")}
        actions={
          <div className="notification-header-actions">
            <span className="unread-big">
              {unreadCount}
              <small>{tr("未读")}</small>
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
                {markingAllRead ? tr("处理中") : tr("一键已读")}
              </button>
            )}
          </div>
        }
      />
      {loading ? <div className="content-loading"><RefreshCw className="spin" />{tr("正在载入")}</div> : items.length ? (
        <div className="notification-list card">
          {items.map((item) => {
            const destination = resolveNotificationDestination(item);
            const copy = (
              <div className="notification-copy">
                <div className="notification-title"><strong>{notificationCopy(item, "title")}</strong><span>{formatChina(item.createdAt)}</span></div>
                <p>{notificationCopy(item, "body")}</p>
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
                        if (error instanceof EditCancelled) return;
                        notify(
                          "error",
                          error instanceof Error ? error.message : tr("通知状态更新失败")
                        );
                      }
                    }}
                  >
                    <Check size={14} />{tr("标为已读")}</button>
                )}
              </article>
            );
          })}
        </div>
      ) : <EmptyState icon={Bell} title={tr("暂时没有通知")} />}
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

function notificationCopy(item: NotificationItem, field: "title" | "body") {
  if (currentLocale() !== "en" || !item.templateKey) return item[field];
  if (item.templateKey.startsWith("SYSTEM_MESSAGE_V1:") && item.templateParams) {
    const reference = item.templateParams[field];
    if (reference && typeof reference === "object" && !Array.isArray(reference)) {
      const record = reference as Record<string, unknown>;
      if (typeof record.code === "string") {
        const params = record.params && typeof record.params === "object" && !Array.isArray(record.params)
          ? record.params as Record<string, unknown>
          : {};
        const translated = translateSystemMessageCode(record.code, params);
        if (translated) return translated;
      }
    }
  }
  const compatibleTranslation = translateServerMessage(item[field]);
  if (compatibleTranslation !== item[field]) return compatibleTranslation;
  const specificKey = `notification.${item.templateKey}.${field}`;
  const translated = trDynamic(specificKey, item.templateParams ?? undefined);
  if (translated !== specificKey) return translated;
  return trDynamic(`notification.generic.${field}`);
}

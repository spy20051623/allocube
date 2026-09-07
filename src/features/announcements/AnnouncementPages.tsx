import { PageHeader } from "../../PageHeader";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { Megaphone } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { api } from "../../api";
import { subscribeRealtimeEvent } from "../../realtime";
import { AnnouncementMarkdown } from "../../AnnouncementMarkdown";
import {
  readSeenAnnouncementIds,
  hasSeenAnnouncementVersion,
  announcementSeenStorageKey,
  rememberSeenAnnouncement
} from "../../shared/announcements";
import { formatChinaFullMinute } from "../../date";
import { type SystemAnnouncement } from "./types";
import { EmptyState } from "../../components/feedback";

export function AnnouncementCenter({
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
            <span>{tr("还有 {{count}} 条公告", { count: announcements.length - 1 })}</span>
          )}
          <button type="button" className="primary-button" onClick={dismiss}>
            {tr("我知道了")}</button>
        </div>
      </div>
    </Modal>
  );
}

export function AnnouncementListPage() {
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
    return subscribeRealtimeEvent("announcement", () => void load());
  }, [load]);

  return (
    <div className="page-shell narrow-page announcement-viewer-page">
      <PageHeader title={tr("系统公告")} />
      {loading ? (
        <div className="card announcement-admin-empty">{tr("正在加载系统公告…")}</div>
      ) : loadError ? (
        <div className="card announcement-load-error" role="alert">
          <span>{tr("系统公告加载失败")}</span>
          <button type="button" className="secondary-button" onClick={() => void load()}>
            {tr("重试")}</button>
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
                <time>{tr("发布于")}{formatChinaFullMinute(announcement.publishedAt)}</time>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={Megaphone}
          title={tr("暂无系统公告")}
          text={tr("当前没有正在展示的系统公告。")}
        />
      )}
    </div>
  );
}

import { Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { tr } from "../../i18n";
import type { SystemMaintenanceNotice } from "../../shared/system-maintenance";

const dismissalKey = (userId: string) => `allocube:system-maintenance-dismissed:v1:${userId}`;
function readDismissedVersion(key: string): number {
  try { return Number(localStorage.getItem(key)) || 0; }
  catch { return 0; }
}

export function useSystemMaintenanceBanner(userId?: string, notice?: SystemMaintenanceNotice) {
  const key = userId ? dismissalKey(userId) : "";
  const [dismissed, setDismissed] = useState({ key: "", version: 0 });
  const dismissedVersion = dismissed.key === key ? dismissed.version : readDismissedVersion(key);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setDismissed({ key, version: readDismissedVersion(key) });
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  return {
    visible: Boolean(userId && notice?.text && notice.version !== dismissedVersion),
    dismiss: () => {
      if (!notice || !userId) return;
      setDismissed({ key, version: notice.version });
      try { localStorage.setItem(key, String(notice.version)); } catch { /* Keep dismissal in this page when storage is unavailable. */ }
    }
  };
}

export function SystemMaintenanceBanner({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return <div className="system-maintenance-banner" role="status">
    <div className="system-maintenance-banner-copy">
      <Wrench size={16} aria-hidden="true" />
      <span title={text}>{text}</span>
    </div>
    <button type="button" onClick={onDismiss} aria-label={tr("关闭系统维护提示")} title={tr("关闭系统维护提示")}>
      <X size={16} aria-hidden="true" />
    </button>
  </div>;
}

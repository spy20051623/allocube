import { tr } from "../i18n/index";
import { CircleAlert, Info, RefreshCw, Check } from "lucide-react";

export function LoadingScreen({ failed = false, onRetry }: { failed?: boolean; onRetry?: () => void }) {
  return (
    <main className="boot-shell">
      <div className="boot-mark">A</div>
      <h1>Allocube</h1>
      <p>{failed ? tr("连接失败，正在重试") : tr("正在载入机器资源与占用日历…")}</p>
      {failed && <button className="secondary-button" onClick={onRetry}>{tr("重试")}</button>}
    </main>
  );
}

export function ContextNotice({
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

export function BusyButtonContent({
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

export function EmptyState({
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

export function Toast({ kind, message }: { kind: "success" | "error"; message: string }) {
  return <div className={`toast ${kind}`}>{kind === "success" ? <Check size={17} /> : <CircleAlert size={17} />}{message}</div>;
}

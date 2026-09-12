import { TerminalHelp } from "./TerminalHelp";
import type { TerminalHelp as Help } from "../../shared/terminal-help";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock3, Copy, Download, KeyRound, PowerOff, RefreshCw, Settings2, Terminal } from "lucide-react";
import { api, jsonBody } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { SectionHeader } from "../../components/SectionHeader";
import { useAppDialog } from "../../components/dialogs";
import { formatChinaFullMinute } from "../../date";
import { currentLocale } from "../../i18n";
import { Modal } from "../../Modal";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { terminalInstallCommand, type TerminalArchitecture, type TerminalEnrollment, type TerminalRelease } from "./install-command";
import "./terminal.css";

type TerminalInfo = { id: string; enrolled: boolean; enabled: boolean; lastSeenAt: string | null; helpRequests?: Help[] };

export function TerminalMachinePanel({ machineId, canManage, notify }: {
  machineId: string;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const t = (zh: string, en: string) => currentLocale() === "en" ? en : zh;
  const dialog = useAppDialog();
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [enrollment, setEnrollment] = useState<TerminalEnrollment | null>(null);
  const [architecture, setArchitecture] = useState<TerminalArchitecture>("amd64");
  const [releases, setReleases] = useState<TerminalRelease[]>([]);
  const [releaseState, setReleaseState] = useState<"loading" | "ready" | "failed">("loading");
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const requestAbort = useRef<AbortController | null>(null);
  const knownTerminal = useRef<TerminalInfo | null>(null);
  const requestVersion = useRef(0);
  const mutating = useRef(false);
  const applyTerminal = useCallback((next: TerminalInfo | null) => {
    const previous = knownTerminal.current;
    knownTerminal.current = next;
    setTerminal(next);
    setLoaded(true);
    setEnrollment((old) => old && (!next?.enabled || next.enrolled || old.terminalId !== next.id) ? null : old);
    if (next?.enabled && next.enrolled && previous?.id === next.id && !previous.enrolled) {
      notifyRef.current("success", currentLocale() === "en" ? "Machine enrolled" : "机器已接入");
    }
  }, []);
  const loadTerminal = useCallback(async (signal: AbortSignal) => {
    const version = requestVersion.current;
    try {
      const result = await api<{ terminal: TerminalInfo | null }>(`/machines/${machineId}/terminal`, { signal });
      if (!signal.aborted && version === requestVersion.current && !mutating.current) applyTerminal(result.terminal);
    } catch (e) {
      if (!signal.aborted && version === requestVersion.current) notifyRef.current("error", e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal.aborted && version === requestVersion.current) setLoading(false);
    }
  }, [machineId, applyTerminal]);
  const refresh = useRealtimeRefresh(loadTerminal, ["terminal"], { filter: () => ({ machineId }) });
  useEffect(() => {
    const controller = new AbortController();
    requestAbort.current = controller;
    requestVersion.current++;
    knownTerminal.current = null;
    mutating.current = false; setBusy(false);
    setTerminal(null); setEnrollment(null); setLoaded(false); setLoading(true); setEditing(false);
    void refresh();
    return () => { controller.abort(); requestVersion.current++; };
  }, [machineId, refresh]);
  useEffect(() => {
    if (!editing) return;
    const controller = new AbortController();
    setReleaseState("loading");
    void api<{ releases: TerminalRelease[] }>("/terminal/downloads", { signal: controller.signal })
      .then((result) => { setReleases(result.releases); setReleaseState("ready"); })
      .catch(() => { if (!controller.signal.aborted) setReleaseState("failed"); });
    return () => controller.abort();
  }, [editing]);
  const release = releaseState === "ready" ? releases.find((item) => item.architecture === architecture) : undefined;
  const downloadPath = release?.format === "deployment-tar-v1" && /^[a-f0-9]{64}$/.test(release.sha256)
    ? `/api/v1/terminal/downloads/${architecture}/${release.sha256}/allocube-deploy-linux-${architecture}.tar.gz` : "";
  let command = "";
  if (enrollment && release) {
    try { command = terminalInstallCommand(enrollment, release); } catch { /* No executable command for invalid release metadata. */ }
  }

  const state = !loaded
    ? { text: loading ? t("正在加载", "Loading") : t("加载失败", "Load failed"), tone: "neutral" }
    : !terminal ? { text: t("尚未接入", "Not enrolled"), tone: "neutral" }
      : !terminal.enabled ? { text: t("已停用", "Disabled"), tone: "disabled" }
        : terminal.enrolled ? { text: t("已接入", "Enrolled"), tone: "active" }
          : { text: t("待登记", "Awaiting enrollment"), tone: "pending" };
  const close = () => {
    if (busy) return;
    setEditing(false);
    setEnrollment(null);
  };
  const copy = async (value: string) => {
    try { await copyTextToClipboard(value); notify("success", t("已复制", "Copied")); }
    catch { notify("error", t("复制失败，请手动复制", "Copy failed. Please copy manually.")); }
  };
  async function run(action: () => Promise<void>) {
    if (mutating.current) return;
    mutating.current = true;
    const context = requestAbort.current;
    requestVersion.current++;
    setBusy(true);
    try { await action(); }
    catch (e) { if (!context?.signal.aborted) notify("error", e instanceof Error ? e.message : String(e)); }
    finally {
      if (requestAbort.current === context && !context?.signal.aborted) {
        mutating.current = false; requestVersion.current++; setBusy(false); void refresh();
      }
    }
  }
  const status = <span className={`terminal-sync-status ${state.tone}`}><i aria-hidden="true" />{state.text}</span>;
  return (
    <>
    <section className="card panel-card terminal-sync-panel">
      <SectionHeader title={t("公钥同步", "Public key synchronization")} actions={canManage ? (
        <button type="button" className="secondary-button compact" disabled={!loaded} onClick={() => { setEditing(true); void refresh(); }}>
          <Settings2 size={14} />{t("管理接入", "Manage connection")}
        </button>
      ) : undefined} />
      <div className="terminal-sync-overview">
        <div className="terminal-sync-identity"><span className="terminal-sync-icon"><KeyRound size={18} /></span>{status}</div>
        <div className="terminal-sync-contact"><Clock3 size={14} /><span>{t("最近联系", "Last contact")}</span><time>{terminal?.lastSeenAt ? formatChinaFullMinute(terminal.lastSeenAt) : "—"}</time></div>
      </div>
      {editing && canManage && (
        <Modal title={t("公钥同步接入", "Public key sync connection")} className="terminal-sync-modal" onClose={close}>
          <div className="terminal-sync-config">
            <div className="terminal-sync-toolbar">
              {status}
              <div className="terminal-sync-buttons">
                <button type="button" className="primary-button" disabled={busy || !release} onClick={() => void run(async () => {
                  const signal = requestAbort.current?.signal;
                  if (terminal && !(await dialog.confirm({
                    signal,
                    title: t("重新生成接入凭据", "Regenerate enrollment credentials"),
                    message: t("旧接入凭据将失效，机器需要重新登记。已有公钥保留。", "Existing connection credentials will be invalidated and the machine must enroll again. Existing public keys are retained."),
                    confirmLabel: t("重新生成", "Regenerate"), tone: "danger",
                  }))) return;
                  const result = await api<TerminalEnrollment>(`/admin/machines/${machineId}/terminal`, { method: "POST", body: jsonBody({}), signal });
                  if (signal?.aborted) return;
                  applyTerminal({ id: result.terminalId, enabled: true, enrolled: false, lastSeenAt: null });
                  setEnrollment(result);
                })}>
                  {terminal ? <RefreshCw size={14} /> : <KeyRound size={14} />}
                  {terminal ? t("重新生成", "Regenerate") : t("生成接入凭据", "Generate credentials")}
                </button>
                {terminal?.enabled && (
                  <button type="button" className="secondary-button danger" disabled={busy} onClick={() => void run(async () => {
                    const signal = requestAbort.current?.signal;
                    if (!(await dialog.confirm({
                      signal,
                      title: t("停用公钥同步", "Disable public key synchronization"),
                      message: t("停用后机器无法继续拉取公钥，已有公钥和 SSH 登录不受影响。", "The machine will stop fetching keys. Existing public keys and SSH logins are unaffected."),
                      confirmLabel: t("停用", "Disable"), tone: "danger",
                    }))) return;
                    await api(`/admin/machines/${machineId}/terminal`, { method: "DELETE", signal });
                    if (signal?.aborted) return;
                    setEnrollment(null);
                    applyTerminal(knownTerminal.current ? { ...knownTerminal.current, enabled: false } : null);
                    notify("success", t("同步接入已停用", "Synchronization disabled"));
                  })}><PowerOff size={14} />{t("停用", "Disable")}</button>
                )}
              </div>
            </div>
            <div className="terminal-sync-architecture">
              <span id="terminal-architecture-label">{t("机器架构", "Machine architecture")}</span>
              <div className="terminal-sync-download-controls">
              <div className="segmented" role="radiogroup" aria-labelledby="terminal-architecture-label" onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? "amd64" : event.key === "End" ? "arm64" : architecture === "amd64" ? "arm64" : "amd64";
                setArchitecture(next);
                event.currentTarget.querySelector<HTMLButtonElement>(`[data-architecture="${next}"]`)?.focus();
              }}>
                {(["amd64", "arm64"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={architecture === value} tabIndex={architecture === value ? 0 : -1} data-architecture={value} className={architecture === value ? "active" : ""} onClick={() => setArchitecture(value)}>{value === "amd64" ? "x86_64" : "aarch64"}</button>)}
              </div>
              {downloadPath ? <a className="secondary-button compact terminal-sync-download" href={downloadPath} download={`allocube-deploy-linux-${architecture}.tar.gz`} aria-label={t(`下载 ${architecture === "amd64" ? "x86_64" : "aarch64"} 部署包`, `Download ${architecture === "amd64" ? "x86_64" : "aarch64"} package`)}><Download size={14} />{t("下载部署包", "Download package")}</a>
                : <button type="button" className="secondary-button compact terminal-sync-download" disabled><Download size={14} />{t("下载部署包", "Download package")}</button>}
              </div>
            </div>
            {terminal?.enabled && terminal.enrolled ? <div className="terminal-sync-connected" role="status"><CheckCircle2 size={20} />{t("机器已接入", "Machine enrolled")}</div> : <div className="terminal-sync-command">
              <div className="terminal-sync-command-heading"><span><Terminal size={15} />{t("解压并进入目录后执行", "Run inside the extracted directory")}</span><button type="button" className="secondary-button compact" disabled={!command} onClick={() => void copy(command)}><Copy size={14} />{t("复制命令", "Copy command")}</button></div>
              {command ? <pre><code>{command}</code></pre> : <p className="terminal-sync-command-empty">{releaseState === "loading" ? t("正在获取安装程序", "Loading installer") : releaseState === "failed" ? t("安装程序加载失败，请重新打开窗口", "Could not load installer. Reopen this window to retry.") : !release ? t("平台尚未发布此架构的安装程序", "No installer published for this architecture") : enrollment ? t("安装信息无效，请重新生成", "Invalid installation details. Regenerate credentials.") : t("生成接入凭据后显示安装命令", "Generate credentials to get the install command")}</p>}
            </div>}
            {command && enrollment && <div className="terminal-sync-install-note"><span>{t(`${Math.floor(enrollment.expiresIn / 60)} 分钟内执行 · 含一次性接入凭据`, `Run within ${Math.floor(enrollment.expiresIn / 60)} minutes · Contains a one-time credential`)}</span><span>{t("自动安装并登记，保留现有映射；SSH 配置需管理员确认。", "Installs and enrolls, preserving mappings. An administrator must check SSH configuration.")}</span></div>}
            <div className="modal-actions terminal-sync-footer"><button type="button" className="secondary-button" disabled={busy} onClick={close}>{t("关闭", "Close")}</button></div>
          </div>
        </Modal>
      )}
    </section>
    {canManage && loaded && <TerminalHelp key={machineId} machineId={machineId} requests={terminal?.helpRequests ?? []} onChange={() => void refresh()} notify={notify} />}
    </>
  );
}

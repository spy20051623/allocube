import { useState } from "react";
import { Check, Eye } from "lucide-react";
import { api, jsonBody } from "../../api";
import { SectionHeader } from "../../components/SectionHeader";
import { formatChinaFullMinute } from "../../date";
import { currentLocale } from "../../i18n";
import { Modal } from "../../Modal";
import { terminalHelpText, terminalHelpOutcome, type TerminalHelp as Help } from "../../shared/terminal-help";

const reportTitles: Record<Help["code"], [string, string]> = {
  SSH_CONFIGURATION: ["SSH 配置需要检查", "Review SSH configuration"],
  SSH_RECOVERY: ["SSH 操作需要恢复", "SSH recovery required"],
  ACCOUNT_POLICY: ["账户接管需要检查", "Review account enrollment"],
  KEY_WRITE: ["公钥更新受阻", "Public key update blocked"],
  LOCAL_STATE: ["终端本地状态异常", "Terminal state issue"],
  PLATFORM_RESPONSE: ["公钥数据异常", "Invalid public key data"],
};

export function TerminalHelp({ machineId, requests, onChange, notify }: {
  machineId: string; requests: Help[]; onChange: () => void;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [visible, setVisible] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const en = currentLocale() === "en";
  const pending = requests.filter(item => item.status === "OPEN").length;
  const selected = requests.find(item => item.eventId === selectedId);
  const title = (item: Help) => reportTitles[item.code][en ? 1 : 0];
  const severity = (item: Help) => <span className={`state-chip ${item.severity === "URGENT" ? "disabled" : "member"}`}>
    {item.severity === "URGENT" ? (en ? "Urgent" : "紧急") : (en ? "General" : "一般")}
  </span>;
  const state = (item: Help) => <span className={`state-chip ${item.status === "RESOLVED" ? "active" : "retiring"}`}>
    {item.status === "RESOLVED" ? (en ? "Resolved" : "已解决") : (en ? "Pending" : "待处理")}
  </span>;
  async function resolve(item: Help) {
    if (busy !== null) return;
    setBusy(item.eventId);
    try {
      await api(`/admin/machines/${machineId}/terminal/help/${item.eventId}/resolve`, { method: "POST", body: jsonBody({}) });
      notify("success", en ? "Marked as resolved" : "已标记为已解决");
      onChange();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : String(error));
    } finally { setBusy(null); }
  }
  const resolveLabel = (item: Help) => busy === item.eventId ? (en ? "Saving…" : "正在保存…") : (en ? "Mark resolved" : "标记已解决");
  const resolveButton = (item: Help) => <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void resolve(item)}>
    <Check size={14}/>{busy === item.eventId ? (en ? "Saving…" : "正在保存…") : (en ? "Mark resolved" : "标记已解决")}
  </button>;
  return <section className="card panel-card terminal-reports-panel" aria-label={en ? "Machine reports" : "机器回报"}>
    <SectionHeader title={en ? "Machine reports" : "机器回报"}
      actions={requests.length > 0 ? <div className="terminal-report-counts">
        <span className={`state-chip ${pending ? "retiring" : "member"}`}>{en ? "Pending" : "待处理"} {pending}</span>
        <span className="state-chip member">{en ? "Resolved" : "已解决"} {requests.length - pending}</span>
      </div> : undefined}/>
    {requests.length === 0 ? <div className="mini-empty">{en ? "No reports" : "暂无回报信息"}</div> : <>
      <div className="terminal-report-table-wrap" role="region" aria-label={en ? "Machine reports table" : "机器回报表格"} tabIndex={0}>
        <table className="machine-member-list terminal-report-table">
          <thead><tr className="machine-member-row machine-member-head terminal-report-row">{[en ? "Issue" : "问题", en ? "Account / service" : "账户 / 服务", en ? "Severity" : "等级", en ? "Reported at" : "上报时间", en ? "Status" : "状态", en ? "Actions" : "操作"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{requests.slice(0, visible).map(item => <tr className="machine-member-row terminal-report-row" key={item.eventId}>
            <td className="member-identity"><strong>{title(item)}</strong></td>
            <td className="terminal-report-scope"><code>{item.scope || "—"}</code></td>
            <td>{severity(item)}</td>
            <td className="terminal-report-time"><time dateTime={item.openedAt}>{formatChinaFullMinute(item.openedAt)}</time></td>
            <td>{state(item)}</td>
            <td><div className="row-actions">
              <button type="button" className="icon-button tiny list-icon-action" title={en ? "Details" : "详情"} aria-label={en ? `Details: ${title(item)} (${item.scope || "SSH"})` : `详情：${title(item)}（${item.scope || "SSH"}）`} onClick={() => setSelectedId(item.eventId)}><Eye size={15}/></button>
              {item.status === "OPEN" && <button type="button" className="icon-button tiny list-icon-action approve" title={resolveLabel(item)} aria-label={`${resolveLabel(item)} (${item.scope || "SSH"})`} disabled={busy !== null} onClick={() => void resolve(item)}><Check size={15}/></button>}
            </div></td>
          </tr>)}</tbody>
        </table>
      </div>
      {visible < requests.length && <button type="button" className="secondary-button compact terminal-report-more" onClick={() => setVisible(value => value + 20)}>{en ? "Show more" : "显示更多"}</button>}
    </>}
    {selected && <Modal title={en ? "Report details" : "回报详情"} className="terminal-report-modal" onClose={() => setSelectedId(null)}>
      <div className="terminal-report-dialog-heading"><strong>{title(selected)}</strong>{severity(selected)}{state(selected)}</div>
      <p className="terminal-report-description">{terminalHelpText(selected.code, en)}</p>
      <dl className="terminal-report-facts">
        <div><dt>{en ? "Account / service" : "账户 / 服务"}</dt><dd><code>{selected.scope || "—"}</code></dd></div>
        <div><dt>{en ? "Reported at" : "上报时间"}</dt><dd>{formatChinaFullMinute(selected.openedAt)}</dd></div>
        <div className="full"><dt>{en ? "Reported outcome" : "上报时处理结果"}</dt><dd>{terminalHelpOutcome(selected.outcome, en)}</dd></div>
        <div className="full"><dt>{en ? "Local log" : "本机日志"}</dt><dd className="terminal-report-log-path"><code>{selected.logPath}</code></dd></div>
        {selected.status === "RESOLVED" && <>
          <div><dt>{en ? "Resolved by" : "解决方式"}</dt><dd>{selected.resolutionSource === "ADMIN" ? (en ? "Marked by administrator" : "管理员标记") : (en ? "Confirmed by machine" : "机器确认")}{selected.resolvedByName ? ` · ${selected.resolvedByName}` : ""}</dd></div>
          <div><dt>{en ? "Resolved at" : "解决时间"}</dt><dd>{selected.resolvedAt ? formatChinaFullMinute(selected.resolvedAt) : "—"}</dd></div>
        </>}
      </dl>
      <div className="modal-actions terminal-report-dialog-actions"><button type="button" className="secondary-button" onClick={() => setSelectedId(null)}>{en ? "Close" : "关闭"}</button>{selected.status === "OPEN" && resolveButton(selected)}</div>
    </Modal>}
  </section>;
}

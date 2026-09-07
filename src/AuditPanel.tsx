import { CalendarDateButton } from "./CalendarDateButton";
import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PageHeader } from "./PageHeader";
import { Modal } from "./Modal";
import { SelectControl } from "./SelectControl";
import { formatChina, todayChina } from "./date";
import { tr, trDynamic } from "./i18n";
import { auditActionLabel } from "./ui-copy";
import { auditFilters, defaultAuditDraft, type AuditDraft } from "./audit-state";
import { useAuditDetail, useAuditRecords } from "./useAuditRecords";
import type { AuditEntry, AuditValue } from "./shared/audit";
import "./audit.css";

const fieldLabels: Record<string, string> = {
  startAt: "开始时间", endAt: "结束时间", scope: "占用范围", status: "状态", title: "标题", purpose: "用途", note: "备注", reason: "原因",
  action: "处理方式", resultingSegments: "调整后时段", replacementBatchId: "新占用批次", replacedReservationIds: "被替换占用", newReservationIds: "新占用", replacesReservationId: "替换的占用", segmentCount: "时段数量",
  allocations: "资源组成", sharingMode: "共享模式", rangeStart: "范围起点", rangeEnd: "范围终点", capacity: "容量", items: "资源设备", name: "名称", address: "地址", hardwareNotes: "硬件信息", connectionGuide: "连接说明", tags: "标签", managementNotesChanged: "管理备注已修改", userId: "关联用户",
  description: "描述", sortOrder: "排序", version: "版本", kind: "类型", unit: "单位", username: "用户名", displayName: "姓名", employeeNumber: "工号", email: "邮箱",
  reviewReason: "审核原因", displayNameChanged: "姓名已修改", employeeNumberChanged: "工号已修改", requestedDisplayName: "申请姓名", requestedEmployeeNumber: "申请工号", targetType: "对象类型", reasonProvided: "已填写原因", impact: "影响数量",
  minBookingMinutes: "最短占用分钟数", maxBookingMinutes: "最长占用分钟数", advanceDays: "可提前预约天数", siteName: "站点名称", siteDescription: "站点描述", siteOrigin: "站点地址",
  icpFilingNumber: "ICP备案号", publicSecurityFilingNumber: "公安备案号", allowedEmailDomains: "注册邮箱白名单", allowRegistrationWithoutEmail: "允许无邮箱注册", requireRegistrationEmail: "注册需要邮箱",
  enabled: "启用", host: "邮件服务器", port: "端口", security: "连接安全", fromName: "发件人名称", fromAddress: "发件人地址", hasPassword: "已配置密码", passwordChanged: "密码已修改", passwordCleared: "密码已清除",
  bodyLength: "正文长度", active: "生效", accessLevel: "访问级别", expiresAt: "到期时间", number: "反馈编号", type: "类型", level: "级别", titleLength: "标题长度", changedFields: "修改字段", commentLength: "评论长度",
  fromDate: "起始日期", toDate: "截止日期", completedDays: "已完成天数", totalDays: "总天数", reasonCode: "原因代码"
};
const entityLabels: Record<string, string> = {
  reservation: "占用", resource_unavailability: "维护安排", machine_access_request: "使用权申请", profile_change_request: "资料修改申请",
  registration_tombstone: "注册申请", registration_email: "注册邮箱规则", primary: "占用规则", booking: "占用规则", site_profile: "站点信息", site_origin: "站点地址",
  icp_filing: "ICP备案号", public_security_filing: "公安备案号"
};
const label = (value: string) => trDynamic(entityLabels[value] ?? value);
const time = (value: string) => formatChina(value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
function valueText(key: string, value: AuditValue | undefined): string {
  if (value === undefined) return tr("未记录");
  if (value === null || value === "" || Array.isArray(value) && !value.length) return "—";
  if (typeof value === "boolean") return value ? tr("是") : tr("否");
  if (Array.isArray(value)) return value.map(v => key === "changedFields" ? trDynamic(fieldLabels[v] ?? v) : v).join("\n");
  if (["startAt", "endAt", "expiresAt"].includes(key) && typeof value === "string") return time(value) || value;
  if (value === "MACHINE") return tr("整机");
  if (value === "RESOURCE_GROUP") return tr("资源组");
  const values: Record<string,string> = { ACTIVE: "启用", DISABLED: "停用", CONFIRMED: "已确认", CANCELLED: "已取消", CANCELLED_UNAVAILABILITY: "已取消", SHARED: "共享", EXCLUSIVE: "独占", READ_ONLY: "只读", READ_WRITE: "读写" };
  return ["status", "sharingMode", "accessLevel"].includes(key) ? trDynamic(values[String(value)] ?? String(value)) : String(value);
}
function actorName(entry: AuditEntry) { return entry.actorDeleted || !entry.actorId ? trDynamic(entry.actorName) : entry.actorName; }
function objectName(entry: AuditEntry) {
  if (entry.machineName) return [entry.machineDeleted ? trDynamic(entry.machineName) : entry.machineName,
    entry.scope === "MACHINE" ? tr("整机") : entry.resourceGroupName ? entry.resourceGroupDeleted ? trDynamic(entry.resourceGroupName) : entry.resourceGroupName : undefined].filter(Boolean).join(" / ");
  if (["settings", "smtp_settings", "REPORT"].includes(entry.entityType) || entry.entityName === entry.entityType || entry.entityDeleted) return label(entry.entityName);
  return entry.entityName;
}
function ObjectSummary({ entry }: { entry: AuditEntry }) {
  return <><strong title={objectName(entry)}>{objectName(entry)}</strong>
    {(entry.startAt || entry.endAt) && <small>{entry.startAt ? time(entry.startAt) : tr("未记录")} — {entry.endAt ? time(entry.endAt) : tr("未记录")}</small>}</>;
}
function AuditDetails({ id, close }: { id: string; close: () => void }) {
  const { data, error, loading, retry } = useAuditDetail(id);
  const entry = data?.entry;
  return <Modal title={tr("审计详情")} onClose={close} wide>
    {loading && <div role="status" className="mini-empty">{tr("加载中…")}</div>}
    {error && <div className="audit-error" role="alert">{trDynamic(error)} <button className="secondary-button compact" onClick={() => void retry()}>{tr("重试")}</button></div>}
    {entry && <>
      <dl className="audit-detail-meta">
        {[["操作时间", time(entry.createdAt)], ["操作者", actorName(entry)], ["操作类型", auditActionLabel(entry.action)], ["操作对象", objectName(entry)],
          ["来源", entry.source === "API" ? tr("个人 API") : tr("其他")], ["记录标识", entry.id], ["对象标识", entry.entityId],
          ...(entry.startAt ? [["开始时间", time(entry.startAt)]] : []), ...(entry.endAt ? [["结束时间", time(entry.endAt)]] : []),
          ...(entry.actorId ? [["操作者标识", entry.actorId]] : []), ...(entry.apiTokenId ? [["令牌标识", entry.apiTokenId]] : []),
          ...(entry.apiTokenName ? [["令牌名称", entry.apiTokenName]] : []), ...(entry.apiOperationId ? [["API 操作标识", entry.apiOperationId]] : [])]
          .map(([key, value]) => <div key={key}><dt>{trDynamic(key)}</dt><dd>{value}</dd></div>)}
      </dl>
      {data.fields.length > 0 && <div className="audit-changes">
        <div className="audit-change audit-change-head"><span>{tr("字段")}</span><span>{tr("修改前")}</span><span>{tr("修改后 / 记录值")}</span></div>
        {data.fields.map(field => <div className="audit-change" key={field.key}>
          <strong>{trDynamic(fieldLabels[field.key] ?? field.key)}</strong>
          <div><small>{tr("修改前")}</small>{valueText(field.key, field.before)}</div>
          <div><small>{tr("修改后 / 记录值")}</small>{valueText(field.key, field.after)}</div>
        </div>)}
      </div>}
      {data.unavailable && <p className="muted">{tr("部分详情未记录、已隐藏或无法读取。")}</p>}
    </>}
  </Modal>;
}
export function AuditPanel() {
  const [initialDraft] = useState(defaultAuditDraft);
  const { data, options, loading, error, optionsError, query, retry, go, loadOptions } = useAuditRecords(auditFilters(initialDraft));
  const [draft, setDraft] = useState<AuditDraft>(initialDraft), [validation, setValidation] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const change = (key: keyof AuditDraft, value: string) => setDraft(old => ({ ...old, [key]: value }));
  const submit = (next = draft) => {
    try { const filters = auditFilters(next); setValidation(""); void query(filters); }
    catch (e) { setValidation(trDynamic(e instanceof Error ? e.message : "日期范围无效")); }
  };
  const turnPage = async (page: number) => { if (await go(page)) list.current?.scrollIntoView({ block: "start", behavior: "instant" }); };
  const all = { value: "", label: tr("全部") };
  return <div className="audit-management-page">
    <PageHeader title={tr("审计记录")} />
    <form className="card audit-filters" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="audit-date-field"><span>{tr("起始日期")}</span><CalendarDateButton date={draft.fromDate} today={todayChina()} label={draft.fromDate || tr("不限")} ariaLabel={tr("起始日期")} onSelect={value => change("fromDate", value)} allowUnbounded /></div>
      <div className="audit-date-field"><span>{tr("截止日期")}</span><CalendarDateButton date={draft.toDate} today={todayChina()} label={draft.toDate || tr("不限")} ariaLabel={tr("截止日期")} onSelect={value => change("toDate", value)} allowUnbounded /></div>
      <label>{tr("操作者")}<SelectControl value={draft.actor} ariaLabel={tr("操作者")} options={[all, ...options.actors.map(actor => ({ value: actor.id, label: label(actor.name) }))]} onChange={v => change("actor", v)} /></label>
      <label>{tr("操作类型")}<SelectControl value={draft.action} ariaLabel={tr("操作类型")} options={[all, ...options.actions.map(action => ({ value: action, label: auditActionLabel(action) }))]} onChange={v => change("action", v)} /></label>
      <label>{tr("来源")}<SelectControl value={draft.source} ariaLabel={tr("来源")} options={[all, { value: "API", label: tr("个人 API") }, { value: "OTHER", label: tr("其他") }]} onChange={v => change("source", v)} /></label>
      <div className="audit-filter-actions"><button className="primary-button" type="submit">{tr("查询")}</button><button className="secondary-button" type="button" onClick={() => { const next = defaultAuditDraft(); setDraft(next); submit(next); }}>{tr("重置")}</button></div>
    </form>
    {validation && <div role="alert" className="audit-error">{validation}</div>}
    {optionsError && <div role="alert" className="audit-error">{tr("筛选选项加载失败")} <button className="secondary-button compact" onClick={() => void loadOptions()}>{tr("重试")}</button></div>}
    {error && <div role="alert" className="audit-error">{trDynamic(error)} <button className="secondary-button compact" onClick={() => void retry()}>{tr("重试")}</button></div>}
    <div className="card audit-records" ref={list} aria-busy={loading}>
      <div className="audit-record audit-record-head" aria-hidden="true"><span>{tr("操作时间")}</span><span>{tr("操作者")}</span><span>{tr("操作类型")}</span><span>{tr("操作对象")}</span><span>{tr("来源")}</span></div>
      {loading && <div className="audit-loading" role="status">{tr("加载中…")}</div>}
      {data?.logs.map(entry => <button className="audit-record" key={entry.id} onClick={() => setSelected(entry.id)} aria-label={`${auditActionLabel(entry.action)} · ${objectName(entry)} · ${time(entry.createdAt)}`}>
        <time dateTime={entry.createdAt}>{time(entry.createdAt)}</time><span title={actorName(entry)}>{actorName(entry)}</span>
        <span title={auditActionLabel(entry.action)}>{auditActionLabel(entry.action)}</span><span className="audit-object"><ObjectSummary entry={entry} /></span>
        <span title={entry.apiTokenName ?? undefined}>{entry.source === "API" ? tr("个人 API") : tr("其他")}</span>
      </button>)}
      {!loading && !error && !data?.logs.length && <div className="mini-empty">{tr("暂无审计记录")}</div>}
    </div>
    {data && data.total > 0 && <div className="audit-pagination">
      <span>{tr("第 {{page}} 页 / 共 {{pages}} 页", { page: data.page, pages: Math.ceil(data.total / data.pageSize) })}</span>
      <button className="secondary-button compact" disabled={loading || data.page <= 1} onClick={() => void turnPage(data.page - 1)}><ChevronLeft size={15} />{tr("上一页")}</button>
      <button className="secondary-button compact" disabled={loading || !data.nextCursor} onClick={() => void turnPage(data.page + 1)}>{tr("下一页")}<ChevronRight size={15} /></button>
    </div>}
    {selected && <AuditDetails key={selected} id={selected} close={() => setSelected(null)} />}
  </div>;
}

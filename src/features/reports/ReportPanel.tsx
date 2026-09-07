import { useUsageReport } from "../../useUsageReport";
import { shiftReportDate, latestReportDate } from "../../shared/reports";
import { PageHeader } from "../../PageHeader";
import { tr, currentLocale, trDynamic } from "../../i18n/index";
import { RefreshCw, Gauge, CalendarDays, Clock3, Activity, Users } from "lucide-react";
import { useState } from "react";
import { compactHoursText } from "../../date";
import { useAppDialog } from "../../components/dialogs";
import { Field, ChoiceField } from "../../components/forms";
import { SectionHeader } from "../../components/SectionHeader";

export function ReportPanel({ machines, notify, isSystemAdmin }: {
  machines: Array<{ id: string; name: string }>;
  notify: (kind: "success" | "error", message: string) => void;
  isSystemAdmin: boolean;
}) {
  const dialog = useAppDialog();
  const [fromDate, setFromDate] = useState(() => shiftReportDate(latestReportDate(), -6));
  const [toDate, setToDate] = useState(() => latestReportDate());
  const [machineId, setMachineId] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({ fromDate, toDate, machineId });
  const { report, job, loading, submitting, statusKnown, load, rebuild } = useUsageReport(appliedFilters.fromDate, appliedFilters.toDate, appliedFilters.machineId, isSystemAdmin, notify);
  const refreshStatistics = () => {
    if (fromDate === appliedFilters.fromDate && toDate === appliedFilters.toDate && machineId === appliedFilters.machineId) {
      void load();
    } else {
      setAppliedFilters({ fromDate, toDate, machineId });
    }
  };
  const running = job?.status === "QUEUED" || job?.status === "RUNNING";
  const confirmRebuild = async () => {
    if (await dialog.confirm({
      title: tr("全部重新统计"),
      message: tr("将按现存记录重新统计全部机器和历史日期，不受当前筛选影响。期间旧统计仍可使用，完成后统一替换。"),
      confirmLabel: tr("开始重新统计")
    })) await rebuild();
  };
  return (
    <div className="report-page">
      <PageHeader
        title={tr("使用统计")}
        titleExtras={<span className="report-status" role="status">
          {loading ? tr("正在加载统计") : report?.coverage.latestCompletedDate ? tr("统计截至 {{date}}", { date: report.coverage.latestCompletedDate }) : ""}
        </span>}
        actions={isSystemAdmin && <div className="report-rebuild-controls">
          <button className="secondary-button report-rebuild-button" disabled={submitting || running || !statusKnown} onClick={() => void confirmRebuild()}>
            <RefreshCw size={14} />{running || submitting ? tr("重新统计中") : tr("全部重新统计")}
          </button>
          <span className="report-status" role="status">{running ? `${job.completedDays} / ${job.totalDays}` : !statusKnown ? tr("正在核对任务状态") : job?.status === "FAILED" ? tr("重新统计失败，原统计结果仍可使用") : ""}</span>
        </div>}
      />
      <div className="report-filters card">
        <Field label={tr("开始日期")}><input type="date" max={latestReportDate()} value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></Field>
        <Field label={tr("结束日期")}><input type="date" max={latestReportDate()} value={toDate} onChange={(e) => setToDate(e.target.value)} /></Field>
        <ChoiceField
          label={tr("机器")}
          value={machineId}
          options={[
            { value: "", label: tr("全部已授权机器") },
            ...machines.map((machine) => ({ value: machine.id, label: machine.name }))
          ]}
          onChange={setMachineId}
        />
        <button className="primary-button" disabled={loading} onClick={refreshStatistics}><RefreshCw size={15} />{tr("刷新统计")}</button>
      </div>
      {report && (
        <div className="report-results">
          <div className="metric-grid">
            <MetricCard icon={Gauge} label={tr("资源占用率")} value={`${report.summary.utilization}%`} />
            <MetricCard
              icon={CalendarDays}
              label={tr("有效占用")}
              value={new Intl.NumberFormat(currentLocale()).format(report.summary.reservationCount)}
            />
            <MetricCard icon={Clock3} label={tr("占用时长")} value={compactHoursText(report.summary.reservedMinutes)} />
          </div>
          <div className="report-layout">
            <section className="card report-card">
              <SectionHeader title={tr("资源组占用率")} leadingIcon={Activity} />
              <div className="utilization-list">
                {report.groups.map((row: typeof report.groups[number]) => (
                  <div key={row.resourceGroupId}>
                    <div className="util-label"><span><strong>{trDynamic(row.groupName)}</strong><small>{trDynamic(row.machineName)} ｜ {trDynamic(row.resourceSummary)}</small></span><b>{row.utilization}%</b></div>
                    <div className="progress"><span style={{ width: `${Math.min(100, row.utilization)}%` }} /></div>
                  </div>
                ))}
                {!report.groups.length && <div className="mini-empty">{tr("当前范围内没有资源组")}</div>}
              </div>
            </section>
            <section className="card report-card">
              <SectionHeader title={tr("用户占用排行")} leadingIcon={Users} />
              <div className="ranking-list">
                {report.users.map((row: typeof report.users[number], index: number) => (
                  <div key={`${trDynamic(row.displayName)}-${row.employeeNumber ?? index}`}><span className="rank">{index + 1}</span><div><strong>{trDynamic(row.displayName)}{row.employeeNumber ? ` · ${row.employeeNumber}` : ""}</strong></div><b>{compactHoursText(row.reservedMinutes)}</b></div>
                ))}
                {!report.users.length && <div className="mini-empty">{tr("当前范围内没有有效占用")}</div>}
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

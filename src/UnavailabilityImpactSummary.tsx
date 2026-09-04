import { Check, CircleAlert } from "lucide-react";
import { formatChinaFullMinute } from "./date";
import { tr } from "./i18n/index";

export type UnavailabilityImpactData = {
  affectedReservations: Array<{
    id: string;
    applicantName: string;
    resourceGroupName: string;
    startAt: string;
  }>;
  summary: {
    total: number;
    cancelled: number;
    trimmed: number;
    split: number;
  };
};

export function UnavailabilityImpactSummary({
  impact
}: {
  impact: UnavailabilityImpactData;
}) {
  const visibleReservations = impact.affectedReservations.slice(0, 3);
  const remainingCount = Math.max(
    0,
    impact.summary.total - visibleReservations.length
  );

  return (
    <div
      className={`unavailability-impact-bar ${
        impact.summary.total ? "warning" : "safe"
      }`}
    >
      <div>
        {impact.summary.total ? <CircleAlert size={16} /> : <Check size={16} />}
        <span>
          <strong>
            {impact.summary.total
              ? tr("影响 {{v0}} 条占用", { v0: impact.summary.total })
              : tr("没有受影响的占用")}
          </strong>
          {impact.summary.total > 0 && (
            <small>
              {tr("取消")}
              {impact.summary.cancelled} {tr("条 · 裁切")}
              {impact.summary.trimmed} {tr("条 · 拆分")}
              {impact.summary.split} {tr("条")}
            </small>
          )}
          {visibleReservations.map((reservation) => (
            <small key={reservation.id}>
              {reservation.applicantName} · {reservation.resourceGroupName || tr("整机")} ·{" "}
              {formatChinaFullMinute(reservation.startAt)}
            </small>
          ))}
          {remainingCount > 0 && (
            <small>
              {tr("另有")}
              {remainingCount} {tr("条占用")}
            </small>
          )}
        </span>
      </div>
    </div>
  );
}

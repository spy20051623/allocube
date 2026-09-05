import { Clock3, Server } from "lucide-react";
import { tr as t } from "./i18n";
import { formatChinaFullMinute } from "./date";
import { reservationPhase } from "./my-reservations-state";
import type { OwnReservation } from "./shared/my-reservations";

export type ReservationNotify = (kind: "success" | "error", message: string) => void;
export function reservationMachineName(item: OwnReservation) {
  return item.machineDeleted ? t("机器已删除") : item.machineName;
}
export function reservationGroupName(item: OwnReservation) {
  return item.scope === "MACHINE" ? t("整机") : item.resourceGroupDeleted ? t("资源组已删除") : item.resourceGroupName;
}
export function ReservationIdentity({ item }: { item: OwnReservation }) {
  const machineName = reservationMachineName(item);
  const groupName = reservationGroupName(item);
  return <div className="own-identity"><Server size={18} aria-hidden="true" /><div>
    <strong title={machineName}>{machineName}</strong><span title={groupName}>{groupName}</span>
  </div></div>;
}
export function ReservationPeriod({ item }: { item: OwnReservation }) {
  return <span className="own-period"><Clock3 size={15} aria-hidden="true" />
    <time dateTime={item.startAt} title={t("开始时间")}>{formatChinaFullMinute(item.startAt)}</time>
    <time dateTime={item.endAt} title={t("结束时间")}>{formatChinaFullMinute(item.endAt)}</time></span>;
}
export function ReservationStatus({ item, now }: { item: OwnReservation; now: number }) {
  const phase = reservationPhase(item, now);
  return <span className={`own-status ${phase.toLowerCase()}`}>{
    phase === "ACTIVE" ? t("进行中") : phase === "UPCOMING" ? t("未开始") : phase === "ENDED" ? t("已结束") : t("已取消")
  }</span>;
}

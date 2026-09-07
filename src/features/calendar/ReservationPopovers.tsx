import { tr } from "../../i18n/index";
import { CalendarAnchoredPopover } from "../../CalendarAnchoredPopover";
import { ChevronRight, Pencil, Trash2, PowerOff } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { formatChina } from "../../date";
import { type ProjectedUnavailability } from "../../calendar-unavailability";
import { type CalendarNearbyReservations, type CalendarReservationDetail } from "./types";
import { useAppDialog } from "../../components/dialogs";

export function CalendarNearbyReservationsPopover({
  nearby,
  onClose,
  onSelect
}: {
  nearby: CalendarNearbyReservations;
  onClose: () => void;
  onSelect: (detail: CalendarReservationDetail) => void;
}) {
  return (
    <CalendarAnchoredPopover
      anchor={nearby.anchor}
      ariaLabel={tr("选择附近占用")}
      className="nearby-reservations-popover"
      heading={<>{tr("附近有")}{nearby.items.length} {tr("条占用")}</>}
      onClose={onClose}
    >
      <p className="nearby-reservations-hint">{tr("请选择一条查看完整信息")}</p>
      <div className="nearby-reservations-list">
        {nearby.items.map((detail) => (
          <button
            type="button"
            key={detail.item.id}
            onClick={() => onSelect(detail)}
          >
            <span
              className={`nearby-reservation-marker${detail.item.scope === "MACHINE" ? " machine-scope" : ""
                }${detail.item.mine ? " mine" : ""}`}
            />
            <span className="nearby-reservation-copy">
              <time>
                {formatChina(detail.item.startAt, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false
                })}
                –
                {formatChina(detail.item.endAt, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false
                })}
              </time>
              <strong>
                {detail.item.scope === "MACHINE" && tr("整机 · ")}
                {detail.item.applicantName}
                {detail.item.applicantEmployeeNumber
                  ? ` · ${detail.item.applicantEmployeeNumber}`
                  : ""}
              </strong>
              {detail.item.title && <small>{detail.item.title}</small>}
            </span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    </CalendarAnchoredPopover>
  );
}

export function CalendarReservationPopover({
  detail,
  currentTime,
  canManage,
  notify,
  onClose,
  onChanged,
  onEdit
}: {
  detail: CalendarReservationDetail;
  currentTime: number;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onEdit: () => void;
}) {
  const { item } = detail;
  const dialog = useAppDialog();
  const [busy, setBusy] = useState(false);
  const now = currentTime;
  const startTime = new Date(item.startAt).getTime();
  const upcoming = startTime > now;
  const active =
    startTime <= now &&
    new Date(item.endAt).getTime() > now;
  const withinFirstMinute = active && now - startTime < 60_000;
  const canRelease = item.mine || canManage;
  const status = upcoming ? tr("未开始") : active ? tr("进行中") : tr("已结束");

  const performAction = async (action: "cancel" | "end") => {
    const releasingAnotherUser = !item.mine && canManage;
    const confirmed = await dialog.confirm({
      title: releasingAnotherUser
        ? tr("释放占用")
        : action === "cancel"
          ? tr("取消占用")
          : tr("提前结束占用"),
      message:
        releasingAnotherUser
          ? action === "cancel"
            ? tr("释放后会取消该占用、立即腾出时段，并通知使用人。")
            : withinFirstMinute
              ? tr("该占用开始不足一分钟，释放后会撤销整条记录并通知使用人。")
              : tr("释放后会立即腾出剩余时段，并通知使用人。")
          : action === "cancel"
            ? tr("取消后会立即释放该时段，且无法自动恢复。")
            : withinFirstMinute
              ? tr("该占用开始不足一分钟，确认后会撤销整条占用记录并立即释放资源。")
              : tr("结束后会立即释放剩余时段，且无法自动恢复。"),
      confirmLabel:
        releasingAnotherUser
          ? tr("确认释放")
          : action === "cancel"
            ? tr("确认取消")
            : withinFirstMinute
              ? tr("确认撤销")
              : tr("确认结束"),
      tone: "danger"
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await api<{ message?: string }>(
        `/reservations/${item.id}/${action}`,
        {
          method: "POST",
          body: "{}"
        }
      );
      notify(
        "success",
        releasingAnotherUser
          ? tr("占用已释放")
          : result.message ??
          (action === "cancel" ? tr("占用已取消") : tr("占用已提前结束"))
      );
      onClose();
      await onChanged();
    } catch (error) {
      notify(
        "error",
        error instanceof Error
          ? error.message
          : releasingAnotherUser
            ? tr("释放失败")
            : action === "cancel"
              ? tr("取消失败")
              : tr("提前结束失败")
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <CalendarAnchoredPopover
      anchor={detail.anchor}
      ariaLabel={tr("占用详情")}
      heading={tr("占用详情")}
      badge={
        <span className={`state-chip ${active ? "active" : ""}`}>
          {status}
        </span>
      }
      actions={
        <>
          {item.mine && (upcoming || active) && (
            <button
              className="reservation-popover-action edit"
              type="button"
              disabled={busy}
              aria-label={tr("编辑占用")}
              title={tr("编辑占用")}
              onClick={onEdit}
            >
              <Pencil size={16} />
            </button>
          )}
          {upcoming && canRelease && (
            <button
              className="reservation-popover-action danger"
              type="button"
              disabled={busy}
              aria-label={item.mine ? tr("取消占用") : tr("释放占用")}
              title={item.mine ? tr("取消占用") : tr("释放占用")}
              onClick={() => void performAction("cancel")}
            >
              <Trash2 size={16} />
            </button>
          )}
          {active && canRelease && (
            <button
              className="reservation-popover-action danger"
              type="button"
              disabled={busy}
              aria-label={
                item.mine
                  ? withinFirstMinute
                    ? tr("撤销占用")
                    : tr("提前结束")
                  : tr("释放占用")
              }
              title={
                item.mine
                  ? withinFirstMinute
                    ? tr("撤销占用")
                    : tr("提前结束")
                  : tr("释放占用")
              }
              onClick={() => void performAction("end")}
            >
              {withinFirstMinute
                ? <Trash2 size={16} />
                : <PowerOff size={16} />}
            </button>
          )}
        </>
      }
      onClose={onClose}
    >
      <dl className="reservation-popover-details">
        <div>
          <dt>{tr("使用人")}</dt>
          <dd>
            {item.applicantName}
            {item.applicantEmployeeNumber
              ? ` · ${item.applicantEmployeeNumber}`
              : ""}
          </dd>
        </div>
        <div><dt>{tr("机器")}</dt><dd>{detail.machineName}</dd></div>
        <div><dt>{tr("范围")}</dt><dd>{detail.groupName}</dd></div>
        <div>
          <dt>{tr("时间")}</dt>
          <dd>
            {formatChina(item.startAt, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            })}
            <span className="reservation-popover-time-separator">{tr("至")}</span>
            {formatChina(item.endAt, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            })}
          </dd>
        </div>
        {item.adjustmentType && (
          <div>
            <dt>{tr("原始时间")}</dt>
            <dd>
              {formatChina(item.initialStartAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
              <span className="reservation-popover-time-separator">{tr("至")}</span>
              {formatChina(item.initialEndAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </dd>
          </div>
        )}
      </dl>
      {(item.title || item.purpose || item.note || item.adjustmentReason) && (
        <div className="reservation-popover-content">
          {item.title && <div><span>{tr("标题")}</span><p>{item.title}</p></div>}
          {item.purpose && <div><span>{tr("用途")}</span><p>{item.purpose}</p></div>}
          {item.note && <div><span>{tr("备注")}</span><p>{item.note}</p></div>}
          {item.adjustmentReason && <div><span>{tr("调整原因")}</span><p>{item.adjustmentReason}</p></div>}
        </div>
      )}
    </CalendarAnchoredPopover>
  );
}

export function CalendarUnavailabilityPopover({
  detail,
  onClose
}: {
  detail: {
    item: ProjectedUnavailability;
    machineName: string;
    groupName: string;
    anchor: DOMRect;
  };
  onClose: () => void;
}) {
  const isDisableHistory =
    detail.item.sources[0]?.window.kind === "LONG_TERM";

  return (
    <CalendarAnchoredPopover
      anchor={detail.anchor}
      ariaLabel={isDisableHistory ? tr("停用详情") : tr("维护详情")}
      className={`unavailability-popover${isDisableHistory ? " disable-history-popover" : ""}`}
      heading={isDisableHistory ? tr("停用详情") : tr("维护详情")}
      badge={
        <span
          className={`state-chip ${isDisableHistory ? "disabled" : "scheduled"}`}
        >
          {detail.item.sources.length}{tr("项")}{isDisableHistory ? tr("记录") : tr("安排")}
        </span>
      }
      onClose={onClose}
    >
      <dl className="reservation-popover-details">
        <div><dt>{tr("机器")}</dt><dd>{detail.machineName}</dd></div>
        <div><dt>{tr("资源组")}</dt><dd>{detail.groupName}</dd></div>
        <div>
          <dt>{tr("有效时间")}</dt>
          <dd>
            {formatChina(detail.item.startAt, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            })}
            <span className="reservation-popover-time-separator">{tr("至")}</span>
            {formatChina(detail.item.endAt, {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit"
            })}
          </dd>
        </div>
      </dl>
      <div className="unavailability-source-list">
        {detail.item.sources.map((source) => (
          <section
            key={`${source.scope}-${source.window.id}`}
            className="unavailability-source-item"
          >
            <div>
              <strong>
                {source.scope === "MACHINE"
                  ? isDisableHistory
                    ? tr("整机停用")
                    : tr("整机维护")
                  : isDisableHistory
                    ? tr("资源组停用")
                    : tr("资源组维护")}
              </strong>
            </div>
            <time>
              {formatChina(source.window.startAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
              <span>{tr("至")}</span>
              {formatChina(source.window.endAt, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })}
            </time>
            <p>{source.window.reason || tr("未填写原因")}</p>
          </section>
        ))}
      </div>
    </CalendarAnchoredPopover>
  );
}

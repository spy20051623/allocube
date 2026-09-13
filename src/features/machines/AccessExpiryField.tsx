import { tr } from "../../i18n/index";
import { addDays } from "../../date";
import { CalendarDateButton } from "../../CalendarDateButton";

export function accessTodayBeijing() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function defaultAccessExpiryInput() {
  return addDays(accessTodayBeijing(), 30);
}

export function accessExpiryInput(value: string) {
  return new Date(Date.parse(value) - 1 + 8 * 3600_000).toISOString().slice(0, 10);
}

export function accessExpiryLabel(value: string | null) {
  return value ? accessExpiryInput(value) : tr("长期有效");
}

export function accessExpiryValue(value: string, permanent: boolean) {
  if (permanent) return null;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && addDays(value, 0) === value;
  const iso = valid ? new Date(`${addDays(value, 1)}T00:00:00+08:00`).toISOString() : "";
  if (!iso || Date.parse(iso) <= Date.now()) throw new Error(tr("到期日期不能早于今天"));
  return iso;
}

export function AccessExpiryField({ value, onChange, permanent = false, onPermanentChange, presetBaseDate, label = tr("到期日期") }: {
  value: string;
  onChange: (value: string) => void;
  permanent?: boolean;
  onPermanentChange?: (value: boolean) => void;
  label?: string;
  presetBaseDate?: string;
}) {
  return <div className="field access-expiry-field">
      <span>{tr("{{label}}（北京时间）", { label })}</span>
        <CalendarDateButton variant="field" date={permanent ? "" : value.slice(0, 10)} today={accessTodayBeijing()}
          label={permanent ? tr("长期有效") : value.slice(0, 10) || tr("选择日期")} ariaLabel={label}
          allowUnbounded={Boolean(onPermanentChange)} unboundedLabel={tr("长期有效")}
          presetBaseDate={presetBaseDate}
          dayPresets={[{ days: 7, label: tr("7天") }, { days: 15, label: tr("15天") }, { days: 30, label: tr("30天") }]}
          onSelect={date => {
            onPermanentChange?.(date === "");
            if (date) onChange(date);
          }} />
  </div>;
}

import { tr } from "../../i18n/index";
import { Server } from "lucide-react";

export function CalendarEmptyState({
  icon: Icon,
  title,
  text,
  onOpenResourceCatalog
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  text: string;
  onOpenResourceCatalog: () => void;
}) {
  return (
    <div className="calendar-empty-state">
      <div className="calendar-empty-state-icon">
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      <button
        type="button"
        className="secondary-button"
        onClick={onOpenResourceCatalog}
      >
        <Server size={15} />
        {tr("全部资源")}</button>
    </div>
  );
}

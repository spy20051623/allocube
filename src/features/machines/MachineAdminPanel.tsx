import { tr } from "../../i18n/index";
import { Server } from "lucide-react";
import { useRef, useEffect } from "react";
import { type MachineAdminSection } from "../../app-routing";
import { MachineInfoSection } from "./MachineInfoSection";
import { MachineResourcesSection } from "./MachineResourcesSection";
import { MachineUsersSection } from "./MachineUsersSection";

export function MachineAdminPanel({
  machine,
  isSystemAdmin,
  canManage,
  notify,
  reloadMachines,
  section,
  onSectionChange
}: {
  machine: any;
  isSystemAdmin: boolean;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
  section: MachineAdminSection;
  onSectionChange: (section: MachineAdminSection) => void;
}) {
  const detailRef = useRef<HTMLDivElement>(null);
  const sections: Array<{ id: MachineAdminSection; label: string }> = [
    { id: "info", label: tr("机器信息") },
    { id: "resources", label: tr("资源设置") },
    { id: "users", label: tr("用户与权限") }
  ];

  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [machine.id, section]);

  const moveTab = (current: MachineAdminSection, delta: number) => {
    const index = sections.findIndex((item) => item.id === current);
    const next = sections[(index + delta + sections.length) % sections.length];
    onSectionChange(next.id);
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[data-machine-section="${next.id}"]`
        )
        ?.focus();
    });
  };

  return (
    <div className="machine-detail" ref={detailRef}>
      <div className="machine-context-bar card">
        <div className="machine-section-tabs" role="tablist" aria-label={tr("{{v0}} 详情页面", { v0: machine.name })}>
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={section === item.id}
              tabIndex={section === item.id ? 0 : -1}
              data-machine-section={item.id}
              className={section === item.id ? "active" : ""}
              onClick={() => onSectionChange(item.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  moveTab(item.id, -1);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  moveTab(item.id, 1);
                }
              }}
            >
              {item.label}
              {item.id === "users" && machine.pendingAccessRequestCount > 0 && (
                <span>{machine.pendingAccessRequestCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="machine-context-identity">
          <span className="machine-list-icon"><Server size={18} /></span>
          <div className="machine-context-copy">
            <strong>{machine.name}</strong>
            <small>{machine.address || tr("未填写地址")}</small>
          </div>
        </div>
      </div>
      <div className="machine-section-content" role="tabpanel">
        {section === "info" && (
          <MachineInfoSection
            machine={machine}
            isSystemAdmin={isSystemAdmin}
            canManage={canManage}
            notify={notify}
            reloadMachines={reloadMachines}
          />
        )}
        {section === "resources" && (
          <MachineResourcesSection
            machine={machine}
            canManage={canManage}
            notify={notify}
            reloadMachines={reloadMachines}
          />
        )}
        {section === "users" && (
          <MachineUsersSection
            machine={machine}
            isSystemAdmin={isSystemAdmin}
            canManage={canManage}
            notify={notify}
            reloadMachines={reloadMachines}
          />
        )}
      </div>
    </div>
  );
}

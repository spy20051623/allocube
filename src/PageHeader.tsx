import type { ReactNode } from "react";

export function PageHeader({
  title,
  titleExtras,
  actions,
  className = ""
}: {
  title: string;
  titleExtras?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`page-header${className ? ` ${className}` : ""}`}>
      <div className="page-header-title-group">
        <h1>{title}</h1>
        {titleExtras}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

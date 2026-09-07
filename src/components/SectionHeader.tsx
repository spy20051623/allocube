

export function SectionHeader({
  title,
  id,
  level = 3,
  leadingIcon: LeadingIcon,
  actions,
  className = ""
}: {
  title: string;
  id?: string;
  level?: 2 | 3;
  leadingIcon?: React.ComponentType<{ size?: number }>;
  actions?: React.ReactNode;
  className?: string;
}) {
  const heading = level === 2
    ? <h2 id={id}>{title}</h2>
    : <h3 id={id}>{title}</h3>;
  return (
    <div className={`section-header${className ? ` ${className}` : ""}`}>
      {LeadingIcon && <span className="section-header-icon"><LeadingIcon size={19} /></span>}
      <div className="section-header-title">{heading}</div>
      {actions && <div className="section-header-actions">{actions}</div>}
    </div>
  );
}

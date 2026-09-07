import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface PreferenceMenuControl {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}
export function PreferenceMenu<T extends string>({
  value, options, onSelect, icon, label, shortLabel, title, ariaLabel, menuLabel,
  compact = false, className = "", open: controlledOpen, onOpenChange
}: PreferenceMenuControl & {
  value: T;
  options: readonly { value: T; label: string; icon: ReactNode }[];
  onSelect: (value: T) => void;
  icon: ReactNode;
  label: string;
  shortLabel?: string;
  title: string;
  ariaLabel: string;
  menuLabel: string;
  compact?: boolean;
  className?: string;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next); };
  const closeRef = useRef(setOpen);
  closeRef.current = setOpen;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const [focused, setFocused] = useState(0);
  const activate = () => {
    setFocused(Math.max(0, options.findIndex(option => option.value === value)));
    setOpen(true);
  };
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => { if (open) buttons.current[focused]?.focus(); }, [open, focused]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div className={`language-switcher preference-menu${compact ? " compact" : ""}${open ? " open" : ""} ${className}`} ref={root}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button type="button" className="language-switcher-trigger" ref={trigger}
        aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        title={title} onClick={() => open ? setOpen(false) : activate()}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); activate(); }
        }}>
        {icon}
        <span className="language-switcher-current">{label}</span>
        {shortLabel && <span className="language-switcher-code" aria-hidden="true">{shortLabel}</span>}
        <ChevronDown className="language-switcher-chevron" size={14} aria-hidden="true" />
      </button>
      {open && <div id={menuId} className="language-switcher-popover" role="menu" aria-label={menuLabel}
        onKeyDown={event => {
          let next = focused;
          if (event.key === "ArrowDown") next = (focused + 1) % options.length;
          else if (event.key === "ArrowUp") next = (focused + options.length - 1) % options.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = options.length - 1;
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
          else return;
          event.preventDefault(); setFocused(next);
        }}>
        {options.map((option, index) => <button key={option.value} type="button"
          className={`language-switcher-option${option.value === value ? " selected" : ""}`}
          role="menuitemradio" aria-checked={option.value === value} tabIndex={focused === index ? 0 : -1}
          ref={element => { buttons.current[index] = element; }} onFocus={() => setFocused(index)}
          onClick={() => { close(); if (option.value !== value) onSelect(option.value); }}>
          <span className="language-switcher-option-code" aria-hidden="true">{option.icon}</span>
          <span className="language-switcher-option-copy"><strong>{option.label}</strong></span>
          <Check size={16} aria-hidden="true" />
        </button>)}
      </div>}
    </div>
  );
}

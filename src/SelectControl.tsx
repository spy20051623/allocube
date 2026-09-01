import { Check, ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";

export type SelectControlOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type MenuPosition = {
  left: number;
  width: number;
  maxHeight: number;
  placement: "down" | "up";
  edge: number;
};

export function SelectControl({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  name,
  className = "",
  compact = false,
  placeholder = "—"
}: {
  value: string;
  options: SelectControlOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  name?: string;
  className?: string;
  compact?: boolean;
  placeholder?: string;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef("");
  const searchTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const unavailable = disabled || options.length === 0;

  const enabledIndex = (start: number, direction: 1 | -1) => {
    if (!options.length) return -1;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (
        (start + offset * direction) % options.length + options.length
      ) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return -1;
  };

  const openMenu = (preferredIndex = selectedIndex) => {
    if (unavailable) return;
    const nextIndex = preferredIndex >= 0 && !options[preferredIndex]?.disabled
      ? preferredIndex
      : enabledIndex(0, 1);
    setActiveIndex(Math.max(0, nextIndex));
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    closeMenu(true);
  };

  const move = (direction: 1 | -1) => {
    const next = enabledIndex(activeIndex + direction, direction);
    if (next >= 0) setActiveIndex(next);
  };

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const padding = 12;
    const gap = 7;
    const availableWidth = Math.max(0, window.innerWidth - padding * 2);
    const width = Math.min(Math.max(rect.width, 200), availableWidth);
    const left = Math.min(
      Math.max(rect.left, padding),
      Math.max(padding, window.innerWidth - padding - width)
    );
    const below = window.innerHeight - rect.bottom - gap - padding;
    const above = rect.top - gap - padding;
    const placement = below >= 180 || below >= above ? "down" : "up";
    const availableHeight = placement === "down" ? below : above;
    setPosition({
      left,
      width,
      maxHeight: Math.max(96, Math.min(280, availableHeight)),
      placement,
      edge: placement === "down" ? rect.bottom + gap : window.innerHeight - rect.top + gap
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    const reposition = () => updatePosition();
    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !position) return;
    window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>(`[data-option-index="${activeIndex}"]`)
        ?.focus();
    });
  }, [activeIndex, open, position]);

  useEffect(() => () => {
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
  }, []);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const fallback = event.key === "ArrowDown" ? 0 : options.length - 1;
      openMenu(selectedIndex >= 0 ? selectedIndex : fallback);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      openMenu(event.key === "Home" ? enabledIndex(0, 1) : enabledIndex(options.length - 1, -1));
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home"
        ? enabledIndex(0, 1)
        : enabledIndex(options.length - 1, -1);
      if (next >= 0) setActiveIndex(next);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      closeMenu();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      searchRef.current += event.key.toLocaleLowerCase();
      if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = window.setTimeout(() => {
        searchRef.current = "";
      }, 600);
      const match = options.findIndex((option) =>
        !option.disabled && option.label.toLocaleLowerCase().startsWith(searchRef.current)
      );
      if (match >= 0) setActiveIndex(match);
    }
  };

  const menuStyle: CSSProperties | undefined = position
    ? {
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        ...(position.placement === "down"
          ? { top: position.edge }
          : { bottom: position.edge })
      }
    : undefined;

  return (
    <div
      className={`select-control${compact ? " compact" : ""}${open ? " open" : ""}${className ? ` ${className}` : ""}`}
      ref={rootRef}
    >
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        type="button"
        className="select-control-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={unavailable}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={`select-control-value${selectedOption ? "" : " placeholder"}`}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className="select-control-chevron" size={14} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className={`select-control-menu ${position?.placement ?? "down"}`}
          role="listbox"
          aria-label={ariaLabel}
          style={menuStyle}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option, index) => {
            const selected = option.value === value;
            const active = index === activeIndex;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                data-option-index={index}
                className={`select-control-option${selected ? " selected" : ""}${active ? " active" : ""}`}
                onMouseEnter={() => {
                  if (!option.disabled) setActiveIndex(index);
                }}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                <Check size={15} aria-hidden="true" />
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </div>
  );
}

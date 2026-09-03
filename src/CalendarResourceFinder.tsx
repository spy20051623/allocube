import { Layers3, Search, Server, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import {
  searchCalendarResources,
  type CalendarSearchGroup,
  type CalendarSearchMachine
} from "./calendar-search";
import { tr } from "./i18n/index";

export type CalendarSearchTarget = {
  machineId: string;
  groupId?: string;
};

type FinderOption = CalendarSearchTarget & {
  key: string;
};

type MenuPosition = {
  left: number;
  width: number;
  maxHeight: number;
  placement: "down" | "up";
  edge: number;
};

export function CalendarResourceFinder({
  machines,
  groups,
  value,
  onChange,
  onSelect
}: {
  machines: CalendarSearchMachine[];
  groups: CalendarSearchGroup[];
  value: string;
  onChange: (value: string) => void;
  onSelect: (target: CalendarSearchTarget) => void;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const results = useMemo(
    () => searchCalendarResources(machines, groups, value),
    [groups, machines, value]
  );
  const options = useMemo<FinderOption[]>(
    () =>
      results.flatMap(({ machine, groups: matchingGroups }) => [
        { key: `machine:${machine.id}`, machineId: machine.id },
        ...matchingGroups.map((group) => ({
          key: `group:${group.id}`,
          machineId: machine.id,
          groupId: group.id
        }))
      ]),
    [results]
  );
  const optionIndex = useMemo(
    () => new Map(options.map((option, index) => [option.key, index])),
    [options]
  );
  const hasQuery = Boolean(value.trim());

  const updatePosition = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const padding = 12;
    const gap = 7;
    const availableWidth = Math.max(0, window.innerWidth - padding * 2);
    const width = Math.min(Math.max(rect.width, 420), 560, availableWidth);
    const left = Math.min(
      Math.max(rect.left, padding),
      Math.max(padding, window.innerWidth - padding - width)
    );
    const below = window.innerHeight - rect.bottom - gap - padding;
    const above = rect.top - gap - padding;
    const placement = below >= 220 || below >= above ? "down" : "up";
    const availableHeight = placement === "down" ? below : above;
    setPosition({
      left,
      width,
      maxHeight: Math.max(128, Math.min(420, availableHeight)),
      placement,
      edge: placement === "down" ? rect.bottom + gap : window.innerHeight - rect.top + gap
    });
  };

  const close = () => {
    setOpen(false);
    setPosition(null);
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    close();
    onSelect({ machineId: option.machineId, groupId: option.groupId });
  };

  const move = (direction: 1 | -1) => {
    if (!options.length) return;
    setActiveIndex((current) => (current + direction + options.length) % options.length);
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, results.length]);

  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  useEffect(() => {
    if (hasQuery || !open) return;
    setOpen(false);
    setPosition(null);
  }, [hasQuery, open]);

  useEffect(() => {
    if (activeIndex < options.length) return;
    setActiveIndex(Math.max(0, options.length - 1));
  }, [activeIndex, options.length]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
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
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-finder-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, position]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!hasQuery) return;
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(event.key === "ArrowDown" ? 0 : Math.max(0, options.length - 1));
      } else {
        move(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      if (!open || !options.length) return;
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") close();
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
  const activeOptionId = options[activeIndex]
    ? `${listboxId}-option-${activeIndex}`
    : undefined;

  return (
    <div className={`calendar-resource-finder${open ? " open" : ""}`} ref={rootRef}>
      <Search size={16} aria-hidden="true" />
      <input
        ref={inputRef}
        role="combobox"
        aria-label={tr("查找机器或资源")}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? activeOptionId : undefined}
        autoComplete="off"
        value={value}
        placeholder={tr("查找机器或资源")}
        onFocus={() => setOpen(hasQuery)}
        onClick={() => setOpen(hasQuery)}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setOpen(Boolean(next.trim()));
        }}
        onKeyDown={onKeyDown}
      />
      {value && (
        <button
          type="button"
          className="calendar-resource-finder-clear"
          aria-label={tr("清除查找")}
          title={tr("清除查找")}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange("");
            close();
            inputRef.current?.focus();
          }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      )}
      {open && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className={`calendar-resource-finder-menu ${position?.placement ?? "down"}`}
          role="listbox"
          aria-label={tr("机器与资源组结果")}
          style={menuStyle}
        >
          {results.length ? (
            <div className="calendar-resource-finder-results">
              {results.map(({ machine, groups: matchingGroups }) => {
                  const machineKey = `machine:${machine.id}`;
                  const machineIndex = optionIndex.get(machineKey) ?? 0;
                  return (
                    <div className="calendar-resource-finder-machine" key={machine.id}>
                      <button
                        type="button"
                        id={`${listboxId}-option-${machineIndex}`}
                        role="option"
                        aria-selected={activeIndex === machineIndex}
                        data-finder-index={machineIndex}
                        className={`calendar-resource-finder-machine-option${activeIndex === machineIndex ? " active" : ""}`}
                        onPointerDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(machineIndex)}
                        onClick={() => choose(machineIndex)}
                      >
                        <span className="calendar-resource-finder-machine-icon">
                          <Server size={16} aria-hidden="true" />
                        </span>
                        <span className="calendar-resource-finder-copy">
                          <span className="calendar-resource-finder-identity">
                            <strong>{machine.name}</strong>
                            {machine.address && (
                              <small title={machine.address}>{machine.address}</small>
                            )}
                            {machine.tags.length > 0 && (
                              <em title={machine.tags.join(" · ")}>
                                {machine.tags.join(" · ")}
                              </em>
                            )}
                          </span>
                          <span className="calendar-resource-finder-metadata">
                            {machine.resourceSummary && (
                              <small title={machine.resourceSummary}>
                                {machine.resourceSummary}
                              </small>
                            )}
                          </span>
                        </span>
                      </button>
                      {matchingGroups.map((group) => {
                        const groupKey = `group:${group.id}`;
                        const groupIndex = optionIndex.get(groupKey) ?? 0;
                        return (
                          <button
                            type="button"
                            id={`${listboxId}-option-${groupIndex}`}
                            key={group.id}
                            role="option"
                            aria-selected={activeIndex === groupIndex}
                            data-finder-index={groupIndex}
                            className={`calendar-resource-finder-group-option${activeIndex === groupIndex ? " active" : ""}`}
                            onPointerDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setActiveIndex(groupIndex)}
                            onClick={() => choose(groupIndex)}
                          >
                            <span aria-hidden="true" />
                            <Layers3 size={15} aria-hidden="true" />
                            <span className="calendar-resource-finder-copy">
                              <strong>{group.name}</strong>
                              {group.resourceSummary && (
                                <small title={group.resourceSummary}>{group.resourceSummary}</small>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
              })}
            </div>
          ) : (
            <div className="calendar-resource-finder-empty" aria-live="polite">
              <Search size={17} aria-hidden="true" />
              {tr("没有匹配的机器或资源")}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}

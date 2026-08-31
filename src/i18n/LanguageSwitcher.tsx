import { Check, ChevronDown, Globe2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { changeLocale, currentLocale, tr, type AppLocale } from "./index";

const localeOptions: Array<{
  value: AppLocale;
  code: string;
  name: string;
}> = [
  { value: "zh-CN", code: "中", name: "简体中文" },
  { value: "en", code: "EN", name: "English" }
];

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  useTranslation();
  const locale = currentLocale();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = localeOptions.find((option) => option.value === locale) ?? localeOptions[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div
      className={`language-switcher${compact ? " compact" : ""}${open ? " open" : ""}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="language-switcher-trigger"
        aria-label={tr("当前语言：{{v0}}", { v0: current.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        title={tr("切换界面语言")}
        onClick={() => setOpen((value) => !value)}
      >
        <Globe2 size={18} aria-hidden="true" />
        <span className="language-switcher-current">{current.name}</span>
        <span className="language-switcher-code" aria-hidden="true">{current.code}</span>
        <ChevronDown className="language-switcher-chevron" size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="language-switcher-popover" role="menu" aria-label={tr("界面语言")}>
          {localeOptions.map((option) => {
            const selected = option.value === locale;
            return (
              <button
                key={option.value}
                type="button"
                className={`language-switcher-option${selected ? " selected" : ""}`}
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setOpen(false);
                  if (!selected) void changeLocale(option.value);
                }}
              >
                <span className="language-switcher-option-code" aria-hidden="true">{option.code}</span>
                <span className="language-switcher-option-copy">
                  <strong>{option.name}</strong>
                </span>
                <Check size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

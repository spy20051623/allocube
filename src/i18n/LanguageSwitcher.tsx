import { Globe2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PreferenceMenu, type PreferenceMenuControl } from "../components/PreferenceMenu";
import { changeLocale, currentLocale, tr, type AppLocale } from "./index";

const options = [
  { value: "zh-CN" as const, icon: "中", label: "简体中文" },
  { value: "en" as const, icon: "EN", label: "English" }
];

export function LanguageSwitcher({ compact = false, ...control }: PreferenceMenuControl & { compact?: boolean }) {
  useTranslation();
  const locale = currentLocale();
  const current = options.find(option => option.value === locale) ?? options[0];
  return <PreferenceMenu<AppLocale> {...control} className="locale-switcher" compact={compact}
    value={locale} options={options} onSelect={value => { void changeLocale(value); }}
    icon={<Globe2 size={18} aria-hidden="true" />} label={current.label} shortLabel={current.icon}
    title={tr("切换界面语言")} ariaLabel={tr("当前语言：{{v0}}", { v0: current.label })} menuLabel={tr("界面语言")} />;
}

import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { tr } from "../i18n";
import { PreferenceMenu, type PreferenceMenuControl } from "../components/PreferenceMenu";
import { setThemePreference, useTheme, type ThemePreference } from "./state";

export function ThemeSwitcher({ compact = false, ...control }: PreferenceMenuControl & { compact?: boolean }) {
  useTranslation();
  const { preference } = useTheme();
  const options = [
    { value: "system" as const, label: tr("跟随系统"), icon: <Monitor size={18} aria-hidden="true" /> },
    { value: "light" as const, label: tr("浅色"), icon: <Sun size={18} aria-hidden="true" /> },
    { value: "dark" as const, label: tr("深色"), icon: <Moon size={18} aria-hidden="true" /> }
  ];
  const current = options.find(option => option.value === preference)!;
  return <PreferenceMenu<ThemePreference> {...control} className="theme-switcher" compact={compact}
    value={preference} options={options} onSelect={setThemePreference} icon={current.icon} label={current.label}
    title={tr("切换主题")} ariaLabel={tr("当前主题：{{v0}}", { v0: current.label })} menuLabel={tr("界面主题")} />;
}

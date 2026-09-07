import { useState } from "react";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { ThemeSwitcher } from "../theme/ThemeSwitcher";

export function DisplayPreferences({ compact = false }: { compact?: boolean }) {
  const [menu, setMenu] = useState<"language" | "theme" | null>(null);
  const change = (name: "language" | "theme", open: boolean) => {
    setMenu(current => open ? name : current === name ? null : current);
  };
  return <div className="display-preferences">
    <LanguageSwitcher compact={compact} open={menu === "language"} onOpenChange={open => change("language", open)} />
    <ThemeSwitcher compact={compact} open={menu === "theme"} onOpenChange={open => change("theme", open)} />
  </div>;
}

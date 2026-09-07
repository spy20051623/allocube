import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";
export interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolved: ThemeMode;
}
declare global {
  interface Window {
    allocubeTheme: {
      getSnapshot(): ThemeSnapshot;
      subscribe(listener: () => void): () => void;
      setPreference(value: ThemePreference): void;
    };
  }
}
const serverSnapshot: ThemeSnapshot = { preference: "system", resolved: "light" };
const subscribe = (listener: () => void) => window.allocubeTheme.subscribe(listener);
const getSnapshot = () => window.allocubeTheme.getSnapshot();
export const setThemePreference = (value: ThemePreference) => window.allocubeTheme.setPreference(value);
export function useTheme() {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}

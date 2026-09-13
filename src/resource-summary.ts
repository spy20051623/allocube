import { tr } from "./i18n/index";

/** Translate generated sharing markers while preserving resource names and units. */
export function localizeResourceSummary(value: string) {
  return value.replace(/(^| ｜ )共享 · /g, (_match, separator: string) =>
    `${separator}${tr("共享")} · `
  );
}

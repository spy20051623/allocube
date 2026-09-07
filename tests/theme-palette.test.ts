import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/theme/theme.css", import.meta.url), "utf8");
const colors = new Map([...css.matchAll(/--([\w-]+):\s*(#[\da-f]{6});/gi)].map(match => [match[1], match[2]]));
function luminance(token: string) {
  const hex = colors.get(token);
  if (!hex) throw new Error(`Unknown palette role: ${token}`);
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a: string, b: string) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
describe("深色主题的语义配色对比度", () => {
  it("正文、次级文字与所有中性背景达到 4.5:1", () => {
    for (const text of ["text-primary", "text-secondary", "text-accent"])
      for (const surface of ["surface-page", "surface-panel", "surface-raised", "surface-hover", "surface-input", "surface-disabled"])
        expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });
  it("状态文字、预约和填充按钮达到 4.5:1", () => {
    for (const tone of ["accent", "success", "warning", "danger", "purple", "info"]) {
      const text = tone === "accent" ? "text-accent" : `text-${tone}`;
      for (const variant of ["", "-hover"])
        expect(contrast(text, `surface-${tone}${variant}`), tone + variant).toBeGreaterThanOrEqual(4.5);
      expect(contrast("text-on-accent", `fill-${tone}`), `fill-${tone}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const [text, surface] of [["text-accent", "surface-booking-own"], ["text-accent", "surface-booking-own-hover"],
      ["text-purple", "surface-machine-own"], ["text-purple", "surface-machine-own-hover"],
      ["text-warning", "surface-warning-stripe-hover"], ["text-danger", "surface-danger-stripe-hover"]])
      expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });
  it("控件边界、焦点环和日历状态边界达到 3:1", () => {
    for (const border of ["border-control", "focus-ring"])
      for (const surface of ["surface-page", "surface-panel", "surface-raised", "surface-input"])
        expect(contrast(border, surface), `${border} on ${surface}`).toBeGreaterThanOrEqual(3);
    for (const tone of ["accent", "success", "warning", "danger", "purple", "info"])
      expect(contrast(`border-${tone}`, `surface-${tone}`), tone).toBeGreaterThanOrEqual(3);
  });
});

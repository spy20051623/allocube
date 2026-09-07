import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSourceTree } from "./helpers/source-tree";

const sources = readSourceTree(new URL("../src/", import.meta.url));
const appSource = [...sources.entries()].filter(([name]) => /\.tsx?$/.test(name)).map(([, source]) => source).join("\n");
const loginSource = sources.get("features/auth/LoginPage.tsx")!;
const calendarSource = [...sources.entries()].filter(([name]) => name.startsWith("features/calendar/")).map(([, source]) => source).join("\n");
const calendarEventSource = readFileSync(
  new URL("../src/CalendarEventVisual.tsx", import.meta.url),
  "utf8"
);
const calendarPopoverSource = readFileSync(
  new URL("../src/CalendarAnchoredPopover.tsx", import.meta.url),
  "utf8"
);
const styles = [...sources.entries()].filter(([name]) => name.endsWith(".css")).map(([, source]) => source).join("\n");

describe("界面复用约束", () => {
  it("用户名和工号登录复用同一表单", () => {
    expect(loginSource.match(/function LoginCredentialForm\(/g)).toHaveLength(1);
    expect(loginSource.match(/<LoginCredentialForm/g)).toHaveLength(2);
    expect(appSource).not.toContain("function UsernameLoginForm(");
    expect(appSource).not.toContain("function EmployeeNumberLoginForm(");
    expect(loginSource).toMatch(
      /usernameLogin\s+\? event\.target\.value\s+: event\.target\.value\.toLowerCase\(\)/
    );
  });

  it("日历正式事件和草稿复用日、周事件组件", () => {
    expect(calendarSource.match(/<CalendarDayEventBlock/g)?.length).toBeGreaterThan(1);
    expect(calendarSource.match(/<CalendarWeekEvent/g)?.length).toBeGreaterThan(1);
    expect(calendarEventSource).toContain("export function CalendarDayEventBlock");
    expect(calendarEventSource).toContain("export function CalendarWeekEvent");
    expect(calendarEventSource).toContain('"DRAFT"');
    expect(calendarEventSource).toContain('"DRAFT_PREVIEW"');
    expect(calendarEventSource).toContain('"ERASE_PREVIEW"');
    expect(calendarEventSource).toContain('"CONFLICT_PREVIEW"');
  });

  it("三个日历弹层复用同一外壳并支持点击背景关闭", () => {
    expect(calendarSource.match(/<CalendarAnchoredPopover/g)).toHaveLength(3);
    expect(calendarPopoverSource).toContain("const CALENDAR_POPOVER_WIDTH = 340;");
    expect(calendarPopoverSource).toContain(
      '<div className="reservation-popover-layer" onPointerDown={onClose}>'
    );
    expect(calendarPopoverSource).toContain(
      "onPointerDown={(event) => event.stopPropagation()}"
    );
  });

  it("维护和停用复用影响摘要", () => {
    expect(appSource.match(/<UnavailabilityImpactSummary/g)).toHaveLength(2);
  });

  it("交互图标在紧凑布局中保持固定尺寸", () => {
    expect(styles).toMatch(
      /\.lucide,\s*\.mouse-control-icon\s*\{[^}]*flex:\s*0 0 auto;/s
    );
  });

  it("确认和输入操作不调用浏览器原生弹窗", () => {
    expect(appSource).not.toMatch(/window\.(alert|confirm|prompt)/);
    expect(appSource).toContain("function DialogProvider");
    expect(appSource).toContain("function AppActionDialog");
  });
});

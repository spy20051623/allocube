import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  UnavailabilityImpactSummary,
  type UnavailabilityImpactData
} from "../src/UnavailabilityImpactSummary.js";

function reservation(id: string) {
  return {
    id,
    applicantName: `用户${id}`,
    resourceGroupName: `资源组${id}`,
    startAt: "2026-09-04T02:00:00.000Z"
  };
}

describe("维护影响摘要", () => {
  it("统一显示影响数量、处理方式和有限条明细", () => {
    const impact: UnavailabilityImpactData = {
      affectedReservations: [
        reservation("1"),
        reservation("2"),
        reservation("3"),
        reservation("4")
      ],
      summary: {
        total: 4,
        cancelled: 1,
        trimmed: 2,
        split: 1
      }
    };

    const html = renderToStaticMarkup(
      <UnavailabilityImpactSummary impact={impact} />
    );

    expect(html).toContain("unavailability-impact-bar warning");
    expect(html).toContain("影响 4 条占用");
    expect(html).toContain("取消1 条 · 裁切2 条 · 拆分1 条");
    expect(html).toContain("用户1");
    expect(html).toContain("用户2");
    expect(html).toContain("用户3");
    expect(html).not.toContain("用户4");
    expect(html).toContain("另有1 条占用");
  });

  it("无影响时显示安全状态", () => {
    const impact: UnavailabilityImpactData = {
      affectedReservations: [],
      summary: {
        total: 0,
        cancelled: 0,
        trimmed: 0,
        split: 0
      }
    };

    const html = renderToStaticMarkup(
      <UnavailabilityImpactSummary impact={impact} />
    );

    expect(html).toContain("unavailability-impact-bar safe");
    expect(html).toContain("没有受影响的占用");
    expect(html).not.toContain("条 · 裁切");
  });
});

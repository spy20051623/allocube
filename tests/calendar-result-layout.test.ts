import { describe, expect, it } from "vitest";
import { allocateCalendarResultFieldWidths } from "../src/calendar-result-layout.js";

const intrinsic = {
  title: 100,
  address: 60,
  tags: 80,
  resource: 120
};

describe("日历查找结果宽度分配", () => {
  it("空间充足时完整保留所有字段", () => {
    expect(allocateCalendarResultFieldWidths(intrinsic, 400)).toEqual(intrinsic);
  });

  it("依次截断并隐藏资源、标签和 IP，最后才截断标题", () => {
    expect(allocateCalendarResultFieldWidths(intrinsic, 320)).toEqual({
      ...intrinsic,
      resource: 68
    });
    expect(allocateCalendarResultFieldWidths(intrinsic, 299)).toEqual({
      ...intrinsic,
      resource: 0
    });
    expect(allocateCalendarResultFieldWidths(intrinsic, 210)).toEqual({
      ...intrinsic,
      tags: 0,
      resource: 0
    });
    expect(allocateCalendarResultFieldWidths(intrinsic, 130)).toEqual({
      ...intrinsic,
      address: 0,
      tags: 0,
      resource: 0
    });
    expect(allocateCalendarResultFieldWidths(intrinsic, 70)).toEqual({
      title: 70,
      address: 0,
      tags: 0,
      resource: 0
    });
  });
});

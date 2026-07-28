import { describe, expect, it } from "vitest";
import {
  calendarDraftFieldIssues,
  calendarDraftIssues,
  calendarEditUrl,
  calendarQueryUrl,
  calendarUrlWithoutEditRequest,
  calendarUrlWithEditRequest,
  createServerClockAnchor,
  clampDayWindowStartMinutes,
  currentMinuteStart,
  defaultDayWindowStartMinutes,
  draggedTimeRange,
  eraseCalendarDraftRange,
  mergeCalendarDrafts,
  mergeTimeRanges,
  parseCalendarQuery,
  parseCalendarEditRoute,
  parseCalendarEditReservationId,
  previewsByDraftId,
  snappedTimelineInstant,
  serverTimeFromAnchor,
  subtractBusyTimeRanges,
  splitDrafts,
  timelineWheelAction,
  advanceCalendarDrafts,
  type CalendarDraft
} from "../src/calendar-state";

describe("资源日历状态", () => {
  it("日视图默认展示十二小时并按北京时间选择窗口", () => {
    expect(
      defaultDayWindowStartMinutes(
        new Date("2026-07-26T05:59:00.000Z").getTime()
      )
    ).toBe(9 * 60);
    expect(
      defaultDayWindowStartMinutes(
        new Date("2026-07-26T06:00:00.000Z").getTime()
      )
    ).toBe(12 * 60);
    expect(
      defaultDayWindowStartMinutes(
        new Date("2026-07-26T06:00:00.000Z").getTime(),
        6
      )
    ).toBe(15 * 60);
    expect(defaultDayWindowStartMinutes(Date.now(), 24)).toBe(0);
  });

  it("日视图窗口不会滚动到当天范围之外", () => {
    expect(clampDayWindowStartMinutes(-30, 12)).toBe(0);
    expect(clampDayWindowStartMinutes(900, 12)).toBe(720);
    expect(clampDayWindowStartMinutes(500, 24)).toBe(0);
  });

  it("滚轮修饰键分别锁定纵向、横向和缩放行为", () => {
    expect(
      timelineWheelAction({
        altKey: false,
        shiftKey: false,
        deltaX: 0,
        deltaY: 120
      })
    ).toEqual({ kind: "VERTICAL" });
    expect(
      timelineWheelAction({
        altKey: false,
        shiftKey: true,
        deltaX: 0,
        deltaY: -120
      })
    ).toEqual({ kind: "HORIZONTAL", delta: -120 });
    expect(
      timelineWheelAction({
        altKey: true,
        shiftKey: false,
        deltaX: 0,
        deltaY: -120
      })
    ).toEqual({ kind: "ZOOM_IN" });
    expect(
      timelineWheelAction({
        altKey: true,
        shiftKey: true,
        deltaX: 0,
        deltaY: 120
      })
    ).toEqual({ kind: "ZOOM_OUT" });
  });

  it("当前分钟从整分钟开始且允许占用", () => {
    expect(
      currentMinuteStart(
        new Date("2026-07-27T10:31:48.521Z").getTime()
      )
    ).toBe("2026-07-27T10:31:00.000Z");
  });

  it("解析并生成可恢复的日历地址", () => {
    const state = parseCalendarQuery(
      "?date=2026-07-27&view=week&machine=m-1&q=GPU",
      "2026-07-26"
    );
    expect(state).toEqual({
      date: "2026-07-27",
      view: "week",
      machineId: "m-1",
      search: "GPU"
    });
    expect(calendarQueryUrl(state)).toBe(
      "/calendar?date=2026-07-27&view=week&machine=m-1&q=GPU"
    );
    const reservationId = "43f88a10-a42e-4fe3-8a4a-2c434d4c20a7";
    const editUrl = calendarEditUrl({
      reservationId,
      date: "2026-07-27",
      machineId: "machine-1"
    });
    expect(editUrl).toBe(
      `/calendar?date=2026-07-27&machine=machine-1&edit=${reservationId}`
    );
    expect(parseCalendarEditReservationId(editUrl.split("?")[1])).toBe(
      reservationId
    );
    expect(parseCalendarEditRoute(editUrl)).toEqual({
      kind: "EDIT",
      reservationId
    });
    expect(parseCalendarEditRoute("?date=2026-07-27")).toEqual({
      kind: "NONE"
    });
    expect(parseCalendarEditRoute("?edit=invalid")).toEqual({
      kind: "INVALID"
    });
    expect(parseCalendarEditReservationId("?edit=invalid")).toBe("");
    expect(calendarUrlWithoutEditRequest(editUrl.split("?")[1])).toBe(
      "/calendar?date=2026-07-27&machine=machine-1"
    );
    expect(calendarUrlWithoutEditRequest(`?edit=${reservationId}`)).toBe(
      "/calendar"
    );
    expect(
      calendarUrlWithEditRequest(
        "?date=2026-07-27&machine=machine-1",
        reservationId
      )
    ).toBe(
      `/calendar?date=2026-07-27&machine=machine-1&edit=${reservationId}`
    );
    expect(
      calendarUrlWithEditRequest(
        `?date=2026-07-27&edit=${reservationId}`,
        "3f9b7c52-b4df-4f9f-83b3-e8745dd7bc0e"
      )
    ).toBe(
      "/calendar?date=2026-07-27&edit=3f9b7c52-b4df-4f9f-83b3-e8745dd7bc0e"
    );
  });

  it("单击不生成时段，拖拽按15分钟吸附", () => {
    expect(
      draggedTimeRange({
        rangeStart: "2026-07-26T16:00:00.000Z",
        days: 1,
        trackLeft: 0,
        trackWidth: 960,
        pointerStart: 400,
        pointerEnd: 402
      })
    ).toBeNull();
    expect(
      draggedTimeRange({
        rangeStart: "2026-07-26T16:00:00.000Z",
        days: 1,
        trackLeft: 0,
        trackWidth: 960,
        pointerStart: 360,
        pointerEnd: 440
      })
    ).toEqual({
      startAt: "2026-07-27T01:00:00.000Z",
      endAt: "2026-07-27T03:00:00.000Z"
    });
  });

  it("鼠标悬停时间按相同粒度吸附并限制在时间轴内", () => {
    expect(
      snappedTimelineInstant({
        rangeStart: "2026-07-26T16:00:00.000Z",
        days: 1,
        trackLeft: 100,
        trackWidth: 960,
        pointer: 463
      })
    ).toBe("2026-07-27T01:00:00.000Z");
    expect(
      snappedTimelineInstant({
        rangeStart: "2026-07-26T16:00:00.000Z",
        days: 1,
        trackLeft: 100,
        trackWidth: 960,
        pointer: 9999
      })
    ).toBe("2026-07-27T16:00:00.000Z");
  });

  it("拖拽时按已有占用裁剪为多个可用片段", () => {
    expect(
      subtractBusyTimeRanges(
        {
          startAt: "2026-07-27T01:00:00.000Z",
          endAt: "2026-07-27T05:00:00.000Z"
        },
        [
          {
            startAt: "2026-07-27T02:00:00.000Z",
            endAt: "2026-07-27T02:30:00.000Z"
          },
          {
            startAt: "2026-07-27T03:00:00.000Z",
            endAt: "2026-07-27T04:00:00.000Z"
          }
        ],
        15
      )
    ).toEqual([
      {
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T02:00:00.000Z"
      },
      {
        startAt: "2026-07-27T02:30:00.000Z",
        endAt: "2026-07-27T03:00:00.000Z"
      },
      {
        startAt: "2026-07-27T04:00:00.000Z",
        endAt: "2026-07-27T05:00:00.000Z"
      }
    ]);
  });

  it("把当前时间以前的拖拽范围整体剔除", () => {
    const past = {
      startAt: "2026-07-26T16:00:00.000Z",
      endAt: "2026-07-27T10:31:00.000Z"
    };
    expect(
      subtractBusyTimeRanges(
        {
          startAt: "2026-07-27T10:00:00.000Z",
          endAt: "2026-07-27T12:00:00.000Z"
        },
        [past],
        1
      )
    ).toEqual([
      {
        startAt: "2026-07-27T10:31:00.000Z",
        endAt: "2026-07-27T12:00:00.000Z"
      }
    ]);
    expect(
      subtractBusyTimeRanges(
        {
          startAt: "2026-07-27T09:00:00.000Z",
          endAt: "2026-07-27T10:00:00.000Z"
        },
        [past],
        1
      )
    ).toEqual([]);
  });

  it("服务器时间推进后，立即开始草稿跟随当前分钟并清理过期草稿", () => {
    const result = advanceCalendarDrafts(
      [
        {
          id: "trimmed",
          resourceGroupId: "group-a",
          startMode: "IMMEDIATE",
          startAt: "2026-07-27T10:00:00.000Z",
          endAt: "2026-07-27T12:00:00.000Z"
        },
        {
          id: "expired",
          resourceGroupId: "group-a",
          startMode: "IMMEDIATE",
          startAt: "2026-07-27T09:00:00.000Z",
          endAt: "2026-07-27T10:20:00.000Z"
        },
        {
          id: "future",
          resourceGroupId: "group-b",
          startMode: "SCHEDULED",
          startAt: "2026-07-27T13:00:00.000Z",
          endAt: "2026-07-27T14:00:00.000Z"
        }
      ],
      "2026-07-27T10:15:00.000Z",
      15
    );
    expect(result).toEqual({
      changed: true,
      drafts: [
        {
          id: "trimmed",
          resourceGroupId: "group-a",
          startMode: "IMMEDIATE",
          startAt: "2026-07-27T10:15:00.000Z",
          endAt: "2026-07-27T12:00:00.000Z"
        },
        {
          id: "future",
          resourceGroupId: "group-b",
          startMode: "SCHEDULED",
          startAt: "2026-07-27T13:00:00.000Z",
          endAt: "2026-07-27T14:00:00.000Z"
        }
      ]
    });
  });

  it("普通预约到达当前分钟后自动进入立即开始模式", () => {
    const draft: CalendarDraft = {
      id: "scheduled",
      resourceGroupId: "group-a",
      startMode: "SCHEDULED",
      startAt: "2026-07-27T10:15:00.000Z",
      endAt: "2026-07-27T12:00:00.000Z"
    };
    expect(
      advanceCalendarDrafts(
        [draft],
        "2026-07-27T10:14:00.000Z",
        15
      )
    ).toEqual({ changed: false, drafts: [draft] });
    expect(
      advanceCalendarDrafts(
        [draft],
        "2026-07-27T10:15:00.000Z",
        15
      ).drafts[0]
    ).toMatchObject({
      startMode: "IMMEDIATE",
      startAt: "2026-07-27T10:15:00.000Z"
    });
  });

  it("服务器授时使用往返中点，并以单调时间持续推进", () => {
    const anchor = createServerClockAnchor(
      "2026-07-27T10:00:00.000Z",
      1_000,
      1_200
    );
    expect(anchor).not.toBeNull();
    expect(serverTimeFromAnchor(anchor!, 1_700)).toBe(
      new Date("2026-07-27T10:00:00.600Z").getTime()
    );
  });

  it("新增时段与已有草稿重叠或首尾相接时自动合并", () => {
    const existing: CalendarDraft[] = [
      {
        id: "draft-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T02:00:00.000Z"
      }
    ];
    expect(
      mergeCalendarDrafts(
        existing,
        [
          {
            resourceGroupId: "group-a",
            startAt: "2026-07-27T02:00:00.000Z",
            endAt: "2026-07-27T03:00:00.000Z"
          },
          {
            resourceGroupId: "group-b",
            startAt: "2026-07-27T04:00:00.000Z",
            endAt: "2026-07-27T05:00:00.000Z"
          }
        ],
        () => "new-id"
      )
    ).toEqual([
      {
        id: "draft-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T03:00:00.000Z"
      },
      {
        id: "new-id",
        resourceGroupId: "group-b",
        startAt: "2026-07-27T04:00:00.000Z",
        endAt: "2026-07-27T05:00:00.000Z"
      }
    ]);
    expect(
      mergeTimeRanges([
        {
          startAt: "2026-07-27T03:00:00.000Z",
          endAt: "2026-07-27T04:00:00.000Z"
        },
        {
          startAt: "2026-07-27T03:30:00.000Z",
          endAt: "2026-07-27T05:00:00.000Z"
        }
      ])
    ).toEqual([
      {
        startAt: "2026-07-27T03:00:00.000Z",
        endAt: "2026-07-27T05:00:00.000Z"
      }
    ]);
  });

  it("右键拖动可删除、裁切或拆分同一目标的草稿", () => {
    const drafts: CalendarDraft[] = [
      {
        id: "draft-a",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startMode: "IMMEDIATE",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T05:00:00.000Z"
      },
      {
        id: "draft-b",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-b",
        startMode: "SCHEDULED",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T05:00:00.000Z"
      }
    ];
    expect(
      eraseCalendarDraftRange(
        drafts,
        {
          scope: "RESOURCE_GROUP",
          machineId: "machine-a",
          resourceGroupId: "group-a"
        },
        {
          startAt: "2026-07-27T02:00:00.000Z",
          endAt: "2026-07-27T04:00:00.000Z"
        },
        () => "split-id",
        30,
        "2026-07-27T01:00:00.000Z"
      )
    ).toEqual({
      changed: true,
      drafts: [
        {
          ...drafts[0],
          endAt: "2026-07-27T02:00:00.000Z"
        },
        {
          ...drafts[0],
          id: "split-id",
          startMode: "SCHEDULED",
          startAt: "2026-07-27T04:00:00.000Z"
        },
        drafts[1]
      ]
    });
    expect(
      eraseCalendarDraftRange(
        [drafts[0]],
        drafts[0],
        {
          startAt: "2026-07-27T00:00:00.000Z",
          endAt: "2026-07-27T06:00:00.000Z"
        },
        () => "unused"
      )
    ).toEqual({ changed: true, drafts: [] });
  });

  it("编辑后已有草稿首尾相接或重叠时也会自动合并", () => {
    const drafts: CalendarDraft[] = [
      {
        id: "first",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T03:00:00.000Z"
      },
      {
        id: "second",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T02:30:00.000Z",
        endAt: "2026-07-27T04:00:00.000Z"
      }
    ];
    expect(mergeCalendarDrafts(drafts, [], () => "unused")).toEqual([
      {
        ...drafts[0],
        endAt: "2026-07-27T04:00:00.000Z"
      }
    ]);
  });

  it("自动合并时不会删除尚未填写完整的草稿", () => {
    const incomplete: CalendarDraft = {
      id: "incomplete",
      scope: "RESOURCE_GROUP",
      machineId: "machine-a",
      resourceGroupId: "group-a",
      startAt: "",
      endAt: "2026-07-27T04:00:00.000Z"
    };
    expect(mergeCalendarDrafts([incomplete], [], () => "unused")).toEqual([
      incomplete
    ]);
  });

  it("资源组草稿只作用于点击的资源组，整机草稿按机器合并", () => {
    const drafts: CalendarDraft[] = [
      {
        id: "group-draft",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T02:00:00.000Z"
      },
      {
        id: "machine-draft",
        scope: "MACHINE",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T03:00:00.000Z",
        endAt: "2026-07-27T04:00:00.000Z"
      }
    ];
    expect(
      mergeCalendarDrafts(
        drafts,
        [
          {
            scope: "RESOURCE_GROUP",
            machineId: "machine-a",
            resourceGroupId: "group-b",
            startAt: "2026-07-27T01:30:00.000Z",
            endAt: "2026-07-27T02:30:00.000Z"
          },
          {
            scope: "MACHINE",
            machineId: "machine-a",
            resourceGroupId: "group-b",
            startAt: "2026-07-27T04:00:00.000Z",
            endAt: "2026-07-27T05:00:00.000Z"
          }
        ],
        () => "new-id"
      )
    ).toEqual([
      drafts[0],
      {
        ...drafts[1],
        endAt: "2026-07-27T05:00:00.000Z"
      },
      {
        id: "new-id",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-b",
        startAt: "2026-07-27T01:30:00.000Z",
        endAt: "2026-07-27T02:30:00.000Z"
      }
    ]);
  });

  it("冲突结果按草稿标识关联，拆分后生成新的草稿标识", () => {
    const drafts: CalendarDraft[] = [
      {
        id: "draft-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T03:00:00.000Z"
      }
    ];
    const items = [
      {
        input: { ...drafts[0] },
        available: false,
        conflicts: [
          {
            type: "RESERVATION" as const,
            startAt: "2026-07-27T02:00:00.000Z",
            endAt: "2026-07-27T02:30:00.000Z",
            label: "已有占用"
          }
        ],
        splitSegments: [
          {
            resourceGroupId: "group-a",
            startAt: "2026-07-27T01:00:00.000Z",
            endAt: "2026-07-27T02:00:00.000Z"
          }
        ]
      }
    ];
    const mapped = previewsByDraftId(drafts, items);
    expect(mapped.get("draft-a")?.available).toBe(false);
    expect(splitDrafts(drafts, mapped, () => "draft-b")).toEqual([
      {
        id: "draft-b",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T02:00:00.000Z"
      }
    ]);
  });

  it("一次返回全部草稿静态问题", () => {
    const drafts: CalendarDraft[] = [
      {
        id: "draft-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T01:10:00.000Z"
      },
      {
        id: "draft-b",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:05:00.000Z",
        endAt: "2026-07-27T03:30:00.000Z"
      }
    ];
    expect(
      calendarDraftIssues(
        drafts,
        {
          minBookingMinutes: 15,
          maxBookingMinutes: 120,
          advanceDays: 30
        },
        new Date("2026-07-26T00:00:00.000Z").getTime()
      )
    ).toEqual([
      "占用时间至少需要 15 分钟",
      "单次占用最长 120 分钟",
      "同一占用目标存在重叠的草稿时段"
    ]);
  });

  it("把时间问题精确映射到开始和结束字段", () => {
    expect(
      calendarDraftFieldIssues(
        {
          id: "draft-a",
          resourceGroupId: "group-a",
          startAt: "2026-07-26T00:00:00.000Z",
          endAt: "2026-07-26T00:05:00.000Z"
        },
        {
          minBookingMinutes: 15,
          maxBookingMinutes: 120,
          advanceDays: 30
        },
        new Date("2026-07-26T01:00:00.000Z").getTime()
      )
    ).toEqual({
      startAt: "不能占用已经过去的时间",
      endAt: "占用时间至少需要 15 分钟"
    });
  });

  it("混合整机与资源组草稿时阻止提交", () => {
    const drafts: CalendarDraft[] = [
      {
        id: "group",
        scope: "RESOURCE_GROUP",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T01:00:00.000Z",
        endAt: "2026-07-27T02:00:00.000Z"
      },
      {
        id: "machine",
        scope: "MACHINE",
        machineId: "machine-a",
        resourceGroupId: "group-a",
        startAt: "2026-07-27T03:00:00.000Z",
        endAt: "2026-07-27T04:00:00.000Z"
      }
    ];
    expect(
      calendarDraftIssues(
        drafts,
        {
          minBookingMinutes: 1,
          maxBookingMinutes: 1440,
          advanceDays: 30
        },
        new Date("2026-07-26T00:00:00.000Z").getTime()
      )
    ).toContain("整机占用和资源组占用不能同时提交");
  });
});

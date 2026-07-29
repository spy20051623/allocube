import { describe, expect, it } from "vitest";
import { mergeProjectedUnavailability } from "../src/calendar-unavailability";
import type { UnavailabilityWindow } from "../src/shared/types";

function planned(
  id: string,
  startAt: string,
  endAt: string,
  resourceGroupId: string | null
): UnavailabilityWindow {
  return {
    id,
    machineId: "machine-1",
    resourceGroupId,
    kind: "PLANNED",
    startAt,
    endAt,
    reason: "",
    status: "ACTIVE"
  };
}

describe("mergeProjectedUnavailability", () => {
  it("projects machine downtime and merges overlapping group downtime", () => {
    const result = mergeProjectedUnavailability(
      [
        planned(
          "machine-window",
          "2026-07-29T02:00:00.000Z",
          "2026-07-29T04:00:00.000Z",
          null
        )
      ],
      [
        planned(
          "group-window",
          "2026-07-29T03:00:00.000Z",
          "2026-07-29T05:00:00.000Z",
          "group-1"
        )
      ]
    );

    expect(result).toEqual([
      {
        startAt: "2026-07-29T02:00:00.000Z",
        endAt: "2026-07-29T05:00:00.000Z",
        sources: [
          expect.objectContaining({ scope: "MACHINE" }),
          expect.objectContaining({ scope: "RESOURCE_GROUP" })
        ]
      }
    ]);
  });

  it("merges adjacent windows and keeps their original sources", () => {
    const result = mergeProjectedUnavailability(
      [
        planned(
          "first",
          "2026-07-29T02:00:00.000Z",
          "2026-07-29T03:00:00.000Z",
          null
        )
      ],
      [
        planned(
          "second",
          "2026-07-29T03:00:00.000Z",
          "2026-07-29T04:00:00.000Z",
          "group-1"
        )
      ]
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      startAt: "2026-07-29T02:00:00.000Z",
      endAt: "2026-07-29T04:00:00.000Z"
    });
    expect(result[0]?.sources.map((source) => source.window.id)).toEqual([
      "first",
      "second"
    ]);
  });

  it("keeps separated windows apart and excludes long-term downtime", () => {
    const longTerm: UnavailabilityWindow = {
      ...planned(
        "long-term",
        "2026-07-29T00:00:00.000Z",
        "9999-12-31T23:59:59.999Z",
        "group-1"
      ),
      kind: "LONG_TERM"
    };
    const result = mergeProjectedUnavailability(
      [
        planned(
          "first",
          "2026-07-29T02:00:00.000Z",
          "2026-07-29T03:00:00.000Z",
          null
        )
      ],
      [
        planned(
          "second",
          "2026-07-29T04:00:00.000Z",
          "2026-07-29T05:00:00.000Z",
          "group-1"
        ),
        longTerm
      ]
    );

    expect(result.map((item) => item.sources[0]?.window.id)).toEqual([
      "first",
      "second"
    ]);
  });
});

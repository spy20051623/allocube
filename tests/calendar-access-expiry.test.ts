import { expect, it } from "vitest";
import { accessExpiryIssues, accessExpiryBusyRanges } from "../src/features/calendar/access-expiry";
import { subtractBusyTimeRanges } from "../src/calendar-state";

it("allows ending exactly at Beijing midnight but disallows starting there", () => {
  const boundary = "2026-09-14T16:00:00.000Z";
  expect(accessExpiryIssues("2026-09-14T15:00:00.000Z", boundary, boundary)).toEqual({});
  expect(accessExpiryIssues(boundary, "2026-09-14T16:01:00.000Z", boundary)).toHaveProperty("startAt");
  expect(accessExpiryIssues("2026-09-14T15:00:00.000Z", "2026-09-14T16:01:00.000Z", boundary)).toHaveProperty("endAt");
});

it("clips a crossing drag and removes a fully expired selection, leaving permanent access unchanged", () => {
  const boundary = "2026-09-14T16:00:00.000Z";
  const crossing = { startAt: "2026-09-14T15:00:00.000Z", endAt: "2026-09-14T17:00:00.000Z" };
  expect(subtractBusyTimeRanges(crossing, accessExpiryBusyRanges(boundary))).toEqual([{ ...crossing, endAt: boundary }]);
  expect(subtractBusyTimeRanges({ ...crossing, startAt: boundary }, accessExpiryBusyRanges(boundary))).toEqual([]);
  expect(subtractBusyTimeRanges(crossing, accessExpiryBusyRanges(null))).toEqual([crossing]);
  expect(accessExpiryIssues(crossing.startAt, crossing.endAt, null)).toEqual({});
});

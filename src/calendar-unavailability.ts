import type { UnavailabilityWindow } from "./shared/types";

export type ProjectedUnavailabilitySource = {
  scope: "MACHINE" | "RESOURCE_GROUP";
  window: UnavailabilityWindow;
};

export type ProjectedUnavailability = {
  startAt: string;
  endAt: string;
  sources: ProjectedUnavailabilitySource[];
};

export function mergeProjectedUnavailability(
  machineWindows: UnavailabilityWindow[],
  groupWindows: UnavailabilityWindow[]
): ProjectedUnavailability[] {
  const sources: ProjectedUnavailabilitySource[] = [
    ...machineWindows.map((window) => ({
      scope: "MACHINE" as const,
      window
    })),
    ...groupWindows.map((window) => ({
      scope: "RESOURCE_GROUP" as const,
      window
    }))
  ]
    .filter(
      ({ window }) =>
        window.kind === "PLANNED" &&
        window.status === "ACTIVE" &&
        Number.isFinite(new Date(window.startAt).getTime()) &&
        Number.isFinite(new Date(window.endAt).getTime()) &&
        new Date(window.endAt).getTime() > new Date(window.startAt).getTime()
    )
    .sort(
      (left, right) =>
        new Date(left.window.startAt).getTime() -
          new Date(right.window.startAt).getTime() ||
        new Date(left.window.endAt).getTime() -
          new Date(right.window.endAt).getTime()
    );

  const merged: ProjectedUnavailability[] = [];
  for (const source of sources) {
    const previous = merged.at(-1);
    const sourceStart = new Date(source.window.startAt).getTime();
    const sourceEnd = new Date(source.window.endAt).getTime();
    const previousEnd = previous
      ? new Date(previous.endAt).getTime()
      : Number.NEGATIVE_INFINITY;

    if (!previous || sourceStart > previousEnd) {
      merged.push({
        startAt: source.window.startAt,
        endAt: source.window.endAt,
        sources: [source]
      });
      continue;
    }

    if (sourceEnd > previousEnd) previous.endAt = source.window.endAt;
    if (
      !previous.sources.some(
        (existing) =>
          existing.scope === source.scope &&
          existing.window.id === source.window.id
      )
    ) {
      previous.sources.push(source);
    }
  }

  return merged;
}

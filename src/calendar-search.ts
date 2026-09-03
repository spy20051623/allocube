import type { Machine, ResourceAllocation, ResourceGroup } from "./shared/types";

export type CalendarSearchMachine = Pick<
  Machine,
  "id" | "name" | "address" | "resourceSummary" | "tags"
>;

export type CalendarSearchGroup = Omit<ResourceGroup, "version">;

export type CalendarSearchResult = {
  machine: CalendarSearchMachine;
  machineMatched: boolean;
  groups: CalendarSearchGroup[];
};

type ScoredGroup = {
  group: CalendarSearchGroup;
  score: number;
  order: number;
};

const normalizeSearchText = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

function allocationSearchText(allocation: ResourceAllocation) {
  const common = [allocation.poolName, allocation.unit];
  if (allocation.kind === "INDEX_RANGE") {
    return [
      ...common,
      ...allocation.ranges.flatMap((range) => [
        `${range.start}-${range.end}`,
        `${range.start}–${range.end}`,
        range.label ?? ""
      ])
    ];
  }
  if (allocation.kind === "ITEM_LIST") {
    return [
      ...common,
      ...allocation.items.flatMap((item) => [item.key, item.label])
    ];
  }
  return [...common, String(allocation.quantity)];
}

function includesAllTerms(values: string[], terms: string[]) {
  const content = normalizeSearchText(values.join(" "));
  return terms.every((term) => content.includes(term));
}

function isOrderedNameMatch(name: string, query: string) {
  if (query.includes(" ")) return false;
  let queryIndex = 0;
  for (const character of name) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function machineMatchScore(
  machine: CalendarSearchMachine,
  normalizedQuery: string,
  terms: string[]
) {
  const name = normalizeSearchText(machine.name);
  if (name === normalizedQuery) return 0;
  if (name.startsWith(normalizedQuery)) return 10;
  if (isOrderedNameMatch(name, normalizedQuery)) return 15;
  return includesAllTerms(
    [machine.name, machine.address, machine.resourceSummary, ...machine.tags],
    terms
  )
    ? 20
    : null;
}

function groupMatchScore(
  group: CalendarSearchGroup,
  normalizedQuery: string,
  terms: string[]
) {
  const name = normalizeSearchText(group.name);
  if (name === normalizedQuery) return 30;
  if (name.startsWith(normalizedQuery)) return 40;
  if (isOrderedNameMatch(name, normalizedQuery)) return 45;
  return includesAllTerms(
    [
      group.name,
      group.description,
      group.resourceSummary,
      ...group.tags,
      ...group.allocations.flatMap(allocationSearchText)
    ],
    terms
  )
    ? 50
    : null;
}

export function searchCalendarResources(
  machines: CalendarSearchMachine[],
  groups: CalendarSearchGroup[],
  query: string
): CalendarSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const terms = normalizedQuery.split(" ");
  const navigableMachineIds = new Set(groups.map((group) => group.machineId));
  const groupsByMachine = new Map<string, ScoredGroup[]>();
  groups.forEach((group, order) => {
    const score = groupMatchScore(group, normalizedQuery, terms);
    if (score === null) return;
    const bucket = groupsByMachine.get(group.machineId) ?? [];
    bucket.push({ group, score, order });
    groupsByMachine.set(group.machineId, bucket);
  });

  return machines
    .filter((machine) => navigableMachineIds.has(machine.id))
    .map((machine, order) => {
      const machineScore = machineMatchScore(machine, normalizedQuery, terms);
      const matchingGroups = (groupsByMachine.get(machine.id) ?? []).sort(
        (left, right) =>
          left.score - right.score ||
          left.group.sortOrder - right.group.sortOrder ||
          left.order - right.order
      );
      if (machineScore === null && matchingGroups.length === 0) return null;
      return {
        result: {
          machine,
          machineMatched: machineScore !== null,
          groups: matchingGroups.map(({ group }) => group)
        },
        score: Math.min(machineScore ?? Number.POSITIVE_INFINITY, matchingGroups[0]?.score ?? Number.POSITIVE_INFINITY),
        order
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ result }) => result);
}

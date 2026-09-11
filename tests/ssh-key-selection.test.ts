import { expect, it } from "vitest";
import { machineSelectionState, selectMachineChoices } from "../src/features/account/ssh-key-selection";

const machines = [
  { id: "a", available: true, active: false },
  { id: "b", available: true, active: false },
  { id: "old", available: false, active: true },
  { id: "disabled", available: false, active: false },
];
it("distinguishes empty, partial and full selections and excludes disabled choices", () => {
  expect(machineSelectionState(machines, [])).toEqual({ ids: ["a", "b", "old"], checked: false, mixed: false });
  expect(machineSelectionState(machines, ["a"])).toMatchObject({ checked: false, mixed: true });
  expect(machineSelectionState(machines, ["a", "b", "old"])).toMatchObject({ checked: true, mixed: false });
  expect(machineSelectionState([], ["a"])).toEqual({ ids: [], checked: false, mixed: false });
});
it("selects search results without changing hidden selections or adding duplicates", () => {
  const { ids } = machineSelectionState(machines.slice(0, 2), ["a", "outside"]);
  expect(selectMachineChoices(["a", "outside"], ids, true)).toEqual(["a", "outside", "b"]);
  expect(selectMachineChoices(["a", "b", "outside"], ids, false)).toEqual(["outside"]);
});

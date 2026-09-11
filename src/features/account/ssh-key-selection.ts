type Choice = { id: string; available: boolean; active: boolean };

export function machineSelectionState(machines: Choice[], selected: string[]) {
  const ids = machines.filter((m) => m.available || m.active).map((m) => m.id);
  const chosen = new Set(selected);
  const count = ids.filter((id) => chosen.has(id)).length;
  return { ids, checked: ids.length > 0 && count === ids.length, mixed: count > 0 && count < ids.length };
}

export function selectMachineChoices(selected: string[], ids: string[], checked: boolean) {
  const next = new Set(selected);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return [...next];
}

import { canSyncDraft, EditCancelled } from "../../edit-conflict";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { useTranslation } from "react-i18next";
import { Plus, GripVertical, Trash2, X, CircleAlert } from "lucide-react";
import { useState, useRef, useEffect, useMemo } from "react";
import { jsonBody } from "../../api";
import { validateResourceConfigurationDraft, reorderResourceDrafts } from "../../resource-config-validation";
import { createClientId } from "../../client-id";
import type { ResourcePool, ResourceAllocation, ResourceGroup } from "../../shared/types";
import { useConflictApi } from "../../app/useConflictApi";
import { useAppDialog } from "../../components/dialogs";
import { Field, ChoiceField } from "../../components/forms";
import { TagEditor } from "../../components/TagEditor";
import { BusyButtonContent } from "../../components/feedback";

type EditableAllocation =
  | {
    poolId: string;
    kind: "INDEX_RANGE";
    ranges: Array<{ start: number; end: number; label: string }>;
  }
  | { poolId: string; kind: "ITEM_LIST"; itemIds: string[] }
  | { poolId: string; kind: "CAPACITY"; quantity: number };

function resourcePoolKindLabel(kind: ResourcePool["kind"]) {
  return {
    INDEX_RANGE: tr("编号范围"),
    ITEM_LIST: tr("设备列表"),
    CAPACITY: tr("容量")
  }[kind];
}

function allocationInput(allocation: ResourceAllocation): EditableAllocation {
  if (allocation.kind === "INDEX_RANGE") {
    return {
      poolId: allocation.poolId,
      kind: "INDEX_RANGE",
      ranges: allocation.ranges.map((range) => ({
        start: range.start,
        end: range.end,
        label: range.label ?? ""
      }))
    };
  }
  if (allocation.kind === "ITEM_LIST") {
    return {
      poolId: allocation.poolId,
      kind: "ITEM_LIST",
      itemIds: allocation.items.map((item) => item.id)
    };
  }
  return {
    poolId: allocation.poolId,
    kind: "CAPACITY",
    quantity: allocation.quantity
  };
}

type ResourcePoolDraft = {
  id: string;
  expectedVersion: number;
  name: string;
  kind: ResourcePool["kind"];
  sharingMode: ResourcePool["sharingMode"];
  unit: string;
  description: string;
  sortOrder: number;
  rangeStart: number;
  rangeEnd: number;
  capacity: number;
  items: Array<{ id: string; key: string; label: string }>;
};

type ResourceGroupDraft = {
  id: string;
  expectedVersion: number;
  name: string;
  description: string;
  tags: string[];
  tagInput: string;
  sortOrder: number;
  status: ResourceGroup["status"];
  allocations: EditableAllocation[];
};

function resourcePoolDraft(pool: ResourcePool): ResourcePoolDraft {
  return {
    id: pool.id,
    expectedVersion: pool.version,
    name: pool.name,
    kind: pool.kind,
    sharingMode: pool.sharingMode,
    unit: pool.unit,
    description: pool.description,
    sortOrder: pool.sortOrder,
    rangeStart: pool.kind === "INDEX_RANGE" ? pool.rangeStart : 0,
    rangeEnd: pool.kind === "INDEX_RANGE" ? pool.rangeEnd : 0,
    capacity: pool.kind === "CAPACITY" ? pool.capacity : 1,
    items: pool.kind === "ITEM_LIST"
      ? pool.items.map((item) => ({
        id: item.id,
        key: item.key,
        label: item.label
      }))
      : []
  };
}

function resourceGroupDraft(group: ResourceGroup): ResourceGroupDraft {
  return {
    id: group.id,
    expectedVersion: group.version,
    name: group.name,
    description: group.description,
    tags: [...group.tags],
    tagInput: "",
    sortOrder: group.sortOrder,
    status: group.status,
    allocations: group.allocations.map(allocationInput)
  };
}

function resourcePoolDraftSummary(pool: ResourcePoolDraft) {
  const sharingSuffix = pool.sharingMode === "SHARED" ? tr(" · 共享") : "";
  if (pool.kind === "INDEX_RANGE") {
    return `${pool.rangeStart}–${pool.rangeEnd} ${pool.unit}${sharingSuffix}`;
  }
  if (pool.kind === "ITEM_LIST") {
    return `${pool.items.length} ${pool.unit}${sharingSuffix}`;
  }
  return `${pool.capacity} ${pool.unit}${sharingSuffix}`;
}

export function ResourceConfigurationModal({
  machine,
  pools,
  groups,
  onClose,
  onSaved,
  notify
}: {
  machine: any;
  pools: ResourcePool[];
  groups: ResourceGroup[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const { request: api, busy: mutationBusy } = useConflictApi();
  const { i18n } = useTranslation();
  const dialog = useAppDialog();
  const [section, setSection] = useState<"POOLS" | "GROUPS">("POOLS");
  const [draftPools, setDraftPools] = useState<ResourcePoolDraft[]>(
    () => pools.map(resourcePoolDraft)
  );
  const [draftGroups, setDraftGroups] = useState<ResourceGroupDraft[]>(
    () => groups.map(resourceGroupDraft)
  );
  const [deletedPools, setDeletedPools] = useState<
    Array<{ id: string; expectedVersion: number }>
  >([]);
  const [selectedPoolId, setSelectedPoolId] = useState(pools[0]?.id ?? "");
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id ?? "");
  const [draggingItemId, setDraggingItemId] = useState("");
  const [dragIndicator, setDragIndicator] = useState<{
    targetId: string;
    position: "BEFORE" | "AFTER";
  } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const baseline = useRef({ pools: draftPools, groups: draftGroups, deleted: deletedPools });
  useEffect(() => {
    if (!canSyncDraft(baseline.current, { pools: draftPools, groups: draftGroups, deleted: deletedPools }, mutationBusy || saving)) return;
    const next = { pools: pools.map(resourcePoolDraft), groups: groups.map(resourceGroupDraft), deleted: [] };
    if (JSON.stringify(next) === JSON.stringify(baseline.current)) return;
    if (next.pools.some(pool => pool.expectedVersion < (baseline.current.pools.find(saved => saved.id === pool.id)?.expectedVersion ?? 0)) ||
      next.groups.some(group => group.expectedVersion < (baseline.current.groups.find(saved => saved.id === group.id)?.expectedVersion ?? 0))) return;
    baseline.current = next; setDraftPools(next.pools); setDraftGroups(next.groups); setDeletedPools([]);
  }, [pools, groups, draftPools, draftGroups, deletedPools, mutationBusy, saving]);
  const selectedPool = draftPools.find((pool) => pool.id === selectedPoolId);
  const selectedGroup = draftGroups.find((group) => group.id === selectedGroupId);
  const validationIssues = useMemo(
    () => validateResourceConfigurationDraft(draftPools, draftGroups),
    [draftGroups, draftPools, i18n.resolvedLanguage]
  );
  const issuesForPool = (poolId: string) =>
    validationIssues.filter(
      (issue) => issue.target === "POOL" && issue.poolId === poolId
    );
  const issuesForGroup = (groupId: string) =>
    validationIssues.filter((issue) => issue.groupId === groupId);
  const issuesForAllocation = (groupId: string, poolId: string) =>
    validationIssues.filter(
      (issue) =>
        issue.target === "ALLOCATION" &&
        issue.groupId === groupId &&
        issue.poolId === poolId
    );
  const hasPoolFieldIssue = (poolId: string, field: string) =>
    validationIssues.some(
      (issue) =>
        issue.target === "POOL" &&
        issue.poolId === poolId &&
        issue.field === field
    );
  const hasGroupFieldIssue = (groupId: string, field: string) =>
    validationIssues.some(
      (issue) =>
        issue.target === "GROUP" &&
        issue.groupId === groupId &&
        issue.field === field
    );

  const updatePool = (
    poolId: string,
    updater: (pool: ResourcePoolDraft) => ResourcePoolDraft
  ) => {
    setSaveError("");
    setDraftPools((current) =>
      current.map((pool) => pool.id === poolId ? updater(pool) : pool)
    );
  };

  const updateGroup = (
    groupId: string,
    updater: (group: ResourceGroupDraft) => ResourceGroupDraft
  ) => {
    setSaveError("");
    setDraftGroups((current) =>
      current.map((group) => group.id === groupId ? updater(group) : group)
    );
  };

  const dropResource = (
    targetId: string,
    position: "BEFORE" | "AFTER"
  ) => {
    if (!draggingItemId) return;
    if (section === "POOLS") {
      setDraftPools((current) =>
        reorderResourceDrafts(current, draggingItemId, targetId, position)
      );
    } else {
      setDraftGroups((current) =>
        reorderResourceDrafts(current, draggingItemId, targetId, position)
      );
    }
    setSaveError("");
    setDraggingItemId("");
    setDragIndicator(null);
  };

  const moveResourceByKeyboard = (itemId: string, direction: -1 | 1) => {
    const move = <T extends { id: string; sortOrder: number },>(current: T[]) => {
      const sourceIndex = current.findIndex((item) => item.id === itemId);
      const target = current[sourceIndex + direction];
      return target
        ? reorderResourceDrafts(
          current,
          itemId,
          target.id,
          direction < 0 ? "BEFORE" : "AFTER"
        )
        : current;
    };
    if (section === "POOLS") {
      setDraftPools(move);
    } else {
      setDraftGroups(move);
    }
    setSaveError("");
  };

  const addPool = () => {
    const id = createClientId();
    setSaveError("");
    setDraftPools((current) => [
      ...current,
      {
        id,
        expectedVersion: 0,
        name: "",
        kind: "INDEX_RANGE",
        sharingMode: "EXCLUSIVE",
        unit: "",
        description: "",
        sortOrder: current.length,
        rangeStart: 0,
        rangeEnd: 0,
        capacity: 1,
        items: []
      }
    ]);
    setSelectedPoolId(id);
  };

  const addGroup = () => {
    const id = createClientId();
    setSaveError("");
    setDraftGroups((current) => [
      ...current,
      {
        id,
        expectedVersion: 0,
        name: "",
        description: "",
        tags: [],
        tagInput: "",
        sortOrder: current.length,
        status: "ACTIVE",
        allocations: []
      }
    ]);
    setSelectedGroupId(id);
  };

  const removePool = async (poolId: string) => {
    const pool = draftPools.find((candidate) => candidate.id === poolId);
    if (!pool) return;
    if (
      pool.expectedVersion > 0 &&
      !(await dialog.confirm({
        title: tr("删除资源项"),
        message: tr("保存配置后将永久删除 {{v0}}。使用该资源项的资源组也需要在本次编辑中调整。", { v0: pool.name }),
        confirmLabel: tr("删除资源项"),
        tone: "danger"
      }))
    ) {
      return;
    }
    const remaining = draftPools.filter((pool) => pool.id !== poolId);
    setDraftPools(remaining);
    if (pool.expectedVersion > 0) {
      setDeletedPools((current) => [
        ...current,
        { id: pool.id, expectedVersion: pool.expectedVersion }
      ]);
    }
    setDraftGroups((current) =>
      current.map((group) => ({
        ...group,
        allocations: group.allocations.filter(
          (allocation) => allocation.poolId !== poolId
        )
      }))
    );
    setSelectedPoolId(remaining[0]?.id ?? "");
    setSaveError("");
  };

  const removeNewGroup = (groupId: string) => {
    const remaining = draftGroups.filter((group) => group.id !== groupId);
    setDraftGroups(remaining);
    setSelectedGroupId(remaining[0]?.id ?? "");
    setSaveError("");
  };

  const toggleAllocation = (
    group: ResourceGroupDraft,
    pool: ResourcePoolDraft
  ) => {
    updateGroup(group.id, (current) => {
      const exists = current.allocations.some(
        (allocation) => allocation.poolId === pool.id
      );
      if (exists) {
        return {
          ...current,
          allocations: current.allocations.filter(
            (allocation) => allocation.poolId !== pool.id
          )
        };
      }
      const allocation: EditableAllocation = pool.kind === "INDEX_RANGE"
        ? {
          poolId: pool.id,
          kind: "INDEX_RANGE",
          ranges: [{
            start: pool.rangeStart,
            end: pool.rangeStart,
            label: ""
          }]
        }
        : pool.kind === "ITEM_LIST"
          ? { poolId: pool.id, kind: "ITEM_LIST", itemIds: [] }
          : {
            poolId: pool.id,
            kind: "CAPACITY",
            quantity:
              pool.sharingMode === "SHARED" ? pool.capacity : 0
          };
      return {
        ...current,
        allocations: [...current.allocations, allocation]
      };
    });
  };

  const updateAllocation = (
    groupId: string,
    poolId: string,
    updater: (allocation: EditableAllocation) => EditableAllocation
  ) => {
    updateGroup(groupId, (group) => ({
      ...group,
      allocations: group.allocations.map((allocation) =>
        allocation.poolId === poolId ? updater(allocation) : allocation
      )
    }));
  };

  const save = async () => {
    if (validationIssues.length) return;
    setSaving(true);
    setSaveError("");
    try {
      await api(`/admin/machines/${machine.id}/resource-configuration`, {
        method: "PUT",
        body: jsonBody({
          pools: draftPools.map((pool) => ({
            id: pool.id,
            expectedVersion: pool.expectedVersion,
            name: pool.name,
            kind: pool.kind,
            sharingMode: pool.sharingMode,
            unit: pool.unit,
            description: pool.description,
            sortOrder: pool.sortOrder,
            ...(pool.kind === "INDEX_RANGE"
              ? {
                rangeStart: pool.rangeStart,
                rangeEnd: pool.rangeEnd
              }
              : {}),
            ...(pool.kind === "ITEM_LIST" ? { items: pool.items } : {}),
            ...(pool.kind === "CAPACITY"
              ? { capacity: pool.capacity }
              : {})
          })),
          groups: draftGroups.map((group) => ({
            id: group.id,
            expectedVersion: group.expectedVersion,
            name: group.name,
            description: group.description,
            tags: group.tags,
            sortOrder: group.sortOrder,
            allocations: group.allocations
          })),
          deletedPools
        })
      });
      notify("success", tr("资源配置已保存"));
      await onSaved();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      setSaveError(error instanceof Error ? error.message : tr("资源配置保存失败"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={tr("编辑资源：{{v0}}", { v0: machine.name })} onClose={onClose} large>
      <fieldset disabled={mutationBusy || saving} className="editor-fieldset resource-config-editor">
        <div className="resource-config-tabs" role="tablist" aria-label={tr("资源编辑内容")}>
          <button
            type="button"
            role="tab"
            aria-selected={section === "POOLS"}
            className={section === "POOLS" ? "active" : ""}
            onClick={() => setSection("POOLS")}
          >
            {tr("资源配置")}</button>
          <button
            type="button"
            role="tab"
            aria-selected={section === "GROUPS"}
            className={section === "GROUPS" ? "active" : ""}
            onClick={() => setSection("GROUPS")}
          >
            {tr("资源组")}</button>
        </div>

        <div className="resource-config-workspace">
          <aside className="resource-config-list">
            <button
              type="button"
              className="secondary-button compact resource-config-add"
              onClick={section === "POOLS" ? addPool : addGroup}
            >
              <Plus size={14} />
              {tr(section === "POOLS" ? "action.resourceItem.new" : "action.resourceGroup.new")}
            </button>
            <div
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (
                  nextTarget instanceof Node &&
                  event.currentTarget.contains(nextTarget)
                ) {
                  return;
                }
                setDragIndicator(null);
              }}
            >
              {(section === "POOLS" ? draftPools : draftGroups).map((item) => {
                const active = section === "POOLS"
                  ? selectedPoolId === item.id
                  : selectedGroupId === item.id;
                const secondary = "kind" in item
                  ? resourcePoolDraftSummary(item)
                  : tr("{{v0}} 项资源", { v0: item.allocations.length });
                const issueCount = section === "POOLS"
                  ? issuesForPool(item.id).length
                  : issuesForGroup(item.id).length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={[
                      active ? "active" : "",
                      issueCount ? "has-errors" : "",
                      "draggable",
                      draggingItemId === item.id ? "dragging" : "",
                      dragIndicator?.targetId === item.id &&
                        draggingItemId !== item.id
                        ? dragIndicator.position === "BEFORE"
                          ? "drop-before"
                          : "drop-after"
                        : ""
                    ].filter(Boolean).join(" ")}
                    draggable
                    title={tr("拖动调整顺序；也可以按 Alt + 上下方向键")}
                    onDragStart={(event) => {
                      setDraggingItemId(item.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.id);
                    }}
                    onDragOver={(event) => {
                      if (
                        !draggingItemId ||
                        draggingItemId === item.id
                      ) {
                        setDragIndicator(null);
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      const bounds =
                        event.currentTarget.getBoundingClientRect();
                      setDragIndicator({
                        targetId: item.id,
                        position:
                          event.clientY < bounds.top + bounds.height / 2
                            ? "BEFORE"
                            : "AFTER"
                      });
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (
                        dragIndicator?.targetId === item.id &&
                        draggingItemId !== item.id
                      ) {
                        dropResource(item.id, dragIndicator.position);
                      }
                    }}
                    onDragEnd={() => {
                      setDraggingItemId("");
                      setDragIndicator(null);
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey) return;
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveResourceByKeyboard(item.id, -1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveResourceByKeyboard(item.id, 1);
                      }
                    }}
                    onClick={() => {
                      if (section === "POOLS") setSelectedPoolId(item.id);
                      else setSelectedGroupId(item.id);
                    }}
                  >
                    <span className="resource-config-list-name">
                      <GripVertical size={13} aria-hidden="true" />
                      <strong>{item.name || tr("未命名")}</strong>
                    </span>
                    <small>{secondary}</small>
                    {issueCount > 0 && (
                      <span className="resource-config-error-count">
                        <i />
                        {issueCount} {tr("个问题")}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          <div className="resource-config-form">
            {section === "POOLS" && selectedPool ? (
              <>
                <div className="resource-config-form-head">
                  <strong>{selectedPool.name || tr("新资源项")}</strong>
                  <div>
                    {issuesForPool(selectedPool.id).length > 0 && (
                      <span className="resource-config-conflict-chip">
                        {issuesForPool(selectedPool.id).length} {tr("个问题")}</span>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact danger"
                      onClick={() => void removePool(selectedPool.id)}
                    >
                      <Trash2 size={14} />
                      {selectedPool.expectedVersion === 0
                        ? tr("删除草稿")
                        : tr("删除资源项")}
                    </button>
                  </div>
                </div>
                <div className="two-fields">
                  <Field label={tr("资源项名称")}>
                    <input
                      className={
                        hasPoolFieldIssue(selectedPool.id, "name")
                          ? "resource-config-invalid"
                          : ""
                      }
                      aria-invalid={hasPoolFieldIssue(selectedPool.id, "name")}
                      value={selectedPool.name}
                      onChange={(event) =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          name: event.target.value
                        }))}
                    />
                  </Field>
                  <ChoiceField
                    label={tr("分配方式")}
                    value={selectedPool.kind}
                    disabled={selectedPool.expectedVersion > 0}
                    options={[
                      { value: "INDEX_RANGE", label: tr("编号范围") },
                      { value: "ITEM_LIST", label: tr("设备列表") },
                      { value: "CAPACITY", label: tr("容量") }
                    ]}
                    onChange={(value) => {
                      const kind = value as ResourcePool["kind"];
                      updatePool(selectedPool.id, (pool) => ({
                        ...pool,
                        kind,
                        items: kind === "ITEM_LIST" && !pool.items.length
                          ? [{
                            id: createClientId(),
                            key: "",
                            label: ""
                          }]
                          : pool.items
                      }));
                      setDraftGroups((current) =>
                        current.map((group) => ({
                          ...group,
                          allocations: group.allocations.filter(
                            (allocation) =>
                              allocation.poolId !== selectedPool.id
                          )
                        }))
                      );
                    }}
                  />
                </div>
                <div className="two-fields">
                  <Field label={tr("单位")}>
                    <input
                      className={
                        hasPoolFieldIssue(selectedPool.id, "unit")
                          ? "resource-config-invalid"
                          : ""
                      }
                      aria-invalid={hasPoolFieldIssue(selectedPool.id, "unit")}
                      value={selectedPool.unit}
                      onChange={(event) =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          unit: event.target.value
                        }))}
                    />
                  </Field>
                  <ChoiceField
                    label={tr("使用方式")}
                    value={selectedPool.sharingMode}
                    options={[
                      { value: "EXCLUSIVE", label: tr("独占分配") },
                      { value: "SHARED", label: tr("共享使用") }
                    ]}
                    onChange={(value) => {
                      const sharingMode = value as ResourcePool["sharingMode"];
                      updatePool(selectedPool.id, (pool) => ({
                        ...pool,
                        sharingMode
                      }));
                      if (
                        sharingMode === "SHARED" &&
                        selectedPool.kind === "CAPACITY"
                      ) {
                        setDraftGroups((current) =>
                          current.map((group) => ({
                            ...group,
                            allocations: group.allocations.map((allocation) =>
                              allocation.poolId === selectedPool.id &&
                                allocation.kind === "CAPACITY"
                                ? {
                                  ...allocation,
                                  quantity: selectedPool.capacity
                                }
                                : allocation
                            )
                          }))
                        );
                      }
                    }}
                  />
                </div>
                {selectedPool.kind === "INDEX_RANGE" && (
                  <div className="two-fields">
                    <Field label={tr("起始编号")}>
                      <input
                        type="number"
                        className={
                          hasPoolFieldIssue(selectedPool.id, "range")
                            ? "resource-config-invalid"
                            : ""
                        }
                        aria-invalid={hasPoolFieldIssue(
                          selectedPool.id,
                          "range"
                        )}
                        value={selectedPool.rangeStart}
                        onChange={(event) =>
                          updatePool(selectedPool.id, (pool) => ({
                            ...pool,
                            rangeStart: Number(event.target.value)
                          }))}
                      />
                    </Field>
                    <Field label={tr("结束编号（包含）")}>
                      <input
                        type="number"
                        className={
                          hasPoolFieldIssue(selectedPool.id, "range")
                            ? "resource-config-invalid"
                            : ""
                        }
                        aria-invalid={hasPoolFieldIssue(
                          selectedPool.id,
                          "range"
                        )}
                        value={selectedPool.rangeEnd}
                        onChange={(event) =>
                          updatePool(selectedPool.id, (pool) => ({
                            ...pool,
                            rangeEnd: Number(event.target.value)
                          }))}
                      />
                    </Field>
                  </div>
                )}
                {selectedPool.kind === "CAPACITY" && (
                  <Field label={tr("总容量{{v0}}", { v0: selectedPool.unit ? `（${selectedPool.unit}）` : "" })}>
                    <input
                      type="number"
                      step="0.001"
                      className={
                        hasPoolFieldIssue(selectedPool.id, "capacity")
                          ? "resource-config-invalid"
                          : ""
                      }
                      aria-invalid={hasPoolFieldIssue(
                        selectedPool.id,
                        "capacity"
                      )}
                      value={selectedPool.capacity}
                      onChange={(event) =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          capacity: Number(event.target.value)
                        }))}
                    />
                  </Field>
                )}
                {selectedPool.kind === "ITEM_LIST" && (
                  <div
                    className={[
                      "resource-item-editor",
                      hasPoolFieldIssue(selectedPool.id, "items")
                        ? "resource-config-invalid-region"
                        : ""
                    ].filter(Boolean).join(" ")}
                  >
                    <div className="section-label"><span>{tr("设备")}</span></div>
                    {selectedPool.items.map((item, index) => (
                      <div className="resource-item-row" key={item.id}>
                        <input
                          aria-label={tr("设备 {{v0}} 标识", { v0: index + 1 })}
                          value={item.key}
                          onChange={(event) =>
                            updatePool(selectedPool.id, (pool) => ({
                              ...pool,
                              items: pool.items.map((candidate) =>
                                candidate.id === item.id
                                  ? { ...candidate, key: event.target.value }
                                  : candidate
                              )
                            }))}
                        />
                        <input
                          aria-label={tr("设备 {{v0}} 名称", { v0: index + 1 })}
                          value={item.label}
                          onChange={(event) =>
                            updatePool(selectedPool.id, (pool) => ({
                              ...pool,
                              items: pool.items.map((candidate) =>
                                candidate.id === item.id
                                  ? { ...candidate, label: event.target.value }
                                  : candidate
                              )
                            }))}
                        />
                        <button
                          type="button"
                          className="icon-button tiny danger"
                          aria-label={tr("删除设备 {{v0}}", { v0: index + 1 })}
                          onClick={() =>
                            updatePool(selectedPool.id, (pool) => ({
                              ...pool,
                              items: pool.items.filter(
                                (candidate) => candidate.id !== item.id
                              )
                            }))}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="secondary-button compact"
                      onClick={() =>
                        updatePool(selectedPool.id, (pool) => ({
                          ...pool,
                          items: [
                            ...pool.items,
                            {
                              id: createClientId(),
                              key: "",
                              label: ""
                            }
                          ]
                        }))}
                    >
                      <Plus size={14} />{tr("action.device.add")}</button>
                  </div>
                )}
                <Field label={tr("说明")}>
                  <textarea
                    rows={3}
                    className={
                      hasPoolFieldIssue(selectedPool.id, "description")
                        ? "resource-config-invalid"
                        : ""
                    }
                    aria-invalid={hasPoolFieldIssue(
                      selectedPool.id,
                      "description"
                    )}
                    value={selectedPool.description}
                    onChange={(event) =>
                      updatePool(selectedPool.id, (pool) => ({
                        ...pool,
                        description: event.target.value
                      }))}
                  />
                </Field>
                {issuesForPool(selectedPool.id).length > 0 && (
                  <div className="resource-config-inline-errors" role="alert">
                    {issuesForPool(selectedPool.id).map((issue) => (
                      <span key={`${issue.field}:${issue.message}`}>
                        <CircleAlert size={13} />
                        {issue.message}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : section === "GROUPS" && selectedGroup ? (
              <>
                <div className="resource-config-form-head">
                  <strong>{selectedGroup.name || tr("新资源组")}</strong>
                  <div>
                    {issuesForGroup(selectedGroup.id).length > 0 && (
                      <span className="resource-config-conflict-chip">
                        {issuesForGroup(selectedGroup.id).length} {tr("个问题")}</span>
                    )}
                    {selectedGroup.expectedVersion === 0 && (
                      <button
                        type="button"
                        className="secondary-button compact danger"
                        onClick={() => removeNewGroup(selectedGroup.id)}
                      >
                        <Trash2 size={14} />{tr("删除草稿")}</button>
                    )}
                  </div>
                </div>
                <Field label={tr("资源组名称")}>
                  <input
                    className={
                      hasGroupFieldIssue(selectedGroup.id, "name")
                        ? "resource-config-invalid"
                        : ""
                    }
                    aria-invalid={hasGroupFieldIssue(
                      selectedGroup.id,
                      "name"
                    )}
                    value={selectedGroup.name}
                    onChange={(event) =>
                      updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        name: event.target.value
                      }))}
                  />
                </Field>
                <div className="field">
                  <span>{tr("标签")}</span>
                  <TagEditor
                    tags={selectedGroup.tags}
                    input={selectedGroup.tagInput}
                    invalid={hasGroupFieldIssue(selectedGroup.id, "tags")}
                    onChange={(tags, tagInput) =>
                      updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        tags,
                        tagInput
                      }))}
                  />
                </div>
                <div className="resource-allocation-editor">
                  <div className="section-label"><span>{tr("资源组成")}</span></div>
                  {draftPools.map((pool) => {
                    const allocation = selectedGroup.allocations.find(
                      (candidate) => candidate.poolId === pool.id
                    );
                    const allocationIssues = issuesForAllocation(
                      selectedGroup.id,
                      pool.id
                    );
                    return (
                      <section
                        className={[
                          "resource-allocation-card",
                          allocation ? "selected" : "",
                          allocationIssues.length ? "conflict" : ""
                        ].filter(Boolean).join(" ")}
                        key={pool.id}
                      >
                        <label className="resource-allocation-toggle">
                          <input
                            type="checkbox"
                            checked={Boolean(allocation)}
                            onChange={() => toggleAllocation(selectedGroup, pool)}
                          />
                          <span>
                            <strong>{pool.name || tr("未命名资源项")}</strong>
                            <small>
                              {resourcePoolKindLabel(pool.kind)} ·
                              {" "}{resourcePoolDraftSummary(pool)}
                            </small>
                          </span>
                        </label>
                        {allocation?.kind === "INDEX_RANGE" &&
                          pool.kind === "INDEX_RANGE" && (
                            <div className="range-allocation-list">
                              {allocation.ranges.map((range, index) => (
                                <div className="range-allocation-row" key={index}>
                                  <input
                                    aria-label={tr("起始编号")}
                                    type="number"
                                    value={range.start}
                                    onChange={(event) =>
                                      updateAllocation(
                                        selectedGroup.id,
                                        pool.id,
                                        (value) => value.kind === "INDEX_RANGE"
                                          ? {
                                            ...value,
                                            ranges: value.ranges.map(
                                              (candidate, candidateIndex) =>
                                                candidateIndex === index
                                                  ? {
                                                    ...candidate,
                                                    start: Number(event.target.value)
                                                  }
                                                  : candidate
                                            )
                                          }
                                          : value
                                      )}
                                  />
                                  <span>—</span>
                                  <input
                                    aria-label={tr("结束编号")}
                                    type="number"
                                    value={range.end}
                                    onChange={(event) =>
                                      updateAllocation(
                                        selectedGroup.id,
                                        pool.id,
                                        (value) => value.kind === "INDEX_RANGE"
                                          ? {
                                            ...value,
                                            ranges: value.ranges.map(
                                              (candidate, candidateIndex) =>
                                                candidateIndex === index
                                                  ? {
                                                    ...candidate,
                                                    end: Number(event.target.value)
                                                  }
                                                  : candidate
                                            )
                                          }
                                          : value
                                      )}
                                  />
                                  <input
                                    aria-label={tr("拓扑标签")}
                                    value={range.label}
                                    onChange={(event) =>
                                      updateAllocation(
                                        selectedGroup.id,
                                        pool.id,
                                        (value) => value.kind === "INDEX_RANGE"
                                          ? {
                                            ...value,
                                            ranges: value.ranges.map(
                                              (candidate, candidateIndex) =>
                                                candidateIndex === index
                                                  ? {
                                                    ...candidate,
                                                    label: event.target.value
                                                  }
                                                  : candidate
                                            )
                                          }
                                          : value
                                      )}
                                  />
                                  <button
                                    type="button"
                                    className="icon-button tiny danger"
                                    aria-label={tr("删除区间 {{v0}}", { v0: index + 1 })}
                                    onClick={() =>
                                      updateAllocation(
                                        selectedGroup.id,
                                        pool.id,
                                        (value) => value.kind === "INDEX_RANGE"
                                          ? {
                                            ...value,
                                            ranges: value.ranges.filter(
                                              (_, candidateIndex) =>
                                                candidateIndex !== index
                                            )
                                          }
                                          : value
                                      )}
                                  >
                                    <X size={14} />
                                  </button>
                                </div>
                              ))}
                              <button
                                type="button"
                                className="secondary-button compact"
                                onClick={() =>
                                  updateAllocation(
                                    selectedGroup.id,
                                    pool.id,
                                    (value) => value.kind === "INDEX_RANGE"
                                      ? {
                                        ...value,
                                        ranges: [
                                          ...value.ranges,
                                          {
                                            start: pool.rangeStart,
                                            end: pool.rangeStart,
                                            label: ""
                                          }
                                        ]
                                      }
                                      : value
                                  )}
                              >
                                <Plus size={14} />{tr("action.interval.add")}</button>
                            </div>
                          )}
                        {allocation?.kind === "ITEM_LIST" &&
                          pool.kind === "ITEM_LIST" && (
                            <div className="device-choice-grid">
                              {pool.items.map((item) => (
                                <label key={item.id}>
                                  <input
                                    type="checkbox"
                                    checked={allocation.itemIds.includes(item.id)}
                                    onChange={() =>
                                      updateAllocation(
                                        selectedGroup.id,
                                        pool.id,
                                        (value) => value.kind === "ITEM_LIST"
                                          ? {
                                            ...value,
                                            itemIds: value.itemIds.includes(item.id)
                                              ? value.itemIds.filter(
                                                (id) => id !== item.id
                                              )
                                              : [...value.itemIds, item.id]
                                          }
                                          : value
                                      )}
                                  />
                                  <span>
                                    <strong>{item.key || tr("未命名设备")}</strong>
                                    <small>{item.label || tr("未填写名称")}</small>
                                  </span>
                                </label>
                              ))}
                            </div>
                          )}
                        {allocation?.kind === "CAPACITY" &&
                          pool.kind === "CAPACITY" &&
                          pool.sharingMode === "EXCLUSIVE" && (
                            <Field label={tr("分配数量（{{v0}}）", { v0: pool.unit || "未填写单位" })}>
                              <input
                                type="number"
                                step="0.001"
                                value={allocation.quantity || ""}
                                onChange={(event) =>
                                  updateAllocation(
                                    selectedGroup.id,
                                    pool.id,
                                    (value) => value.kind === "CAPACITY"
                                      ? {
                                        ...value,
                                        quantity: Number(event.target.value)
                                      }
                                      : value
                                  )}
                              />
                            </Field>
                          )}
                        {allocationIssues.length > 0 && (
                          <div
                            className="resource-allocation-errors"
                            role="alert"
                          >
                            {allocationIssues.map((issue) => (
                              <span key={`${issue.field}:${issue.message}`}>
                                <CircleAlert size={12} />
                                {issue.message}
                              </span>
                            ))}
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
                <Field label={tr("说明")}>
                  <textarea
                    rows={3}
                    className={
                      hasGroupFieldIssue(selectedGroup.id, "description")
                        ? "resource-config-invalid"
                        : ""
                    }
                    aria-invalid={hasGroupFieldIssue(
                      selectedGroup.id,
                      "description"
                    )}
                    value={selectedGroup.description}
                    onChange={(event) =>
                      updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        description: event.target.value
                      }))}
                  />
                </Field>
                {issuesForGroup(selectedGroup.id).some(
                  (issue) => issue.target === "GROUP"
                ) && (
                    <div className="resource-config-inline-errors" role="alert">
                      {issuesForGroup(selectedGroup.id)
                        .filter((issue) => issue.target === "GROUP")
                        .map((issue) => (
                          <span key={`${issue.field}:${issue.message}`}>
                            <CircleAlert size={13} />
                            {issue.message}
                          </span>
                        ))}
                    </div>
                  )}
              </>
            ) : (
              <div className="mini-empty">
                {section === "POOLS" ? tr("请新增资源项") : tr("请新增资源组")}
              </div>
            )}
          </div>
        </div>

        {validationIssues.length > 0 && (
          <div className="resource-config-validation-summary" role="status">
            <CircleAlert size={15} />
            <span>
              {tr("当前有")}{validationIssues.length} {tr("个问题，请检查红色标记。")}</span>
          </div>
        )}
        {saveError && (
          <div className="resource-config-save-error" role="alert">
            <CircleAlert size={15} />
            <span>{saveError}</span>
          </div>
        )}
        <div className="modal-actions resource-config-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={saving}
          >
            {tr("取消")}</button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void save()}
            disabled={saving || validationIssues.length > 0}
          >
            <BusyButtonContent busy={saving}>{tr("保存配置")}</BusyButtonContent>
          </button>
        </div>
      </fieldset>
    </Modal>
  );
}

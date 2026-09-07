import { overwriteRequested, checkEditVersion } from "../edit-conflict.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  withImmediateTransaction,
  db,
  nowIso,
  addAudit,
  bumpScheduleRevision,
  getScheduleRevision,
  checkpointSensitiveDeletion
} from "../db.js";
import { createNotification } from "../mailer.js";
import { BusinessError } from "../business-error.js";
import {
  listResourcePools,
  resourceConfigurationSchema,
  mapResourceGroup,
  resourcePoolConfiguration,
  validateResourceConfiguration,
  getResourcePool,
  insertPoolRevision,
  replaceGroupAllocations,
  groupConfiguration,
  insertGroupRevision,
  resourcePoolSchema,
  resourceGroupSchema,
  validateAndResolveGroupAllocations
} from "../resources.js";
import { requireMachineManager, requireMachineManagerForId, requireMachineViewer } from "./access-guards.js";
import { tombstoneResourcePool } from "./deletion-service.js";
import { countRows, getCurrentResourceGroupRow } from "./records.js";

export function registerResourcesAdminRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {

  app.get("/api/v1/admin/machines/:id/resource-pools", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    return { pools: listResourcePools(auth.machineId) };
  });

  app.put(
    "/api/v1/admin/machines/:id/resource-configuration",
    async (request, reply) => {
      const { id: machineId } = z.object({ id: z.string().uuid() }).parse(request.params);
      const auth = requireMachineManagerForId(request, reply, machineId);
      if (!auth) return;
      const body = resourceConfigurationSchema.parse(request.body);
      try {
        const revision = withImmediateTransaction(() => {
          const currentPools = listResourcePools(machineId);
          const currentGroupRows = db
            .prepare(
              `SELECT * FROM resource_groups
               WHERE machine_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM deleted_resource_group_tombstones drgt
                   WHERE drgt.resource_group_id = resource_groups.id
                 )`
            )
            .all(machineId) as Array<Record<string, unknown>>;
          const currentGroups = currentGroupRows.map(mapResourceGroup);
          if (overwriteRequested(request)) {
            const poolIds = new Set([...body.pools, ...body.deletedPools].map(pool => pool.id));
            const groupIds = new Set(body.groups.map(group => group.id));
            const additions = resourceConfigurationSchema.parse({
              pools: currentPools.filter(pool => !poolIds.has(pool.id)).map(pool => ({
                ...resourcePoolConfiguration(pool), id: pool.id, expectedVersion: pool.version
              })),
              groups: currentGroups.filter(group => !groupIds.has(group.id)).map(group => ({
                ...group, expectedVersion: group.version,
                allocations: group.allocations.map(allocation => allocation.kind === "ITEM_LIST"
                  ? { ...allocation, itemIds: allocation.items.map(item => item.id) } : allocation)
              }))
            });
            body.pools.push(...additions.pools);
            body.groups.push(...additions.groups);
          }
          const submittedPoolIds = new Set(body.pools.map((pool) => pool.id));
          const submittedGroupIds = new Set(body.groups.map((group) => group.id));
          const deletedPoolVersions = new Map(
            body.deletedPools.map((pool) => [pool.id, pool.expectedVersion])
          );

          if (
            deletedPoolVersions.size !== body.deletedPools.length ||
            body.deletedPools.some((pool) => submittedPoolIds.has(pool.id)) ||
            currentPools.some(
              (pool) =>
                !submittedPoolIds.has(pool.id) &&
                !deletedPoolVersions.has(pool.id)
            ) ||
            currentGroups.some((group) => !submittedGroupIds.has(group.id))
          ) {
            throw new BusinessError(
              "资源配置已由其他管理员更新，请刷新后重试",
              409,
              undefined,
              overwriteRequested(request) ? "RESOURCE_CONFIGURATION_INVALID" : "RESOURCE_CONFIGURATION_STALE"
            );
          }

          const currentPoolMap = new Map(currentPools.map((pool) => [pool.id, pool]));
          for (const pool of body.pools) {
            const current = currentPoolMap.get(pool.id);
            if (current) {
              checkEditVersion(current.version, pool.expectedVersion, overwriteRequested(request), "RESOURCE_CONFIGURATION_STALE");
              if (
                pool.kind !== current.kind
              ) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_INVALID"
                );
              }
            } else {
              const collision = db
                .prepare("SELECT 1 FROM resource_pools WHERE id = ?")
                .get(pool.id);
              if (pool.expectedVersion !== 0 || collision) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_INVALID"
                );
              }
            }
          }

          for (const deletedPool of body.deletedPools) {
            const current = currentPoolMap.get(deletedPool.id);
            if (current) checkEditVersion(current.version, deletedPool.expectedVersion, overwriteRequested(request), "RESOURCE_CONFIGURATION_STALE");
            if (
              !current
            ) {
              throw new BusinessError(
                "资源配置已由其他管理员更新，请刷新后重试",
                409,
                undefined,
                "RESOURCE_CONFIGURATION_INVALID"
              );
            }
          }

          const currentGroupMap = new Map(
            currentGroups.map((group) => [group.id, group])
          );
          for (const group of body.groups) {
            const current = currentGroupMap.get(group.id);
            if (current) {
              checkEditVersion(current.version, group.expectedVersion, overwriteRequested(request), "RESOURCE_CONFIGURATION_STALE");
            } else {
              const collision = db
                .prepare("SELECT 1 FROM resource_groups WHERE id = ?")
                .get(group.id);
              if (group.expectedVersion !== 0 || collision) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_INVALID"
                );
              }
            }
          }

          const resolvedGroups = validateResourceConfiguration(body);
          const now = nowIso();
          db.prepare(
            `DELETE FROM resource_group_allocations
             WHERE resource_group_id IN (
               SELECT id FROM resource_groups WHERE machine_id = ?
             )`
          ).run(machineId);

          for (const deletedPool of body.deletedPools) {
            const current = currentPoolMap.get(deletedPool.id)!;
            tombstoneResourcePool(
              deletedPool.id,
              machineId,
              auth.user.id
            );
            addAudit(
              auth.user.id,
              "RESOURCE_POOL_DELETE",
              "resource_pool",
              deletedPool.id,
              undefined,
              { name: current.name }
            );
          }

          for (const pool of body.pools) {
            const current = currentPoolMap.get(pool.id);
            const nextVersion = current ? current.version + 1 : 1;
            if (current) {
              db.prepare(
                `UPDATE resource_pools SET
                  name = ?, sharing_mode = ?, unit = ?, description = ?, sort_order = ?,
                  range_start = ?, range_end = ?, capacity_milli = ?,
                  version = ?, updated_at = ?
                 WHERE id = ?`
              ).run(
                pool.name,
                pool.sharingMode,
                pool.unit,
                pool.description,
                pool.sortOrder,
                pool.kind === "INDEX_RANGE" ? pool.rangeStart : null,
                pool.kind === "INDEX_RANGE" ? pool.rangeEnd : null,
                pool.kind === "CAPACITY"
                  ? Math.round(pool.capacity * 1000)
                  : null,
                nextVersion,
                now,
                pool.id
              );
            } else {
              db.prepare(
                `INSERT INTO resource_pools(
                  id, machine_id, name, kind, sharing_mode, unit, description, sort_order,
                  range_start, range_end, capacity_milli, version,
                  created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
              ).run(
                pool.id,
                machineId,
                pool.name,
                pool.kind,
                pool.sharingMode,
                pool.unit,
                pool.description,
                pool.sortOrder,
                pool.kind === "INDEX_RANGE" ? pool.rangeStart : null,
                pool.kind === "INDEX_RANGE" ? pool.rangeEnd : null,
                pool.kind === "CAPACITY"
                  ? Math.round(pool.capacity * 1000)
                  : null,
                now,
                now
              );
            }

            if (pool.kind === "ITEM_LIST") {
              const requestedIds = new Set(pool.items.map((item) => item.id));
              for (const [index, item] of pool.items.entries()) {
                const existingItem = db
                  .prepare(
                    "SELECT pool_id FROM resource_pool_items WHERE id = ?"
                  )
                  .get(item.id) as { pool_id: string } | undefined;
                if (existingItem && existingItem.pool_id !== pool.id) {
                  throw new BusinessError(
                    "设备配置已由其他管理员更新，请刷新后重试",
                    409,
                    undefined,
                    "RESOURCE_CONFIGURATION_STALE"
                  );
                }
                if (existingItem) {
                  db.prepare(
                    `UPDATE resource_pool_items SET
                      item_key = ?, label = ?, sort_order = ?, updated_at = ?
                     WHERE id = ? AND pool_id = ?`
                  ).run(
                    item.key,
                    item.label,
                    index,
                    now,
                    item.id,
                    pool.id
                  );
                } else {
                  db.prepare(
                    `INSERT INTO resource_pool_items(
                      id, pool_id, item_key, label, sort_order, created_at, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?)`
                  ).run(
                    item.id,
                    pool.id,
                    item.key,
                    item.label,
                    index,
                    now,
                    now
                  );
                }
              }
              if (current?.kind === "ITEM_LIST") {
                for (const item of current.items) {
                  if (!requestedIds.has(item.id)) {
                    db.prepare(
                      "DELETE FROM resource_pool_items WHERE id = ?"
                    ).run(item.id);
                  }
                }
              }
            }

            const updated = getResourcePool(pool.id)!;
            insertPoolRevision(
              pool.id,
              nextVersion,
              resourcePoolConfiguration(updated),
              auth.user.id
            );
            addAudit(
              auth.user.id,
              current ? "RESOURCE_POOL_UPDATE" : "RESOURCE_POOL_CREATE",
              "resource_pool",
              pool.id,
              current ? resourcePoolConfiguration(current) : undefined,
              resourcePoolConfiguration(updated)
            );
          }

          const allocationSignature = (
            allocations: ReturnType<typeof mapResourceGroup>["allocations"]
          ) =>
            JSON.stringify(
              allocations.map((allocation) => {
                if (allocation.kind === "INDEX_RANGE") {
                  return {
                    poolId: allocation.poolId,
                    kind: allocation.kind,
                    sharingMode: allocation.sharingMode,
                    ranges: allocation.ranges
                  };
                }
                if (allocation.kind === "ITEM_LIST") {
                  return {
                    poolId: allocation.poolId,
                    kind: allocation.kind,
                    sharingMode: allocation.sharingMode,
                    itemIds: allocation.items.map((item) => item.id)
                  };
                }
                return {
                  poolId: allocation.poolId,
                  kind: allocation.kind,
                  sharingMode: allocation.sharingMode,
                  quantity: allocation.quantity
                };
              })
            );

          for (const group of body.groups) {
            const current = currentGroupMap.get(group.id);
            const allocations = resolvedGroups.get(group.id)!;
            const nextVersion = current ? current.version + 1 : 1;
            if (current) {
              db.prepare(
                `UPDATE resource_groups SET
                  name = ?, description = ?, tags_json = ?, sort_order = ?,
                  version = ?, updated_at = ?
                 WHERE id = ?`
              ).run(
                group.name,
                group.description,
                JSON.stringify(group.tags),
                group.sortOrder,
                nextVersion,
                now,
                group.id
              );
            } else {
              db.prepare(
                `INSERT INTO resource_groups(
                  id, machine_id, name, description, tags_json, sort_order,
                  version, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`
              ).run(
                group.id,
                machineId,
                group.name,
                group.description,
                JSON.stringify(group.tags),
                group.sortOrder,
                now,
                now
              );
            }
            replaceGroupAllocations(group.id, allocations);
            const configuration = groupConfiguration(
              group.name,
              group.description,
              group.tags,
              allocations,
              group.sortOrder
            );
            insertGroupRevision(
              group.id,
              nextVersion,
              configuration,
              auth.user.id
            );
            const resourcesChanged =
              !current ||
              allocationSignature(current.allocations) !==
              allocationSignature(allocations);
            if (current && resourcesChanged) {
              const affected = db
                .prepare(
                  `SELECT DISTINCT r.user_id
                   FROM reservations r
                   WHERE r.resource_group_id = ?
                     AND r.status = 'CONFIRMED' AND r.end_at > ?`
                )
                .all(group.id, now) as Array<{ user_id: string }>;
              for (const user of affected) {
                createNotification(
                  user.user_id,
                  "RESOURCE_GROUP_CHANGED",
                  "资源组配置已调整",
                  `${group.name} 的资源已从“${current.resourceSummary}”调整为“${configuration.resourceSummary}”。你的未结束占用仍然有效，并立即采用新配置。`,
                  "/reservations",
                  { emailPolicy: "RESERVATION_IMPACT" }
                );
              }
            }
            addAudit(
              auth.user.id,
              current ? "RESOURCE_GROUP_UPDATE" : "RESOURCE_GROUP_CREATE",
              "resource_group",
              group.id,
              current
                ? groupConfiguration(
                  current.name,
                  current.description,
                  current.tags,
                  current.allocations,
                  current.sortOrder
                )
                : undefined,
              configuration
            );
          }
          return bumpScheduleRevision();
        });
        publishRevision(revision);
        return { message: "资源配置已保存", revision };
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          return reply.code(409).send({
            error: "资源项名称、资源组名称或设备标识不能重复"
          });
        }
        throw error;
      }
    }
  );

  app.post("/api/v1/admin/machines/:id/resource-pools", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const body = resourcePoolSchema.parse(request.body);
    const id = randomUUID();
    const now = nowIso();
    try {
      withImmediateTransaction(() => {
        db.prepare(
          `INSERT INTO resource_pools(
            id, machine_id, name, kind, sharing_mode, unit, description, sort_order,
            range_start, range_end, capacity_milli, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          auth.machineId,
          body.name,
          body.kind,
          body.sharingMode,
          body.unit,
          body.description,
          body.sortOrder,
          body.kind === "INDEX_RANGE" ? body.rangeStart : null,
          body.kind === "INDEX_RANGE" ? body.rangeEnd : null,
          body.kind === "CAPACITY" ? Math.round(body.capacity * 1000) : null,
          now,
          now
        );
        if (body.kind === "ITEM_LIST") {
          const seen = new Set<string>();
          const insert = db.prepare(
            `INSERT INTO resource_pool_items(
              id, pool_id, item_key, label, sort_order, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?)`
          );
          body.items.forEach((item, index) => {
            const key = item.key.toLocaleLowerCase();
            if (seen.has(key)) throw new BusinessError("设备标识不能重复");
            seen.add(key);
            insert.run(randomUUID(), id, item.key, item.label, index, now, now);
          });
        }
        const pool = getResourcePool(id)!;
        insertPoolRevision(
          id,
          1,
          resourcePoolConfiguration(pool),
          auth.user.id
        );
        addAudit(
          auth.user.id,
          "RESOURCE_POOL_CREATE",
          "resource_pool",
          id,
          undefined,
          resourcePoolConfiguration(pool)
        );
        bumpScheduleRevision();
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "同一机器内资源项名称或设备标识不能重复" });
      }
      throw error;
    }
    publishRevision(getScheduleRevision());
    return reply.code(201).send({ id });
  });

  app.get("/api/v1/admin/resource-pools/:id/revisions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pool = getResourcePool(id);
    if (!pool) return reply.code(404).send({ error: "资源项不存在" });
    const auth = requireMachineManagerForId(request, reply, pool.machineId);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT r.*, u.display_name AS changed_by_name
         FROM resource_pool_revisions r
         LEFT JOIN users u ON u.id = r.changed_by
         WHERE r.resource_pool_id = ?
         ORDER BY r.version DESC`
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        configuration: JSON.parse(String(row.configuration_json)),
        changedByName: row.changed_by_name ?? "系统",
        createdAt: row.created_at
      }))
    };
  });

  app.patch("/api/v1/admin/resource-pools/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = getResourcePool(id);
    if (!current) return reply.code(404).send({ error: "资源项不存在" });
    const auth = requireMachineManagerForId(request, reply, current.machineId);
    if (!auth) return;
    const expectedVersion = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body).expectedVersion;
    const body = resourcePoolSchema.parse(request.body);
    if (body.kind !== current.kind) {
      return reply.code(409).send({ error: "资源项的分配方式不能修改" });
    }
    try {
      withImmediateTransaction(() => {
        const fresh = getResourcePool(id);
        if (!fresh) throw new BusinessError("资源项不存在", 404);
        checkEditVersion(fresh.version, expectedVersion, overwriteRequested(request));
        if (body.kind === "INDEX_RANGE" && current.kind === "INDEX_RANGE") {
          const claim = db
            .prepare(
              `SELECT g.name, r.range_start, r.range_end
               FROM resource_group_allocation_ranges r
               JOIN resource_group_allocations a ON a.id = r.allocation_id
               JOIN resource_groups g ON g.id = a.resource_group_id
               WHERE a.resource_pool_id = ?
                 AND (r.range_start < ? OR r.range_end > ?)
               LIMIT 1`
            )
            .get(id, body.rangeStart, body.rangeEnd) as
            | { name: string; range_start: number; range_end: number }
            | undefined;
          if (claim) {
            throw new BusinessError(
              `缩小编号范围会影响 ${claim.name}（${claim.range_start}–${claim.range_end}）`,
              409
            );
          }
        }
        if (
          body.kind === "CAPACITY" &&
          current.kind === "CAPACITY" &&
          body.sharingMode === "EXCLUSIVE"
        ) {
          const allocated = db
            .prepare(
              `SELECT COALESCE(SUM(a.quantity_milli), 0) AS total
               FROM resource_group_allocations a
               JOIN resource_groups g ON g.id = a.resource_group_id
               WHERE a.resource_pool_id = ?`
            )
            .get(id) as { total: number };
          if (Number(allocated.total) > body.capacity * 1000) {
            throw new BusinessError("降低容量会影响现有资源组", 409);
          }
        }
        if (body.kind === "ITEM_LIST" && current.kind === "ITEM_LIST") {
          const requestedIds = new Set(
            body.items.flatMap((item) => (item.id ? [item.id] : []))
          );
          for (const item of current.items.filter(
            (candidate) => !requestedIds.has(candidate.id)
          )) {
            const allocation = db
              .prepare(
                `SELECT g.name
                 FROM resource_group_allocation_items ai
                 JOIN resource_group_allocations a ON a.id = ai.allocation_id
                 JOIN resource_groups g ON g.id = a.resource_group_id
                 WHERE ai.item_id = ?
                 LIMIT 1`
              )
              .get(item.id) as { name: string } | undefined;
            if (allocation) {
              throw new BusinessError(
                `删除设备 ${item.key} 会影响 ${allocation.name}`,
                409
              );
            }
          }
        }
        db.prepare(
          `UPDATE resource_pools SET
            name = ?, sharing_mode = ?, unit = ?, description = ?, sort_order = ?,
            range_start = ?, range_end = ?, capacity_milli = ?,
            version = version + 1, updated_at = ?
           WHERE id = ?`
        ).run(
          body.name,
          body.sharingMode,
          body.unit,
          body.description,
          body.sortOrder,
          body.kind === "INDEX_RANGE" ? body.rangeStart : null,
          body.kind === "INDEX_RANGE" ? body.rangeEnd : null,
          body.kind === "CAPACITY" ? Math.round(body.capacity * 1000) : null,
          nowIso(),
          id
        );
        if (
          body.kind === "CAPACITY" &&
          body.sharingMode === "SHARED"
        ) {
          db.prepare(
            `UPDATE resource_group_allocations
             SET quantity_milli = ?
             WHERE resource_pool_id = ?`
          ).run(Math.round(body.capacity * 1000), id);
        }
        if (body.kind === "ITEM_LIST") {
          const now = nowIso();
          const requestedIds = new Set<string>();
          const keys = new Set<string>();
          body.items.forEach((item, index) => {
            const normalizedKey = item.key.toLocaleLowerCase();
            if (keys.has(normalizedKey)) {
              throw new BusinessError("设备标识不能重复");
            }
            keys.add(normalizedKey);
            const itemId = item.id ?? randomUUID();
            requestedIds.add(itemId);
            if (item.id) {
              const result = db.prepare(
                `UPDATE resource_pool_items SET
                  item_key = ?, label = ?, sort_order = ?,
                  updated_at = ?
                 WHERE id = ? AND pool_id = ?`
              ).run(item.key, item.label, index, now, item.id, id);
              if (!result.changes) {
                throw new BusinessError("设备列表已更新，请刷新后重试", 409);
              }
            } else {
              db.prepare(
                `INSERT INTO resource_pool_items(
                  id, pool_id, item_key, label, sort_order, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?)`
              ).run(itemId, id, item.key, item.label, index, now, now);
            }
          });
          for (const item of current.items) {
            if (!requestedIds.has(item.id)) {
              db.prepare("DELETE FROM resource_pool_items WHERE id = ?").run(item.id);
            }
          }
        }
        const updated = getResourcePool(id)!;
        insertPoolRevision(
          id,
          updated.version,
          resourcePoolConfiguration(updated),
          auth.user.id
        );
        addAudit(
          auth.user.id,
          "RESOURCE_POOL_UPDATE",
          "resource_pool",
          id,
          resourcePoolConfiguration(current),
          resourcePoolConfiguration(updated)
        );
        bumpScheduleRevision();
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "同一机器内资源项名称或设备标识不能重复" });
      }
      throw error;
    }
    publishRevision(getScheduleRevision());
    return { message: "资源项已更新" };
  });

  app.delete("/api/v1/admin/resource-pools/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pool = getResourcePool(id);
    if (!pool) return reply.code(404).send({ error: "资源项不存在" });
    const auth = requireMachineManagerForId(request, reply, pool.machineId);
    if (!auth) return;
    const expectedVersion = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body).expectedVersion;
    const result = withImmediateTransaction(() => {
      const usedBy = db
        .prepare(
          `SELECT DISTINCT g.name
           FROM resource_group_allocations a
           JOIN resource_groups g ON g.id = a.resource_group_id
           WHERE a.resource_pool_id = ?
           ORDER BY g.name`
        )
        .all(id) as Array<{ name: string }>;
      if (usedBy.length) {
        throw new BusinessError(
          `该资源项仍被以下资源组使用：${usedBy.map((group) => group.name).join("、")}`,
          409,
          { resourceGroups: usedBy.map((group) => group.name) },
          "RESOURCE_POOL_IN_USE"
        );
      }
      const fresh = getResourcePool(id);
      if (!fresh) throw new BusinessError("资源项不存在", 404);
      checkEditVersion(fresh.version, expectedVersion, overwriteRequested(request));
      tombstoneResourcePool(id, pool.machineId, auth.user.id);
      addAudit(
        auth.user.id,
        "RESOURCE_POOL_DELETE",
        "resource_pool",
        id,
        undefined,
        { name: pool.name }
      );
      return bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(result);
    return { deleted: true };
  });

  app.get("/api/v1/admin/machines/:id/groups", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT * FROM resource_groups WHERE machine_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deleted_resource_group_tombstones drgt
             WHERE drgt.resource_group_id = resource_groups.id
           )
         ORDER BY sort_order, name`
      )
      .all(auth.machineId) as Array<Record<string, unknown>>;
    const now = nowIso();
    return {
      groups: rows.map((row) => {
        const group = mapResourceGroup(row);
        const visibleGroup = auth.canManage
          ? group
          : (({ version: _version, ...visible }) => visible)(group);
        return {
          ...visibleGroup,
          scheduledUnavailabilityCount: countRows(
            `SELECT COUNT(*) AS count FROM resource_unavailability
             WHERE resource_group_id = ? AND kind = 'PLANNED'
               AND status = 'ACTIVE' AND start_at > ?`,
            row.id,
            now
          ),
          hasCurrentPlannedUnavailability: Boolean(
            countRows(
              `SELECT COUNT(*) AS count FROM resource_unavailability
               WHERE resource_group_id = ? AND kind = 'PLANNED'
                 AND status = 'ACTIVE' AND start_at <= ? AND end_at > ?`,
              row.id,
              now,
              now
            )
          )
        };
      })
    };
  });

  app.post("/api/v1/admin/machines/:id/groups", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const body = resourceGroupSchema.parse(request.body);
    const requestedSortOrder =
      (request.body as { sortOrder?: unknown } | null)?.sortOrder;
    const id = randomUUID();
    const now = nowIso();
    try {
      withImmediateTransaction(() => {
        const duplicate = db
          .prepare(
            "SELECT 1 FROM resource_groups WHERE machine_id = ? AND name = ?"
          )
          .get(auth.machineId, body.name);
        if (duplicate) {
          throw new BusinessError("同一机器内资源组名称不能重复", 409);
        }
        const allocations = validateAndResolveGroupAllocations(
          auth.machineId,
          body.allocations
        );
        const sortOrder =
          typeof requestedSortOrder === "number"
            ? body.sortOrder
            : Number(
              (
                db.prepare(
                  `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
                     FROM resource_groups WHERE machine_id = ?`
                ).get(auth.machineId) as { next: number }
              ).next
            );
        db.prepare(
          `INSERT INTO resource_groups(
            id, machine_id, name, description, tags_json, sort_order,
            created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          auth.machineId,
          body.name,
          body.description,
          JSON.stringify(body.tags),
          sortOrder,
          now,
          now
        );
        replaceGroupAllocations(id, allocations);
        const configuration = groupConfiguration(
          body.name,
          body.description,
          body.tags,
          allocations,
          sortOrder
        );
        insertGroupRevision(id, 1, configuration, auth.user.id);
        addAudit(
          auth.user.id,
          "RESOURCE_GROUP_CREATE",
          "resource_group",
          id,
          undefined,
          configuration
        );
        bumpScheduleRevision();
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "同一机器内资源组名称不能重复" });
      }
      throw error;
    }
    publishRevision(getScheduleRevision());
    return reply.code(201).send({ id });
  });

  app.get("/api/v1/admin/groups/:id/revisions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id) as
      | { machine_id: string }
      | undefined;
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT r.*, u.display_name AS changed_by_name
         FROM resource_group_revisions r
         LEFT JOIN users u ON u.id = r.changed_by
         WHERE r.resource_group_id = ?
         ORDER BY r.version DESC`
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        configuration: JSON.parse(String(row.configuration_json)),
        changedByName: row.changed_by_name ?? "系统",
        createdAt: row.created_at
      }))
    };
  });

  app.patch("/api/v1/admin/groups/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = getCurrentResourceGroupRow(id);
    if (!current) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, current.machine_id);
    if (!auth) return;
    const body = resourceGroupSchema.parse(request.body);
    const sortOrder =
      typeof (request.body as { sortOrder?: unknown } | null)?.sortOrder ===
        "number"
        ? body.sortOrder
        : Number(current.sort_order ?? 0);
    if (body.expectedVersion === undefined) {
      return reply.code(400).send({ error: "缺少资源组配置版本" });
    }
    const beforeGroup = mapResourceGroup(current);
    withImmediateTransaction(() => {
      const fresh = getCurrentResourceGroupRow(id);
      if (!fresh) throw new BusinessError("资源组不存在", 404);
      checkEditVersion(Number(fresh.version), body.expectedVersion!, overwriteRequested(request));
      const duplicate = db
        .prepare(
          `SELECT 1 FROM resource_groups
           WHERE machine_id = ? AND name = ? AND id != ?`
        )
        .get(current.machine_id, body.name, id);
      if (duplicate) {
        throw new BusinessError("同一机器内资源组名称不能重复", 409);
      }
      const allocations = validateAndResolveGroupAllocations(
        String(current.machine_id),
        body.allocations,
        id
      );
      const version = Number(fresh.version) + 1;
      db.prepare(
        `UPDATE resource_groups SET
          name = ?, description = ?, tags_json = ?, sort_order = ?,
          version = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        body.name,
        body.description,
        JSON.stringify(body.tags),
        sortOrder,
        version,
        nowIso(),
        id
      );
      replaceGroupAllocations(id, allocations);
      const configuration = groupConfiguration(
        body.name,
        body.description,
        body.tags,
        allocations,
        sortOrder
      );
      insertGroupRevision(id, version, configuration, auth.user.id);
      const resourcesChanged =
        JSON.stringify(beforeGroup.allocations) !== JSON.stringify(allocations);
      if (resourcesChanged) {
        const affected = db
          .prepare(
            `SELECT DISTINCT r.user_id, u.display_name
             FROM reservations r JOIN users u ON u.id = r.user_id
             WHERE r.resource_group_id = ? AND r.status = 'CONFIRMED' AND r.end_at > ?`
          )
          .all(id, nowIso()) as Array<{ user_id: string; display_name: string }>;
        for (const user of affected) {
          createNotification(
            user.user_id,
            "RESOURCE_GROUP_CHANGED",
            "资源组配置已调整",
            `${body.name} 的资源已从“${beforeGroup.resourceSummary}”调整为“${configuration.resourceSummary}”。你的未结束占用仍然有效，并立即采用新配置。`,
            "/reservations",
            { emailPolicy: "RESERVATION_IMPACT" }
          );
        }
      }
      addAudit(
        auth.user.id,
        "RESOURCE_GROUP_UPDATE",
        "resource_group",
        id,
        groupConfiguration(
          beforeGroup.name,
          beforeGroup.description,
          beforeGroup.tags,
          beforeGroup.allocations,
          beforeGroup.sortOrder
        ),
        configuration
      );
      bumpScheduleRevision();
    });
    publishRevision(getScheduleRevision());
    return { message: "资源组已更新" };
  });
}

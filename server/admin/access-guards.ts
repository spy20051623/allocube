import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth, canAccessMachine, canManageMachine } from "../auth.js";

export function requireMachineManager(request: FastifyRequest, reply: FastifyReply) {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  return requireMachineManagerForId(request, reply, id);
}

export function requireMachineViewer(request: FastifyRequest, reply: FastifyReply) {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  return requireMachineViewerForId(request, reply, id);
}

function requireMachineViewerForId(
  request: FastifyRequest,
  reply: FastifyReply,
  machineId: string
) {
  const auth = requireAuth(request, reply);
  if (!auth) return null;
  if (!canAccessMachine(auth.user.id, auth.user.role, machineId)) {
    reply.code(403).send({ error: "你没有这台机器的使用权限" });
    return null;
  }
  return {
    ...auth,
    machineId,
    canManage: canManageMachine(auth.user.id, auth.user.role, machineId)
  };
}

export function requireMachineManagerForId(
  request: FastifyRequest,
  reply: FastifyReply,
  machineId: string
) {
  const auth = requireAuth(request, reply);
  if (!auth) return null;
  if (!canManageMachine(auth.user.id, auth.user.role, machineId)) {
    reply.code(403).send({ error: "无权管理这台机器" });
    return null;
  }
  return { ...auth, machineId };
}

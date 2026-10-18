// task.* capabilities (UAPF-IP capabilities/task.yaml): the human-in-the-loop
// work queue. The agent keeps the queue; people complete tasks through the
// agent API or its MCP tools.

import { badInput, notFound } from "../problem.js";

export function createTaskCapabilities({ cfg, memory }) {
  const accessUrl = (id) => `${cfg.agent.publicBaseUrl.replace(/\/$/, "")}/agent/tasks/${id}`;

  const assign = async (input, _g, ctx) => {
    if (!input?.role) throw badInput("task.assign: required field 'role' is missing.");
    const task = memory.putTask({
      taskInstanceId: memory.id("task"),
      sessionId: ctx.sessionId,
      stepId: ctx.stepId,
      role: input.role,
      assignee: input.assignee ?? null,
      payload: input.payload ?? {},
      priority: input.priority ?? "normal",
      dueBy: input.dueBy ?? null,
      state: "open",
      createdAt: new Date().toISOString(),
    });
    return { taskInstanceId: task.taskInstanceId, assignee: task.assignee, accessUrl: accessUrl(task.taskInstanceId) };
  };

  const existing = (id) => {
    const t = memory.task(id);
    if (!t) throw notFound(`Task ${id} not found.`);
    return t;
  };

  return {
    "task.assign@1": assign,
    // The reference engine dispatches BPMN user tasks to task.request@1 when no
    // capability is named; it is served exactly like task.assign@1.
    "task.request@1": (input, g, ctx) => assign({ role: "unassigned", ...input }, g, ctx),

    "task.complete@1": async (input) => {
      if (!input?.taskInstanceId) throw badInput("task.complete: required field 'taskInstanceId' is missing.");
      const t = existing(input.taskInstanceId);
      memory.putTask({
        ...t,
        state: "completed",
        result: input.result ?? null,
        completedBy: input.completedBy ?? null,
        completedAt: input.completedAt ?? new Date().toISOString(),
      });
      return { acknowledged: true };
    },

    "task.escalate@1": async (input, g, ctx) => {
      if (!input?.taskInstanceId || !input?.reason) {
        throw badInput("task.escalate: 'taskInstanceId' and 'reason' are required.");
      }
      const t = existing(input.taskInstanceId);
      memory.putTask({ ...t, state: "escalated", escalationReason: input.reason });
      const target = input.targetRole || `${t.role}-escalation`;
      const next = await assign({ role: target, payload: t.payload, priority: "high" }, g, ctx);
      return { escalatedTo: target, newTaskInstanceId: next.taskInstanceId };
    },

    "task.reassign@1": async (input) => {
      if (!input?.taskInstanceId) throw badInput("task.reassign: required field 'taskInstanceId' is missing.");
      const t = existing(input.taskInstanceId);
      const updated = memory.putTask({
        ...t,
        role: input.newRole ?? t.role,
        assignee: input.newAssignee ?? null,
        reassignReason: input.reason ?? null,
      });
      return { reassignedTo: updated.assignee || updated.role };
    },
  };
}

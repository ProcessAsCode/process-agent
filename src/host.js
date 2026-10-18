// UAPF-IP host surface: the capability manifest and the dispatcher that the
// runtime calls for every service and user task. The agent contains no
// process-specific code — what happens, in which order and under which rules
// is defined by the UAPF package the runtime is executing.

import { createAiCapabilities } from "./capabilities/ai.js";
import { createTaskCapabilities } from "./capabilities/task.js";
import { notAvailable, Problem } from "./problem.js";

const parseRef = (ref) => {
  const m = String(ref).match(/^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)@(\d+)$/);
  return m ? { namespace: m[1], operation: m[2], version: Number(m[3]) } : null;
};

export function createHost({ cfg, llm, memory, trust, systems }) {
  const handlers = {
    ...createAiCapabilities({ cfg, llm }),
    ...createTaskCapabilities({ cfg, memory }),
    "event.emit@1": async (input, _g, ctx) => {
      // Runtimes that pass the process variables as input (as the reference
      // engine does) carry no event type; the BPMN step id then names it.
      const type = input?.type || (ctx.stepId ? `dev.uapf.process.${ctx.stepId}` : null);
      if (!type) throw new Problem(400, "schema-validation-failed", "Input validation failed",
        "event.emit: required field 'type' is missing.");
      const e = trust.record({ sessionId: ctx.sessionId, stepId: ctx.stepId, type, data: input?.data ?? input });
      return { eventId: `evt_${e.seq}_${e.hash.slice(0, 12)}`, publishedAt: e.at };
    },
  };

  // data.* and document.* come from the organisation's systems via MCP bindings.
  for (const ref of systems.bound()) {
    if (!handlers[ref]) handlers[ref] = (input) => systems.invoke(ref, input);
  }

  function manifest() {
    return {
      hostDid: cfg.agent.did,
      hostBaseUrl: cfg.agent.publicBaseUrl,
      profiles: ["uapf-ip-orchestrated", "uapf-ip-sync-decision"],
      capabilities: Object.keys(handlers).map(parseRef).filter(Boolean),
      auditDelivery: "webhook",
    };
  }

  async function invoke(namespace, operation, body) {
    const sessionId = body?.sessionId ?? null;
    const stepId = body?.stepId ?? null;
    const guardrails = body?.guardrails ?? null;
    const input = body?.input ?? {};
    // The REST binding does not carry the version in the path; v1 is the only
    // reserved version in UAPF-IP v0.1.
    const ref = `${namespace}.${operation}@1`;
    const handler = handlers[ref];
    if (!handler) throw notAvailable(ref, { "uapf:sessionId": sessionId });

    trust.record({ sessionId, stepId, type: "dev.uapf.host.capability.invoked", data: { capability: ref } });
    try {
      const output = await handler(input, guardrails, { sessionId, stepId });
      const done = trust.record({ sessionId, stepId, type: "dev.uapf.host.capability.completed", data: { capability: ref, output } });
      return { output, auditEvent: `chain:${done.seq}:${done.hash}` };
    } catch (err) {
      const isPolicy = err instanceof Problem && err.slug === "policy-violation";
      trust.record({
        sessionId,
        stepId,
        type: isPolicy ? "dev.uapf.policy_violation" : "dev.uapf.host.capability.failed",
        data: { capability: ref, error: err.message },
      });
      if (err instanceof Problem) {
        err.extra = { "uapf:sessionId": sessionId, "uapf:capability": ref, ...err.extra };
        throw err;
      }
      throw new Problem(500, "internal-error", "Internal error", err.message, { "uapf:sessionId": sessionId });
    }
  }

  return { manifest, invoke, has: (ref) => Boolean(handlers[ref]) };
}

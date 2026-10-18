// Planning: turns a request in plain language into a proposal — which
// published process to run and with which input. The planner only chooses
// among the packages the runtime already holds; it never invents steps.
// A proposal is not executed until a person (or a calling system) confirms it.

import { badInput } from "./problem.js";
import { resolveModel } from "./guardrails.js";

export function createPlanner({ cfg, llm, processes }) {
  async function catalog() {
    const pkgs = await processes.listPackages();
    return pkgs.flatMap((p) =>
      (p.processes || []).map((proc) => ({
        packageId: p.packageId ?? p.id,
        packageVersion: p.version,
        processId: proc.id ?? proc.bpmnProcessId,
        name: p.name,
        description: proc.description || p.description || "",
      }))
    );
  }

  async function plan(goal, context = {}) {
    if (!goal || typeof goal !== "string") throw badInput("plan: 'goal' must be a non-empty string.");
    const options = await catalog();
    if (options.length === 0) return { proposal: null, reason: "The runtime holds no runnable processes." };
    const r = await llm.chatJson({
      model: resolveModel(null, null, cfg.llm.defaultModel),
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You select which published process fits a request. Choose only from the catalogue. " +
            'Answer only with JSON: {"packageId":"...","processId":"...","input":{...},"rationale":"..."} ' +
            'or {"packageId":null,"rationale":"..."} when nothing fits. Put into input only values stated in the request or context.',
        },
        {
          role: "user",
          content: `Catalogue:\n${JSON.stringify(options, null, 2)}\n\nContext:\n${JSON.stringify(context)}\n\nRequest:\n${goal}`,
        },
      ],
    });
    const choice = r.json;
    const match = options.find((o) => o.packageId === choice.packageId && o.processId === choice.processId);
    if (!match) return { proposal: null, reason: choice.rationale || "No published process fits the request." };
    return {
      proposal: {
        packageId: match.packageId,
        packageVersion: match.packageVersion,
        processId: match.processId,
        input: choice.input && typeof choice.input === "object" ? choice.input : {},
      },
      rationale: choice.rationale || "",
      requiresConfirmation: true,
      modelUsed: r.modelUsed,
    };
  }

  return { catalog, plan };
}

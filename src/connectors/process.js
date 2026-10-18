// Process connector: talks to a UAPF-IP runtime (the reference uapf-engine or
// any conformant runtime) over the REST binding. The agent acts as the host:
// it starts sessions with its own capability manifest, and the runtime calls
// back into the agent for every service and user task.

import { upstream, badInput } from "../problem.js";

export function createProcessConnector(cfg, manifest) {
  const base = cfg.engine.url.replace(/\/$/, "");

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(cfg.engine.timeoutMs),
      });
    } catch (err) {
      throw upstream(`Process runtime unreachable: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = data.error || data.detail || `runtime returned ${res.status}`;
      throw res.status === 400 ? badInput(detail) : upstream(detail);
    }
    return data;
  }

  return {
    health: () => call("GET", "/health"),
    listPackages: async () => (await call("GET", "/uapf/packages")) || [],
    getPackage: (packageId) => call("GET", `/uapf/packages/${encodeURIComponent(packageId)}`),
    startSession: ({ packageId, packageVersion, processId, input, guardrailsRef }) =>
      call("POST", "/uapf/start-session", {
        packageId,
        packageVersion,
        processId,
        input: input ?? {},
        hostManifest: manifest(),
        guardrailsRef,
      }),
    evaluateDecision: ({ packageId, packageVersion, decisionId, input }) =>
      call("POST", "/uapf/evaluate-decision", { packageId, packageVersion, decisionId, input }),
    getSession: (sessionId) => call("GET", `/uapf/sessions/${encodeURIComponent(sessionId)}`),
    getAudit: (sessionId) => call("GET", `/uapf/sessions/${encodeURIComponent(sessionId)}/audit`),
    abort: (sessionId, reason) =>
      call("POST", `/uapf/sessions/${encodeURIComponent(sessionId)}/abort`, { reason }),
  };
}

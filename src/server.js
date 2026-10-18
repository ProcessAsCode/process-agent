// HTTP entry point.
//
//   UAPF-IP host surface (called by the process runtime):
//     GET  /uapf/host/manifest
//     POST /uapf/host/capability/{namespace}/{operation}
//     POST /uapf/host/audit
//
//   Agent API (called by people, chat front-ends and the MCP adapter):
//     GET  /agent/processes             catalogue of runnable processes
//     POST /agent/plan      {goal}      proposal: which process, which input
//     POST /agent/runs      {packageId, processId, input}   start a process
//     GET  /agent/runs[/{runId}]
//     GET  /agent/tasks[?state=open]
//     GET  /agent/tasks/{id}
//     POST /agent/tasks/{id}/complete   {result, completedBy}
//     GET  /agent/audit/verify          check the audit hash chain
//
//   GET /health

import http from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig, secret } from "./config.js";
import { createLlm } from "./llm.js";
import { createMemory } from "./memory.js";
import { createTrust } from "./connectors/trust.js";
import { createSystems } from "./connectors/systems.js";
import { createProcessConnector } from "./connectors/process.js";
import { createHost } from "./host.js";
import { createPlanner } from "./planner.js";
import { Problem, unauthorized, notFound, badInput } from "./problem.js";

const MAX_BODY = 5 * 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(badInput("Request body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(badInput("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(JSON.stringify(body));
}

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

export function createApp(cfg = loadConfig(), deps = {}) {
  const llm = deps.llm || createLlm(cfg);
  const memory = deps.memory || createMemory(cfg.memory.file);
  const trust = deps.trust || createTrust(cfg);
  const systems = deps.systems || createSystems(cfg);
  let host;
  const processes = deps.processes || createProcessConnector(cfg, () => host.manifest());
  host = createHost({ cfg, llm, memory, trust, systems });
  const planner = createPlanner({ cfg, llm, processes });

  const apiToken = secret(cfg.agent.apiTokenEnv);
  const hostToken = secret(cfg.agent.hostTokenEnv);

  async function startRun({ packageId, packageVersion, processId, input, guardrailsRef, requestedBy }) {
    if (!packageId || !processId) throw badInput("'packageId' and 'processId' are required.");
    const run = memory.addRun({
      runId: memory.id("run"),
      packageId,
      packageVersion: packageVersion ?? null,
      processId,
      requestedBy: requestedBy ?? null,
      startedAt: new Date().toISOString(),
      state: "starting",
    });
    trust.record({ type: "dev.uapf.agent.run.requested", data: { runId: run.runId, packageId, processId, requestedBy } });
    try {
      const r = await processes.startSession({ packageId, packageVersion, processId, input, guardrailsRef });
      return memory.updateRun(run.runId, {
        sessionId: r.sessionId,
        state: r.state,
        output: r.output ?? null,
        finishedAt: ["completed", "failed", "aborted"].includes(r.state) ? new Date().toISOString() : null,
      });
    } catch (err) {
      memory.updateRun(run.runId, { state: "failed", error: err.message, finishedAt: new Date().toISOString() });
      throw err;
    }
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const m = req.method;

    if (m === "GET" && p === "/health") {
      return send(res, 200, { status: "ok", agent: cfg.agent.id, did: cfg.agent.did });
    }

    // ── UAPF-IP host surface ─────────────────────────────────────────
    if (p.startsWith("/uapf/host")) {
      if (hostToken && bearer(req) !== hostToken) throw unauthorized();
      if (m === "GET" && p === "/uapf/host/manifest") return send(res, 200, host.manifest());
      const cap = p.match(/^\/uapf\/host\/capability\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/);
      if (m === "POST" && cap) return send(res, 200, await host.invoke(cap[1], cap[2], await readJson(req)));
      if (m === "POST" && p === "/uapf/host/audit") {
        const body = await readJson(req);
        const events = Array.isArray(body) ? body : [body];
        for (const e of events) {
          trust.record({ sessionId: e.uapfsessionid, stepId: e.uapfstepid, type: e.type || "dev.uapf.runtime.event", data: e });
        }
        return send(res, 202, { accepted: events.length });
      }
      throw notFound(`No host endpoint ${m} ${p}`);
    }

    // ── Agent API ────────────────────────────────────────────────────
    if (p.startsWith("/agent")) {
      if (!apiToken || bearer(req) !== apiToken) throw unauthorized();
      if (m === "GET" && p === "/agent/processes") return send(res, 200, await planner.catalog());
      if (m === "POST" && p === "/agent/plan") {
        const b = await readJson(req);
        return send(res, 200, await planner.plan(b.goal, b.context));
      }
      if (m === "POST" && p === "/agent/runs") return send(res, 200, await startRun(await readJson(req)));
      if (m === "GET" && p === "/agent/runs") return send(res, 200, memory.runs());
      const run = p.match(/^\/agent\/runs\/([\w-]+)$/);
      if (m === "GET" && run) {
        const r = memory.run(run[1]);
        if (!r) throw notFound(`Run ${run[1]} not found.`);
        const session = r.sessionId ? await processes.getSession(r.sessionId).catch(() => null) : null;
        return send(res, 200, { ...r, session });
      }
      if (m === "GET" && p === "/agent/tasks") {
        return send(res, 200, memory.tasks({ state: url.searchParams.get("state") || undefined }));
      }
      const task = p.match(/^\/agent\/tasks\/([\w-]+)(\/complete)?$/);
      if (task && m === "GET" && !task[2]) {
        const t = memory.task(task[1]);
        if (!t) throw notFound(`Task ${task[1]} not found.`);
        return send(res, 200, t);
      }
      if (task && m === "POST" && task[2]) {
        const b = await readJson(req);
        const out = await host.invoke("task", "complete", {
          input: { taskInstanceId: task[1], result: b.result, completedBy: b.completedBy },
        });
        return send(res, 200, out.output);
      }
      if (m === "GET" && p === "/agent/audit/verify") {
        return send(res, 200, { chain: trust.verifyChain(), signer: await trust.signerStatus() });
      }
      throw notFound(`No agent endpoint ${m} ${p}`);
    }

    throw notFound(`No endpoint ${m} ${p}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (err instanceof Problem) {
        res.writeHead(err.status, { "Content-Type": "application/problem+json" });
        return res.end(JSON.stringify(err.toJSON()));
      }
      console.error(`[process-agent] ${req.method} ${req.url}: ${err.stack || err.message}`);
      res.writeHead(500, { "Content-Type": "application/problem+json" });
      res.end(JSON.stringify(new Problem(500, "internal-error", "Internal error", "Unexpected error").toJSON()));
    }
  });

  return { server, host, memory, trust, planner, close: () => systems.close() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  if (!secret(cfg.agent.apiTokenEnv)) {
    console.error(`[process-agent] ${cfg.agent.apiTokenEnv} must be set; the agent API is refused without it.`);
    process.exit(1);
  }
  const app = createApp(cfg);
  app.server.listen(cfg.agent.listen.port, cfg.agent.listen.host, () => {
    console.log(`[process-agent] ${cfg.agent.id} listening on ${cfg.agent.listen.host}:${cfg.agent.listen.port}`);
    console.log(`[process-agent] runtime ${cfg.engine.url}; capabilities: ${app.host.manifest().capabilities.length}`);
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact, resolveModel, assertNoForbiddenInputs, prepareModelText, needsHumanReview } from "../src/guardrails.js";
import { createTrust } from "../src/connectors/trust.js";
import { applyTemplate, parseToolResult } from "../src/connectors/systems.js";
import { createMemory } from "../src/memory.js";
import { createHost } from "../src/host.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pa-"));

function testConfig(dir) {
  process.env.AGENT_CONFIG = "/nonexistent.yaml";
  process.env.AUDIT_LOG = path.join(dir, "audit.jsonl");
  process.env.MEMORY_FILE = path.join(dir, "memory.json");
  process.env.LLM_MODEL = "model-a";
  return loadConfig();
}

// Records what the agent sends to the model, and answers with canned JSON.
function fakeLlm(answer) {
  const calls = [];
  return {
    calls,
    chat: async (args) => {
      calls.push(args);
      return { text: "done", modelUsed: args.model };
    },
    chatJson: async (args) => {
      calls.push(args);
      return { json: typeof answer === "function" ? answer(args) : answer, modelUsed: args.model };
    },
  };
}

const noSystems = { bound: () => [], has: () => false, invoke: async () => ({}), close: async () => {} };

test("redact removes e-mail, national ID and IBAN", () => {
  const r = redact("Write to a.b@example.com, code 010190-12345, account LV80BANK0000435195001");
  assert.ok(!r.redactedText.includes("example.com"));
  assert.ok(!r.redactedText.includes("010190-12345"));
  assert.ok(!r.redactedText.includes("LV80BANK"));
  assert.deepEqual([...new Set(r.detections.map((d) => d.category))].sort(), ["email", "iban", "national_id"]);
});

test("model resolution follows the guardrails allowlist", () => {
  const g = { ai: { allowed_models: ["m1", "m2"] } };
  assert.equal(resolveModel(g, "m2", "x"), "m2");
  assert.equal(resolveModel(g, "not-allowed", "x"), "m1");
  assert.equal(resolveModel(null, null, "fallback"), "fallback");
  assert.throws(() => resolveModel(null, null, ""), /No model/);
});

test("forbidden inputs are refused, redaction applied when required", () => {
  const g = { ai: { forbidden_inputs: ["personas_kods"], pii_redactor: "required", max_confidence_for_autocomplete: 0.8 } };
  assert.throws(() => assertNoForbiddenInputs(g, { a: { personas_kods: "x" } }), /a\.personas_kods/);
  assert.doesNotThrow(() => assertNoForbiddenInputs(g, { text: "ok" }));
  assert.deepEqual(prepareModelText(g, "mail x@y.lv").redactionsApplied, ["email"]);
  assert.equal(needsHumanReview(g, "s1", 0.5), true);
  assert.equal(needsHumanReview(g, "s1", 0.9), false);
});

test("audit log is a verifiable hash chain and detects tampering", () => {
  const dir = tmp();
  const trust = createTrust({ trust: { auditLog: path.join(dir, "a.jsonl"), eventSignerUrl: "" } });
  trust.record({ sessionId: "s", stepId: "1", type: "t", data: { a: 1 } });
  trust.record({ sessionId: "s", stepId: "2", type: "t", data: { b: 2 } });
  assert.deepEqual(trust.verifyChain(), { ok: true, entries: 2 });
  const file = path.join(dir, "a.jsonl");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"stepId":"1"', '"stepId":"9"'));
  assert.equal(trust.verifyChain().ok, false);
});

test("systems templates and tool results", () => {
  assert.deepEqual(applyTemplate({ id: "$.documentId", fixed: 1 }, { documentId: "d1" }), { id: "d1", fixed: 1 });
  assert.deepEqual(applyTemplate(undefined, { x: 1 }), { x: 1 });
  assert.deepEqual(parseToolResult({ content: [{ type: "text", text: '{"ok":true}' }] }), { ok: true });
  assert.throws(() => parseToolResult({ isError: true, content: [{ type: "text", text: "boom" }] }), /boom/);
});

test("host: classify enforces guardrails and only returns known categories", async () => {
  const dir = tmp();
  const cfg = testConfig(dir);
  const llm = fakeLlm({ predictions: [{ category: "invoice", confidence: 0.9 }, { category: "made-up", confidence: 0.8 }] });
  const host = createHost({ cfg, llm, memory: createMemory(cfg.memory.file), trust: createTrust(cfg), systems: noSystems });
  const out = await host.invoke("ai", "classify", {
    sessionId: "s1",
    stepId: "Classify",
    input: { text: "Pay to x@y.lv", categories: ["invoice", "complaint"] },
    guardrails: { ai: { allowed_models: ["model-b"], pii_redactor: "required" } },
  });
  assert.deepEqual(out.output.predictions, [{ category: "invoice", confidence: 0.9 }]);
  assert.equal(out.output.modelUsed, "model-b");
  assert.deepEqual(out.output.redactionsApplied, ["email"]);
  assert.ok(!JSON.stringify(llm.calls[0].messages).includes("x@y.lv"), "PII must not reach the model");
  await assert.rejects(
    host.invoke("ai", "classify", { input: { text: "t", categories: ["a"], bank_account: "1" }, guardrails: { ai: { forbidden_inputs: ["bank_account"] } } }),
    (e) => e.status === 422 && e.slug === "policy-violation"
  );
  await assert.rejects(host.invoke("data", "read", { input: {} }), (e) => e.status === 422 && e.slug === "capability-not-available");
});

test("host: task lifecycle and manifest", async () => {
  const dir = tmp();
  const cfg = testConfig(dir);
  const memory = createMemory(cfg.memory.file);
  const host = createHost({ cfg, llm: fakeLlm({}), memory, trust: createTrust(cfg), systems: noSystems });
  const caps = host.manifest().capabilities.map((c) => `${c.namespace}.${c.operation}`);
  for (const c of ["ai.complete", "ai.classify", "ai.extract", "ai.redact", "task.assign", "task.complete", "event.emit"]) {
    assert.ok(caps.includes(c), c);
  }
  assert.ok(!caps.includes("data.read"), "data.* is only advertised when a system binding exists");
  const a = await host.invoke("task", "assign", { sessionId: "s", stepId: "Review", input: { role: "reviewer", payload: { doc: 1 } } });
  assert.match(a.output.taskInstanceId, /^task_/);
  const esc = await host.invoke("task", "escalate", { input: { taskInstanceId: a.output.taskInstanceId, reason: "late" } });
  assert.equal(esc.output.escalatedTo, "reviewer-escalation");
  await host.invoke("task", "complete", { input: { taskInstanceId: esc.output.newTaskInstanceId, result: { ok: true }, completedBy: "u1" } });
  assert.equal(memory.task(esc.output.newTaskInstanceId).state, "completed");
});

test("agent API requires a token; host surface serves the manifest", async () => {
  const dir = tmp();
  const cfg = testConfig(dir);
  process.env.AGENT_API_TOKEN = "t0k";
  const app = createApp(cfg, { llm: fakeLlm({}), systems: noSystems, processes: { listPackages: async () => [] } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/agent/runs`)).status, 401);
    assert.equal((await fetch(`${base}/agent/runs`, { headers: { Authorization: "Bearer t0k" } })).status, 200);
    const man = await (await fetch(`${base}/uapf/host/manifest`)).json();
    assert.equal(man.hostBaseUrl, cfg.agent.publicBaseUrl);
    const bad = await fetch(`${base}/uapf/host/capability/ai/classify`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type"), /problem\+json/);
  } finally {
    app.server.close();
    delete process.env.AGENT_API_TOKEN;
  }
});

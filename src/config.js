// Configuration: a YAML file (AGENT_CONFIG, default config/agent.yaml) plus
// environment overrides. Secrets are never stored in the file; the file names
// the environment variables that hold them.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const DEFAULTS = {
  agent: {
    id: "process-agent",
    did: "did:web:localhost",
    listen: { host: "0.0.0.0", port: 4100 },
    publicBaseUrl: "http://localhost:4100",
    apiTokenEnv: "AGENT_API_TOKEN",
    hostTokenEnv: "AGENT_HOST_TOKEN",
  },
  engine: { url: "http://localhost:4000", timeoutMs: 120000 },
  llm: {
    baseUrl: "http://localhost:8000/v1",
    apiKeyEnv: "LLM_API_KEY",
    defaultModel: "",
    timeoutMs: 60000,
  },
  trust: { auditLog: "./data/audit.jsonl", eventSignerUrl: "" },
  memory: { file: "./data/memory.json" },
  systems: { servers: {}, bindings: {} },
};

function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = base && typeof base[k] === "object" && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(file = process.env.AGENT_CONFIG || "config/agent.yaml") {
  let fromFile = {};
  if (file && fs.existsSync(file)) {
    fromFile = YAML.parse(fs.readFileSync(file, "utf8")) || {};
  }
  const cfg = merge(DEFAULTS, fromFile);
  const env = process.env;
  if (env.AGENT_DID) cfg.agent.did = env.AGENT_DID;
  if (env.AGENT_PUBLIC_URL) cfg.agent.publicBaseUrl = env.AGENT_PUBLIC_URL;
  if (env.AGENT_PORT) cfg.agent.listen.port = Number(env.AGENT_PORT);
  if (env.ENGINE_URL) cfg.engine.url = env.ENGINE_URL;
  if (env.LLM_BASE_URL) cfg.llm.baseUrl = env.LLM_BASE_URL;
  if (env.LLM_MODEL) cfg.llm.defaultModel = env.LLM_MODEL;
  if (env.EVENT_SIGNER_URL) cfg.trust.eventSignerUrl = env.EVENT_SIGNER_URL;
  if (env.AUDIT_LOG) cfg.trust.auditLog = env.AUDIT_LOG;
  if (env.MEMORY_FILE) cfg.memory.file = env.MEMORY_FILE;
  for (const p of [cfg.trust.auditLog, cfg.memory.file]) {
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  }
  return cfg;
}

export const secret = (envName) => (envName ? process.env[envName] || "" : "");

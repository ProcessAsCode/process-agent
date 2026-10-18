#!/usr/bin/env node
// MCP adapter (stdio): exposes the agent API as MCP tools so chat front-ends
// and other AI agents can find processes, propose runs, start them after
// confirmation and handle human tasks. It holds no logic of its own.
//
//   AGENT_URL=http://localhost:4100 AGENT_API_TOKEN=... node src/mcp.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AGENT_URL = (process.env.AGENT_URL || "http://localhost:4100").replace(/\/$/, "");
const TOKEN = process.env.AGENT_API_TOKEN || "";

async function api(method, path, body) {
  const res = await fetch(`${AGENT_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { isError: !res.ok, content: [{ type: "text", text }] };
}

const server = new McpServer({ name: "process-agent", version: "0.1.0" });

server.tool("list_processes", "List the published processes this agent can run.", {}, () =>
  api("GET", "/agent/processes"));

server.tool(
  "plan_process",
  "Propose which published process fits a request, and with which input. Does not start anything.",
  { goal: z.string().describe("What the user wants done, in plain language"), context: z.record(z.string(), z.any()).optional() },
  ({ goal, context }) => api("POST", "/agent/plan", { goal, context })
);

server.tool(
  "start_process",
  "Start a published process. Only call this after the user has confirmed the proposal.",
  {
    packageId: z.string(),
    processId: z.string(),
    packageVersion: z.string().optional(),
    input: z.record(z.string(), z.any()).optional(),
    requestedBy: z.string().optional(),
  },
  (args) => api("POST", "/agent/runs", args)
);

server.tool("get_run", "Get the state, output and runtime session of a run.", { runId: z.string() }, ({ runId }) =>
  api("GET", `/agent/runs/${encodeURIComponent(runId)}`));

server.tool(
  "list_tasks",
  "List human tasks created by running processes.",
  { state: z.enum(["open", "completed", "escalated"]).optional() },
  ({ state }) => api("GET", `/agent/tasks${state ? `?state=${state}` : ""}`)
);

server.tool(
  "complete_task",
  "Record a person's decision on a human task.",
  { taskInstanceId: z.string(), result: z.any(), completedBy: z.string() },
  ({ taskInstanceId, result, completedBy }) =>
    api("POST", `/agent/tasks/${encodeURIComponent(taskInstanceId)}/complete`, { result, completedBy })
);

server.tool("verify_audit", "Verify the agent's audit hash chain and event-signer status.", {}, () =>
  api("GET", "/agent/audit/verify"));

await server.connect(new StdioServerTransport());

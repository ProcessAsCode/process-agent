// Systems connector: fulfils data.* and document.* capabilities by calling
// MCP tools exposed by the organisation's IT systems (document management,
// contract management, ERP, …). Which tool serves which capability is
// configuration, not code:
//
//   systems:
//     servers:
//       dms: { url: "http://opendms:8000/mcp", authEnv: DMS_MCP_TOKEN }
//     bindings:
//       "document.fetch@1": { server: dms, tool: get_document, args: { id: "$.documentId" } }
//
// Argument templates take values from the capability input with `$.path`;
// anything else is passed through literally. Without `args`, the whole
// capability input is passed to the tool.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { secret } from "../config.js";
import { upstream, badInput } from "../problem.js";

function pick(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function applyTemplate(template, input) {
  if (template === undefined) return input;
  if (typeof template === "string" && template.startsWith("$.")) return pick(input, template.slice(2));
  if (Array.isArray(template)) return template.map((t) => applyTemplate(t, input));
  if (template && typeof template === "object") {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, applyTemplate(v, input)]));
  }
  return template;
}

export function parseToolResult(result) {
  if (result?.isError) {
    const msg = result.content?.map((c) => c.text).filter(Boolean).join(" ") || "tool error";
    throw upstream(`System tool failed: ${msg}`);
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

export function createSystems(cfg) {
  const servers = cfg.systems.servers || {};
  const bindings = cfg.systems.bindings || {};
  const clients = new Map();

  async function client(name) {
    if (clients.has(name)) return clients.get(name);
    const s = servers[name];
    if (!s?.url) throw badInput(`Systems binding refers to unknown server '${name}'.`);
    const token = secret(s.authEnv);
    const transport = new StreamableHTTPClientTransport(new URL(s.url), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    const c = new Client({ name: cfg.agent.id, version: "0.1.0" });
    try {
      await c.connect(transport);
    } catch (err) {
      throw upstream(`Cannot connect to system '${name}': ${err.message}`);
    }
    clients.set(name, c);
    return c;
  }

  return {
    bound: () => Object.keys(bindings),
    has: (capRef) => Boolean(bindings[capRef]),
    async invoke(capRef, input) {
      const b = bindings[capRef];
      const c = await client(b.server);
      const result = await c.callTool({ name: b.tool, arguments: applyTemplate(b.args, input) ?? {} });
      return parseToolResult(result);
    },
    async close() {
      for (const c of clients.values()) await c.close().catch(() => {});
      clients.clear();
    },
  };
}

# PaC Process Agent

[![CI](https://github.com/ProcessAsCode/process-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/ProcessAsCode/process-agent/actions/workflows/ci.yml)

A governed AI agent that executes [UAPF](https://github.com/UAPFormat/UAPF-specification) process packages. It acts as a **UAPF-IP host**: it starts sessions in a process runtime, and the runtime calls back into the agent for every service and user task. Part of the [Process-as-Code](https://github.com/ProcessAsCode) stack.

The agent contains **no process logic**. What happens, in which order and under which rules is defined in the UAPF package (BPMN, DMN, guardrails) that the runtime executes. The agent supplies capabilities — AI, human tasks, events, access to systems — and enforces the session guardrails on each of them.

```
 chat front-end / other agents ──MCP──▶ ┌──────────── process-agent ────────────┐
 people / systems ─────────HTTP───────▶ │ planner   memory   guardrails          │
                                        │                                        │
       UAPF-IP runtime ◀── start ─────  │ process connector  (UAPF-IP REST)      │
       (uapf-engine)   ── callback ──▶  │ host surface: ai.*  task.*  event.*    │
                                        │ systems connector  (MCP → IT systems)  │──▶ DMS, contracts, ERP …
                                        │ trust connector    (hash-chained log)  │──▶ event signer
                                        └──────────────┬─────────────────────────┘
                                                       ▼
                                              LLM gateway ──▶ any model
```

## Capabilities

| Capability (UAPF-IP v0.1) | Served by |
|---|---|
| `ai.complete@1`, `ai.classify@1`, `ai.extract@1`, `ai.redact@1` | LLM gateway, with guardrails |
| `task.assign@1`, `task.complete@1`, `task.escalate@1`, `task.reassign@1` | the agent's human-task queue |
| `task.request@1` | same as `task.assign@1` (the reference engine's default for BPMN user tasks) |
| `event.emit@1` | trust connector |
| `data.*`, `document.*` | MCP tools of your systems, through configured bindings |

Only capabilities that can actually be served are advertised in the host manifest. `data.*` and `document.*` appear only when a binding exists.

## Guardrails enforced

The guardrails snapshot sent with each invocation is applied before any model is called:

- `ai.allowed_models`: the model is resolved against the allowlist.
- `ai.forbidden_inputs`: any listed field anywhere in the input rejects the call (`policy_violation`).
- `ai.pii_redactor: required`: e-mail addresses, national ID numbers, IBANs and phone numbers are redacted before the text leaves the agent; `redactionsApplied` reports what was removed.
- Violations are returned as RFC 7807 `policy-violation` problems and recorded in the audit log.

## Quick start

```bash
npm ci
cp config/agent.example.yaml config/agent.yaml   # set engine, LLM gateway, systems
export AGENT_API_TOKEN=$(openssl rand -hex 32)
npm start                                        # listens on :4100
```

Run a published process:

```bash
curl -H "Authorization: Bearer $AGENT_API_TOKEN" http://localhost:4100/agent/processes
curl -H "Authorization: Bearer $AGENT_API_TOKEN" -H "Content-Type: application/json" \
     http://localhost:4100/agent/runs \
     -d '{"packageId":"…","processId":"…","input":{…}}'
```

Ask the planner which process fits a request (nothing is started):

```bash
curl -H "Authorization: Bearer $AGENT_API_TOKEN" -H "Content-Type: application/json" \
     http://localhost:4100/agent/plan -d '{"goal":"Register this incoming letter and route it"}'
```

### MCP

`src/mcp.js` exposes the agent to MCP clients over stdio, with the tools `list_processes`, `plan_process`, `start_process`, `get_run`, `list_tasks`, `complete_task` and `verify_audit`:

```json
{ "command": "node", "args": ["src/mcp.js"],
  "env": { "AGENT_URL": "http://localhost:4100", "AGENT_API_TOKEN": "…" } }
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /uapf/host/manifest` | host capability manifest (UAPF-IP) |
| `POST /uapf/host/capability/{namespace}/{operation}` | capability invocation from the runtime (UAPF-IP) |
| `POST /uapf/host/audit` | runtime audit events (CloudEvents), appended to the audit chain |
| `GET /agent/processes` | runnable processes in the runtime |
| `POST /agent/plan` | proposal: which process, which input |
| `POST /agent/runs`, `GET /agent/runs[/{runId}]` | start and inspect runs |
| `GET /agent/tasks[?state=open]`, `POST /agent/tasks/{id}/complete` | human tasks |
| `GET /agent/audit/verify` | verify the audit hash chain, event-signer status |
| `GET /health` | liveness |

`/agent/*` always requires `AGENT_API_TOKEN`. `/uapf/host/*` requires `AGENT_HOST_TOKEN` when it is set.

## Audit trail

Every capability invocation, policy violation and runtime event is appended to `data/audit.jsonl`. Each entry carries the hash of the previous one, so any later change breaks the chain; `GET /agent/audit/verify` checks it.

## Current limits

- **Per-event signatures.** UAPF-IP §7 asks for a DID/VC signature on every event. Entries are written with `signature: null` until the event signer offers a generic event-signing endpoint; the hash chain is already in place.
- **Credentials on the wire.** The REST binding expects VC-JWT bearer credentials. This version uses shared bearer tokens; VC-JWT verification is planned.
- **Human tasks.** The reference engine runs a session in one pass and has no signal endpoint yet, so a user task is assigned and the process continues; completing the task records the decision but does not resume a waiting process.
- **Capability versions.** The REST binding carries no version in the path; v1, the only version reserved in UAPF-IP v0.1, is assumed.

## Tests

```bash
npm test
```

Unit tests cover guardrails, redaction, the audit chain, system bindings, task lifecycle and API authentication. The agent has also been run end-to-end against `uapf-engine` with the `opendms-document-intake` example package from UAPF-IP.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

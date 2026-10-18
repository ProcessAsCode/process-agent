// Trust connector: every capability invocation and every engine audit event
// is appended to a hash-chained log (each entry carries the hash of the
// previous one, so any later edit breaks the chain). When an event signer
// is configured, its health and identity are reported alongside.
//
// Per-event DID/VC signatures (UAPF-IP §7 `uapfsignature`) need a generic
// event-signing endpoint in the event signer; until it exists, entries are
// recorded with `signature: null` rather than a placeholder.

import fs from "node:fs";
import crypto from "node:crypto";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function createTrust(cfg) {
  const file = cfg.trust.auditLog;
  let last = { seq: 0, hash: "0".repeat(64) };
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) last = JSON.parse(lines[lines.length - 1]);
  }

  function record({ sessionId, stepId, type, data }) {
    const entry = {
      seq: last.seq + 1,
      at: new Date().toISOString(),
      sessionId: sessionId ?? null,
      stepId: stepId ?? null,
      type,
      dataHash: sha256(canonical(data)),
      prevHash: last.hash,
      signature: null,
    };
    entry.hash = sha256(canonical({ ...entry, hash: undefined }));
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    last = entry;
    return entry;
  }

  function verifyChain() {
    if (!fs.existsSync(file)) return { ok: true, entries: 0 };
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    let prev = "0".repeat(64);
    for (const [i, line] of lines.entries()) {
      const e = JSON.parse(line);
      const expected = sha256(canonical({ ...e, hash: undefined }));
      if (e.prevHash !== prev || e.hash !== expected) return { ok: false, entries: lines.length, brokenAt: i + 1 };
      prev = e.hash;
    }
    return { ok: true, entries: lines.length };
  }

  async function signerStatus() {
    const url = cfg.trust.eventSignerUrl;
    if (!url) return { configured: false };
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(5000) });
      return { configured: true, reachable: res.ok, status: res.status };
    } catch (err) {
      return { configured: true, reachable: false, error: err.message };
    }
  }

  return { record, verifyChain, signerStatus };
}

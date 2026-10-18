// LLM access through an OpenAI-compatible gateway (e.g. an on-premises LLM
// gateway in front of any model). The agent never talks to a model vendor
// directly; which models exist is the gateway's and the guardrails' business.

import { secret } from "./config.js";
import { upstream } from "./problem.js";

export function createLlm(cfg) {
  const base = cfg.llm.baseUrl.replace(/\/$/, "");
  const key = secret(cfg.llm.apiKeyEnv);

  async function chat({ model, messages, maxTokens, temperature, stop, json }) {
    const body = { model, messages };
    if (maxTokens) body.max_tokens = maxTokens;
    if (typeof temperature === "number") body.temperature = temperature;
    if (stop?.length) body.stop = stop;
    if (json) body.response_format = { type: "json_object" };
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.llm.timeoutMs),
      });
    } catch (err) {
      throw upstream(`LLM gateway unreachable: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw upstream(`LLM gateway returned ${res.status}`);
    const text = data?.choices?.[0]?.message?.content ?? "";
    return {
      text,
      modelUsed: data.model || model,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  async function chatJson(args) {
    const r = await chat({ ...args, json: true });
    const raw = r.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return { ...r, json: JSON.parse(raw) };
    } catch {
      throw upstream("LLM gateway returned a non-JSON answer where JSON was required.");
    }
  }

  return { chat, chatJson };
}

// ai.* capabilities (UAPF-IP capabilities/ai.yaml). Every call resolves the
// model against the session guardrails, rejects forbidden inputs and applies
// redaction when the guardrails require it.

import { badInput } from "../problem.js";
import {
  resolveModel,
  assertNoForbiddenInputs,
  prepareModelText,
  redact,
} from "../guardrails.js";

const requireFields = (input, fields, op) => {
  for (const f of fields) {
    if (input?.[f] === undefined || input?.[f] === null || input?.[f] === "") {
      throw badInput(`${op}: required field '${f}' is missing from the process variables.`);
    }
  }
};

export function createAiCapabilities({ cfg, llm }) {
  const model = (g, hint) => resolveModel(g, hint, cfg.llm.defaultModel);

  return {
    "ai.complete@1": async (input, g) => {
      requireFields(input, ["prompt"], "ai.complete");
      assertNoForbiddenInputs(g, input);
      const promptText = typeof input.prompt === "string" ? input.prompt : JSON.stringify(input.prompt);
      const { text, redactionsApplied } = prepareModelText(g, promptText);
      const r = await llm.chat({
        model: model(g, input.modelHint),
        messages: [{ role: "user", content: text }],
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        stop: input.stopSequences,
      });
      return { text: r.text, modelUsed: r.modelUsed, redactionsApplied, usage: r.usage };
    },

    "ai.classify@1": async (input, g) => {
      requireFields(input, ["text", "categories"], "ai.classify");
      assertNoForbiddenInputs(g, input);
      const categories = input.categories.map((c) => (typeof c === "string" ? c : c.id ?? c.name));
      const { text, redactionsApplied } = prepareModelText(g, input.text);
      const r = await llm.chatJson({
        model: model(g, input.modelHint),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Classify the text into the given categories. Answer only with JSON: " +
              '{"predictions":[{"category":"<one of the categories>","confidence":<0..1>}]}. ' +
              (input.multiLabel ? "Several categories may apply." : "Return exactly one prediction."),
          },
          { role: "user", content: `Categories: ${JSON.stringify(categories)}\n\nText:\n${text}` },
        ],
      });
      const predictions = (r.json.predictions || [])
        .filter((p) => categories.includes(p.category))
        .map((p) => ({ category: p.category, confidence: Number(p.confidence) || 0 }));
      const top = [...predictions].sort((a, b) => b.confidence - a.confidence)[0];
      return {
        predictions,
        // Convenience for single-label routing in BPMN/DMN; not part of the
        // required output and always equal to the highest-confidence prediction.
        topCategory: top ? top.category : null,
        topConfidence: top ? top.confidence : null,
        modelUsed: r.modelUsed,
        redactionsApplied,
      };
    },

    "ai.extract@1": async (input, g) => {
      requireFields(input, ["text", "schema"], "ai.extract");
      assertNoForbiddenInputs(g, input);
      const { text, redactionsApplied } = prepareModelText(g, input.text);
      const r = await llm.chatJson({
        model: model(g, input.modelHint),
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Extract data from the text according to the JSON Schema. Answer only with JSON: " +
              '{"extracted":{...},"confidence":<0..1>}. Use null for values not present in the text.',
          },
          { role: "user", content: `Schema:\n${JSON.stringify(input.schema)}\n\nText:\n${text}` },
        ],
      });
      return {
        extracted: r.json.extracted ?? {},
        confidence: typeof r.json.confidence === "number" ? r.json.confidence : undefined,
        modelUsed: r.modelUsed,
        redactionsApplied,
      };
    },

    "ai.redact@1": async (input) => {
      requireFields(input, ["text"], "ai.redact");
      return redact(input.text, input.categories);
    },
  };
}

// Guardrail enforcement on the host side (UAPF-IP §10: guardrails MUST be
// enforced by both ends). The policy snapshot travels with every capability
// invocation; this module only interprets it — it never adds business rules.
//
// Supported keys (as used in the UAPF-IP examples):
//   ai.allowed_models            list of model ids the session may use
//   ai.forbidden_inputs          field names that must never reach a model
//   ai.pii_redactor: required    redact text before any model invocation
//   ai.max_confidence_for_autocomplete   below this, results are flagged for review
//   human_oversight.required_for list of step or decision ids that need a human

import { policyViolation } from "./problem.js";

const PATTERNS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  iban: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
  national_id: /\b\d{6}-?\d{5}\b/g,
  phone: /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)?\d{3}[\s-]?\d{2,4}[\s-]?\d{2,4}\b/g,
};

export function redact(text, categories) {
  const cats = categories && categories.length ? categories : Object.keys(PATTERNS);
  let out = String(text ?? "");
  const detections = [];
  for (const cat of cats) {
    const re = PATTERNS[cat];
    if (!re) continue;
    out = out.replace(re, (m) => {
      detections.push({ category: cat, length: m.length });
      return `[${cat.toUpperCase()}]`;
    });
  }
  return { redactedText: out, detections };
}

export function resolveModel(guardrails, hint, fallback) {
  const allowed = guardrails?.ai?.allowed_models;
  const wanted = hint || fallback;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    if (!wanted) throw policyViolation("No model configured and none allowed by guardrails.");
    return wanted;
  }
  if (wanted && allowed.includes(wanted)) return wanted;
  // UAPF-IP ai.*: the host MUST resolve against the allowlist and MAY substitute an equivalent.
  return allowed[0];
}

function findForbidden(value, forbidden, trail = []) {
  if (!value || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (forbidden.includes(k)) return [...trail, k].join(".");
    const hit = findForbidden(v, forbidden, [...trail, k]);
    if (hit) return hit;
  }
  return null;
}

export function assertNoForbiddenInputs(guardrails, input) {
  const forbidden = guardrails?.ai?.forbidden_inputs;
  if (!Array.isArray(forbidden) || forbidden.length === 0) return;
  const hit = findForbidden(input, forbidden);
  if (hit) throw policyViolation(`Input field '${hit}' is forbidden for AI invocation by the session guardrails.`);
}

export function redactionRequired(guardrails) {
  return guardrails?.ai?.pii_redactor === "required";
}

export function prepareModelText(guardrails, text) {
  if (!redactionRequired(guardrails)) return { text: String(text ?? ""), redactionsApplied: [] };
  const { redactedText, detections } = redact(text);
  return { text: redactedText, redactionsApplied: [...new Set(detections.map((d) => d.category))] };
}

export function needsHumanReview(guardrails, stepId, confidence) {
  const required = guardrails?.human_oversight?.required_for;
  if (Array.isArray(required) && required.includes(stepId)) return true;
  const floor = guardrails?.ai?.max_confidence_for_autocomplete;
  return typeof floor === "number" && typeof confidence === "number" && confidence < floor;
}

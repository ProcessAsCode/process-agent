// RFC 7807 problem+json errors with UAPF-IP extensions (UAPF-IP REST binding).

export class Problem extends Error {
  constructor(status, slug, title, detail, extra = {}) {
    super(detail || title);
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }

  toJSON() {
    return {
      type: `https://uapf.dev/errors/${this.slug}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      ...this.extra,
    };
  }
}

export const badInput = (detail, extra) =>
  new Problem(400, "schema-validation-failed", "Input validation failed", detail, extra);

export const notAvailable = (capability, extra = {}) =>
  new Problem(422, "capability-not-available", "Capability not available",
    `Host does not implement ${capability}`, { "uapf:capability": capability, ...extra });

export const policyViolation = (detail, extra) =>
  new Problem(422, "policy-violation", "Guardrail violation", detail, extra);

export const unauthorized = () =>
  new Problem(401, "unauthorized", "Missing or invalid credential", "A valid bearer token is required.");

export const notFound = (detail) => new Problem(404, "not-found", "Not found", detail);

export const upstream = (detail) => new Problem(503, "capability-unavailable", "Capability temporarily unavailable", detail);

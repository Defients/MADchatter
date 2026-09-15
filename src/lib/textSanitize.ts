/**
 * Em-dashes (—) are banned from all user-facing AI output — Forge suggestion
 * cards, AutoForge action payloads/reasons, refined messages, briefings.
 * They read as machine-polished rather than human-typed chat. Replaced with a
 * plain hyphen, preserving whatever spacing surrounded the em-dash.
 */
export function stripEmDashes(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(/—/g, "-");
}

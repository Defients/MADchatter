/**
 * Em-dashes (—) are banned from all user-facing AI output — Forge suggestion
 * cards, AutoForge action payloads/reasons, refined messages, briefings.
 * They read as machine-polished rather than human-typed chat. Replaced with
 * " - " (spaces on either side), collapsing any surrounding whitespace so the
 * result is always a single-spaced hyphen regardless of the original spacing.
 */
export function stripEmDashes(text: string): string {
  if (!text || typeof text !== "string") return text;
  return text.replace(/\s*—\s*/g, " - ").trim();
}

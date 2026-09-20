export type ConfidenceThresholdLevel = "aggressive" | "active" | "balanced" | "cautious" | "strict";

export interface ConfidenceThresholdDescription {
  level: ConfidenceThresholdLevel;
  label: Uppercase<ConfidenceThresholdLevel>;
  color: string;
}

export function describeConfidenceThreshold(value: number): ConfidenceThresholdDescription {
  const percent = Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5)) * 100);
  if (percent <= 39) return { level: "aggressive", label: "AGGRESSIVE", color: "#fb7185" };
  if (percent <= 59) return { level: "active", label: "ACTIVE", color: "#fb923c" };
  if (percent <= 74) return { level: "balanced", label: "BALANCED", color: "#34d399" };
  if (percent <= 89) return { level: "cautious", label: "CAUTIOUS", color: "#38bdf8" };
  return { level: "strict", label: "STRICT", color: "#a78bfa" };
}

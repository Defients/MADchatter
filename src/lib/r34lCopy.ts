import type { R34lLearningState } from "./r34lLearning";

export function r34lStateLabel(state: R34lLearningState, enabled: boolean, connected: boolean, frozen = false): string {
  if (!connected) return "No channel connected — nothing is being learned";
  if (frozen) {
    if (state === "unlearned") return "Frozen — no learning yet for this channel; nothing is collected";
    return enabled
      ? "Frozen — learned style still applies; nothing new is collected or changed"
      : "Frozen — learned style preserved (not applied while R34L is off); nothing new is collected";
  }
  if (!enabled) {
    if (state === "unlearned") return "R34L off — no learning is collected; no learned style yet";
    if (state === "aging") return "R34L off — learned style preserved (aging), not applied or updated";
    return "R34L off — learned style preserved, not applied or updated";
  }
  if (state === "unlearned") return "No learning yet for this channel";
  if (state === "collecting") return "Still learning — too little evidence to adapt confidently";
  if (state === "aging") return "Using saved channel style (evidence is aging)";
  return state === "established" ? "Established profile active" : "Learned profile active";
}

export function r34lDesktopShortcutHint(frozen: boolean, showDesktopShortcutHint: boolean): string | null {
  return frozen && showDesktopShortcutHint
    ? "Ctrl+click the R34L button to resume learning."
    : null;
}

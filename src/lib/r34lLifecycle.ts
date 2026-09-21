import type { R34lView } from "./r34lLearning";

export interface R34lPlateauSnapshot {
  channelKey: string;
  fingerprint: string;
  recentMessagesAtStart: number;
}

export interface R34lPlateauResult {
  snapshot: R34lPlateauSnapshot | null;
  suggestFrozen: boolean;
}

export const R34L_PLATEAU_EVIDENCE_WINDOW = 18;

/** Canonical applied output—not raw counters—is the stability identity. */
export function r34lAppliedFingerprint(view: R34lView): string {
  const traits = view.statements
    .filter((statement) => statement.applied)
    .map((statement) => `${statement.family}:${statement.band}:${statement.text}`)
    .sort();
  const emotes = view.emotes
    .filter((emote) => emote.band !== "collecting" && emote.usable === "yes")
    .map((emote) => `${emote.name}:${emote.band}:${emote.patterns.slice().sort().join(",")}`)
    .sort();
  return [...traits, ...emotes].join("|");
}

export function r34lStyleReady(view: R34lView): boolean {
  return (view.state === "usable" || view.state === "established") &&
    view.appliedCount > 0 && r34lAppliedFingerprint(view).length > 0;
}

/**
 * Bounded plateau suggestion. The profile must already be established, must
 * have applied traits, and must receive a meaningful window of new eligible
 * evidence while the canonical applied fingerprint stays unchanged.
 */
export function advanceR34lPlateau(
  previous: R34lPlateauSnapshot | null,
  view: R34lView,
): R34lPlateauResult {
  const fingerprint = r34lAppliedFingerprint(view);
  if (view.state !== "established" || view.appliedCount === 0 || !fingerprint) {
    return { snapshot: null, suggestFrozen: false };
  }
  if (!previous || previous.channelKey !== view.channelKey || previous.fingerprint !== fingerprint) {
    return {
      snapshot: { channelKey: view.channelKey, fingerprint, recentMessagesAtStart: view.recentMessages },
      suggestFrozen: false,
    };
  }
  return {
    snapshot: previous,
    suggestFrozen: view.recentMessages - previous.recentMessagesAtStart >= R34L_PLATEAU_EVIDENCE_WINDOW,
  };
}

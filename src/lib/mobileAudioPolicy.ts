export type MobileAudioCue =
  | "attention_mention"
  | "error"
  | "send_complete"
  | "major_action"
  | "navigation"
  | "setting_select"
  | "slider_commit";

const PRIORITY: Record<MobileAudioCue, number> = {
  attention_mention: 7,
  error: 6,
  send_complete: 5,
  major_action: 4,
  navigation: 3,
  setting_select: 2,
  slider_commit: 1,
};

export function mobileAudioPriority(cue: MobileAudioCue): number {
  return PRIORITY[cue];
}

/** Functional attention audio ignores the optional-SFX preference. */
export function mobileAudioCueAllowed(cue: MobileAudioCue, sfxEnabled: boolean): boolean {
  return cue === "attention_mention" || sfxEnabled;
}

export function shouldSuppressLowerPriorityCue(
  incoming: MobileAudioCue,
  active: { cue: MobileAudioCue; until: number } | null,
  now = Date.now(),
): boolean {
  return !!active && active.until > now && mobileAudioPriority(active.cue) > mobileAudioPriority(incoming);
}

/** Slider audio is a release/commit cue, never a per-pixel input cue. */
export function shouldPlaySliderCommit(changedDuringGesture: boolean): boolean {
  return changedDuringGesture;
}

export async function attemptAttentionPlayback(deps: {
  playMedia: () => Promise<boolean>;
  playFallback: () => void;
}): Promise<"media" | "fallback"> {
  try {
    if (await deps.playMedia()) return "media";
  } catch {
    // Expected on autoplay-restricted browsers.
  }
  try { deps.playFallback(); } catch { /* audio never blocks the event */ }
  return "fallback";
}

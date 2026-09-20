/**
 * R34L Adaptation Resolver — the single chokepoint that turns per-channel
 * learning into the effective adaptation context used by EVERY generation
 * path (manual Forge, AutoForge decide, AutoForge full_forge, per-bot
 * AutoForge, Smart Replies, Refine) AND by the R34L learning readout UI.
 *
 * Same resolved evidence powers both: the tooltip can never look impressive
 * while generation uses unrelated defaults.
 *
 * This module is store-bound (reads useAppStore + the emote cache). The pure
 * learning math lives in r34lLearning.ts; this file only gathers inputs.
 */

import { useAppStore } from "../store";
import { getAvailableEmoteNames, getCachedChannelEmotes } from "./emotes";
import {
  deriveR34lView,
  formatR34lPromptBlock,
  r34lProfileKey,
  type R34lView,
} from "./r34lLearning";

export interface R34lAdaptation {
  /** The full derived view (statements, emotes, evidence counts, notes). */
  view: R34lView;
  /** The bounded prompt block. Empty when R34L is off, no channel is
   *  connected, or evidence is still collecting (the restrained baseline
   *  texture in R34L_TYPING_PROMPT applies instead). */
  promptBlock: string;
  /** true when the prompt block is non-empty and R34L is enabled. */
  applied: boolean;
}

/**
 * Emote recognition set for INGESTION (App.tsx → noteR34lObservation).
 * Returns the channel's known emote names (extension cache) for textual
 * matching, plus whether any metadata existed — when the cache is cold or
 * awareness is off, emote learning degrades honestly while all other traits
 * keep learning.
 */
export function getR34lRecognitionSet(channelName: string): {
  known: ReadonlySet<string>;
  metadataAvailable: boolean;
} {
  const state = useAppStore.getState();
  if (!state.emoteAwarenessEnabled || !channelName) {
    return { known: new Set(), metadataAvailable: false };
  }
  const map = getCachedChannelEmotes(channelName);
  if (!map || map.size === 0) return { known: new Set(), metadataAvailable: false };
  return { known: new Set(map.keys()), metadataAvailable: true };
}

/**
 * Resolve the effective R34L adaptation for the CURRENT channel. Combines:
 * active channel identity (platform + normalized name), retained learning,
 * the fresh session overlay, per-feature confidence/age, and the selected
 * sending identity's known emote capabilities (the extension-cache set —
 * BTTV/7TV/FFZ names are plain text any account can send; platform-native or
 * subscriber emotes stay honestly "unknown").
 *
 * Personality, operator settings, and content constraints are NOT inputs here
 * — they live in the surrounding prompts and always outrank this advisory
 * block by prompt construction.
 */
export function resolveCurrentR34lAdaptation(now: number = Date.now()): R34lAdaptation {
  const state = useAppStore.getState();
  const channel = state.streamMetadata.channelName;
  const platform = state.platform;
  const key = r34lProfileKey(platform, channel);

  const baseline = state.r34lProfiles[key] ?? null;
  const overlay = state.r34lSessionProfile && state.r34lSessionProfile.key === key
    ? state.r34lSessionProfile
    : null;

  // Known-usable emote set for the sending bot(s). Emote awareness off →
  // capability unknown (honest), not "none".
  const usableEmotes = state.emoteAwarenessEnabled && channel
    ? new Set(getAvailableEmoteNames(channel, 500))
    : null;

  const view = deriveR34lView({
    baseline,
    overlay,
    channelKey: key,
    usableEmotes,
    now,
  });

  // R34L OFF → adaptation stops applying immediately; learning is preserved.
  if (!state.r34lEnabled || !channel.trim()) {
    return { view, promptBlock: "", applied: false };
  }
  const promptBlock = formatR34lPromptBlock(view);
  return { view, promptBlock, applied: promptBlock.length > 0 };
}

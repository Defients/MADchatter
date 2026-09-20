import {
  attemptAttentionPlayback,
  mobileAudioCueAllowed,
  mobileAudioPriority,
  shouldPlaySliderCommit,
  shouldSuppressLowerPriorityCue,
} from "./mobileAudioPolicy";

let passed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  passed++;
}

assert(mobileAudioCueAllowed("attention_mention", true), "mention alert plays with optional SFX on");
assert(mobileAudioCueAllowed("attention_mention", false), "mention alert still plays with optional SFX off");
assert(!mobileAudioCueAllowed("setting_select", false), "settings audio is muted with optional SFX off");
assert(mobileAudioCueAllowed("setting_select", true), "settings audio is allowed with optional SFX on");
assert(mobileAudioPriority("attention_mention") > mobileAudioPriority("error"), "mention outranks errors");
assert(mobileAudioPriority("navigation") > mobileAudioPriority("setting_select"), "tab and setting cues are distinct priorities");
assert(shouldSuppressLowerPriorityCue("setting_select", { cue: "attention_mention", until: 200 }, 100), "active mention suppresses a setting cue");
assert(!shouldSuppressLowerPriorityCue("error", { cue: "setting_select", until: 200 }, 100), "important error is not suppressed by a setting cue");
assert(!shouldPlaySliderCommit(false), "slider does not sound when no committed change occurred");
assert(shouldPlaySliderCommit(true), "slider may sound once on commit");

let fallbackCalls = 0;
const fallbackResult = await attemptAttentionPlayback({
  playMedia: async () => { throw new Error("autoplay blocked"); },
  playFallback: () => { fallbackCalls++; },
});
assert(fallbackResult === "fallback" && fallbackCalls === 1, "media rejection falls back exactly once");

const failureResult = await attemptAttentionPlayback({
  playMedia: async () => false,
  playFallback: () => { throw new Error("audio device unavailable"); },
});
assert(failureResult === "fallback", "total playback failure is contained");

console.log(`${passed}/${passed} mobile-audio-policy scenarios passed`);

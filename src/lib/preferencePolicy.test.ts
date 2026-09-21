import assert from "node:assert/strict";
import { mergePersistedAppState, useAppStore } from "../store";
import { mobileAudioCueAllowed } from "./mobileAudioPolicy";
import { resolveSfxEvent } from "./sfx";

const fresh = useAppStore.getState();
assert.equal(fresh.smartRepliesEnabled, true, "fresh Smart Replies default ON");
assert.equal(mergePersistedAppState({ smartRepliesEnabled: false }, fresh).smartRepliesEnabled, false, "persisted explicit false stays OFF");
assert.equal(mergePersistedAppState({ smartRepliesEnabled: true }, fresh).smartRepliesEnabled, true, "persisted explicit true stays ON");
assert.equal(mergePersistedAppState({}, fresh).smartRepliesEnabled, false, "legacy payload without preference is not silently opted in");

useAppStore.setState({ ttsEnabled: false, ttsBackgroundEnabled: true });
const normalized = mergePersistedAppState({ ttsEnabled: false, ttsBackgroundEnabled: true }, useAppStore.getState());
assert.equal(normalized.ttsBackgroundEnabled, false, "invalid persisted Background TTS state normalizes OFF");
useAppStore.getState().setTtsEnabled(false);
assert.equal(useAppStore.getState().ttsBackgroundEnabled, false, "turning TTS OFF immediately forces Background TTS OFF");
useAppStore.getState().setTtsBackgroundEnabled(true);
assert.equal(useAppStore.getState().ttsBackgroundEnabled, false, "Background TTS cannot enable while TTS is OFF");
assert(mobileAudioCueAllowed("attention_mention", false), "direct mention alert ignores optional SFX preference");

for (const sfxEnabled of [false, true]) {
  for (const ttsEnabled of [false, true]) {
    useAppStore.setState({ sfxEnabled, ttsEnabled, ttsBackgroundEnabled: false });
    assert.equal(mobileAudioCueAllowed("setting_select", sfxEnabled), sfxEnabled, `optional SFX follows preference for ${sfxEnabled}/${ttsEnabled}`);
    assert.equal(useAppStore.getState().ttsEnabled, ttsEnabled, `TTS follows its independent preference for ${sfxEnabled}/${ttsEnabled}`);
    assert.equal(mobileAudioCueAllowed("attention_mention", sfxEnabled), true, `mention attention remains eligible for ${sfxEnabled}/${ttsEnabled}`);
  }
}

const semanticRoutes = ["navigation", "setting_toggle", "channel_set", "send_message", "drawer_open", "drawer_close", "history_open", "destructive_clear", "error"] as const;
assert.equal(new Set(semanticRoutes.map(resolveSfxEvent)).size, semanticRoutes.length, "semantic Mobile SFX categories route distinctly");

useAppStore.getState().setSmartRepliesEnabled(false);
const exported = useAppStore.getState().exportSettings();
useAppStore.getState().setSmartRepliesEnabled(true);
assert(useAppStore.getState().importSettings(exported));
assert.equal(useAppStore.getState().smartRepliesEnabled, false, "Smart Reply preference survives export/import");

console.log("Fresh/persisted preference and audio-policy scenarios passed");

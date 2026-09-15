import { useAppStore } from "../store";
import { messageQueue } from "./messageQueue";
import { clearTwitchMessageIdCache } from "./twitchReplyCache";
import { setThreadChannel } from "./conversationThread";

/**
 * Switch to a different channel with a full session reset.
 *
 * Non-destructive channel switch:
 * 1) Save the current channel's session (LTM, memory, AutoForge report,
 *    analytics, per-bot runtime) to channelStore
 * 2) Wipe all session-scoped state so nothing residual leaks into the new
 *    channel's prompts, report, or dashboard
 * 3) Update stream metadata (triggers useAutoMemory to reload auto-memory)
 * 4) Restore the target channel's session from channelStore
 *
 * Shared by Core mode (CoreWorkspace) and Studio mode (ForgeLayout) so both
 * reset components identically when the channel changes.
 *
 * @param trimmed The new channel name (no leading @ or #).
 * @returns true if the switch happened, false if it was a no-op (same channel).
 */
export async function switchChannel(trimmed: string): Promise<boolean> {
  const store = useAppStore.getState();
  const currentName = store.streamMetadata?.channelName || "";

  if (trimmed.toLowerCase() === currentName.toLowerCase()) {
    // Same channel (case-insensitive) — nothing to do
    return false;
  }

  try {
    if (currentName) {
      await store.saveCurrentChannelSnapshot();
    }
    store.clearAllContext();
    clearTwitchMessageIdCache();
    setThreadChannel(trimmed.toLowerCase());
    store.setVariants([]);
    // Queued retries carry the old channel name — sending one would
    // reconnect the client back to the previous streamer.
    messageQueue.clear();
    store.updateStreamMetadata({ channelName: trimmed });
    await store.restoreChannelSnapshot(trimmed.toLowerCase());
  } catch (e) {
    console.error("[channelSwitch] Failed to switch channel:", e);
    // Still update the channel name even if snapshot restore fails
    store.updateStreamMetadata({ channelName: trimmed });
  }
  return true;
}

import { useAppStore } from "../store";
import { messageQueue } from "./messageQueue";
import { clearTwitchMessageIdCache } from "./twitchReplyCache";
import { setThreadChannel } from "./conversationThread";
import { captureSessionScope, isSessionScopeCurrent } from "./sessionScope";

let switching = false;

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
 * @throws If the current session cannot be archived, or a switch is already pending.
 */
export async function switchChannel(trimmed: string): Promise<boolean> {
  // A second switch must not archive a target whose restore is still pending.
  if (switching) throw new Error("A channel switch is already in progress. Please wait.");
  const store = useAppStore.getState();
  const currentName = store.streamMetadata?.channelName || "";

  if (trimmed.toLowerCase() === currentName.toLowerCase()) {
    // Same channel (case-insensitive) — nothing to do
    return false;
  }

  const scope = captureSessionScope();
  switching = true;
  try {
    if (currentName) {
      try {
        await store.saveCurrentChannelSnapshot();
      } catch (error) {
        console.error("[channelSwitch] Could not archive current session:", error);
        throw new Error("Could not save the current channel. Your session is unchanged; try again.");
      }
    }
    // Platform changes or context resets during IndexedDB work invalidate the request.
    if (!isSessionScopeCurrent(scope)) throw new Error("The session changed while saving. Please select the channel again.");
    store.clearAllContext();
    clearTwitchMessageIdCache();
    setThreadChannel(trimmed.toLowerCase());
    store.setVariants([]);
    // Queued retries carry the old channel name — sending one would
    // reconnect the client back to the previous streamer.
    messageQueue.clear();
    store.updateStreamMetadata({ channelName: trimmed });
    const targetScope = captureSessionScope();
    try {
      await store.restoreChannelSnapshot(trimmed.toLowerCase());
    } catch (error) {
      // The prior session is safely archived. Keep the clean target session;
      // never overwrite a newer channel/platform selection after an async failure.
      console.error("[channelSwitch] Could not restore channel snapshot:", error);
    }
    if (!isSessionScopeCurrent(targetScope)) throw new Error("The session changed while restoring. Please select the channel again.");
    return true;
  } finally {
    switching = false;
  }
}

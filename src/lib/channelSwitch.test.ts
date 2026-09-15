// Run: node scripts/check-channel-switch.mjs (isolates browser delivery adapters).
import assert from "node:assert/strict";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });

const { useAppStore } = await import("../store");
const { switchChannel } = await import("./channelSwitch");
const { messageQueue } = await import("./messageQueue");
const { recordTwitchMessageId, getTwitchMessageId } = await import("./twitchReplyCache");
const original = useAppStore.getState();
let passed = 0;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function reset() {
  useAppStore.setState(original, true);
  useAppStore.getState().updateStreamMetadata({ channelName: "old" });
  useAppStore.setState({ longTermMemory: "old channel memory", saveCurrentChannelSnapshot: async () => {}, restoreChannelSnapshot: async () => {} });
  messageQueue.clear();
  messageQueue.enqueue("queued old message", "old", "twitch");
  recordTwitchMessageId("viewer", "old-message-id");
}
try {
  reset();
  const before = useAppStore.getState();
  useAppStore.setState({ saveCurrentChannelSnapshot: async () => { throw new Error("storage unavailable"); } });
  await assert.rejects(switchChannel("new"), /Could not save the current channel/);
  assert.equal(useAppStore.getState().streamMetadata.channelName, "old");
  assert.equal(useAppStore.getState().longTermMemory, "old channel memory");
  assert.equal(useAppStore.getState().sessionRevision, before.sessionRevision);
  assert.equal(messageQueue.getDepth(), 1);
  assert.equal(getTwitchMessageId("viewer"), "old-message-id");
  passed++;

  // Failure releases the lock, allowing a safe retry; reset happens before restore.
  useAppStore.setState({ saveCurrentChannelSnapshot: async () => {}, restoreChannelSnapshot: async (channel) => {
    assert.equal(channel, "new");
    assert.equal(useAppStore.getState().longTermMemory, "");
    assert.equal(messageQueue.getDepth(), 0);
    assert.equal(getTwitchMessageId("viewer"), null);
    useAppStore.setState({ longTermMemory: "restored new memory" });
  } });
  assert.equal(await switchChannel("new"), true);
  assert.equal(useAppStore.getState().longTermMemory, "restored new memory");
  assert.equal(await switchChannel("NEW"), false);
  passed++;

  reset();
  const saving = deferred();
  useAppStore.setState({ saveCurrentChannelSnapshot: () => saving.promise });
  const first = switchChannel("new");
  await assert.rejects(switchChannel("other"), /already in progress/);
  saving.resolve();
  assert.equal(await first, true);
  assert.equal(useAppStore.getState().streamMetadata.channelName, "new");
  passed++;

  reset();
  const staleSave = deferred();
  useAppStore.setState({ saveCurrentChannelSnapshot: () => staleSave.promise });
  const stale = switchChannel("new");
  useAppStore.getState().setPlatform("kick");
  staleSave.resolve();
  await assert.rejects(stale, /session changed while saving/);
  assert.equal(useAppStore.getState().streamMetadata.channelName, "old");
  assert.equal(useAppStore.getState().longTermMemory, "old channel memory");
  passed++;

  reset();
  useAppStore.setState({ restoreChannelSnapshot: async () => { throw new Error("restore unavailable"); } });
  assert.equal(await switchChannel("new"), true);
  assert.equal(useAppStore.getState().streamMetadata.channelName, "new");
  assert.equal(useAppStore.getState().longTermMemory, "");
  passed++;

  reset();
  const restoring = deferred();
  useAppStore.setState({ restoreChannelSnapshot: () => restoring.promise });
  const pending = switchChannel("new");
  await Promise.resolve();
  await assert.rejects(switchChannel("other"), /already in progress/);
  useAppStore.getState().updateStreamMetadata({ channelName: "latest" });
  restoring.resolve();
  await assert.rejects(pending, /session changed while restoring/);
  assert.equal(useAppStore.getState().streamMetadata.channelName, "latest");
  passed++;
  console.log(`${passed} channel-switch scenarios passed`);
} finally {
  messageQueue.clear();
  useAppStore.setState(original, true);
}

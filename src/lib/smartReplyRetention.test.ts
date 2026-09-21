import assert from "node:assert/strict";
import type { SmartReplyThread } from "../types";

const storage = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, String(value)),
  removeItem: (key: string) => storage.delete(key),
};
const { useAppStore } = await import("../store");

const thread = (bot: string, message: string, loading: boolean, text = ""): SmartReplyThread => ({
  key: `id:${bot}:mention:${message}`,
  botKey: `id:${bot}`,
  botId: bot,
  botUsername: `Bot${bot.toUpperCase()}`,
  messageId: message,
  receivedAt: message === "a1" ? 1 : 2,
  loading,
  replies: text ? [{ id: `reply-${message}`, text, timestamp: 1, botId: bot, mentionMessageId: message }] : [],
  notice: { state: loading ? "loading" : "ready", messageId: message, username: "viewer", botUsername: `Bot${bot.toUpperCase()}`, text: "mention", receivedAt: 1 },
});

const store = useAppStore.getState();
store.clearSmartReplyThreads();
store.upsertSmartReplyThread(thread("a", "a1", true));
store.upsertSmartReplyThread(thread("b", "b1", true));
assert.equal(useAppStore.getState().smartReplyThreads.length, 2, "Bot A and Bot B request state coexist");
assert.equal(useAppStore.getState().smartRepliesLoading, true, "aggregate loading stays true with multiple requests");

store.upsertSmartReplyThread(thread("b", "b1", false, "B result"));
assert.equal(useAppStore.getState().smartRepliesLoading, true, "Bot B completion cannot clear Bot A loading");
store.upsertSmartReplyThread(thread("a", "a1", false, "A result"), false);
assert.equal(useAppStore.getState().smartRepliesLoading, false, "aggregate loading clears after every request completes");
assert.equal(useAppStore.getState().smartReplyThreads.length, 2, "both completed result sets remain retained");

store.focusSmartReplyThread("id:a:mention:a1");
assert.equal(useAppStore.getState().smartReplies[0]?.text, "A result", "focus projects Bot A into the compatibility surface");
store.focusSmartReplyThread("id:b:mention:b1");
assert.equal(useAppStore.getState().smartReplies[0]?.text, "B result", "focus changes do not delete Bot A");
assert.equal(useAppStore.getState().smartReplyThreads.some((item) => item.botId === "a"), true);
store.dismissSmartReplyThread("id:b:mention:b1");
assert.equal(useAppStore.getState().smartReplyThreads.length, 1, "dismiss removes only the selected bot/mention");
assert.equal(useAppStore.getState().smartReplies[0]?.text, "A result", "remaining result becomes recoverable focus");

console.log("10/10 Smart Reply retention scenarios passed");

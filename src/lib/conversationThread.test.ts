/** Run with: npx tsx --test src/lib/conversationThread.test.ts */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  clearThreadData, formatThreadContext, getActiveThreads, getThreadMessageCount,
  markAsBotMessage, recordBotMessage, recordIncomingMessage, setThreadChannel,
} from "./conversationThread";

const realNow = Date.now;
let now = 1_000_000;
beforeEach(() => {
  clearThreadData();
  now = 1_000_000;
  Date.now = () => now;
});
afterEach(() => {
  Date.now = realNow;
  clearThreadData();
});

test("bot-specific context excludes other marked bots and normalizes casing", () => {
  recordBotMessage("alpha", "AlphaBot", "alpha topic");
  recordBotMessage("beta", "BetaBot", "beta topic");
  recordIncomingMessage("a-reply", "viewer", "hello alpha", "alpha");
  recordIncomingMessage("b-reply", "viewer", "hello beta", "beta");
  assert.deepEqual(getActiveThreads("ALPHABOT").map(t => t.rootId), ["alpha"]);
  assert.equal(getActiveThreads().length, 2);
  assert.equal(formatThreadContext("alphabot").includes("beta topic"), false);
  assert.equal(formatThreadContext("unknownbot"), "");
});

test("unmarked username roots retain direct and transitive replies", () => {
  recordIncomingMessage("root", "AlphaBot", "topic", null);
  now += 10;
  recordIncomingMessage("reply", "viewer", "first", "root");
  now += 10;
  recordIncomingMessage("nested", "viewer2", "second", "reply");
  const [thread] = getActiveThreads("ALPHABOT");
  assert.deepEqual(thread.replies.map(r => r.id), ["reply", "nested"]);
  assert.equal(thread.replyCount, 2);
  assert.equal(getActiveThreads().length, 0);
});

test("incoming bursts stay bounded and evict the oldest root and its marker", () => {
  markAsBotMessage("old"); // Same ordering as App.tsx.
  recordIncomingMessage("old", "bot", "old topic", null);
  for (let i = 0; i < 1_000; i++) {
    recordIncomingMessage(`message-${i}`, "viewer", "chat", null);
    assert.ok(getThreadMessageCount() <= 200);
  }
  recordIncomingMessage("orphan", "viewer", "reply to evicted root", "old");
  assert.deepEqual(getActiveThreads(), []);
  recordIncomingMessage("old", "viewer", "reused ID", null);
  assert.deepEqual(getActiveThreads(), [], "evicted bot marker must not survive");
});

test("outgoing bot bursts also stay bounded", () => {
  for (let i = 0; i < 500; i++) recordBotMessage(`bot-${i}`, "bot", "topic");
  assert.equal(getThreadMessageCount(), 200);
  recordIncomingMessage("reply", "viewer", "hello", "bot-499");
  assert.deepEqual(getActiveThreads().map(t => t.rootId), ["bot-499"]);
});

test("mark-before-record remains supported but orphan markers are bounded", () => {
  for (let i = 0; i < 500; i++) markAsBotMessage(`marked-${i}`);
  recordIncomingMessage("marked-0", "viewer", "old", null);
  recordIncomingMessage("old-reply", "viewer", "hello", "marked-0");
  recordIncomingMessage("marked-499", "bot", "new", null);
  recordIncomingMessage("new-reply", "viewer", "hello", "marked-499");
  assert.deepEqual(getActiveThreads().map(t => t.rootId), ["marked-499"]);
});

test("expiry clears both messages and bot markers without incoming traffic", () => {
  recordBotMessage("root", "bot", "topic");
  recordIncomingMessage("reply", "viewer", "hello", "root");
  now += 10 * 60_000 + 1;
  assert.deepEqual(getActiveThreads(), []);
  assert.equal(getThreadMessageCount(), 0);
  recordIncomingMessage("root", "viewer", "reused ID", null);
  recordIncomingMessage("reply", "viewer", "hello", "root");
  assert.deepEqual(getActiveThreads(), []);
});

test("channel changes clear threads while repeated same-channel reads preserve them", () => {
  setThreadChannel("alpha");
  recordBotMessage("root", "bot", "topic");
  recordIncomingMessage("reply", "viewer", "hello", "root");
  setThreadChannel("alpha");
  assert.equal(getActiveThreads().length, 1);
  setThreadChannel("beta");
  assert.equal(getThreadMessageCount(), 0);
  assert.equal(formatThreadContext(), "");
});

test("broken and cyclic reply chains do not become bot threads", () => {
  recordBotMessage("root", "bot", "topic");
  recordIncomingMessage("broken", "viewer", "hello", "missing");
  recordIncomingMessage("cycle-a", "viewer", "a", "cycle-b");
  recordIncomingMessage("cycle-b", "viewer", "b", "cycle-a");
  assert.deepEqual(getActiveThreads("bot"), []);
});

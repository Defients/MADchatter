import assert from "node:assert/strict";
import { formatSentHistoryForCopy, getSentSourcePresentation, selectMergedSentMessages } from "./sentHistory";
import type { Bot, SentMessage } from "../types";

const global: SentMessage[] = [
  { id: "g1", channel: "room", message: "manual", timestamp: 10, source: "manual" },
  { id: "g2", channel: "room", message: "reply", timestamp: 30, source: "smart_reply" },
];
const bots = [{
  id: "bot-1", label: "Gremlin", session: { username: "gremlinbot" },
  runtime: { sentMessages: [{ id: "b1", channel: "room", message: "auto", timestamp: 20, source: "autoforge" }] },
}] as unknown as Bot[];

const merged = selectMergedSentMessages(global, bots);
assert.deepEqual(merged.map((message) => message.id), ["g2", "b1", "g1"], "global/per-bot history is merged newest-first");
assert.equal(merged[1].botName, "gremlinbot", "per-bot identity is retained");
assert.equal(getSentSourcePresentation("smart_reply").label, "REPLY", "Smart Reply has a concise source label");
assert.equal(getSentSourcePresentation("future_source").label, "FUTURE SOURCE", "unknown future provenance degrades gracefully");
const copy = formatSentHistoryForCopy(merged);
assert.match(copy, /\[REPLY\].*reply/);
assert.match(copy, /\[gremlinbot\].*auto/);
assert.equal(selectMergedSentMessages(global, bots, 2).length, 2, "merged history stays bounded");

console.log("Sent history merge/source/copy scenarios passed");

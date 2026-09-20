import assert from "node:assert/strict";
import type { AutoForgeDecision } from "./ai";
import type { Bot } from "../types";
import {
  mergeAutoForgeDecisionHistory,
  navigateAutoForgeHistory,
  resolveAutoForgeHistorySelection,
} from "./autoForgeHistory";

function decision(timestamp: number, payload: string): AutoForgeDecision {
  return {
    decision: "direct_reaction",
    confidence: 0.8,
    reason: `reason-${timestamp}`,
    estimated_next_action_minutes: 1,
    action_payload: payload,
    timestamp,
  };
}

function bot(id: string, history: AutoForgeDecision[]): Bot {
  return {
    id,
    label: id,
    active: true,
    session: { accessToken: "test", username: id, userId: id },
    runtime: { autoForgeDecisionHistory: history, sentMessages: [] },
  } as unknown as Bot;
}

const legacy = mergeAutoForgeDecisionHistory([decision(10, "one"), decision(20, "two")], []);
let selected = resolveAutoForgeHistorySelection(legacy, null);
assert.equal(selected.entry?.decision.action_payload, "two", "latest is selected by default");
assert.equal(selected.index, 1);

const previousKey = navigateAutoForgeHistory(legacy, selected.index, "previous");
selected = resolveAutoForgeHistorySelection(legacy, previousKey);
assert.equal(selected.entry?.decision.action_payload, "one", "previous navigation selects the older entry");
assert.equal(navigateAutoForgeHistory(legacy, selected.index, "previous"), legacy[0].key, "previous clamps at oldest");
assert.equal(navigateAutoForgeHistory(legacy, selected.index, "next"), null, "next from oldest returns to follow-latest when latest is next");

const botA = bot("a", [decision(30, "a-late"), decision(5, "a-early")]);
const botB = bot("b", [decision(20, "b-middle")]);
const merged = mergeAutoForgeDecisionHistory([], [botA, botB]);
assert.deepEqual(merged.map((entry) => entry.decision.timestamp), [5, 20, 30], "multi-bot history is chronological");
assert.deepEqual(merged.map((entry) => entry.bot?.id), ["a", "b", "a"], "bot identity stays attached to each decision");

const pinnedKey = merged[1].key;
const withNewLatest = mergeAutoForgeDecisionHistory([], [
  bot("a", [decision(30, "a-late"), decision(5, "a-early"), decision(40, "new")]),
  botB,
]);
assert.equal(resolveAutoForgeHistorySelection(withNewLatest, pinnedKey).entry?.decision.action_payload, "b-middle", "new latest decision does not yank an older pinned page");
assert.equal(resolveAutoForgeHistorySelection(withNewLatest, null).entry?.decision.action_payload, "new", "follow-latest advances to a new decision");

console.log("AutoForge decision-history merge, navigation, bounds, and cursor scenarios passed");

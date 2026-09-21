import {
  classifyDirectMentionEvents,
  DirectMentionCoordinator,
  SmartReplyRequestError,
  type DirectMentionCoordinatorDeps,
  type MentionEvent,
} from "./directMention";
import type { SmartReply, SmartReplyNotice } from "../types";

let passed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  passed++;
}

const classified = classifyDirectMentionEvents({
  messageId: "m1",
  username: "viewer123",
  text: "@BotName what do you think?",
  receivedAt: 1,
  channel: "room",
  platform: "twitch",
  sessionRevision: 2,
  targets: [{ botUsername: "BotName" }],
});
assert(classified.length === 1 && classified[0].evidence === "at_mention", "explicit @bot mention is direct");
assert(classifyDirectMentionEvents({
  messageId: "m2", username: "viewer", text: "I saw botname yesterday", receivedAt: 2,
  channel: "room", platform: "twitch", sessionRevision: 2, targets: [{ botUsername: "BotName" }],
}).length === 0, "incidental name occurrence is not a direct attention mention");
assert(classifyDirectMentionEvents({
  messageId: "m3", username: "viewer", text: "what do you think?", receivedAt: 3,
  channel: "room", platform: "twitch", sessionRevision: 2, targets: [{ botUsername: "BotName" }], replyTargetUsername: "botname",
})[0]?.evidence === "platform_reply", "platform reply metadata is direct evidence");

for (const text of ["@BotName", "yo @BotName", "yo,@BotName", "(@BotName)", "hey—@BotName", "well...@BotName?"]) {
  assert(classifyDirectMentionEvents({
    messageId: `boundary-${text}`, username: "viewer", text, receivedAt: 3,
    channel: "room", platform: "twitch", sessionRevision: 2, targets: [{ botUsername: "BotName" }],
  }).length === 1, `punctuation boundary recognized: ${text}`);
}
for (const text of ["hello@botname.com", "@BotNameExtra", "BotName in a sentence"]) {
  assert(classifyDirectMentionEvents({
    messageId: `reject-${text}`, username: "viewer", text, receivedAt: 3,
    channel: "room", platform: "twitch", sessionRevision: 2, targets: [{ botUsername: "BotName" }],
  }).length === 0, `false direct mention rejected: ${text}`);
}

function event(messageId: string): MentionEvent {
  return {
    messageId, botUsername: "BotName", username: "viewer123", text: `@BotName ${messageId}`,
    receivedAt: 10, channel: "room", platform: "twitch", evidence: "at_mention", sessionRevision: 2,
  };
}

function harness(options?: {
  enabled?: boolean;
  generate?: (mention: MentionEvent) => Promise<SmartReply[]>;
  acknowledge?: (mention: MentionEvent) => void | Promise<void>;
}) {
  const state: { loading: boolean; replies: SmartReply[]; notice: SmartReplyNotice | null; current: boolean; acknowledgements: number; generations: number } = {
    loading: false, replies: [], notice: null, current: true, acknowledgements: 0, generations: 0,
  };
  const deps: DirectMentionCoordinatorDeps = {
    now: () => 100,
    acknowledge: async (mention) => {
      state.acknowledgements++;
      await options?.acknowledge?.(mention);
    },
    smartRepliesEnabled: () => options?.enabled ?? true,
    generate: async (mention, _signal) => {
      state.generations++;
      return options?.generate?.(mention) ?? [{ id: `r-${mention.messageId}`, text: "reply", timestamp: 100 }];
    },
    isSessionCurrent: () => state.current,
    setReplies: (replies) => { state.replies = replies; },
    setLoading: (loading) => { state.loading = loading; },
    setNotice: (notice) => { state.notice = notice; },
  };
  return { state, deps };
}

for (const mode of [
  { autoForge: false, autoCheck: false },
  { autoForge: true, autoCheck: false },
  { autoForge: true, autoCheck: true },
]) {
  const coordinator = new DirectMentionCoordinator();
  const { state, deps } = harness();
  const result = await coordinator.handle(event(`mode-${mode.autoForge}-${mode.autoCheck}`), deps);
  assert(result === "ready" && state.acknowledgements === 1 && state.generations === 1, `direct mention is immediate and independent for ${JSON.stringify(mode)}`);
}

{
  const coordinator = new DirectMentionCoordinator();
  const { state, deps } = harness();
  assert(await coordinator.handle(event("dedup"), deps) === "ready", "first message is processed");
  assert(await coordinator.handle(event("dedup"), deps) === "duplicate", "same message is deduped");
  assert(await coordinator.handle(event("unique"), deps) === "ready", "second unique mention is processed without a global cooldown");
  assert(state.acknowledgements === 2 && state.generations === 2, "dedup produces one alert and generation per unique message");
}

{
  let resolveGeneration!: (value: SmartReply[]) => void;
  const deferred = new Promise<SmartReply[]>((resolve) => { resolveGeneration = resolve; });
  const coordinator = new DirectMentionCoordinator();
  const { state, deps } = harness({ generate: () => deferred });
  const pending = coordinator.handle(event("stale"), deps);
  assert(state.loading, "loading begins before provider work completes");
  state.current = false;
  resolveGeneration([{ id: "late", text: "late", timestamp: 1 }]);
  assert(await pending === "stale" && state.replies.length === 0, "session switch discards stale replies");
  assert(!state.loading, "stale completion releases the shared loading state");
}

{
  const coordinator = new DirectMentionCoordinator();
  let resolveFirst!: (value: SmartReply[]) => void;
  let firstAborted = false;
  const first = new Promise<SmartReply[]>((resolve) => { resolveFirst = resolve; });
  const { state, deps } = harness({
    generate: (mention) => mention.messageId === "superseded"
      ? first
      : Promise.resolve([{ id: "new", text: "newest", timestamp: 2 }]),
  });
  const originalGenerate = deps.generate;
  deps.generate = async (mention, signal) => {
    if (mention.messageId === "superseded") signal.addEventListener("abort", () => { firstAborted = true; }, { once: true });
    return originalGenerate(mention, signal);
  };
  const stale = coordinator.handle(event("superseded"), deps);
  const newest = coordinator.handle(event("newest"), deps);
  assert(await newest === "ready" && state.replies[0]?.text === "newest", "newer mention owns the shared reply surface");
  assert(firstAborted, "superseded provider work receives an abort signal");
  resolveFirst([{ id: "old", text: "obsolete", timestamp: 1 }]);
  assert(await stale === "stale" && state.replies[0]?.text === "newest", "superseded completion cannot overwrite newer replies");
}

for (const [reason, expectedState] of [
  ["no_provider", "unavailable"],
  ["trial_exhausted", "unavailable"],
  ["provider_unavailable", "unavailable"],
  ["no_usable_reply", "unavailable"],
  ["generation_failed", "error"],
] as const) {
  const coordinator = new DirectMentionCoordinator();
  const { state, deps } = harness({
    generate: async () => { throw new SmartReplyRequestError(reason, reason === "no_provider" ? "Smart Replies need an AI provider." : "Friend Trial is used up."); },
  });
  await coordinator.handle(event(reason), deps);
  assert(!state.loading && state.notice?.state === expectedState && state.notice.reason === reason, `${reason} clears loading and stays visible`);
}

{
  const coordinator = new DirectMentionCoordinator();
  const { state, deps } = harness();
  for (let i = 0; i < 6; i++) await coordinator.handle(event(`burst-${i}`), deps);
  assert(await coordinator.handle(event("burst-guarded"), deps) === "spam_guard", "bounded spam guard suppresses an excessive burst");
  assert(!state.loading && state.notice?.reason === "spam_guard", "spam guard cannot leave loading stuck");
}

{
  const coordinator = new DirectMentionCoordinator();
  const { state, deps } = harness({ acknowledge: () => { throw new Error("audio failed"); } });
  assert(await coordinator.handle(event("audio-failure"), deps) === "ready", "audio failure does not break mention processing");
  assert(state.generations === 1, "audio failure still permits one Smart Reply attempt");
}

console.log(`${passed}/${passed} direct-mention scenarios passed`);

{
  const coordinator = new DirectMentionCoordinator();
  const pending = new Map<string, (value: SmartReply[]) => void>();
  const aborted: string[] = [];
  const retained = new Map<string, SmartReply[]>();
  let active = 0;
  let now = 10_000;
  const alerts: Array<{ bot: string; alert: boolean }> = [];
  const makeEvent = (botId: string, botUsername: string, messageId: string): MentionEvent => ({
    ...event(messageId), botId, botUsername, text: `@${botUsername} hi`, receivedAt: now,
  });
  const depsFor = (mention: MentionEvent): DirectMentionCoordinatorDeps => ({
    now: () => now,
    acknowledge: (item, alert) => { alerts.push({ bot: item.botId!, alert }); },
    smartRepliesEnabled: () => true,
    generate: (item, signal) => new Promise((resolve) => {
      pending.set(item.messageId, resolve);
      signal.addEventListener("abort", () => aborted.push(item.messageId), { once: true });
    }),
    isSessionCurrent: () => true,
    setReplies: (replies) => retained.set(`${mention.botId}:${mention.messageId}`, replies),
    setLoading: (loading) => { active += loading ? 1 : -1; },
    setNotice: () => {},
  });
  const botA = makeEvent("a", "BotA", "a1");
  const botB = makeEvent("b", "BotB", "b1");
  const aPending = coordinator.handle(botA, depsFor(botA));
  const bPending = coordinator.handle(botB, depsFor(botB));
  assert(!aborted.includes("a1"), "Bot B does not abort Bot A generation");
  pending.get("b1")!([{ id: "rb", text: "B", timestamp: now }]);
  assert(await bPending === "ready", "Bot B completes independently");
  pending.get("a1")!([{ id: "ra", text: "A", timestamp: now }]);
  assert(await aPending === "ready", "Bot A remains independently valid");
  assert(retained.get("a:a1")?.[0]?.text === "A" && retained.get("b:b1")?.[0]?.text === "B", "per-bot results remain retained");
  assert(active === 0, "per-request loading balances after concurrent completion");

  now += 100;
  const a2 = makeEvent("a", "BotA", "a2");
  const first = coordinator.handle(a2, depsFor(a2));
  now += 100;
  const a3 = makeEvent("a", "BotA", "a3");
  const newest = coordinator.handle(a3, depsFor(a3));
  assert(aborted.includes("a2"), "newer Bot A mention supersedes older Bot A work");
  pending.get("a2")!([{ id: "old-a", text: "old", timestamp: now }]);
  assert(await first === "stale", "old Bot A completion is stale");
  pending.get("a3")!([{ id: "new-a", text: "new", timestamp: now }]);
  assert(await newest === "ready" && retained.get("a:a3")?.[0]?.text === "new", "new Bot A completion wins");

  assert(alerts.filter((entry) => entry.bot === "a" && entry.alert).length === 1, "same-bot attention burst coalesces within two seconds");
  assert(alerts.some((entry) => entry.bot === "b" && entry.alert), "different bots keep independent attention windows");
}

console.log(`${passed}/${passed} direct-mention scenarios passed (including multi-bot ownership)`);

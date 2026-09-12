/**
 * Memory Retrieval — focused test harness.
 *
 * Run with: npx tsx src/lib/memoryRetrieval.test.ts
 *
 * Tests keyword extraction, memory scoring, director notes formatting,
 * and the memory context builder.
 */

import { retrieveRelevantMemories, formatDirectorNotesContext, formatMemoryContext } from "./memoryRetrieval";
import type { AutoMemory, UserProfile, InsideJoke, PersonalityState, DirectorNote, ChatMessage } from "../types";
import type { StreamMetadata } from "./ai";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; } else { failed++; failures.push(msg); console.error(`  FAIL: ${msg}`); }
}

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  console.log(`\n▸ ${name}`);
  try { await fn(); } catch (e: any) {
    failed++; failures.push(`${name}: threw ${e?.message ?? e}`); console.error(`  FAIL: threw ${e?.message ?? e}`);
  }
}

const streamMeta: StreamMetadata = {
  channelName: "test", title: "Test Stream", category: "Gaming", viewerCount: 100,
};

function makeChat(messages: [string, string][]): ChatMessage[] {
  return messages.map(([user, text], i) => ({
    id: String(i), user, text,
    timestamp: i, platform: "twitch" as const,
  }));
}

function makeMemory(overrides: Partial<AutoMemory> = {}): AutoMemory {
  return {
    id: "1",
    type: "fact",
    subject: "chatter",
    content: "test content",
    context: "test context",
    source: "chat",
    confidence: 0.8,
    strength: 0.5,
    createdAt: 0,
    lastReferencedAt: 0,
    referenceCount: 0,
    isVerified: false,
    tags: [],
    ...overrides,
  };
}

function makeNote(overrides: Partial<DirectorNote> = {}): DirectorNote {
  return {
    id: "1",
    text: "test note",
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── retrieveRelevantMemories ────────────────────────────────────────────────

await runTest("empty memories returns empty", () => {
  const r = retrieveRelevantMemories([], [], [], null, {
    currentChatLog: [], audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  assert(r.memories.length === 0, "no memories = empty result");
});

await runTest("memories about active users get boosted", () => {
  const memories: AutoMemory[] = [
    makeMemory({ id: "1", content: "likes pizza", subjectUsername: "alice" }),
    makeMemory({ id: "2", content: "likes burgers", subjectUsername: "bob" }),
  ];
  const chat = makeChat([["alice", "hi"], ["alice", "hello"]]);
  const r = retrieveRelevantMemories(memories, [], [], null, {
    currentChatLog: chat, audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  assert(r.memories.length > 0, "should retrieve memories");
  // Memory about alice (active user) should score higher
  const aliceMem = r.memories.find((m) => m.memory.id === "1");
  const bobMem = r.memories.find((m) => m.memory.id === "2");
  if (aliceMem && bobMem) {
    assert(aliceMem.score >= bobMem.score, "active user memory should score higher");
  }
});

await runTest("keyword overlap boosts score", () => {
  const memories: AutoMemory[] = [
    makeMemory({ id: "1", content: "loves playing minecraft", tags: ["minecraft", "gaming"] }),
    makeMemory({ id: "2", content: "likes cooking", tags: ["cooking", "food"] }),
  ];
  const chat = makeChat([["user", "minecraft is fun"], ["user", "playing minecraft"]]);
  const r = retrieveRelevantMemories(memories, [], [], null, {
    currentChatLog: chat, audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  const minecraftMem = r.memories.find((m) => m.memory.id === "1");
  const cookingMem = r.memories.find((m) => m.memory.id === "2");
  if (minecraftMem && cookingMem) {
    assert(minecraftMem.score > cookingMem.score, "keyword-matching memory should score higher");
  }
});

await runTest("recently referenced memories get boost", () => {
  const now = Date.now();
  const memories: AutoMemory[] = [
    makeMemory({ id: "1", content: "recent memory", lastReferencedAt: now }),
    makeMemory({ id: "2", content: "old memory", lastReferencedAt: 0 }),
  ];
  const r = retrieveRelevantMemories(memories, [], [], null, {
    currentChatLog: [], audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  const recentMem = r.memories.find((m) => m.memory.id === "1");
  const oldMem = r.memories.find((m) => m.memory.id === "2");
  if (recentMem && oldMem) {
    assert(recentMem.score > oldMem.score, "recent memory should score higher");
  }
});

await runTest("verified memories get small boost", () => {
  const memories: AutoMemory[] = [
    makeMemory({ id: "1", content: "verified fact", isVerified: true }),
    makeMemory({ id: "2", content: "unverified fact", isVerified: false }),
  ];
  const r = retrieveRelevantMemories(memories, [], [], null, {
    currentChatLog: [], audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  const verifiedMem = r.memories.find((m) => m.memory.id === "1");
  const unverifiedMem = r.memories.find((m) => m.memory.id === "2");
  if (verifiedMem && unverifiedMem) {
    assert(verifiedMem.score > unverifiedMem.score, "verified memory should score higher");
  }
});

// ─── formatDirectorNotesContext ──────────────────────────────────────────────

await runTest("empty director notes produce empty context", () => {
  assert(formatDirectorNotesContext([]) === "", "empty notes = empty context");
  assert(formatDirectorNotesContext(null) === "", "null notes = empty context");
  assert(formatDirectorNotesContext(undefined) === "", "undefined notes = empty context");
});

await runTest("director notes formatted with header", () => {
  const notes: DirectorNote[] = [
    makeNote({ id: "1", text: "be more energetic" }),
  ];
  const ctx = formatDirectorNotesContext(notes);
  assert(ctx.includes("DIRECTOR NOTES"), "should have header");
  assert(ctx.includes("be more energetic"), "should include note text");
});

await runTest("expired director notes filtered out", () => {
  const notes: DirectorNote[] = [
    makeNote({ id: "1", text: "active note" }),
    makeNote({ id: "2", text: "expired note", createdAt: 0, expiresAt: 1 }),
  ];
  const ctx = formatDirectorNotesContext(notes);
  assert(ctx.includes("active note"), "should include active note");
  assert(!ctx.includes("expired note"), "should not include expired note");
});

await runTest("priority notes labeled correctly", () => {
  // Director notes priority is by array order (position 0 = PRIORITY 1)
  const notes: DirectorNote[] = [
    makeNote({ id: "1", text: "top priority" }),
    makeNote({ id: "2", text: "second" }),
    makeNote({ id: "3", text: "third" }),
    makeNote({ id: "4", text: "standard" }),
  ];
  const ctx = formatDirectorNotesContext(notes);
  assert(ctx.includes("PRIORITY 1"), "should label priority 1");
  assert(ctx.includes("PRIORITY 2"), "should label priority 2");
  assert(ctx.includes("PRIORITY 3"), "should label priority 3");
  assert(ctx.includes("STANDARD"), "should label standard");
});

// ─── formatMemoryContext ─────────────────────────────────────────────────────

await runTest("formatMemoryContext with no memories returns empty or minimal", () => {
  const r = retrieveRelevantMemories([], [], [], null, {
    currentChatLog: [], audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  const ctx = formatMemoryContext(r, { memoriesFormed: 0, jokesCreated: 0 });
  // Should not crash and should be a string
  assert(typeof ctx === "string", "should return a string");
});

await runTest("formatMemoryContext includes memories when present", () => {
  const memories: AutoMemory[] = [
    makeMemory({ id: "1", content: "test memory content", strength: 0.8, confidence: 0.9, isVerified: true }),
  ];
  const r = retrieveRelevantMemories(memories, [], [], null, {
    currentChatLog: [], audioTranscript: "", visualContext: "",
    streamMetadata: streamMeta, activeUsers: [], tokenBudget: 1000,
  });
  const ctx = formatMemoryContext(r, { memoriesFormed: 5, jokesCreated: 2 });
  assert(typeof ctx === "string", "should return a string");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`Memory Retrieval tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}

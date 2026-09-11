import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, getKeys, getActiveProvider, openAiCompatEndpoint } from "./keys";
import { withAiTimeout } from "./ai";
import { MEMORY_EXTRACTION_PROMPT } from "./prompts";
import type { TokenUsage } from "./ai";
import type {
  AutoMemory,
  UserProfile,
  InsideJoke,
  PersonalityState,
  MemoryExtractionResult,
  ChatMessage,
  AutoMemoryConfig,
} from "../types";
import { formatChatLog } from "./chatUtils";
import { generateId } from "./ids";
import * as memoryStore from "./memoryStore";

function normalizeProvider(rawProvider: string): string {
  if (rawProvider === "gemini-pro" || rawProvider === "gemini-env") return "gemini";
  if (rawProvider === "anthropic") return "claude";
  return rawProvider;
}

/**
 * B7: Deterministic relationship progression.
 * Advances a user's relationship based on message count, rapport score, and interaction history.
 * Thresholds:
 *   stranger → acquaintance: 5+ total messages, rapport 10+
 *   acquaintance → regular: 20+ total messages, rapport 30+
 *   regular → friend: 50+ total messages, rapport 60+, 3+ positive interactions
 *   friend → inner_circle: 100+ total messages, rapport 85+, 5+ positive interactions
 */
export function progressRelationship(profile: UserProfile): {
  relationship: UserProfile["relationship"];
  rapportScore: number;
  reason?: string;
} {
  const { totalMessages, rapportScore, interactionHistory, relationship } = profile;
  const positiveInteractions = interactionHistory.filter(
    (i) => i.type === "chat_reply" || i.type === "joke_exchange" || i.type === "support"
  ).length;

  const thresholds: { level: UserProfile["relationship"]; msgs: number; rapport: number; interactions: number }[] = [
    { level: "inner_circle", msgs: 100, rapport: 85, interactions: 5 },
    { level: "friend", msgs: 50, rapport: 60, interactions: 3 },
    { level: "regular", msgs: 20, rapport: 30, interactions: 0 },
    { level: "acquaintance", msgs: 5, rapport: 10, interactions: 0 },
  ];

  for (const t of thresholds) {
    if (totalMessages >= t.msgs && rapportScore >= t.rapport && positiveInteractions >= t.interactions) {
      if (relationship !== t.level) {
        return {
          relationship: t.level,
          rapportScore: Math.min(100, rapportScore),
          reason: `Progressed to ${t.level} (${totalMessages} msgs, ${rapportScore} rapport, ${positiveInteractions} positive interactions)`,
        };
      }
      return { relationship: t.level, rapportScore: Math.min(100, rapportScore) };
    }
  }
  return { relationship: relationship || "stranger", rapportScore: Math.min(100, rapportScore) };
}

/**
 * B7: Increment rapport score deterministically based on interaction type.
 */
export function incrementRapport(
  profile: UserProfile,
  interactionType: "chat_reply" | "mention" | "joke_exchange" | "argument" | "support",
): { rapportScore: number; interactionHistory: UserProfile["interactionHistory"] } {
  const increments: Record<string, number> = {
    chat_reply: 1,
    mention: 2,
    joke_exchange: 3,
    support: 4,
    argument: -2,
  };
  const inc = increments[interactionType] || 0;
  const newScore = Math.max(0, Math.min(100, profile.rapportScore + inc));
  const newHistory = [
    ...profile.interactionHistory,
    {
      timestamp: Date.now(),
      type: interactionType,
      summary: "",
    },
  ].slice(-50); // Keep last 50 interactions
  return { rapportScore: newScore, interactionHistory: newHistory };
}

function cleanJsonStr(str: string): string {
  let clean = str.trim();
  if (!clean) return "{}";
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  if (!clean) return "{}";
  return clean;
}


// ─── Extraction ─────────────────────────────────────────────────

export interface ExtractionParams {
  chatLog: ChatMessage[];
  audioTranscript: string;
  streamMetadata: { channelName: string; title: string; category: string; viewerCount: number };
  existingMemories: AutoMemory[];
  existingProfiles: UserProfile[];
  existingJokes: InsideJoke[];
  config: AutoMemoryConfig;
}

export async function extractMemories(params: ExtractionParams): Promise<MemoryExtractionResult> {
  const rawProvider = getActiveProvider();
  const provider = normalizeProvider(rawProvider);
  const apiKey = getApiKey(rawProvider);
  if (!apiKey) throw new Error(`No API key configured for ${rawProvider}.`);

  const keys = getKeys();
  const chatText = formatChatLog(params.chatLog);
  const existingSummary = params.existingMemories
    .slice(0, 30)
    .map((m) => `- [${m.type}] ${m.content}`)
    .join("\n");
  const existingJokesSummary = params.existingJokes
    .filter((j) => j.status === "active")
    .slice(0, 10)
    .map((j) => `- "${j.punchline}" (origin: ${j.origin})`)
    .join("\n");

  const userMessage = `STREAM CONTEXT:
Channel: ${params.streamMetadata.channelName}
Category: ${params.streamMetadata.category}
Title: ${params.streamMetadata.title}
Viewers: ${params.streamMetadata.viewerCount}

RECENT CHAT LOG:
${chatText || "None"}

STREAMER AUDIO TRANSCRIPT:
${params.audioTranscript?.slice(-2000) || "None"}

ALREADY KNOWN MEMORIES (avoid duplicates):
${existingSummary || "None"}

ALREADY KNOWN JOKES (avoid duplicates):
${existingJokesSummary || "None"}

Analyze the above and extract new memories, profile updates, inside jokes, and personality shifts. Output strict JSON per the schema.`;

  const systemPrompt = MEMORY_EXTRACTION_PROMPT;
  let generatedJsonStr = "";
  let usage: TokenUsage | undefined;

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const model = rawProvider === "gemini-pro" ? "gemini-3.7-flash" : "gemini-3.8-flash";
    const response = await withAiTimeout(ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.5,
      },
    }), 45_000, `extractMemories/gemini`);
    generatedJsonStr = response.text || "{}";
    if (response.usageMetadata) {
      usage = {
        prompt_tokens: response.usageMetadata.promptTokenCount,
        completion_tokens: response.usageMetadata.candidatesTokenCount,
        total_tokens: response.usageMetadata.totalTokenCount,
      };
    }
  } else if (provider === "openai" || provider === "openrouter" || provider === "ollama") {
    const { baseUrl, model } = openAiCompatEndpoint(provider, keys);
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const response = await withAiTimeout(ai.chat.completions.create({
      model,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }), 45_000, `extractMemories/openai`);
    generatedJsonStr = response.choices[0].message.content || "{}";
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      };
    }
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await withAiTimeout(ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      temperature: 0.5,
      system: systemPrompt + "\n\nYou must output ONLY valid JSON matching the schema format.",
      messages: [{ role: "user", content: userMessage }],
    }), 45_000, `extractMemories/claude`);
    generatedJsonStr = (response.content[0] as any).text || "{}";
    if (response.usage) {
      usage = {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      };
    }
  }

  let result: MemoryExtractionResult;
  try {
    result = JSON.parse(cleanJsonStr(generatedJsonStr)) as MemoryExtractionResult;
  } catch (e) {
    console.warn("[memoryEngine] Failed to parse model JSON, returning empty result", e);
    return { newMemories: [], updatedProfiles: [], newJokes: [], summary: "" };
  }

  // Filter by confidence threshold
  if (result.newMemories) {
    result.newMemories = result.newMemories.filter(
      (m) => m.confidence >= params.config.minConfidenceToStore,
    );
  }

  if (usage) {
    result.tokenUsage = usage;
  }
  return result;
}

// ─── Apply Extraction Results ───────────────────────────────────

export async function applyExtractionResults(
  result: MemoryExtractionResult,
  config: AutoMemoryConfig,
  channel: string,
): Promise<{ memoriesAdded: number; profilesUpdated: number; jokesCreated: number }> {
  const now = Date.now();
  let memoriesAdded = 0;
  let profilesUpdated = 0;
  let jokesCreated = 0;

  // Store new memories
  if (result.newMemories && result.newMemories.length > 0) {
    const newMemories: AutoMemory[] = result.newMemories.map((m) => ({
      ...m,
      id: generateId(),
      createdAt: now,
      lastReferencedAt: now,
      referenceCount: 0,
      strength: 0.7,
      isVerified: m.confidence >= config.autoVerifyThreshold,
      subjectUsername: m.subjectUsername || undefined,
    }));
    await memoryStore.addMemories(channel, newMemories);
    memoriesAdded = newMemories.length;
  }

  // Update profiles
  if (result.updatedProfiles && result.updatedProfiles.length > 0) {
    for (const update of result.updatedProfiles) {
      if (!update.username) continue;
      const existing = await memoryStore.getProfile(channel, update.username);
      const profile: UserProfile = existing || {
        username: update.username,
        firstSeenAt: now,
        lastSeenAt: now,
        totalMessages: 0,
        messagesThisSession: 0,
        relationship: "stranger",
        rapportScore: 0,
        traits: [],
        interests: [],
        knownFacts: [],
        sharedJokes: [],
        interactionHistory: [],
        notes: "",
        isVIP: false,
        isBlocked: false,
      };

      const merged: UserProfile = {
        ...profile,
        lastSeenAt: now,
        traits: update.updates.traits
          ? Array.from(new Set([...profile.traits, ...update.updates.traits]))
          : profile.traits,
        interests: update.updates.interests
          ? Array.from(new Set([...profile.interests, ...update.updates.interests]))
          : profile.interests,
        knownFacts: update.updates.knownFacts
          ? Array.from(new Set([...profile.knownFacts, ...update.updates.knownFacts]))
          : profile.knownFacts,
      };

      // B7: Apply deterministic relationship progression
      const progressed = progressRelationship(merged);
      merged.relationship = progressed.relationship;
      merged.rapportScore = progressed.rapportScore;
      if (progressed.reason) {
        console.log(`[Memory] ${profile.username}: ${progressed.reason}`);
      }

      await memoryStore.upsertProfile(channel, merged);
      profilesUpdated++;
    }
  }

  // Store new jokes
  if (result.newJokes && result.newJokes.length > 0) {
    const newJokes: InsideJoke[] = result.newJokes.map((j) => ({
      ...j,
      id: generateId(),
      createdAt: now,
      usageCount: 0,
      lastUsedAt: now,
      strength: 1.0,
      status: "active",
      variations: [],
      originTimestamp: j.originTimestamp || now,
    }));
    await memoryStore.addJokes(channel, newJokes);
    jokesCreated = newJokes.length;
  }

  // Apply personality shift
  if (result.personalityShift && config.personalityEvolutionEnabled) {
    const current = await memoryStore.getPersonality(channel);
    if (current) {
      const updated: PersonalityState = {
        ...current,
        ...result.personalityShift,
        mood: result.personalityShift.mood || current.mood,
        comfortLevel: result.personalityShift.comfortLevel ?? current.comfortLevel,
      };
      await memoryStore.savePersonality(channel, updated);
    }
  }

  // Log extraction
  await memoryStore.addExtractionLog(channel, {
    id: generateId(),
    timestamp: now,
    summary: result.summary || `Extraction: ${memoriesAdded} memories, ${profilesUpdated} profiles, ${jokesCreated} jokes`,
    memoriesFormed: memoriesAdded,
    profilesUpdated,
    jokesCreated,
  });

  return { memoriesAdded, profilesUpdated, jokesCreated };
}

// ─── Memory Decay & Pruning ─────────────────────────────────────

export function applyMemoryDecay(memories: AutoMemory[], halfLifeDays: number): AutoMemory[] {
  const now = Date.now();
  const halfLifeMs = halfLifeDays * 86400000;
  return memories.map((m) => {
    const daysSinceReference = (now - m.lastReferencedAt) / 86400000;
    const decayFactor = Math.pow(0.5, daysSinceReference / halfLifeDays);
    const newStrength = m.strength * decayFactor;
    return { ...m, strength: Math.max(0, newStrength) };
  });
}

export function applyJokeDecay(jokes: InsideJoke[], halfLifeDays: number): InsideJoke[] {
  const now = Date.now();
  return jokes.map((j) => {
    const daysSinceUse = (now - j.lastUsedAt) / 86400000;
    const decayFactor = Math.pow(0.5, daysSinceUse / halfLifeDays);
    const newStrength = j.strength * decayFactor;
    let status = j.status;
    if (newStrength < 0.1 && status === "active") status = "fading";
    if (newStrength < 0.03 && status !== "retired") status = "retired";
    return { ...j, strength: Math.max(0, newStrength), status };
  });
}

export function pruneMemories(memories: AutoMemory[], maxMemories: number): { kept: AutoMemory[]; pruned: AutoMemory[] } {
  const sorted = [...memories].sort((a, b) => b.strength - a.strength);
  const kept = sorted.slice(0, maxMemories);
  const pruned = sorted.slice(maxMemories);
  return { kept, pruned };
}

export function pruneProfiles(profiles: UserProfile[], maxProfiles: number): { kept: UserProfile[]; pruned: UserProfile[] } {
  const sorted = [...profiles].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const kept = sorted.slice(0, maxProfiles);
  const pruned = sorted.slice(maxProfiles);
  return { kept, pruned };
}

export function pruneJokes(jokes: InsideJoke[], maxJokes: number): { kept: InsideJoke[]; pruned: InsideJoke[] } {
  const active = jokes.filter((j) => j.status !== "retired");
  const retired = jokes.filter((j) => j.status === "retired");
  const sorted = [...active].sort((a, b) => b.strength - a.strength);
  const kept = [...sorted.slice(0, maxJokes), ...retired];
  const pruned = sorted.slice(maxJokes);
  return { kept, pruned };
}

// ─── Memory Boosting ────────────────────────────────────────────

export async function boostMemory(channel: string, memoryId: string): Promise<void> {
  const allMemories = await memoryStore.getAllMemories(channel);
  const memory = allMemories.find((m) => m.id === memoryId);
  if (!memory) return;
  const updated: AutoMemory = {
    ...memory,
    referenceCount: memory.referenceCount + 1,
    lastReferencedAt: Date.now(),
    strength: Math.min(1.0, memory.strength + 0.1),
  };
  await memoryStore.updateMemory(channel, updated);
}

export async function boostJoke(channel: string, jokeId: string, variationText?: string): Promise<void> {
  const allJokes = await memoryStore.getAllJokes(channel);
  const joke = allJokes.find((j) => j.id === jokeId);
  if (!joke) return;
  const updated: InsideJoke = {
    ...joke,
    usageCount: joke.usageCount + 1,
    lastUsedAt: Date.now(),
    strength: Math.min(1.0, joke.strength + 0.15),
    status: "active",
    variations: variationText
      ? [...joke.variations, { text: variationText, timestamp: Date.now() }].slice(-20)
      : joke.variations,
  };
  await memoryStore.updateJoke(channel, updated);
}

// ─── Run Full Decay Cycle ───────────────────────────────────────

export async function runDecayCycle(config: AutoMemoryConfig, channel: string): Promise<void> {
  const [memories, jokes, profiles] = await Promise.all([
    memoryStore.getAllMemories(channel),
    memoryStore.getAllJokes(channel),
    memoryStore.getAllProfiles(channel),
  ]);

  // Apply decay
  const decayedMemories = applyMemoryDecay(memories, config.decayHalfLifeDays);
  const decayedJokes = applyJokeDecay(jokes, config.jokeDecayHalfLifeDays);

  // Prune
  const { kept: keptMemories, pruned: prunedMemories } = pruneMemories(decayedMemories, config.maxMemories);
  const { kept: keptJokes, pruned: prunedJokes } = pruneJokes(decayedJokes, config.maxJokes);
  const { kept: keptProfiles, pruned: prunedProfiles } = pruneProfiles(profiles, config.maxProfiles);

  // Persist kept items
  await memoryStore.clearMemories(channel);
  await memoryStore.addMemories(channel, keptMemories);
  await memoryStore.clearJokes(channel);
  await memoryStore.addJokes(channel, keptJokes);

  // Prune profiles by removing pruned ones
  for (const p of prunedProfiles) {
    await memoryStore.deleteProfile(channel, p.username);
  }

  const decayed = keptMemories.length < memories.length || keptJokes.length < jokes.length || keptProfiles.length < profiles.length;
  if (decayed) {
    console.log(`[MemoryEngine] Decay cycle complete. Memories: ${keptMemories.length}/${memories.length}, Jokes: ${keptJokes.length}/${jokes.length}, Profiles: ${keptProfiles.length}/${profiles.length}`);
  }
}

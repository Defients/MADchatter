import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getApiKey, getKeys, getActiveProvider } from "./keys";
import { MEMORY_EXTRACTION_PROMPT } from "./prompts";
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

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    const model = rawProvider === "gemini-pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        temperature: 0.5,
      },
    });
    generatedJsonStr = response.text || "{}";
  } else if (provider === "openai" || provider === "openrouter") {
    const baseUrl = provider === "openrouter" ? keys.customBaseUrl || "https://openrouter.ai/api/v1" : undefined;
    const model = provider === "openrouter" ? keys.customModel || "google/gemini-2.5-flash" : "gpt-4o";
    const ai = new OpenAI({ apiKey, baseURL: baseUrl, dangerouslyAllowBrowser: true });
    const response = await ai.chat.completions.create({
      model,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });
    generatedJsonStr = response.choices[0].message.content || "{}";
  } else if (provider === "claude") {
    const ai = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const response = await ai.messages.create({
      model: "claude-3-7-sonnet-20250219",
      max_tokens: 2048,
      temperature: 0.5,
      system: systemPrompt + "\n\nYou must output ONLY valid JSON matching the schema format.",
      messages: [{ role: "user", content: userMessage }],
    });
    generatedJsonStr = (response.content[0] as any).text || "{}";
  }

  const result = JSON.parse(cleanJsonStr(generatedJsonStr)) as MemoryExtractionResult;

  // Filter by confidence threshold
  if (result.newMemories) {
    result.newMemories = result.newMemories.filter(
      (m) => m.confidence >= params.config.minConfidenceToStore,
    );
  }

  return result;
}

// ─── Apply Extraction Results ───────────────────────────────────

export async function applyExtractionResults(
  result: MemoryExtractionResult,
  config: AutoMemoryConfig,
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
    await memoryStore.addMemories(newMemories);
    memoriesAdded = newMemories.length;
  }

  // Update profiles
  if (result.updatedProfiles && result.updatedProfiles.length > 0) {
    for (const update of result.updatedProfiles) {
      if (!update.username) continue;
      const existing = await memoryStore.getProfile(update.username);
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

      await memoryStore.upsertProfile(merged);
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
    await memoryStore.addJokes(newJokes);
    jokesCreated = newJokes.length;
  }

  // Apply personality shift
  if (result.personalityShift && config.personalityEvolutionEnabled) {
    const current = await memoryStore.getPersonality();
    if (current) {
      const updated: PersonalityState = {
        ...current,
        ...result.personalityShift,
        mood: result.personalityShift.mood || current.mood,
        comfortLevel: result.personalityShift.comfortLevel ?? current.comfortLevel,
      };
      await memoryStore.savePersonality(updated);
    }
  }

  // Log extraction
  await memoryStore.addExtractionLog({
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

export async function boostMemory(memoryId: string): Promise<void> {
  const allMemories = await memoryStore.getAllMemories();
  const memory = allMemories.find((m) => m.id === memoryId);
  if (!memory) return;
  const updated: AutoMemory = {
    ...memory,
    referenceCount: memory.referenceCount + 1,
    lastReferencedAt: Date.now(),
    strength: Math.min(1.0, memory.strength + 0.1),
  };
  await memoryStore.updateMemory(updated);
}

export async function boostJoke(jokeId: string, variationText?: string): Promise<void> {
  const allJokes = await memoryStore.getAllJokes();
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
  await memoryStore.updateJoke(updated);
}

// ─── Run Full Decay Cycle ───────────────────────────────────────

export async function runDecayCycle(config: AutoMemoryConfig): Promise<void> {
  const [memories, jokes, profiles] = await Promise.all([
    memoryStore.getAllMemories(),
    memoryStore.getAllJokes(),
    memoryStore.getAllProfiles(),
  ]);

  // Apply decay
  const decayedMemories = applyMemoryDecay(memories, config.decayHalfLifeDays);
  const decayedJokes = applyJokeDecay(jokes, config.jokeDecayHalfLifeDays);

  // Prune
  const { kept: keptMemories, pruned: prunedMemories } = pruneMemories(decayedMemories, config.maxMemories);
  const { kept: keptJokes, pruned: prunedJokes } = pruneJokes(decayedJokes, config.maxJokes);
  const { kept: keptProfiles, pruned: prunedProfiles } = pruneProfiles(profiles, config.maxProfiles);

  // Persist kept items
  await memoryStore.clearMemories();
  await memoryStore.addMemories(keptMemories);
  await memoryStore.clearJokes();
  await memoryStore.addJokes(keptJokes);

  // Prune profiles by removing pruned ones
  for (const p of prunedProfiles) {
    await memoryStore.deleteProfile(p.username);
  }

  console.log(`[MemoryEngine] Decay cycle complete. Memories: ${keptMemories.length}/${memories.length}, Jokes: ${keptJokes.length}/${jokes.length}, Profiles: ${keptProfiles.length}/${profiles.length}`);
}

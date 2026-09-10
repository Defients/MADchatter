import type { PersonalityState, ChatMessage } from "../types";
import * as memoryStore from "./memoryStore";

export function createDefaultPersonality(): PersonalityState {
  return {
    mood: "chill",
    comfortLevel: 20,
    sessionCount: 1,
    totalMessagesSent: 0,
    dominantTraits: [],
    currentSessionStart: Date.now(),
    sessionMemoriesFormed: 0,
    sessionJokesCreated: 0,
    relationshipProgression: [],
  };
}

export function detectMood(
  chatLog: ChatMessage[],
  audioTranscript: string,
  /** Reserved for future viewer-aware mood scaling; currently unused */
  _viewerCount: number,
): PersonalityState["mood"] {
  const recentMessages = chatLog.filter((m) => !m.marker).slice(-20);
  const chatText = recentMessages.map((m) => m.text.toLowerCase()).join(" ");
  const audioText = audioTranscript.slice(-500).toLowerCase();

  const hypeSignals = ["pog", "lets go", "no way", "clutch", "insane", "huge", "big", "wow", "omg", "!!!"];
  const gremlinSignals = ["lmao", "lol", "kekw", "bruh", "💀", "ratio", "skill issue", "copium"];
  const chillSignals = ["cozy", "vibes", "relaxing", "calm", "wholesome", "comfy", "nice"];
  const thoughtfulSignals = ["interesting", "actually", "think", "strategy", "meta", "analysis", "because"];
  const chaoticSignals = ["chaos", "wild", "what is happening", "insane", "unpredictable", "cursed"];
  const sentimentalSignals = [
    "miss you", "remember when", "used to", "old days", "love you guys",
    "thank you for", "been here since", "first stream", "grew up watching",
    "missed this", "brings me back", "nostalgia", "so long", "years ago",
    "good old", "back in the day", "emotional", "teared up", "this means a lot",
  ];

  const hypeScore = hypeSignals.filter((s) => chatText.includes(s) || audioText.includes(s)).length;
  const gremlinScore = gremlinSignals.filter((s) => chatText.includes(s)).length;
  const chillScore = chillSignals.filter((s) => chatText.includes(s) || audioText.includes(s)).length;
  const thoughtfulScore = thoughtfulSignals.filter((s) => chatText.includes(s) || audioText.includes(s)).length;
  const chaoticScore = chaoticSignals.filter((s) => chatText.includes(s) || audioText.includes(s)).length;
  const sentimentalScore = sentimentalSignals.filter((s) => chatText.includes(s) || audioText.includes(s)).length;

  const scores: Record<PersonalityState["mood"], number> = {
    hyped: hypeScore * 2,
    gremlin: gremlinScore * 1.5,
    chill: chillScore,
    thoughtful: thoughtfulScore,
    chaotic: chaoticScore * 1.5,
    sentimental: sentimentalScore * 2,
  };

  const maxMood = Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a));
  if (maxMood[1] === 0) return "chill";
  return maxMood[0] as PersonalityState["mood"];
}

export function updateComfortLevel(
  current: number,
  messagesSent: number,
  positiveInteractions: number,
): number {
  // Comfort grows slowly, caps at 100
  const growth = (messagesSent * 0.5) + (positiveInteractions * 2);
  return Math.min(100, current + growth);
}

/** Valid mood values for validation */
const VALID_MOODS: PersonalityState["mood"][] = [
  "hyped", "gremlin", "chill", "thoughtful", "chaotic", "sentimental",
];

/**
 * E4: Mood lock — returns the locked mood if active, otherwise calls detectMood.
 * Callers should use this instead of detectMood directly to respect mood lock.
 * Validates the locked mood against the allowed union; falls back to detectMood
 * if the locked value is invalid.
 */
export function detectMoodWithLock(
  chatLog: ChatMessage[],
  audioTranscript: string,
  viewerCount: number,
  moodLock?: { locked: boolean; mood: string | null },
): PersonalityState["mood"] {
  if (moodLock?.locked && moodLock.mood) {
    const locked = moodLock.mood as PersonalityState["mood"];
    if (VALID_MOODS.includes(locked)) {
      return locked;
    }
    // Invalid locked mood — ignore the lock and detect normally
    console.warn(`[personalityEngine] Invalid locked mood "${moodLock.mood}", falling back to detection`);
  }
  return detectMood(chatLog, audioTranscript, viewerCount);
}

export function evolveTraits(
  currentTraits: string[],
  recentActions: { type: string; success: boolean }[],
): string[] {
  const traitCounts: Record<string, number> = {};
  for (const t of currentTraits) traitCounts[t] = 1;

  for (const action of recentActions) {
    if (!action.success) continue;
    const traitMap: Record<string, string> = {
      short_reaction: "reactive",
      emote_only: "expressive",
      full_forge: "thoughtful",
      quick_followup: "conversational",
      joke_callback: "funny",
      meta_observation: "observant",
    };
    const trait = traitMap[action.type];
    if (trait) traitCounts[trait] = (traitCounts[trait] || 0) + 1;
  }

  // Keep traits that appear frequently
  return Object.entries(traitCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([trait]) => trait);
}

export async function startNewSession(): Promise<PersonalityState> {
  const existing = await memoryStore.getPersonality();
  if (!existing) {
    const fresh = createDefaultPersonality();
    await memoryStore.savePersonality(fresh);
    return fresh;
  }

  // Drift comfort toward baseline (50% of current + 50% of 20)
  const driftedComfort = Math.round(existing.comfortLevel * 0.5 + 20 * 0.5);

  const updated: PersonalityState = {
    ...existing,
    sessionCount: existing.sessionCount + 1,
    currentSessionStart: Date.now(),
    sessionMemoriesFormed: 0,
    sessionJokesCreated: 0,
    comfortLevel: driftedComfort,
  };
  await memoryStore.savePersonality(updated);
  return updated;
}

export async function saveSessionEnd(state: PersonalityState): Promise<void> {
  await memoryStore.savePersonality(state);
}

export function addRelationshipMilestone(
  state: PersonalityState,
  stage: string,
  note: string,
): PersonalityState {
  return {
    ...state,
    relationshipProgression: [
      ...state.relationshipProgression,
      { timestamp: Date.now(), stage, note },
    ].slice(-50),
  };
}

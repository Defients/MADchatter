import type {
  AutoMemory,
  UserProfile,
  InsideJoke,
  PersonalityState,
  ChatMessage,
  DirectorNote,
} from "../types";

export interface RetrievalContext {
  currentChatLog: ChatMessage[];
  audioTranscript: string;
  visualContext: string;
  streamMetadata: { channelName: string; title: string; category: string; viewerCount: number };
  activeUsers: string[];
  tokenBudget: number;
}

export interface RetrievedMemory {
  memory: AutoMemory;
  score: number;
  reason: string;
}

function extractKeywords(text: string): string[] {
  if (!text) return [];
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "can", "to", "of", "in", "for",
    "on", "at", "with", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "up", "down", "out", "off",
    "over", "under", "again", "further", "then", "once", "here", "there",
    "when", "where", "why", "how", "all", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same",
    "so", "than", "too", "very", "just", "but", "and", "or", "if", "i",
    "you", "he", "she", "it", "we", "they", "me", "him", "her", "us",
    "them", "my", "your", "his", "its", "our", "their", "this", "that",
    "these", "those", "what", "which", "who", "whom", "whose",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

export function retrieveRelevantMemories(
  allMemories: AutoMemory[],
  allProfiles: UserProfile[],
  allJokes: InsideJoke[],
  personality: PersonalityState | null,
  context: RetrievalContext,
): { memories: RetrievedMemory[]; profiles: UserProfile[]; jokes: InsideJoke[]; personality: PersonalityState | null } {
  const now = Date.now();

  // Gather active users from recent chat
  const recentMessages = context.currentChatLog.filter((m) => !m.marker).slice(-30);
  const activeUsernames = new Set<string>(context.activeUsers);
  for (const msg of recentMessages) {
    activeUsernames.add(msg.user);
  }

  // Extract keywords from current context
  const chatText = recentMessages.map((m) => `${m.user} ${m.text}`).join(" ");
  const contextText = `${chatText} ${context.audioTranscript} ${context.visualContext} ${context.streamMetadata.title} ${context.streamMetadata.category}`;
  const contextKeywords = new Set(extractKeywords(contextText));

  // Score each memory
  const scored: RetrievedMemory[] = allMemories.map((memory) => {
    let score = memory.strength * 0.3; // base: strength
    const reasons: string[] = [];

    // User relevance — memories about active users get boosted
    if (memory.subjectUsername && activeUsernames.has(memory.subjectUsername)) {
      score += 0.3;
      reasons.push("about active user");
    }

    // Topic relevance — tag overlap with context keywords
    const memoryWords = new Set(extractKeywords(`${memory.content} ${memory.tags.join(" ")}`));
    let overlap = 0;
    for (const word of memoryWords) {
      if (contextKeywords.has(word)) overlap++;
    }
    if (overlap > 0) {
      score += Math.min(0.3, overlap * 0.05);
      reasons.push(`${overlap} keyword matches`);
    }

    // Recency boost — recently referenced memories get boosted
    const daysSinceRef = (now - memory.lastReferencedAt) / 86400000;
    if (daysSinceRef < 1) {
      score += 0.15;
      reasons.push("recently referenced");
    }

    // Verified memories get a small boost
    if (memory.isVerified) {
      score += 0.05;
      reasons.push("verified");
    }

    // Personality alignment — memories matching current mood
    if (personality && personality.mood) {
      const moodTags: Record<string, string[]> = {
        hyped: ["hype", "exciting", "big", "clutch", "pog"],
        gremlin: ["funny", "chaotic", "meme", "troll"],
        chill: ["calm", "wholesome", "cozy", "relaxing"],
        thoughtful: ["interesting", "deep", "analysis", "strategy"],
        sentimental: ["emotional", "touching", "nostalgic", "milestone"],
        chaotic: ["chaos", "wild", "insane", "unpredictable"],
      };
      const moodWords = moodTags[personality.mood] || [];
      const hasMoodMatch = memory.tags.some((t) => moodWords.includes(t.toLowerCase()));
      if (hasMoodMatch) {
        score += 0.1;
        reasons.push(`matches ${personality.mood} mood`);
      }
    }

    return { memory, score, reason: reasons.join(", ") || "base strength" };
  });

  // Sort by score and take top N that fit token budget
  scored.sort((a, b) => b.score - a.score);
  const selectedMemories: RetrievedMemory[] = [];
  let tokenEstimate = 0;
  for (const item of scored) {
    const memoryTokens = Math.ceil(item.memory.content.length / 4) + 10;
    if (tokenEstimate + memoryTokens > context.tokenBudget * 0.5) break;
    selectedMemories.push(item);
    tokenEstimate += memoryTokens;
  }

  // Select relevant profiles — active users only
  const selectedProfiles = allProfiles.filter(
    (p) => activeUsernames.has(p.username) && !p.isBlocked,
  );

  // Select relevant jokes — active, sorted by strength, limited
  const activeJokes = allJokes
    .filter((j) => j.status === "active")
    .sort((a, b) => b.strength - a.strength);

  const selectedJokes: InsideJoke[] = [];
  let jokeTokens = 0;
  for (const joke of activeJokes) {
    const jokeTokensEst = Math.ceil((joke.punchline.length + joke.context.length) / 4) + 20;
    if (jokeTokens + jokeTokensEst > context.tokenBudget * 0.25) break;
    if (selectedJokes.length >= 3) break;
    selectedJokes.push(joke);
    jokeTokens += jokeTokensEst;
  }

  return {
    memories: selectedMemories,
    profiles: selectedProfiles,
    jokes: selectedJokes,
    personality,
  };
}

/**
 * Build the [DIRECTOR NOTES] context block from a list of notes. Filters out
 * expired notes (expiresAt < now) so the AI never sees stale directives.
 * Returns an empty string when there are no active notes.
 */
export function formatDirectorNotesContext(directorNotes?: DirectorNote[] | null): string {
  if (!directorNotes || directorNotes.length === 0) return "";
  const now = Date.now();
  const active = directorNotes.filter((n) => n.expiresAt == null || n.expiresAt > now);
  if (active.length === 0) return "";
  const parts: string[] = [`[DIRECTOR NOTES — from the streamer, follow these directives]`];
  for (const note of active.slice(-10)) {
    parts.push(`- ${note.text}`);
  }
  return parts.join("\n");
}

export function formatMemoryContext(
  retrieved: { memories: RetrievedMemory[]; profiles: UserProfile[]; jokes: InsideJoke[]; personality: PersonalityState | null },
  sessionInfo?: { memoriesFormed: number; jokesCreated: number },
  directorNotes?: DirectorNote[],
): string {
  const parts: string[] = [];

  // Director notes — highest priority, always injected first
  const directorCtx = formatDirectorNotesContext(directorNotes);
  if (directorCtx) parts.push(directorCtx);

  // Personality
  if (retrieved.personality) {
    const p = retrieved.personality;
    parts.push(`[PERSONALITY] You're feeling ${p.mood}. Comfort level with this chat: ${Math.round(p.comfortLevel)}/100. You've been here for ${p.sessionCount} sessions.`);
    if (p.dominantTraits.length > 0) {
      parts.push(`Your dominant traits: ${p.dominantTraits.join(", ")}.`);
    }
  }

  // Streamer memories
  const streamerMems = retrieved.memories.filter((m) => m.memory.subject === "streamer");
  if (streamerMems.length > 0) {
    parts.push(`\n[ABOUT THE STREAMER]`);
    for (const m of streamerMems.slice(0, 8)) {
      parts.push(`- ${m.memory.content} (strength: ${m.memory.strength.toFixed(2)}, referenced ${m.memory.referenceCount}x)`);
    }
  }

  // Chatter memories
  const chatterMems = retrieved.memories.filter((m) => m.memory.subject === "chatter");
  if (chatterMems.length > 0) {
    parts.push(`\n[ABOUT CHATTERS]`);
    for (const m of chatterMems.slice(0, 6)) {
      parts.push(`- ${m.memory.subjectUsername ? "@" + m.memory.subjectUsername + ": " : ""}${m.memory.content} (strength: ${m.memory.strength.toFixed(2)})`);
    }
  }

  // General memories
  const generalMems = retrieved.memories.filter((m) => m.memory.subject === "chat_general" || m.memory.subject === "bot_self");
  if (generalMems.length > 0) {
    parts.push(`\n[GENERAL CONTEXT]`);
    for (const m of generalMems.slice(0, 4)) {
      parts.push(`- ${m.memory.content}`);
    }
  }

  // User profiles
  if (retrieved.profiles.length > 0) {
    parts.push(`\n[ACTIVE CHATTERS YOU KNOW]`);
    for (const p of retrieved.profiles.slice(0, 8)) {
      const traits = p.traits.length > 0 ? p.traits.join(", ") : "unknown";
      parts.push(`- @${p.username}: ${p.relationship}, ${traits}, rapport ${Math.round(p.rapportScore)}/100${p.knownFacts.length > 0 ? `, facts: ${p.knownFacts.slice(0, 2).join("; ")}` : ""}`);
    }
  }

  // Inside jokes
  if (retrieved.jokes.length > 0) {
    parts.push(`\n[ACTIVE INSIDE JOKES]`);
    for (const j of retrieved.jokes) {
      parts.push(`- "${j.punchline}" — ${j.context} (used ${j.usageCount}x, strength ${j.strength.toFixed(2)})`);
    }
  }

  // Session notes
  if (sessionInfo) {
    parts.push(`\n[CURRENT SESSION NOTES]`);
    parts.push(`- ${sessionInfo.memoriesFormed} new memories formed this session`);
    parts.push(`- ${sessionInfo.jokesCreated} new inside jokes created this session`);
  }

  if (parts.length === 0) return "";

  return `=== WHAT YOU KNOW ===\n${parts.join("\n")}`;
}

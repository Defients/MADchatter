import { generateChat } from "./ai";
import { getActiveProvider, getApiKey, hasAnyApiKey } from "./keys";
import { formatChatLog } from "./chatUtils";
import { summarizeSentiment, formatSentimentContext } from "./sentiment";
import { useAppStore } from "../store";
import type { SmartReply } from "../types";
import { generateId } from "./ids";
import { retrieveRelevantMemories, formatMemoryContext, formatDirectorNotesContext } from "./memoryRetrieval";
import { analyzeRepetition, formatRepetitionContext } from "./antiRepetition";
import { buildLongTermMemoryContext } from "./autoForgeCore";
import { getAvailableEmoteNames } from "./emotes";

let lastSmartReplyTime = 0;
const SMART_REPLY_COOLDOWN_MS = 30_000;
const SMART_REPLY_EXPIRY_MS = 60_000;

export function canGenerateSmartReplies(): boolean {
  return Date.now() - lastSmartReplyTime > SMART_REPLY_COOLDOWN_MS;
}

export function cleanExpiredSmartReplies(replies: SmartReply[]): SmartReply[] {
  const now = Date.now();
  return replies.filter((r) => now - r.timestamp < SMART_REPLY_EXPIRY_MS);
}

export async function generateSmartReplies(mentionedLines: string[], options?: { botId?: string }): Promise<SmartReply[]> {
  if (!canGenerateSmartReplies()) return [];
  if (!hasAnyApiKey()) return [];

  lastSmartReplyTime = Date.now();

  const state = useAppStore.getState();
  const activeProvider = getActiveProvider();

  if (!getApiKey(activeProvider)) return [];

  // Resolve the actual bot username from the platform session — NOT the
  // streamer's channel name. In multi-bot mode, prefer the explicitly
  // provided botId (from the per-bot loop), then the manual send bot's
  // identity; otherwise fall back to the legacy singleton session.
  const resolveBotUsername = (): string | undefined => {
    const platform = state.platform;
    // Per-bot loop passes the mentioned bot's ID explicitly
    if (options?.botId) {
      const bot = state.bots.find((b) => b.id === options.botId);
      if (bot?.session?.username) return bot.session.username;
    }
    if (state.multiBotEnabled && state.manualSendBotId) {
      const bot = state.bots.find((b) => b.id === state.manualSendBotId);
      if (bot?.session?.username) return bot.session.username;
    }
    if (platform === 'kick') return window.__kickSession?.username;
    if (platform === 'joystick') return window.__joystickSession?.username;
    return window.__twitchSession?.username;
  };
  const botUsername = resolveBotUsername();

  // Resolve the bot's persona + runtime for context enrichment. In multi-bot
  // mode (with an explicit botId or manual send bot), use that bot's persona
  // and sent history. In legacy single-bot mode, fall back to the global
  // config + global sent messages.
  const resolveBotPersona = () => {
    if (options?.botId) {
      const bot = state.bots.find((b) => b.id === options.botId);
      if (bot) return bot;
    }
    if (state.multiBotEnabled && state.manualSendBotId) {
      const bot = state.bots.find((b) => b.id === state.manualSendBotId);
      if (bot) return bot;
    }
    return undefined;
  };
  const bot = resolveBotPersona();

  const sentimentHistory = state.sentimentHistory;
  let sentimentContext = "";
  if (sentimentHistory.length > 0) {
    const summary = summarizeSentiment(sentimentHistory);
    sentimentContext = formatSentimentContext(summary);
  }

  const recentChat = formatChatLog(state.chatLog.slice(-20));

  // ── Memory context ──────────────────────────────────────────────────────
  // Enrich smart replies with the same memory + director notes context the
  // AutoForge loops inject, so reply suggestions are aware of what the bot
  // knows about the streamer, chatters, and active inside jokes. In multi-bot
  // mode, use the bot's own per-bot memory; in legacy mode, use the global
  // auto-memory cache.
  let memoryContext = "";
  if (bot) {
    const runtime = bot.runtime;
    if (runtime.autoMemoryConfig?.enabled) {
      const retrieved = retrieveRelevantMemories(
        runtime.autoMemories,
        runtime.userProfiles,
        runtime.insideJokes,
        runtime.personalityState,
        {
          currentChatLog: state.chatLog,
          audioTranscript: state.audioTranscript,
          visualContext: state.visualContextTags.join(" "),
          streamMetadata: state.streamMetadata,
          activeUsers: [],
          tokenBudget: runtime.autoMemoryConfig.contextInjectionTokenBudget,
        },
      );
      memoryContext = formatMemoryContext(retrieved, {
        memoriesFormed: runtime.personalityState?.sessionMemoriesFormed ?? 0,
        jokesCreated: runtime.personalityState?.sessionJokesCreated ?? 0,
      }, runtime.directorNotes);
    } else {
      // Director notes are user-authored directives — inject even when
      // AutoMemory is disabled (parity with the AutoForge loops).
      memoryContext = formatDirectorNotesContext(runtime.directorNotes);
    }
  } else if (state.autoMemoryConfig?.enabled) {
    // Legacy single-bot: use the global auto-memory cache.
    const retrieved = retrieveRelevantMemories(
      state.autoMemories,
      state.userProfiles,
      state.insideJokes,
      state.personalityState,
      {
        currentChatLog: state.chatLog,
        audioTranscript: state.audioTranscript,
        visualContext: state.visualContextTags.join(" "),
        streamMetadata: state.streamMetadata,
        activeUsers: [],
        tokenBudget: state.autoMemoryConfig.contextInjectionTokenBudget,
      },
    );
    memoryContext = formatMemoryContext(retrieved, {
      memoriesFormed: state.personalityState?.sessionMemoriesFormed ?? 0,
      jokesCreated: state.personalityState?.sessionJokesCreated ?? 0,
    }, state.directorNotes);
  } else {
    memoryContext = formatDirectorNotesContext(state.directorNotes);
  }

  // ── Anti-repetition context ────────────────────────────────────────────
  // Use the bot's own sent history (multi-bot) or the global sent messages
  // (legacy) so reply suggestions don't repeat what was recently sent.
  // generateChat doesn't have a dedicated antiRepetitionContext param (that's
  // autoforgeDecide only), so we fold it into memoryContext which is appended
  // to the user message verbatim.
  const sentMessages = bot ? bot.runtime.sentMessages : state.sentMessages;
  const repAnalysis = analyzeRepetition(sentMessages);
  const antiRepetitionContext = formatRepetitionContext(repAnalysis);
  if (antiRepetitionContext) {
    memoryContext = memoryContext ? `${memoryContext}\n\n${antiRepetitionContext}` : antiRepetitionContext;
  }

  // ── Long-term memory context (pinned + golden) ─────────────────────────
  const longTermMemory = bot
    ? buildLongTermMemoryContext(bot.runtime.longTermMemory, bot.runtime.pinnedMemories, bot.runtime.goldenMemoryId)
    : buildLongTermMemoryContext(state.longTermMemory, state.pinnedMemories, state.goldenMemoryId);

  // ── Bot identity ────────────────────────────────────────────────────────
  const botIdentityMode = bot?.persona.botIdentityMode;
  const botIdentityStory = bot?.persona.botIdentityStory;

  // ── Available emotes ───────────────────────────────────────────────────
  const availableEmotes = state.emoteAwarenessEnabled
    ? getAvailableEmoteNames(state.streamMetadata.channelName, 50)
    : undefined;

  // ── Visual context ─────────────────────────────────────────────────────
  const visualContext = state.visualContextTags.join(" ");

  // ── Config: prefer the bot's persona config in multi-bot mode ──────────
  const baseConfig = bot ? bot.persona.config : state.config;

  const prompt = `You are a chat co-pilot for a streamer. The bot (${botUsername || "the bot"}) was just mentioned in chat. Generate 3 short, natural-sounding reply suggestions that the bot can click to send instantly.

Mentioned lines:
${mentionedLines.join("\n")}

Recent chat context:
${recentChat}

${sentimentContext ? `Current chat sentiment: ${sentimentContext}` : ""}

Stream: ${state.streamMetadata.channelName} — ${state.streamMetadata.title} (${state.streamMetadata.category})

Rules:
- Each reply must be under 200 characters
- Make them casual, natural, and varied in tone (one funny, one chill, one engaging)
- Don't use @ mentions back
- Respond as the bot (${botUsername || "the bot"}), not as a viewer or the streamer
- Return EXACTLY 3 replies, one per line, no numbering or prefixes`;

  try {
    const result = await generateChat({
      streamMetadata: state.streamMetadata,
      recentChatLog: recentChat,
      visualContext,
      audioTranscript: state.audioTranscript,
      longTermContext: longTermMemory,
      config: { ...baseConfig, lengthPreference: "short", emoteDensity: "minimal" },
      activeProvider,
      count: 3,
      r34lEnabled: state.r34lEnabled,
      botUsername,
      memoryContext,
      sentimentContext,
      availableEmotes,
      botIdentityMode,
      botIdentityStory,
      // Smart replies are background/autonomous — must not block manual Forge.
      priority: "autonomous",
    });

    if (result?.tokenUsage) {
      useAppStore.getState().recordTokenUsage("forge", result.tokenUsage);
    }

    const suggestions = typeof result === "string" ? [] : (result?.suggestions || []);
    if (suggestions.length === 0) return [];

    return suggestions.slice(0, 3).map((s: any) => ({
      id: generateId(),
      text: String(s.message || "").slice(0, 280),
      timestamp: Date.now(),
    })).filter((r: SmartReply) => r.text.length > 0);
  } catch (e) {
    console.error("[smartReplies] Generation failed:", e);
    return [];
  }
}

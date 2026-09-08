import { generateChat } from "./ai";
import { getActiveProvider, getApiKey, hasAnyApiKey } from "./keys";
import { formatChatLog } from "./chatUtils";
import { summarizeSentiment, formatSentimentContext } from "./sentiment";
import { useAppStore } from "../store";
import type { SmartReply } from "../types";
import { generateId } from "./ids";

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

export async function generateSmartReplies(mentionedLines: string[]): Promise<SmartReply[]> {
  if (!canGenerateSmartReplies()) return [];
  if (!hasAnyApiKey()) return [];

  lastSmartReplyTime = Date.now();

  const state = useAppStore.getState();
  const activeProvider = getActiveProvider();

  if (!getApiKey(activeProvider)) return [];

  const sentimentHistory = state.sentimentHistory;
  let sentimentContext = "";
  if (sentimentHistory.length > 0) {
    const summary = summarizeSentiment(sentimentHistory);
    sentimentContext = formatSentimentContext(summary);
  }

  const recentChat = formatChatLog(state.chatLog.slice(-20));

  const prompt = `You are a chat co-pilot for a streamer. The streamer was just mentioned in chat. Generate 3 short, natural-sounding reply suggestions that the streamer can click to send instantly.

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
- Respond as the streamer/bot, not as a viewer
- Return EXACTLY 3 replies, one per line, no numbering or prefixes`;

  try {
    const result = await generateChat({
      streamMetadata: state.streamMetadata,
      recentChatLog: recentChat,
      config: { ...state.config, lengthPreference: "short", emoteDensity: "minimal" },
      activeProvider,
      count: 3,
      r34lEnabled: state.r34lEnabled,
      botUsername: state.streamMetadata.channelName,
      sentimentContext,
    });

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

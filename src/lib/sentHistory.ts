import type { Bot, SentMessage } from "../types";

export interface DisplaySentMessage {
  id: string;
  message: string;
  channel?: string;
  timestamp: number;
  source: string;
  botId?: string;
  botName?: string;
  dryRun?: boolean;
}

export interface SentSourcePresentation {
  label: string;
  className: string;
}

const SOURCE_PRESENTATION: Record<string, SentSourcePresentation> = {
  manual: { label: "MANUAL", className: "text-green-400 bg-green-500/10 border-green-500/20" },
  autoforge: { label: "AUTOFORGE", className: "text-red-400 bg-red-500/10 border-red-500/20" },
  followup: { label: "FOLLOWUP", className: "text-purple-400 bg-purple-500/10 border-purple-500/20" },
  smart_reply: { label: "REPLY", className: "text-cyan-300 bg-cyan-500/10 border-cyan-500/25" },
};

export function getSentSourcePresentation(source: string): SentSourcePresentation {
  const normalized = source?.trim().toLowerCase();
  return SOURCE_PRESENTATION[normalized] ?? {
    label: normalized ? normalized.replace(/[_-]+/g, " ").toUpperCase().slice(0, 18) : "OTHER",
    className: "text-gray-400 bg-white/5 border-white/10",
  };
}

/** One bounded, newest-first representation shared by Desktop and Mobile. */
export function selectMergedSentMessages(
  sentMessages: readonly SentMessage[] | null | undefined,
  bots: readonly Bot[] | null | undefined,
  limit = 100,
): DisplaySentMessage[] {
  const global = Array.isArray(sentMessages)
    ? sentMessages.map((message) => ({ ...message, botName: undefined }))
    : [];
  const perBot = Array.isArray(bots)
    ? bots.flatMap((bot) => Array.isArray(bot.runtime?.sentMessages)
      ? bot.runtime.sentMessages.map((message) => ({
          ...message,
          botId: message.botId ?? bot.id,
          botName: bot.session?.username || bot.label,
        }))
      : [])
    : [];
  return [...global, ...perBot]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, limit));
}

export function formatSentHistoryForCopy(messages: readonly DisplaySentMessage[]): string {
  return messages.map((message) => {
    const clock = new Date(message.timestamp).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const source = getSentSourcePresentation(message.source).label;
    return `[${clock}] [${source}]${message.botName ? ` [${message.botName}]` : ""} ${message.message}`;
  }).join("\n");
}

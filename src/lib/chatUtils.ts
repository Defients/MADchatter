import type { ChatMessage } from "../types";
import { generateId } from "./ids";

export function formatChatLog(messages: ChatMessage[], limit?: number): string {
  const slice = limit ? messages.slice(-limit) : messages;
  return slice
    .filter((m) => !m.marker)
    .map((m) => `${m.user}: ${m.text}`)
    .join("\n");
}

export function createChatMessage(
  user: string,
  text: string,
  platform?: string,
  twitchEmotes?: Record<string, number[][]>,
): ChatMessage {
  return {
    id: generateId(),
    user,
    text,
    timestamp: Date.now(),
    platform,
    twitchEmotes,
  };
}

export function createMarker(marker: "manual" | "autoforge"): ChatMessage {
  return {
    id: generateId(),
    user: "__MARKER__",
    text: "",
    timestamp: Date.now(),
    marker,
  };
}

/**
 * Parses the Twitch IRC `emotes` tag into a structured map.
 *
 * The raw tag format is: "emoteId:start-end,start-end/emoteId2:start-end"
 * e.g. "25:0-4/501169489:6-14,16-24"
 *
 * Returns: { "25": [[0, 4]], "501169489": [[6, 14], [16, 24]] }
 * Returns null if the tag is empty or malformed.
 */
export function parseTwitchEmoteTag(emoteTag: string | undefined): Record<string, number[][]> | undefined {
  if (!emoteTag || emoteTag === "") return undefined;
  const result: Record<string, number[][]> = {};
  try {
    for (const group of emoteTag.split("/")) {
      const [emoteId, positions] = group.split(":");
      if (!emoteId || !positions) continue;
      const ranges: number[][] = [];
      for (const pos of positions.split(",")) {
        const [start, end] = pos.split("-").map(Number);
        if (!isNaN(start) && !isNaN(end)) ranges.push([start, end]);
      }
      if (ranges.length > 0) result[emoteId] = ranges;
    }
  } catch {
    return undefined;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

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
): ChatMessage {
  return {
    id: generateId(),
    user,
    text,
    timestamp: Date.now(),
    platform,
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

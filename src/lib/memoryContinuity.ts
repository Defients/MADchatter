import type { ChatMessage } from "../types";

/**
 * Extraction cursor — tracks the processed window, not its length.
 *
 * `chatLog` is a rolling buffer capped at 150 messages (see store.ts
 * `appendChatLog`/`appendChatLogBatch`), so a count-based watermark
 * stops growing once the buffer fills and extraction never fires again.
 * The cursor stores the *set* of processed message IDs plus the audio
 * transcript tail, so new messages (and audio-only signal) are detected
 * even when the total count is stable.
 */
export interface MemoryExtractionCursor {
  messageIds: ReadonlySet<string>;
  audioTail: string;
}

export function captureMemoryExtractionCursor(chat: ChatMessage[], audio: string): MemoryExtractionCursor {
  return {
    messageIds: new Set(chat.filter((message) => !message.marker).map((message) => message.id)),
    audioTail: audio.slice(-1500),
  };
}

function appendedAudioCharacters(previous: string, current: string): number {
  if (!previous) return current.length;
  if (previous === current) return 0;
  // The transcript also rolls over: recover the suffix/prefix overlap.
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap--) {
    if (previous.endsWith(current.slice(0, overlap))) return current.length - overlap;
  }
  return current.length;
}

export function hasNewMemorySignal(chat: ChatMessage[], audio: string, cursor: MemoryExtractionCursor | null): boolean {
  const messages = chat.filter((message) => !message.marker);
  const newIds = new Set(messages.filter((message) => !cursor?.messageIds.has(message.id)).map((message) => message.id));
  const audioTail = audio.slice(-1500);
  return (messages.length >= 10 && newIds.size >= 5) ||
    (audioTail.length >= 100 && appendedAudioCharacters(cursor?.audioTail ?? "", audioTail) >= 100);
}

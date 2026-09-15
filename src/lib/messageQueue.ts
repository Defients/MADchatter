import type { QueuedMessage } from "../types";
import { generateId } from "./ids";
import { getPlatformSendFn } from "./platformSend";
import { SendCancelledError } from "./sendCancellation";

const MAX_QUEUE_SIZE = 20;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;

function getRetryDelay(retryCount: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
  return Math.min(delay, MAX_DELAY_MS);
}

export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private listeners: Set<(depth: number) => void> = new Set();
  private processing = false;
  private processingAbort: AbortController | null = null;

  enqueue(message: string, channel: string, platform: string, lastError?: string): QueuedMessage {
    const now = Date.now();
    const entry: QueuedMessage = {
      id: generateId(),
      message,
      channel,
      platform,
      timestamp: now,
      retryCount: 0,
      maxRetries: MAX_RETRIES,
      nextRetryMs: now,
      lastError,
    };
    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUE_SIZE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE_SIZE);
    }
    this.notifyListeners();
    return entry;
  }

  getDepth(): number {
    return this.queue.length;
  }

  getQueue(): QueuedMessage[] {
    return [...this.queue];
  }

  onDepthChange(listener: (depth: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    const depth = this.queue.length;
    for (const listener of this.listeners) {
      listener(depth);
    }
  }

  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    const controller = new AbortController();
    this.processingAbort = controller;

    try {
      const now = Date.now();
      const ready = this.queue.filter((m) => m.nextRetryMs <= now);
      if (ready.length === 0) return;

      for (const entry of ready) {
        if (controller.signal.aborted) break;
        if (!this.queue.includes(entry)) continue;
        try {
          const sendFn = getPlatformSendFn(entry.platform as any);
          await sendFn(entry.channel, entry.message, controller.signal);
          if (controller.signal.aborted) break;
          this.queue = this.queue.filter((m) => m.id !== entry.id);
          this.notifyListeners();
          console.log(`[MessageQueue] Successfully sent queued message: "${entry.message.slice(0, 50)}"`);
        } catch (e: any) {
          if (controller.signal.aborted) break;
          if (e instanceof SendCancelledError) {
            // Every entry in this ready snapshot belongs to the withdrawn run.
            // Preserve entries enqueued later, but never start another old send.
            this.queue = this.queue.filter((m) => !ready.includes(m));
            this.notifyListeners();
            break;
          }
          entry.retryCount++;
          entry.lastError = e?.message || "Unknown error";
          entry.nextRetryMs = Date.now() + getRetryDelay(entry.retryCount);

          if (entry.retryCount >= entry.maxRetries) {
            console.warn(`[MessageQueue] Dropping message after ${entry.maxRetries} retries: "${entry.message.slice(0, 50)}"`);
            this.queue = this.queue.filter((m) => m.id !== entry.id);
            this.notifyListeners();
          }
        }
      }
    } finally {
      this.processing = false;
      this.processingAbort = null;
    }
  }

  clear(): void {
    this.processingAbort?.abort();
    this.queue = [];
    this.notifyListeners();
  }
}

export const messageQueue = new MessageQueue();

export function startQueueProcessor(): () => void {
  const interval = setInterval(() => {
    messageQueue.processQueue().catch(console.error);
  }, 5000);
  return () => clearInterval(interval);
}

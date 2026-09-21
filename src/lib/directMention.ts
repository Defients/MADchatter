import type { SmartReply, SmartReplyFailureReason, SmartReplyNotice } from "../types";

export interface MentionTarget {
  botUsername: string;
  botId?: string;
}

export interface MentionEvent {
  messageId: string;
  botUsername: string;
  botId?: string;
  username: string;
  text: string;
  receivedAt: number;
  channel: string;
  platform: string;
  evidence: "at_mention" | "platform_reply";
  sessionRevision: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasDirectAtMention(text: string, botUsername: string): boolean {
  const normalized = botUsername.trim().replace(/^@+/, "");
  if (!text || !normalized) return false;
  // The character before @ must not be an address/identifier character. This
  // accepts punctuation and brackets while rejecting hello@botname.com.
  // The trailing negative lookahead rejects @BotNameExtra for BotName.
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escapeRegex(normalized)}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

export function smartReplyBotKey(target: Pick<MentionEvent, "botId" | "botUsername">): string {
  return target.botId ? `id:${target.botId}` : `username:${target.botUsername.trim().replace(/^@+/, "").toLowerCase()}`;
}

/**
 * High-confidence chat-only classification. Fuzzy/incidental name matching is
 * intentionally left to AutoForge context and never drives attention audio.
 */
export function classifyDirectMentionEvents(input: {
  messageId: string;
  username: string;
  text: string;
  receivedAt: number;
  channel: string;
  platform: string;
  sessionRevision: number;
  targets: MentionTarget[];
  replyTargetUsername?: string | null;
}): MentionEvent[] {
  const replyTarget = input.replyTargetUsername?.trim().replace(/^@+/, "").toLowerCase() || null;
  const uniqueTargets = new Map<string, MentionTarget>();
  for (const target of input.targets) {
    const normalized = target.botUsername.trim().replace(/^@+/, "").toLowerCase();
    if (normalized && !uniqueTargets.has(normalized)) uniqueTargets.set(normalized, target);
  }
  const events: MentionEvent[] = [];
  for (const [normalized, target] of uniqueTargets) {
    const evidence = replyTarget === normalized
      ? "platform_reply" as const
      : hasDirectAtMention(input.text, target.botUsername)
        ? "at_mention" as const
        : null;
    if (!evidence) continue;
    events.push({
      messageId: input.messageId,
      botUsername: target.botUsername,
      botId: target.botId,
      username: input.username,
      text: input.text,
      receivedAt: input.receivedAt,
      channel: input.channel,
      platform: input.platform,
      evidence,
      sessionRevision: input.sessionRevision,
    });
  }
  return events;
}

export class SmartReplyRequestError extends Error {
  constructor(public readonly reason: SmartReplyFailureReason, message: string) {
    super(message);
    this.name = "SmartReplyRequestError";
  }
}

export interface DirectMentionCoordinatorDeps {
  now: () => number;
  acknowledge: (event: MentionEvent, alertUser: boolean) => void | Promise<void>;
  smartRepliesEnabled: () => boolean;
  generate: (event: MentionEvent, signal: AbortSignal) => Promise<SmartReply[]>;
  isSessionCurrent: (event: MentionEvent) => boolean;
  setReplies: (replies: SmartReply[]) => void;
  setLoading: (loading: boolean) => void;
  setNotice: (notice: SmartReplyNotice | null) => void;
}

export type MentionHandleResult =
  | "duplicate"
  | "acknowledged"
  | "spam_guard"
  | "stale"
  | "ready"
  | "unavailable"
  | "error";

const DEDUP_TTL_MS = 2 * 60_000;
const MAX_DEDUP_KEYS = 256;
const SPAM_WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 6;
export const ATTENTION_COALESCE_MS = 2_000;

export class DirectMentionCoordinator {
  private processed = new Map<string, number>();
  private requestTimes = new Map<string, number[]>();
  /** One active provider request per stable bot identity. */
  private activeRequests = new Map<string, { key: string; controller: AbortController; supersede: () => void }>();
  private lastAttentionAt = new Map<string, number>();

  reset(): void {
    for (const request of this.activeRequests.values()) request.controller.abort();
    this.processed.clear();
    this.requestTimes.clear();
    this.activeRequests.clear();
    this.lastAttentionAt.clear();
  }

  private prune(now: number): void {
    for (const [key, timestamp] of this.processed) {
      if (now - timestamp > DEDUP_TTL_MS) this.processed.delete(key);
    }
    while (this.processed.size > MAX_DEDUP_KEYS) {
      const oldest = this.processed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.processed.delete(oldest);
    }
  }

  private requestAllowed(target: Pick<MentionEvent, "botId" | "botUsername">, now: number): boolean {
    const key = smartReplyBotKey(target);
    const recent = (this.requestTimes.get(key) ?? []).filter((timestamp) => now - timestamp <= SPAM_WINDOW_MS);
    if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
      this.requestTimes.set(key, recent);
      return false;
    }
    recent.push(now);
    this.requestTimes.set(key, recent);
    return true;
  }

  async handle(event: MentionEvent, deps: DirectMentionCoordinatorDeps): Promise<MentionHandleResult> {
    const now = deps.now();
    this.prune(now);
    const dedupKey = `${event.botUsername.toLowerCase()}:${event.messageId}`;
    if (this.processed.has(dedupKey)) return "duplicate";
    this.processed.set(dedupKey, now);

    // Acknowledgement happens before any provider work and failures are
    // isolated: audio/notification policy can never break chat ingestion.
    try {
      const botKey = smartReplyBotKey(event);
      const lastAlert = this.lastAttentionAt.get(botKey) ?? -Infinity;
      const alertUser = now - lastAlert >= ATTENTION_COALESCE_MS;
      if (alertUser) this.lastAttentionAt.set(botKey, now);
      const acknowledgement = deps.acknowledge(event, alertUser);
      if (acknowledgement && typeof (acknowledgement as Promise<void>).catch === "function") {
        void (acknowledgement as Promise<void>).catch(() => {});
      }
    } catch { /* intentionally isolated */ }

    if (!deps.smartRepliesEnabled()) return "acknowledged";
    if (!this.requestAllowed(event, now)) {
      const botKey = smartReplyBotKey(event);
      const active = this.activeRequests.get(botKey);
      active?.controller.abort();
      active?.supersede();
      this.activeRequests.delete(botKey);
      deps.setLoading(false);
      deps.setNotice({
        state: "unavailable",
        messageId: event.messageId,
        username: event.username,
        botUsername: event.botUsername,
        text: event.text,
        receivedAt: event.receivedAt,
        reason: "spam_guard",
        message: "Smart Replies paused briefly after a burst of mentions.",
      });
      return "spam_guard";
    }

    const botKey = smartReplyBotKey(event);
    const prior = this.activeRequests.get(botKey);
    prior?.controller.abort();
    prior?.supersede();
    const controller = new AbortController();
    this.activeRequests.set(botKey, {
      key: dedupKey,
      controller,
      supersede: () => {
        deps.setReplies([]);
        deps.setNotice(null);
        deps.setLoading(false);
      },
    });
    deps.setReplies([]);
    deps.setNotice({
      state: "loading",
      messageId: event.messageId,
      username: event.username,
      botUsername: event.botUsername,
      text: event.text,
      receivedAt: event.receivedAt,
    });
    deps.setLoading(true);

    try {
      const replies = await deps.generate(event, controller.signal);
      if (!deps.isSessionCurrent(event) || this.activeRequests.get(botKey)?.key !== dedupKey) return "stale";
      if (!deps.smartRepliesEnabled()) {
        deps.setReplies([]);
        deps.setNotice(null);
        return "stale";
      }
      if (replies.length === 0) {
        throw new SmartReplyRequestError("no_usable_reply", "The provider returned no usable Smart Replies.");
      }
      deps.setReplies(replies);
      deps.setNotice({
        state: "ready",
        messageId: event.messageId,
        username: event.username,
        botUsername: event.botUsername,
        text: event.text,
        receivedAt: event.receivedAt,
      });
      return "ready";
    } catch (error) {
      if (!deps.isSessionCurrent(event) || this.activeRequests.get(botKey)?.key !== dedupKey || controller.signal.aborted) return "stale";
      const known = error instanceof SmartReplyRequestError ? error : null;
      const reason = known?.reason ?? "generation_failed";
      deps.setNotice({
        state: reason === "generation_failed" ? "error" : "unavailable",
        messageId: event.messageId,
        username: event.username,
        botUsername: event.botUsername,
        text: event.text,
        receivedAt: event.receivedAt,
        reason,
        message: known?.message ?? "Smart Reply generation failed. Try again on the next mention.",
      });
      return reason === "generation_failed" ? "error" : "unavailable";
    } finally {
      if (this.activeRequests.get(botKey)?.key === dedupKey) {
        this.activeRequests.delete(botKey);
        // Loading belongs to the shared surface, not the old channel. Clear it
        // even when the session became stale; resetDirectMentionHandling also
        // clears replies/notice synchronously at the transition boundary.
        deps.setLoading(false);
      }
    }
  }
}

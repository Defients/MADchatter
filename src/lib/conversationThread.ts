/**
 * Conversation Threading — lightweight Twitch reply-thread tracker.
 *
 * Problem: the bot has no concept of conversation threads. When user A replies
 * to the bot's message, then user B replies to user A, the bot can't
 * distinguish a directed reply from a general comment. The existing
 * twitchReplyCache.ts captures message IDs for mention rendering but doesn't
 * use them for context.
 *
 * Solution: this module captures `reply-parent-msg-id` from incoming Twitch
 * messages (standard IRC tag), maintains a bounded map of message metadata +
 * parent links, and exposes helpers to find active threads (chains of replies
 * to a bot message) so the AutoForge decision loops can inject thread context
 * into the prompt — the bot knows when it's being replied to and can maintain
 * coherent multi-turn exchanges.
 *
 * Twitch-only: Kick and Joystick don't support IRC reply tags, so threading
 * is only available on Twitch (same scope as the reply-cache mention
 * rendering).
 *
 * Bounded: 200 entries max, 10-minute TTL. Cleared on channel switch.
 */

export interface ThreadedMessage {
  /** Twitch message ID (tags.id). */
  id: string;
  /** Username of the sender (lowercase). */
  username: string;
  /** Message text. */
  text: string;
  /** Unix-ms timestamp. */
  timestamp: number;
  /** Parent message ID (reply-parent-msg-id tag). null = top-level message. */
  parentId: string | null;
  /** Parent username if the parent is known in the cache. */
  parentUsername: string | null;
}

export interface ActiveThread {
  /** The root message ID (the bot's message that started the thread). */
  rootId: string;
  /** The bot's message text. */
  rootText: string;
  /** All replies in the thread (chronological). */
  replies: ThreadedMessage[];
  /** Total reply count. */
  replyCount: number;
  /** Whether the thread has had activity in the last N minutes. */
  recentActivity: boolean;
  /** Timestamp of the most recent reply. */
  lastActivityAt: number;
}

const MAX_ENTRIES = 200;
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const RECENT_ACTIVITY_MS = 5 * 60 * 1000; // 5 minutes

/** Map of messageId → ThreadedMessage. */
const messageMap = new Map<string, ThreadedMessage>();

/** Set of known bot message IDs (recorded when the bot sends a message). */
const botMessageIds = new Set<string>();

/** Channel scope — cleared on switch. */
let currentChannel: string | null = null;

/**
 * Prune entries older than TTL. Called on every insert to keep the map
 * bounded without a separate timer.
 */
function pruneExpired(): void {
  const now = Date.now();
  for (const [id, msg] of messageMap) {
    if (now - msg.timestamp > TTL_MS) {
      messageMap.delete(id);
      botMessageIds.delete(id);
    }
  }
}

/** Enforce the advertised bound even when a busy channel never hits the TTL. */
function enforceCapacity(): void {
  while (messageMap.size > MAX_ENTRIES) {
    const oldestId = messageMap.keys().next().value!;
    messageMap.delete(oldestId);
    botMessageIds.delete(oldestId);
  }
  // App.tsx marks bot IDs before recording their messages. Keep that ordering
  // supported without allowing standalone markers to grow indefinitely.
  while (botMessageIds.size > MAX_ENTRIES) {
    botMessageIds.delete(botMessageIds.values().next().value!);
  }
}

/**
 * Record an incoming Twitch message with its reply-parent tag (if any).
 * Called from App.tsx's `client.on('message')` handler.
 *
 * @param id - Twitch message ID (tags.id)
 * @param username - Sender's display name or username
 * @param text - Message text
 * @param parentId - The reply-parent-msg-id tag value (null if not a reply)
 */
export function recordIncomingMessage(
  id: string,
  username: string,
  text: string,
  parentId: string | null,
): void {
  if (!id) return;
  pruneExpired();

  // Look up the parent's username if the parent is in our cache.
  let parentUsername: string | null = null;
  if (parentId) {
    const parent = messageMap.get(parentId);
    if (parent) parentUsername = parent.username;
  }

  messageMap.set(id, {
    id,
    username: username.toLowerCase(),
    text,
    timestamp: Date.now(),
    parentId,
    parentUsername,
  });
  enforceCapacity();
}

/**
 * Record an outgoing bot message so we can track threads rooted at the bot's
 * messages. Called from the send path after a successful send.
 *
 * Note: Twitch doesn't return the message ID from a PRIVMSG send via tmi.js,
 * so we can't always capture the exact ID. When the bot's own messages appear
 * in the `client.on('message')` handler (self=true), we can capture the ID
 * there. This function is a fallback for when we want to manually register a
 * bot message ID.
 *
 * @param id - The bot's message ID (if known)
 * @param username - The bot's username
 * @param text - The message text
 */
export function recordBotMessage(
  id: string,
  username: string,
  text: string,
): void {
  if (!id) return;
  pruneExpired();
  botMessageIds.add(id);
  messageMap.set(id, {
    id,
    username: username.toLowerCase(),
    text,
    timestamp: Date.now(),
    parentId: null,
    parentUsername: null,
  });
  enforceCapacity();
}

/**
 * Mark a message ID as a bot message (when the bot's own message comes back
 * through the `client.on('message')` handler with self=true, or when we
 * know the ID from the send path). This lets us identify thread roots.
 */
export function markAsBotMessage(id: string): void {
  if (!id) return;
  botMessageIds.add(id);
  enforceCapacity();
}

/**
 * Walk up the parent chain from a message to find the thread root.
 * Returns the root message ID, or null if the chain is broken (parent not
 * in cache) or exceeds max depth.
 */
function findThreadRoot(messageId: string, maxDepth = 10): string | null {
  let current = messageId;
  for (let i = 0; i < maxDepth; i++) {
    const msg = messageMap.get(current);
    if (!msg) return null;
    if (msg.parentId === null) return current; // top-level = root
    current = msg.parentId;
  }
  return null; // chain too deep
}

/**
 * Collect all messages that are replies (direct or transitive) to a given
 * root message ID. Walks the entire map looking for messages whose parent
 * chain leads back to the root.
 */
function collectReplies(rootId: string): ThreadedMessage[] {
  const replies: ThreadedMessage[] = [];
  for (const msg of messageMap.values()) {
    if (msg.id === rootId) continue;
    // Fast path: direct reply to root.
    if (msg.parentId === rootId) {
      replies.push(msg);
      continue;
    }
    // Slow path: walk up the chain to see if it leads to root.
    if (findThreadRoot(msg.id) === rootId) {
      replies.push(msg);
    }
  }
  replies.sort((a, b) => a.timestamp - b.timestamp);
  return replies;
}

/**
 * Get all active threads (threads rooted at a bot message with recent
 * reply activity). Used by the AutoForge loops to inject thread context
 * into the decision prompt.
 *
 * @param botUsername - The bot's username (lowercase) to identify thread roots.
 *   If omitted, uses all messages marked as bot messages via recordBotMessage.
 * @returns Active threads sorted by most recent activity.
 */
export function getActiveThreads(botUsername?: string): ActiveThread[] {
  pruneExpired();
  const now = Date.now();
  const threads: ActiveThread[] = [];

  // An explicit identity must constrain marked roots too: otherwise another
  // bot's conversation is presented as "You" in this bot's AI context.
  const normalizedBotUsername = botUsername?.toLowerCase();
  const rootIds = new Set<string>();
  for (const [id, msg] of messageMap) {
    if (normalizedBotUsername && msg.username !== normalizedBotUsername) continue;
    if (botMessageIds.has(id)) {
      rootIds.add(id);
    } else if (normalizedBotUsername && msg.parentId === null) {
      rootIds.add(id);
    }
  }

  for (const rootId of rootIds) {
    const root = messageMap.get(rootId);
    if (!root) continue;
    const replies = collectReplies(rootId);
    if (replies.length === 0) continue; // no replies = no active thread

    const lastActivityAt = replies.length > 0
      ? replies[replies.length - 1].timestamp
      : root.timestamp;
    const recentActivity = now - lastActivityAt < RECENT_ACTIVITY_MS;

    threads.push({
      rootId,
      rootText: root.text,
      replies,
      replyCount: replies.length,
      recentActivity,
      lastActivityAt,
    });
  }

  // Sort by most recent activity first.
  threads.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return threads;
}

/**
 * Format active threads into a compact context block for the AutoForge
 * decision prompt. Returns an empty string when there are no active threads.
 *
 * Example output:
 *   [ACTIVE CONVERSATION THREADS — users are replying to your messages]
 *   Thread 1 (3 replies, 2m ago):
 *   - You: "that clutch play was insane"
 *   - @viewer1: "fr that was unreal"
 *   - @viewer2: "agree with the bot on this one"
 */
export function formatThreadContext(botUsername?: string): string {
  const threads = getActiveThreads(botUsername);
  if (threads.length === 0) return "";

  const parts: string[] = ["[ACTIVE CONVERSATION THREADS — users are replying to your messages]"];
  const now = Date.now();

  for (let i = 0; i < threads.length && i < 3; i++) {
    const t = threads[i];
    const minsAgo = Math.round((now - t.lastActivityAt) / 60000);
    const agoLabel = minsAgo < 1 ? "just now" : `${minsAgo}m ago`;
    parts.push(`Thread ${i + 1} (${t.replyCount} ${t.replyCount === 1 ? "reply" : "replies"}, ${agoLabel}):`);
    parts.push(`- You: "${t.rootText.slice(0, 120)}"`);
    for (const reply of t.replies.slice(-4)) {
      parts.push(`- @${reply.username}: "${reply.text.slice(0, 120)}"`);
    }
  }

  return parts.join("\n");
}

/**
 * Clear all thread data. Called on channel switch (parity with
 * twitchReplyCache.ts which also clears on switch).
 */
export function clearThreadData(): void {
  messageMap.clear();
  botMessageIds.clear();
}

/**
 * Set the current channel scope. When the channel changes, all thread data
 * is cleared (threads don't carry across channels).
 */
export function setThreadChannel(channel: string | null): void {
  if (channel !== currentChannel) {
    clearThreadData();
    currentChannel = channel;
  }
}

/**
 * Get the current number of tracked messages (for diagnostics).
 */
export function getThreadMessageCount(): number {
  return messageMap.size;
}

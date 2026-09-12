/**
 * Twitch message-ID cache for reply-based mentions.
 *
 * Twitch's web chat only renders `@username` as a "special" clickable
 * mention when the user is currently in the channel's chatters list. When
 * a bot sends `@username` via IRC, users who aren't present (or other bots
 * that haven't spoken recently) render as plain text.
 *
 * The fix: Twitch's IRC supports reply tags. When you send a PRIVMSG with
 * `@reply-parent-msg-id=<id>`, Twitch creates a reply thread and renders
 * the parent user's name as a highlighted, clickable mention — regardless
 * of whether they're in the channel.
 *
 * This module caches the most recent Twitch message ID per username so the
 * send path can auto-attach reply tags when a message mentions a user we've
 * seen recently.
 */

/** Maximum age of a cached message ID before it's considered stale (10 min). */
const MAX_AGE_MS = 10 * 60_000;
/** Maximum cache size to prevent unbounded growth. */
const MAX_ENTRIES = 500;

interface CachedMsgId {
  id: string;
  username: string;
  ts: number;
}

/** Map: lowercase username → most recent message ID + metadata. */
const cache = new Map<string, CachedMsgId>();

/** Normalize a username for cache keying (Twitch logins are lowercase). */
function normalizeKey(username: string): string {
  return username.toLowerCase().replace(/^@/, "");
}

/** Record a Twitch message ID from an incoming chat message. */
export function recordTwitchMessageId(username: string, messageId: string): void {
  if (!username || !messageId) return;
  const key = normalizeKey(username);
  cache.set(key, { id: messageId, username, ts: Date.now() });
  // Evict oldest entries if cache grows too large.
  if (cache.size > MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
}

/**
 * Look up the most recent message ID for a username.
 * Returns null if not cached or stale (>10 min old).
 */
export function getTwitchMessageId(username: string): string | null {
  const key = normalizeKey(username);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > MAX_AGE_MS) {
    cache.delete(key);
    return null;
  }
  return entry.id;
}

/**
 * Scan a message for `@username` mentions and return the best reply target
 * message ID (the most recently seen user who is mentioned in the message).
 * Returns null if no mentioned user has a cached message ID.
 *
 * Mention format: `@username` where username is 4-25 alphanumeric/underscore
 * chars. Must have a word boundary before `@` (start of string, whitespace,
 * or punctuation that isn't `@`).
 */
export function findReplyTargetFromMentions(message: string): string | null {
  // Match @username with word boundary before @.
  // Twitch usernames: 4-25 chars, [a-zA-Z0-9_], must start with a letter.
  const mentionRegex = /(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]{2,24})/g;
  let match: RegExpExecArray | null;
  let bestId: string | null = null;
  let bestTs = 0;
  while ((match = mentionRegex.exec(message)) !== null) {
    const username = match[1];
    const id = getTwitchMessageId(username);
    if (id) {
      const entry = cache.get(normalizeKey(username));
      if (entry && entry.ts > bestTs) {
        bestTs = entry.ts;
        bestId = id;
      }
    }
  }
  return bestId;
}

/** Clear the cache (used on channel switch). */
export function clearTwitchMessageIdCache(): void {
  cache.clear();
}

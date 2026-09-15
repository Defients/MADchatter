// ─── 7TV + FrankerFaceZ Emote Service ────────────────────────────────────────
// Fetches global + channel-specific emotes from 7TV and FrankerFaceZ,
// builds a name→URL map, and provides a text parser that splits chat messages
// into text segments and emote images.

export interface Emote {
  name: string;
  url: string;
  provider: "7tv" | "ffz" | "bttv";
  /** Whether this emote is channel-specific or global. Channel emotes are
   *  more contextual and should be favored by the AI over global ones. */
  scope?: "channel" | "global";
  width?: number;
  height?: number;
}

// Network/CORS failures are already surfaced by the browser console; only warn
// on genuinely unexpected errors so the console isn't flooded with duplicates.
const isNetworkError = (e: unknown) =>
  e instanceof TypeError && /fetch/i.test(e.message);

type EmoteMap = Map<string, Emote>;

interface ChannelCache {
  channel: string;
  emotes: EmoteMap;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const channelCache: Map<string, ChannelCache> = new Map();
let globalEmotes: EmoteMap | null = null;
let globalEmotesPromise: Promise<EmoteMap> | null = null;

// ─── 7TV ─────────────────────────────────────────────────────────────────────

interface SevenTVEmote {
  name: string;
  data: {
    host: {
      url: string;
      files: { name: string; format: string; width: number; height: number }[];
    };
  };
}

interface SevenTVEmoteSet {
  emotes: SevenTVEmote[];
}

interface SevenTVUser {
  emote_set_ids?: string[];
  connections?: { platform: string; id: string }[];
}

async function fetch7TVGlobal(): Promise<Emote[]> {
  try {
    const res = await fetch("https://7tv.io/v3/emote-sets/global");
    if (!res.ok) return [];
    const data: SevenTVEmoteSet = await res.json();
    return (data.emotes || []).map((e) => {
      const file = e.data.host.files.find((f) => f.format === "WEBP") || e.data.host.files[0];
      return {
        name: e.name,
        url: `https:${e.data.host.url}/${file?.name || "1x.webp"}`,
        provider: "7tv" as const,
        scope: "global" as const,
        width: file?.width,
        height: file?.height,
      };
    });
  } catch (e) {
    if (!isNetworkError(e)) console.warn("[emotes] fetch7TVGlobal failed:", e);
    return [];
  }
}

async function fetch7TVChannel(channelName: string): Promise<Emote[]> {
  try {
    // Look up user by Twitch login
    const userRes = await fetch(`https://7tv.io/v3/users/twitch/${encodeURIComponent(channelName)}`);
    if (!userRes.ok) return [];
    const userData: SevenTVUser = await userRes.json();
    const setIds = userData.emote_set_ids || [];
    if (setIds.length === 0) return [];

    const emotes: Emote[] = [];
    for (const setId of setIds) {
      try {
        const setRes = await fetch(`https://7tv.io/v3/emote-sets/${setId}`);
        if (!setRes.ok) continue;
        const setData: SevenTVEmoteSet = await setRes.json();
        for (const e of setData.emotes || []) {
          const file = e.data.host.files.find((f) => f.format === "WEBP") || e.data.host.files[0];
          emotes.push({
            name: e.name,
            url: `https:${e.data.host.url}/${file?.name || "1x.webp"}`,
            provider: "7tv" as const,
            scope: "channel" as const,
            width: file?.width,
            height: file?.height,
          });
        }
      } catch (e) {
        if (!isNetworkError(e)) console.warn(`[emotes] fetch7TVChannel set ${setId} failed:`, e);
      }
    }
    return emotes;
  } catch (e) {
    if (!isNetworkError(e)) console.warn(`[emotes] fetch7TVChannel(${channelName}) failed:`, e);
    return [];
  }
}

// ─── FrankerFaceZ ─────────────────────────────────────────────────────────────

interface FFZEmote {
  name: string;
  urls: { [size: string]: string };
  width?: number;
  height?: number;
}

interface FFZRoomResponse {
  sets: { [setId: string]: { emotes: FFZEmote[] } };
}

interface FFZGlobalResponse {
  sets: { [setId: string]: { emotes: FFZEmote[] } };
}

function parseFFZEmotes(data: FFZRoomResponse | FFZGlobalResponse, scope: "channel" | "global" = "channel"): Emote[] {
  const emotes: Emote[] = [];
  for (const setId of Object.keys(data.sets || {})) {
    for (const e of data.sets[setId].emotes || []) {
      const sizes = Object.keys(e.urls || {}).sort((a, b) => Number(a) - Number(b));
      const smallest = sizes[0];
      if (smallest && e.urls[smallest]) {
        const url = e.urls[smallest].startsWith("//")
          ? `https:${e.urls[smallest]}`
          : e.urls[smallest];
        emotes.push({
          name: e.name,
          url,
          provider: "ffz" as const,
          scope,
          width: e.width,
          height: e.height,
        });
      }
    }
  }
  return emotes;
}

async function fetchFFZGlobal(): Promise<Emote[]> {
  try {
    const res = await fetch("https://api.frankerfacez.com/v1/set/global");
    if (!res.ok) return [];
    return parseFFZEmotes(await res.json(), "global");
  } catch (e) {
    if (!isNetworkError(e)) console.warn("[emotes] fetchFFZGlobal failed:", e);
    return [];
  }
}

async function fetchFFZChannel(channelName: string): Promise<Emote[]> {
  try {
    const res = await fetch(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(channelName)}`);
    if (!res.ok) return [];
    return parseFFZEmotes(await res.json());
  } catch (e) {
    if (!isNetworkError(e)) console.warn(`[emotes] fetchFFZChannel(${channelName}) failed:`, e);
    return [];
  }
}

// ─── BetterTTV ────────────────────────────────────────────────────────────────

interface BTTVEmote {
  id: string;
  code: string;
  imageType: string;
  userId?: string;
}

interface BTTVChannelResponse {
  channelEmotes: BTTVEmote[];
  sharedEmotes: BTTVEmote[];
}

async function fetchBTTVGlobal(): Promise<Emote[]> {
  try {
    const res = await fetch("https://api.betterttv.net/3/emotes/global");
    if (!res.ok) return [];
    const data: BTTVEmote[] = await res.json();
    return data.map((e) => ({
      name: e.code,
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.${e.imageType || "webp"}`,
      provider: "bttv" as const,
      scope: "global" as const,
    }));
  } catch (e) {
    if (!isNetworkError(e)) console.warn("[emotes] fetchBTTVGlobal failed:", e);
    return [];
  }
}

async function fetchBTTVChannel(twitchUserId: string): Promise<Emote[]> {
  try {
    const res = await fetch(`https://api.betterttv.net/3/users/twitch/${encodeURIComponent(twitchUserId)}`);
    if (!res.ok) return [];
    const data: BTTVChannelResponse = await res.json();
    const all = [...(data.channelEmotes || []), ...(data.sharedEmotes || [])];
    return all.map((e) => ({
      name: e.code,
      url: `https://cdn.betterttv.net/emote/${e.id}/1x.${e.imageType || "webp"}`,
      provider: "bttv" as const,
      scope: "channel" as const,
    }));
  } catch (e) {
    if (!isNetworkError(e)) console.warn(`[emotes] fetchBTTVChannel(${twitchUserId}) failed:`, e);
    return [];
  }
}

// ─── Combined API ─────────────────────────────────────────────────────────────

export interface EmoteProviderConfig {
  sevenTV: boolean;
  ffz: boolean;
  bttv: boolean;
}

const DEFAULT_PROVIDERS: EmoteProviderConfig = {
  sevenTV: true,
  ffz: true,
  bttv: true,
};

async function loadGlobalEmotes(providers: EmoteProviderConfig = DEFAULT_PROVIDERS): Promise<EmoteMap> {
  if (globalEmotes) return globalEmotes;
  if (globalEmotesPromise) return globalEmotesPromise;

  globalEmotesPromise = (async () => {
    const tasks: Promise<Emote[]>[] = [];
    if (providers.sevenTV) tasks.push(fetch7TVGlobal());
    if (providers.ffz) tasks.push(fetchFFZGlobal());
    if (providers.bttv) tasks.push(fetchBTTVGlobal());
    const results = await Promise.all(tasks);
    const map: EmoteMap = new Map();
    for (const e of results.flat()) {
      if (!map.has(e.name)) map.set(e.name, e);
    }
    globalEmotes = map;
    return map;
  })();

  return globalEmotesPromise;
}

export async function loadChannelEmotes(
  channelName: string,
  options?: { providers?: EmoteProviderConfig; twitchUserId?: string },
): Promise<EmoteMap> {
  const key = channelName.toLowerCase();
  const cached = channelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.emotes;
  }

  const providers = options?.providers ?? DEFAULT_PROVIDERS;
  const twitchUserId = options?.twitchUserId;

  const tasks: Promise<EmoteMap | Emote[]>[] = [loadGlobalEmotes(providers)];
  if (providers.sevenTV) tasks.push(fetch7TVChannel(channelName));
  if (providers.ffz) tasks.push(fetchFFZChannel(channelName));
  if (providers.bttv && twitchUserId) tasks.push(fetchBTTVChannel(twitchUserId));

  const results = await Promise.all(tasks);
  const global = results[0] as EmoteMap;
  const channelEmotes = results.slice(1).flat() as Emote[];

  const map: EmoteMap = new Map(global);
  // Channel emotes override globals (same name → channel-specific version)
  for (const e of channelEmotes) {
    map.set(e.name, e);
  }

  channelCache.set(key, {
    channel: key,
    emotes: map,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return map;
}

export function getCachedChannelEmotes(channelName: string): EmoteMap | null {
  const key = channelName.toLowerCase();
  const cached = channelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.emotes;
  }
  // Remove expired entry so the Map doesn't grow unbounded
  if (cached) channelCache.delete(key);
  return null;
}

export function clearEmoteCache(channelName?: string): void {
  if (channelName) {
    channelCache.delete(channelName.toLowerCase());
  } else {
    channelCache.clear();
    globalEmotes = null;
    globalEmotesPromise = null;
  }
}

// ─── Text Parsing ─────────────────────────────────────────────────────────────

export type TextSegment =
  | { type: "text"; content: string }
  | { type: "emote"; name: string; url: string; provider: string };

/**
 * Returns up to `limit` emote names from the cached channel emotes,
 * prioritizing channel-specific emotes first, then globals.
 * Used to inform the AI what emotes are available to use.
 */
export function getAvailableEmoteNames(channelName: string, limit = 50): string[] {
  const map = getCachedChannelEmotes(channelName);
  if (!map || map.size === 0) return [];
  const all = Array.from(map.values());
  // Channel emotes first (non-global providers take priority by name specificity)
  const channelEmotes = all.filter((e) => e.provider !== "7tv" || !globalEmotes?.has(e.name));
  const names = channelEmotes.length > 0 ? channelEmotes : all;
  return names.slice(0, limit).map((e) => e.name);
}

/**
 * Returns up to `limit` emote names tagged with their provider and scope,
 * formatted as `"name (provider-scope)"` (e.g. `"monkaS (7tv-channel)"`).
 * Channel-specific emotes are listed first, then globals.
 *
 * Used by the AI prompt so the model knows which emotes are channel-specific
 * (BTTV/7TV/FFZ channel emotes — favor these) vs global (use sparingly).
 * The AI is instructed to favor channel-specific emotes and rarely use
 * "standard" emotes not in this list.
 */
export function getAvailableEmotesTagged(channelName: string, limit = 50): string[] {
  const map = getCachedChannelEmotes(channelName);
  if (!map || map.size === 0) return [];
  const all = Array.from(map.values());
  // Channel emotes first, then globals — same priority as getAvailableEmoteNames
  const channel = all.filter((e) => e.scope === "channel");
  const global = all.filter((e) => e.scope !== "channel");
  const ordered = channel.length > 0 ? [...channel, ...global] : all;
  return ordered.slice(0, limit).map((e) => {
    const scope = e.scope === "channel" ? "channel" : "global";
    return `${e.name} (${e.provider}-${scope})`;
  });
}

// Memoized emote regex — avoids rebuilding on every parse call
let _emoteRegexCache: { key: string; regex: RegExp } | null = null;

function getEmoteRegex(emoteMap: EmoteMap): RegExp | null {
  if (emoteMap.size === 0) return null;
  const names = Array.from(emoteMap.keys()).sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  // Cache key: joined names — if the set hasn't changed, reuse the regex
  const key = names.join("|");
  if (_emoteRegexCache && _emoteRegexCache.key === key) {
    return _emoteRegexCache.regex;
  }
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "g");
  _emoteRegexCache = { key, regex };
  return regex;
}

export function parseEmotes(text: string, emoteMap: EmoteMap | null): TextSegment[] {
  if (!emoteMap || emoteMap.size === 0) return [{ type: "text", content: text }];

  const pattern = getEmoteRegex(emoteMap);
  if (!pattern) return [{ type: "text", content: text }];

  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state for each use (shared regex with /g flag)
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) !== null) {
    // Add preceding text
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    // Add emote
    const emote = emoteMap.get(match[0]);
    if (emote) {
      segments.push({ type: "emote", name: emote.name, url: emote.url, provider: emote.provider });
    }
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

/**
 * Parses Twitch native emotes from IRC tags.
 *
 * Twitch sends emote data as `tags.emotes` in the format:
 *   "emoteId:start-end,start-end/emoteId2:start-end"
 * e.g. "25:0-4/501169489:6-14,16-24" means emote ID 25 at chars 0-4,
 * and emote ID 501169489 at chars 6-14 and 16-24.
 *
 * This function takes that parsed structure (emoteId → [[start, end], ...])
 * and produces TextSegments with Twitch CDN emote URLs.
 */
export function parseTwitchEmotes(
  text: string,
  twitchEmotes: Record<string, number[][]>,
): TextSegment[] {
  // Collect all emote ranges sorted by start position
  const ranges: { start: number; end: number; emoteId: string }[] = [];
  for (const [emoteId, positions] of Object.entries(twitchEmotes)) {
    for (const [start, end] of positions) {
      ranges.push({ start, end, emoteId });
    }
  }
  if (ranges.length === 0) return [{ type: "text", content: text }];
  ranges.sort((a, b) => a.start - b.start);

  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const range of ranges) {
    // Add preceding text
    if (range.start > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, range.start) });
    }
    // Extract the emote name from the text
    const emoteName = text.slice(range.start, range.end + 1);
    // Twitch emote CDN URL (1x = small, 2x = medium, 3x = large)
    const url = `https://static-cdn.jtvnw.net/emoticons/v2/${range.emoteId}/default/dark/1.0`;
    segments.push({ type: "emote", name: emoteName, url, provider: "twitch" });
    lastIndex = range.end + 1;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: "text", content: text }];
}

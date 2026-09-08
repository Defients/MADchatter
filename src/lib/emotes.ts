// ─── 7TV + FrankerFaceZ Emote Service ────────────────────────────────────────
// Fetches global + channel-specific emotes from 7TV and FrankerFaceZ,
// builds a name→URL map, and provides a text parser that splits chat messages
// into text segments and emote images.

export interface Emote {
  name: string;
  url: string;
  provider: "7tv" | "ffz";
  width?: number;
  height?: number;
}

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
        width: file?.width,
        height: file?.height,
      };
    });
  } catch {
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
            width: file?.width,
            height: file?.height,
          });
        }
      } catch {
        // skip failed set
      }
    }
    return emotes;
  } catch {
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

function parseFFZEmotes(data: FFZRoomResponse | FFZGlobalResponse): Emote[] {
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
    return parseFFZEmotes(await res.json());
  } catch {
    return [];
  }
}

async function fetchFFZChannel(channelName: string): Promise<Emote[]> {
  try {
    const res = await fetch(`https://api.frankerfacez.com/v1/room/${encodeURIComponent(channelName)}`);
    if (!res.ok) return [];
    return parseFFZEmotes(await res.json());
  } catch {
    return [];
  }
}

// ─── Combined API ─────────────────────────────────────────────────────────────

async function loadGlobalEmotes(): Promise<EmoteMap> {
  if (globalEmotes) return globalEmotes;
  if (globalEmotesPromise) return globalEmotesPromise;

  globalEmotesPromise = (async () => {
    const [sevenTv, ffz] = await Promise.all([
      fetch7TVGlobal(),
      fetchFFZGlobal(),
    ]);
    const map: EmoteMap = new Map();
    for (const e of [...sevenTv, ...ffz]) {
      if (!map.has(e.name)) map.set(e.name, e);
    }
    globalEmotes = map;
    return map;
  })();

  return globalEmotesPromise;
}

export async function loadChannelEmotes(channelName: string): Promise<EmoteMap> {
  const key = channelName.toLowerCase();
  const cached = channelCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.emotes;
  }

  const [global, sevenTvChannel, ffzChannel] = await Promise.all([
    loadGlobalEmotes(),
    fetch7TVChannel(channelName),
    fetchFFZChannel(channelName),
  ]);

  const map: EmoteMap = new Map(global);
  // Channel emotes override globals (same name → channel-specific version)
  for (const e of [...ffzChannel, ...sevenTvChannel]) {
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

export function parseEmotes(text: string, emoteMap: EmoteMap | null): TextSegment[] {
  if (!emoteMap || emoteMap.size === 0) return [{ type: "text", content: text }];

  // Build a regex that matches any emote name as a whole word
  // Sort by length descending so longer emote names match first
  const names = Array.from(emoteMap.keys()).sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ type: "text", content: text }];

  // Escape regex special characters in emote names
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "g");

  const segments: TextSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

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

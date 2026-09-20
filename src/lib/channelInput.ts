const SUPPORTED_CHANNEL_HOSTS = new Set([
  "twitch.tv",
  "www.twitch.tv",
  "m.twitch.tv",
  "kick.com",
  "www.kick.com",
]);

const RESERVED_TWITCH_PATHS = new Set([
  "directory",
  "downloads",
  "drops",
  "inventory",
  "jobs",
  "login",
  "p",
  "search",
  "settings",
  "signup",
  "subscriptions",
  "videos",
  "wallet",
]);

const RESERVED_KICK_PATHS = new Set([
  "browse",
  "categories",
  "dashboard",
  "login",
  "search",
  "settings",
  "signup",
]);

function cleanChannelToken(raw: string): string {
  const token = raw.trim().replace(/^[@#]+/, "").replace(/[/?#].*$/, "");
  return /^[A-Za-z0-9_-]+$/.test(token) ? token : "";
}

function looksLikeUrl(raw: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    || /^(?:www\.|m\.)?[^\s/]+\.[^\s/]+(?:[/?#]|$)/i.test(raw);
}

/**
 * Sanitize user-entered channel text without changing the lower-level
 * session-key normalizer. Only explicit Twitch/Kick hosts are parsed as URLs;
 * arbitrary URLs are rejected instead of being turned into plausible-looking
 * channel identifiers.
 */
export function sanitizeChannelInput(raw: string): string {
  const input = raw.trim();
  if (!input) return "";

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  const knownHostWithoutScheme = /^(?:www\.|m\.)?(?:twitch\.tv|kick\.com)(?:[/?#]|$)/i.test(input);

  if (hasScheme || knownHostWithoutScheme) {
    let parsed: URL;
    try {
      parsed = new URL(hasScheme ? input : `https://${input}`);
    } catch {
      return "";
    }

    const host = parsed.hostname.toLowerCase();
    if (!SUPPORTED_CHANNEL_HOSTS.has(host)) return "";

    const firstSegment = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    const channel = cleanChannelToken(firstSegment);
    if (!channel) return "";

    const reserved = host.endsWith("twitch.tv") ? RESERVED_TWITCH_PATHS : RESERVED_KICK_PATHS;
    return reserved.has(channel.toLowerCase()) ? "" : channel;
  }

  // A URL-shaped value from an unsupported host is invalid channel input.
  if (looksLikeUrl(input)) return "";
  return cleanChannelToken(input);
}

/** Whether a paste is explicitly a supported platform URL. */
export function isSupportedChannelUrlInput(raw: string): boolean {
  const input = raw.trim();
  if (!input) return false;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return SUPPORTED_CHANNEL_HOSTS.has(new URL(candidate).hostname.toLowerCase());
  } catch {
    return false;
  }
}

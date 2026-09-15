/**
 * streamThumbnail — fetches a live stream preview thumbnail for the vision
 * pipeline on platforms where getDisplayMedia() is unavailable (mobile).
 *
 * Twitch serves a public, periodically-updated preview JPEG at a static CDN
 * URL. Kick exposes a `thumbnail` field on the livestream object via the v2
 * channels API. Both are fetched as blobs and converted to data URLs so they
 * can feed directly into `visionRequest()` — the same pipeline the desktop
 * canvas-capture path uses.
 *
 * The thumbnail is a few seconds stale (CDN refresh interval), but that's
 * fine for visual context: the AI just needs to know what's on screen.
 */

export type ThumbnailPlatform = "twitch" | "kick" | "joystick";

/**
 * Fetch a live stream thumbnail as a base64 data URL.
 * Returns null if the stream is offline, the fetch fails, or the platform
 * doesn't support thumbnails (Joystick).
 */
export async function fetchStreamThumbnail(
  platform: ThumbnailPlatform,
  channel: string,
  width = 1280,
  height = 720,
): Promise<string | null> {
  if (!channel) return null;

  const url = getThumbnailUrl(platform, channel, width, height);
  if (!url) return null;

  try {
    // Primary: fetch as blob → FileReader data URL. Works when the server
    // sends CORS headers (Twitch CDN and Kick API both do).
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    return await blobToDataUrl(blob);
  } catch {
    // Fallback: Image + canvas. Some CDNs allow <img> CORS but not fetch CORS.
    return await imageToDataUrl(url);
  }
}

/**
 * Resolve the thumbnail URL for a given platform + channel.
 * - Twitch: static CDN pattern, no API call needed.
 * - Kick: requires a v2 channels API call to get the `thumbnail` field.
 * - Joystick: no public thumbnail — returns null.
 */
function getThumbnailUrl(
  platform: ThumbnailPlatform,
  channel: string,
  width: number,
  height: number,
): string | null {
  const lc = channel.toLowerCase();

  if (platform === "twitch") {
    // Cache-bust so we always get a fresh frame (CDN caches aggressively).
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${lc}-${width}x${height}.jpg?t=${Date.now()}`;
  }

  if (platform === "kick") {
    // Kick's thumbnail URL is on the livestream object — we need to fetch
    // the channel info first, then resolve the thumbnail URL. This is
    // handled separately because it's async.
    return null; // handled by fetchKickThumbnailUrl
  }

  return null; // Joystick — no public thumbnail
}

/**
 * Kick requires an API call to get the thumbnail URL. Exported separately
 * so the caller can do the async resolution before fetching the image.
 */
export async function fetchKickThumbnailUrl(slug: string): Promise<string | null> {
  const encSlug = encodeURIComponent(slug);
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encSlug}`, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    // The thumbnail can be at different paths depending on API version.
    const thumbnail =
      data?.livestream?.thumbnail ||
      data?.stream?.thumbnail ||
      null;
    if (!thumbnail || typeof thumbnail !== "string") return null;
    // Cache-bust for fresh frames.
    return thumbnail.includes("?")
      ? `${thumbnail}&t=${Date.now()}`
      : `${thumbnail}?t=${Date.now()}`;
  } catch {
    return null;
  }
}

/**
 * Full fetch for Kick: resolve thumbnail URL → fetch image → data URL.
 */
async function fetchKickThumbnail(
  slug: string,
  width: number,
  height: number,
): Promise<string | null> {
  const thumbUrl = await fetchKickThumbnailUrl(slug);
  if (!thumbUrl) return null;
  try {
    const res = await fetch(thumbUrl, { mode: "cors" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    return await blobToDataUrl(blob);
  } catch {
    return await imageToDataUrl(thumbUrl);
  }
}

/**
 * Unified entry point — handles the platform dispatch internally.
 */
export async function fetchStreamThumbnailDataUrl(
  platform: ThumbnailPlatform,
  channel: string,
  width = 1280,
  height = 720,
): Promise<string | null> {
  if (!channel) return null;

  if (platform === "kick") {
    return fetchKickThumbnail(channel, width, height);
  }

  return fetchStreamThumbnail(platform, channel, width, height);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function imageToDataUrl(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      } catch {
        resolve(null); // canvas tainted — CORS blocked
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

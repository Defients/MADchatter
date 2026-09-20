/**
 * Shared low-level helpers for browser media elements used by background TTS
 * and functional attention audio. Product settings remain separate; this file
 * only centralizes the autoplay-safe mechanics.
 */

export function ensureManagedAudioElement(
  current: HTMLAudioElement | null,
  src: string,
  options: { loop?: boolean; label: string },
): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (current) return current;
  try {
    const element = document.createElement("audio");
    element.src = src;
    element.loop = options.loop === true;
    element.preload = "auto";
    element.setAttribute("playsinline", "");
    element.setAttribute("aria-label", options.label);
    return element;
  } catch {
    return null;
  }
}

/** Best-effort media playback. Browser policy rejections are expected. */
export async function safePlayMediaElement(element: HTMLAudioElement): Promise<boolean> {
  try {
    await element.play();
    return true;
  } catch {
    return false;
  }
}

/**
 * Prime a media element inside a trusted user gesture, then immediately pause
 * it. This never reports benign autoplay-policy failures to the user.
 */
export function primeMediaElement(element: HTMLAudioElement, shouldRemainPlaying = false, silent = false): void {
  const previousMuted = element.muted;
  if (silent) element.muted = true;
  try {
    const playback = element.play();
    if (playback && typeof playback.then === "function") {
      void playback
        .then(() => {
          if (!shouldRemainPlaying) element.pause();
          element.muted = previousMuted;
        })
        .catch(() => { element.muted = previousMuted; });
    } else {
      if (!shouldRemainPlaying) element.pause();
      element.muted = previousMuted;
    }
  } catch {
    element.muted = previousMuted;
    // Unsupported or blocked. The caller retains its normal fallback path.
  }
}

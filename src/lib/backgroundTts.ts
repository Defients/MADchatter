/**
 * backgroundTts — optional "keep TTS audible while the phone is locked or the
 * browser is backgrounded" support (mobile; `ttsBackgroundEnabled` in the
 * store, default OFF).
 *
 * What it does, where the platform permits it:
 *   - Web Speech (`speechSynthesis`): the API owns no media element, so mobile
 *     browsers can suspend a backgrounded page mid-utterance. While a TTS
 *     utterance is active we hold a silent looping <audio> element so the OS
 *     keeps a real media session — and with it the page/speech — alive.
 *   - ElevenLabs (<audio> playback): the element itself IS the media session;
 *     we only publish Media Session metadata + a stop handler so lock-screen
 *     surfaces show real "now playing" state instead of a dead page.
 *
 * What it deliberately never does: retry loops, toasts, claiming support that
 * doesn't exist, playing audio on its own, or touching anything outside TTS
 * playback (AutoForge, mic, capture, FEED — all unaffected).
 *
 * Everything here is best-effort and fully wrapped — on platforms that refuse
 * background media the priming/keep-alive play() simply rejects and TTS
 * behaves exactly as it did before the toggle existed.
 */

import { useAppStore } from "../store";

export type BackgroundTtsKind = "web" | "elevenlabs";

let keepAliveEl: HTMLAudioElement | null = null;
let silenceUrl: string | null = null;
/** Number of live TTS utterances currently holding a background session. */
let activeSessions = 0;

// ─── Silent keep-alive clip ─────────────────────────────────────────────────
// 1s of 8kHz/16-bit/mono PCM at ~-60dB — effectively inaudible but a real
// non-zero waveform, which some engines require to count as "audible media".
// Small enough (~16KB) for a data URI; built lazily on first use.

function buildSilenceDataUri(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);          // fmt chunk size
  v.setUint16(20, 1, true);           // PCM
  v.setUint16(22, 1, true);           // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);           // block align
  v.setUint16(34, 16, true);          // bits per sample
  writeStr(36, "data");
  v.setUint32(40, dataSize, true);
  // ~-60dB sine — inaudible, but a genuine waveform.
  const AMP = 24;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(AMP * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
    v.setInt16(44 + i * 2, sample, true);
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return "data:audio/wav;base64," + btoa(binary);
}

function ensureKeepAliveEl(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (!keepAliveEl) {
    try {
      if (!silenceUrl) silenceUrl = buildSilenceDataUri();
      const el = document.createElement("audio");
      el.src = silenceUrl;
      el.loop = true;
      el.preload = "auto";
      el.setAttribute("playsinline", "");
      el.setAttribute("aria-hidden", "true");
      keepAliveEl = el;
    } catch {
      return null;
    }
  }
  return keepAliveEl;
}

// ─── Media Session ──────────────────────────────────────────────────────────

function setMediaSession(playing: boolean, onStop?: () => void): void {
  try {
    const ms = (navigator as any).mediaSession as MediaSession | undefined;
    if (!ms) return;
    if (playing) {
      try {
        ms.metadata = new MediaMetadata({ title: "MADchatter", artist: "Text-to-Speech" });
      } catch { /* MediaMetadata ctor unsupported — metadata stays absent */ }
      ms.playbackState = "playing";
      if (onStop) {
        // Lock-screen pause/stop surfaces route to TTS stop — never to
        // anything else in the app.
        try { ms.setActionHandler("pause", onStop); } catch { /* optional */ }
        try { ms.setActionHandler("stop", onStop); } catch { /* optional */ }
      }
    } else {
      ms.playbackState = "none";
      try { ms.metadata = null; } catch { /* ignore */ }
      try { ms.setActionHandler("pause", null); } catch { /* ignore */ }
      try { ms.setActionHandler("stop", null); } catch { /* ignore */ }
    }
  } catch { /* no mediaSession — fine, unsupported platform */ }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Prime the keep-alive element inside a user gesture (the toggle click).
 * Pre-authorizes later playback on engines that gate audio on interaction.
 * Does NOT leave anything audible running — the element is paused again
 * immediately unless a TTS session is active.
 */
export function primeBackgroundTtsAudio(): void {
  const el = ensureKeepAliveEl();
  if (!el) return;
  try {
    const p = el.play();
    if (p && typeof (p as Promise<void>).then === "function") {
      (p as Promise<void>)
        .then(() => { if (activeSessions === 0 && keepAliveEl) keepAliveEl.pause(); })
        .catch(() => { /* engine refused — that's a graceful no-op */ });
    }
  } catch { /* ignore */ }
}

/**
 * Called when a TTS utterance/audio begins. With the preference OFF this is a
 * strict no-op — foreground playback is identical either way.
 * `onStop` is wired to lock-screen pause/stop controls (tts.stopSpeaking).
 */
export function beginBackgroundTtsSession(kind: BackgroundTtsKind, onStop: () => void): void {
  if (!useAppStore.getState().ttsBackgroundEnabled) return;
  activeSessions++;
  // Web Speech has no media element of its own — the silent keep-alive holds
  // the OS media session open so speech may continue in the background where
  // the platform allows it. ElevenLabs plays a real <audio> element, which is
  // itself the session — no keep-alive needed.
  if (kind === "web") {
    const el = ensureKeepAliveEl();
    if (el && el.paused) {
      try { el.play().catch(() => { /* unsupported — degrade silently */ }); } catch { /* ignore */ }
    }
  }
  setMediaSession(true, onStop);
}

/** Called when one TTS utterance ends (or is superseded). Idempotent. */
export function endBackgroundTtsSession(): void {
  if (activeSessions === 0) return;
  activeSessions--;
  if (activeSessions > 0) return;
  if (keepAliveEl && !keepAliveEl.paused) {
    try { keepAliveEl.pause(); } catch { /* ignore */ }
  }
  setMediaSession(false);
}

/** Hard stop — called from stopSpeaking()/cancel paths. */
export function endAllBackgroundTtsSessions(): void {
  activeSessions = 0;
  if (keepAliveEl && !keepAliveEl.paused) {
    try { keepAliveEl.pause(); } catch { /* ignore */ }
  }
  setMediaSession(false);
}

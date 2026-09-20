import { attemptAttentionPlayback, mobileAudioCueAllowed } from "./mobileAudioPolicy";
import { ensureManagedAudioElement, primeMediaElement, safePlayMediaElement } from "./mediaAudio";
import { playAttentionFallbackSfx, reserveAudioPriority } from "./sfx";

let mentionElement: HTMLAudioElement | null = null;
let mentionClipUrl: string | null = null;

function buildMentionClip(): string {
  if (mentionClipUrl) return mentionClipUrl;
  const sampleRate = 16_000;
  const durationSeconds = 0.72;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.015) * Math.max(0, 1 - t / durationSeconds);
    const first = t < 0.3 ? Math.sin(2 * Math.PI * 880 * t) : 0;
    const secondT = Math.max(0, t - 0.26);
    const second = t >= 0.26 ? Math.sin(2 * Math.PI * 1320 * secondT) : 0;
    const sample = Math.max(-1, Math.min(1, (first * 0.46 + second * 0.38) * envelope));
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  mentionClipUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return mentionClipUrl;
}

function ensureMentionElement(): HTMLAudioElement | null {
  mentionElement = ensureManagedAudioElement(mentionElement, buildMentionClip(), {
    label: "Direct bot mention alert",
  });
  return mentionElement;
}

/** Prime the functional alert during an ordinary trusted user interaction. */
export function primeMentionAlertAudio(): void {
  const element = ensureMentionElement();
  if (!element) return;
  element.volume = 0.72;
  primeMediaElement(element, false, true);
}

/**
 * Always-on functional attention audio. It intentionally does not read
 * `sfxEnabled` or any TTS preference.
 */
export function playMentionAlert(): void {
  if (typeof window === "undefined") return;
  // This assertion documents the product policy and protects future refactors.
  if (!mobileAudioCueAllowed("attention_mention", false)) return;
  reserveAudioPriority("attention_mention", 900);
  const element = ensureMentionElement();
  void attemptAttentionPlayback({
    playMedia: async () => {
      if (!element) return false;
      try { element.currentTime = 0; } catch { /* some mobile engines reject seeking before metadata */ }
      element.volume = 0.72;
      return safePlayMediaElement(element);
    },
    playFallback: () => playAttentionFallbackSfx(),
  });
}

/**
 * corePanelAvailability — one source of truth for "is this CORE panel usable?"
 *
 * Problem this solves: CORE's bottom dock let AUDIO and VISUAL look and behave
 * as if they were available even when the Stream source they depend on did not
 * exist. Clicking them opened empty panels, and — worse — hiding the Stream
 * *panel* (a presentation-only action that keeps the stream running) was
 * conflated with "Stream is off", so dependent inline panels vanished too.
 *
 * Semantics (deliberate):
 *   - STREAM is the parent capability. It is available when a channel is set
 *     (that is the stream source: the embed + the capture target).
 *   - AUDIO and VISUAL require the Stream source. If STREAM is unavailable they
 *     are unavailable and their toggles must reflect that.
 *   - Hiding a panel is presentation only and NEVER disables a feature. A
 *     collapsed/hidden Stream panel leaves AUDIO/VISUAL available.
 *   - MEMORY never depends on the Stream source.
 *
 * Pure functions so CORE, STUDIO, mobile, and tests agree.
 */

// Leaf-module import keeps this pure module out of the store module graph.
import { normalizeSessionChannel } from "./normalizeChannel";

export const STREAM_REQUIRED_REASON = "Enable Stream to use this panel";
export const AUDIO_REQUIRED_REASON = "Enable Stream to use Audio";
export const VISUAL_REQUIRED_REASON = "Enable Stream to use Visual";
export const AUDIO_UNSUPPORTED_REASON = "Audio transcription needs a desktop Chromium browser";
export const VISUAL_UNSUPPORTED_REASON = "Screen capture isn't available in this browser";

export interface PanelAvailabilityInput {
  /** Channel the session is watching. Empty/null = no stream source. */
  channelName?: string | null;
  /** Can this environment transcribe stream audio? (desktop Chromium) */
  audioCaptureSupported?: boolean;
  /** Can this environment capture stream frames? (getDisplayMedia) */
  visualCaptureSupported?: boolean;
}

export interface PanelAvailability {
  /** STREAM itself — the parent capability. */
  streamAvailable: boolean;
  audioAvailable: boolean;
  visualAvailable: boolean;
  /** Memory is context data, not stream-derived — always available. */
  memoryAvailable: true;
  /** Human-readable reason each surface is unavailable (undefined when ok). */
  streamReason?: string;
  audioReason?: string;
  visualReason?: string;
}

export function computePanelAvailability(input: PanelAvailabilityInput): PanelAvailability {
  const streamAvailable = !!normalizeSessionChannel(input.channelName || "");
  const audioSupported = input.audioCaptureSupported !== false;
  const visualSupported = input.visualCaptureSupported !== false;

  const audioAvailable = streamAvailable && audioSupported;
  const visualAvailable = streamAvailable && visualSupported;

  return {
    streamAvailable,
    audioAvailable,
    visualAvailable,
    memoryAvailable: true,
    streamReason: streamAvailable ? undefined : STREAM_REQUIRED_REASON,
    audioReason: audioAvailable
      ? undefined
      : !streamAvailable
        ? AUDIO_REQUIRED_REASON
        : AUDIO_UNSUPPORTED_REASON,
    visualReason: visualAvailable
      ? undefined
      : !streamAvailable
        ? VISUAL_REQUIRED_REASON
        : VISUAL_UNSUPPORTED_REASON,
  };
}

/** True when the given widget depends on the Stream source. */
export function requiresStream(widget: string): boolean {
  return widget === "stream" || widget === "audio" || widget === "visual";
}

export type PanelDependency = "stream" | "audio" | "visual" | "memory" | "chat";

/**
 * Availability lookup for a single widget, used by the dock to decide whether
 * a toggle is enabled, and whether a click should be allowed to open a panel.
 */
export function isPanelAvailable(availability: PanelAvailability, widget: PanelDependency): boolean {
  switch (widget) {
    case "stream":
      return availability.streamAvailable;
    case "audio":
      return availability.audioAvailable;
    case "visual":
      return availability.visualAvailable;
    default:
      return true;
  }
}

/** Reason string for a widget's unavailable state (undefined when available). */
export function panelUnavailableReason(
  availability: PanelAvailability,
  widget: PanelDependency,
): string | undefined {
  switch (widget) {
    case "stream":
      return availability.streamReason;
    case "audio":
      return availability.audioReason;
    case "visual":
      return availability.visualReason;
    default:
      return undefined;
  }
}

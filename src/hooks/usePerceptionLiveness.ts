/**
 * usePerceptionLiveness — the wiring hook that turns MADchatter's perception
 * systems into canonical liveness state. Mounted once in App.tsx.
 *
 * Responsibilities (and nothing else):
 * 1. Bind the engine to the live session (reset on channel/platform switch
 *    and context clear — parity with the Room Model wiring, so channel A's
 *    freshness can never leak into channel B).
 * 2. Report session capabilities (browser/platform support) to the engine.
 * 3. Tick the engine ~1s and mirror the compact PerceptionSummary into the
 *    store for React consumers — with content-signature dedup + heartbeat so
 *    perception subscriptions never cause rerender storms.
 *
 * The hot path (chat/audio/vision/event notes) is fed directly from store
 * actions and capture call sites, NOT from this hook — liveness ingestion must
 * never wait on React rendering. Zero polling, zero AI calls: the engine is
 * purely event/timestamp driven (§43, §73).
 */

import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { perception } from "../lib/perceptionLiveness";

/** Mirror flush cadence — the engine is cheap but the store should not churn. */
const FLUSH_INTERVAL_MS = 1_000;
/** Heartbeat flush even when statuses are unchanged (keeps ageMs live). */
const HEARTBEAT_FLUSH_MS = 10_000;
/** Age labels bucket to this granularity for signature comparison. */
const AGE_BUCKET_MS = 5_000;

function summarySignature(summary: ReturnType<typeof perception.getSummary>): string {
  return JSON.stringify([
    summary.overall,
    Object.entries(summary.lanes).map(([lane, l]) => [
      lane,
      l.status,
      l.reasonCode,
      l.ageMs != null ? Math.floor(l.ageMs / AGE_BUCKET_MS) : "x",
      l.stages ? Object.entries(l.stages).map(([k, s]) => `${k}:${s.status}:${s.detail ?? ""}`) : null,
    ]),
  ]);
}

export function usePerceptionLiveness() {
  const lastSigRef = useRef("");
  const lastFlushAtRef = useRef(0);

  // 1. Bind to the live session + report capabilities. sessionRevision bumps
  //    on channel switch (incl. A→B→A), platform switch, and clearAllContext
  //    — every one of those is a session boundary that must reset volatile
  //    liveness facts. Reload truthfulness (§52): a fresh mount starts the
  //    engine from scratch; nothing persisted ever marks a lane LIVE.
  useEffect(() => {
    const rebind = () => {
      const state = useAppStore.getState();
      const channel = state.streamMetadata.channelName;
      perception.setChannel(channel || null);
      // Capabilities are environment facts, not session facts:
      // - screen capture (getDisplayMedia) is absent on mobile browsers
      // - raids/subs/cheers only flow from Twitch IRC (Kick/Joystick don't
      //   expose them) — platform limitation, never an error.
      const visionCaptureSupported =
        typeof navigator !== "undefined" &&
        !!navigator.mediaDevices &&
        typeof (navigator.mediaDevices as unknown as { getDisplayMedia?: unknown }).getDisplayMedia === "function";
      perception.setCapabilities({
        visionCaptureSupported,
        platformEventsSupported: state.platform === "twitch",
      });
    };
    rebind();
    let lastRevision = useAppStore.getState().sessionRevision;
    let lastChannel = useAppStore.getState().streamMetadata.channelName;
    let lastPlatform = useAppStore.getState().platform;
    const unsubscribe = useAppStore.subscribe(() => {
      const state = useAppStore.getState();
      if (
        state.sessionRevision !== lastRevision ||
        state.streamMetadata.channelName !== lastChannel ||
        state.platform !== lastPlatform
      ) {
        lastRevision = state.sessionRevision;
        lastChannel = state.streamMetadata.channelName;
        lastPlatform = state.platform;
        rebind();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Tick loop: derive + mirror. One shared interval for the whole app —
  //    consumers read the store mirror; nobody spins their own timer.
  useEffect(() => {
    const interval = setInterval(() => {
      const store = useAppStore.getState();
      const channel = store.streamMetadata.channelName;
      const summary = perception.getSummary();
      const sig = summarySignature(summary);
      const now = Date.now();
      if (sig !== lastSigRef.current || now - lastFlushAtRef.current >= HEARTBEAT_FLUSH_MS) {
        lastSigRef.current = sig;
        lastFlushAtRef.current = now;
        store.setPerceptionSummary(channel ? summary : null);
      }
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

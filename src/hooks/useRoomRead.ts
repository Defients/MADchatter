/**
 * useRoomRead — React binding for the Room Read contract.
 *
 * One derivation per second, driven by store.getState() polling instead of
 * reactive subscriptions: raw chat messages, transcript growth, and mirror
 * flushes never cause a React rerender by themselves. The Room Read Card is
 * always visible, so the derivation is deliberately cheap and the emitted
 * state is signature-compared — the card rerenders only when the read (or a
 * coarse age bucket) actually changed.
 *
 * Contextual facts the pure derivation cannot see on its own:
 * - botsActiveRecent: MADchatter's own lines in the chat log (attributed,
 *   never human room activity).
 * - streamerCallout: a confirmed, unconsumed address from the shared
 *   Spoken Callout engine (including its intent and echo protections).
 * - aiConfigured: for the zero-AI hint (deterministic reads stay useful).
 *
 * Session safety: a sessionRevision bump (channel/platform switch, context
 * clear) immediately drops the previous read and any pending callout —
 * channel A's Room Read can never render in channel B, even for one tick.
 */

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { deriveRoomRead, stabilizeRoomRead, debugRoomRead, type RoomReadState } from "../lib/roomRead";
import { spokenCallouts } from "../lib/spokenCallout";
import { getActiveProvider, getApiKey } from "../lib/keys";

/** Derivation + emit cadence. */
const TICK_MS = 1_000;
/** Re-emit unchanged reads at least this often so age labels stay live. */
const REEMIT_MS = 2_000;
/** Age labels bucket to this granularity for signature comparison. */
const AGE_BUCKET_MS = 5_000;
function readSignature(read: RoomReadState): string {
  return JSON.stringify([
    read.status,
    read.headline,
    read.band,
    Math.round(read.confidence * 20) / 20,
    read.momentId,
    read.semanticKey,
    read.chips.map((c) => c.label),
    read.lanes.map((l) => `${l.lane}:${l.status}:${l.ageMs != null ? Math.floor(l.ageMs / AGE_BUCKET_MS) : "x"}`),
  ]);
}

export interface UseRoomReadResult {
  read: RoomReadState | null;
  /** Semantic AI provider configured (for the zero-AI read hint). */
  aiConfigured: boolean;
}

/** Last derived read (module-level) for developer diagnostics. No secrets. */
let lastReadForDebug: RoomReadState | null = null;
export function getRoomReadDebug(): Record<string, unknown> | null {
  return lastReadForDebug ? debugRoomRead(lastReadForDebug) : null;
}

export function useRoomRead(): UseRoomReadResult {
  const [result, setResult] = useState<UseRoomReadResult>({ read: null, aiConfigured: false });
  const prevReadRef = useRef<RoomReadState | null>(null);
  const lastSigRef = useRef("");
  const lastEmitRef = useRef(0);
  const sessionRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const store = useAppStore.getState();
      const now = Date.now();

      // Session boundary → drop previous read + callout immediately.
      if (sessionRevisionRef.current === null) {
        sessionRevisionRef.current = store.sessionRevision;
      } else if (sessionRevisionRef.current !== store.sessionRevision) {
        sessionRevisionRef.current = store.sessionRevision;
        prevReadRef.current = null;
        lastSigRef.current = "";
      }

      // The detector owns address intent, expiry, echo rejection and consumption.
      const callout = spokenCallouts.getActiveCallout(now);
      // Bot activity: own/marked lines in the recent chat log.
      const botsActiveRecent = store.chatLog.some(
        (m) => now - m.timestamp < 120_000 && !m.dryRun && (m.selfSent || m.marker === "autoforge"),
      );

      const next = deriveRoomRead({
        state: store.roomState,
        moments: store.roomMoments,
        now,
        botsActiveRecent,
        streamerCallout: callout ? { name: callout.targetDisplay, text: callout.transcriptText, at: callout.latestSpokenAt } : null,
        // Canonical Perception Liveness (store mirror, flushed ~1/s by
        // usePerceptionLiveness) — gates semantic chips + lane statuses.
        liveness: store.perceptionSummary ? Object.values(store.perceptionSummary.lanes) : null,
      });
      const stable = stabilizeRoomRead(next, prevReadRef.current, now);
      prevReadRef.current = stable;
      lastReadForDebug = stable;

      const provider = getActiveProvider();
      const aiConfigured = !!getApiKey(provider);
      const sig = readSignature(stable);
      if (sig !== lastSigRef.current || now - lastEmitRef.current >= REEMIT_MS) {
        lastSigRef.current = sig;
        lastEmitRef.current = now;
        setResult({ read: stable, aiConfigured });
      }
    };

    tick();
    const interval = setInterval(tick, TICK_MS);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.sessionRevision !== previous.sessionRevision) tick();
    });
    return () => { clearInterval(interval); unsubscribe(); };
  }, []);

  return result;
}

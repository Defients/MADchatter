import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { fireConfetti } from "../lib/confetti";

/**
 * FirstMessageWatcher — non-visual companion to First Message Mode.
 *
 * Responsibilities:
 *  1. Stream/channel reset: when the channel changes, clear the cohort so
 *     armed state can never leak into a different streamer's context.
 *  2. Completion celebration: when every remaining cohort member has
 *     completed its first message, fire a one-shot dual-corner confetti
 *     burst. Guarded against duplicate fires (React rerenders, Strict Mode,
 *     stale closures) via the cohort's `celebrated` flag + a local ref.
 *
 * Returns null — render it anywhere inside the app tree.
 */
export function FirstMessageWatcher() {
  const cohort = useAppStore((s) => s.firstMessageCohort);
  const channelName = useAppStore((s) => s.streamMetadata?.channelName);
  const firedRef = useRef<string | null>(null);

  // ── Re-arm on reload ────────────────────────────────────────────────────
  // The user preference (`firstMessageModeEnabled`) is persisted, but the
  // runtime cohort is ephemeral. On reload the toggle would show ON with no
  // armed bots. Re-create a fresh cohort from the currently active+authed
  // bots so the toggle state stays consistent (mount-only; Strict Mode safe
  // — setFirstMessageMode(true) just rebuilds the cohort idempotently).
  const didArmOnMountRef = useRef(false);
  useEffect(() => {
    if (didArmOnMountRef.current) return;
    didArmOnMountRef.current = true;
    const s = useAppStore.getState();
    if (s.firstMessageModeEnabled && !s.firstMessageCohort && s.multiBotEnabled) {
      s.setFirstMessageMode(true);
    }
  }, []);

  // ── Stream/channel reset ────────────────────────────────────────────────
  // Track the channel the cohort was created under; if it changes, wipe the
  // cohort. We key off the cohort id so a fresh cohort re-seeds the tracker.
  const cohortChannelRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!cohort) {
      cohortChannelRef.current = undefined;
      return;
    }
    if (cohortChannelRef.current === undefined) {
      cohortChannelRef.current = channelName;
    } else if (channelName !== cohortChannelRef.current) {
      useAppStore.getState().resetFirstMessageCohort();
    }
  }, [cohort?.id, channelName, cohort]);

  // ── Completion celebration ──────────────────────────────────────────────
  useEffect(() => {
    if (!cohort || cohort.celebrated) return;
    if (cohort.botIds.length === 0) return; // empty cohort → never celebrate
    const allComplete = cohort.botIds.every((id) => cohort.status[id] === "complete");
    if (!allComplete) return;

    // Guard: only fire once per cohort id (handles Strict Mode double-invoke,
    // rerenders, and duplicate callbacks).
    if (firedRef.current === cohort.id) return;
    firedRef.current = cohort.id;

    // Mark celebrated in the store so a reload / re-render can't retrigger.
    useAppStore.setState((s) => ({
      firstMessageCohort: s.firstMessageCohort
        ? { ...s.firstMessageCohort, celebrated: true }
        : s.firstMessageCohort,
    }));

    // Respect reduced-motion: skip the particle burst; the gold borders have
    // already faded, which is a quiet enough completion signal.
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion) {
      // Dual-corner burst from bottom-left + bottom-right ("the squad has
      // entered chat"). Brief and nonblocking (pointer-events disabled in
      // the confetti container).
      fireConfetti("bottom", 90);
    }
  }, [cohort]);

  return null;
}

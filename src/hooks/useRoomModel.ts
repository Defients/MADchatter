/**
 * useRoomModel — the wiring hook that turns MADchatter's perception systems
 * into Room Model state. Mounted once in App.tsx.
 *
 * Responsibilities (and nothing else):
 * 1. Bind the engine to the live session channel (reset on channel/platform
 *    change — parity with clearAllContext; the engine itself is restored by
 *    restoreChannelSnapshot).
 * 2. Tick the engine ~1/s: refresh conversation facts (threads, participants,
 *    direct mention), run lifecycle maintenance, and mirror the compact
 *    Room State + bounded Moment timeline into the store for React
 *    consumers and channel persistence.
 * 3. Optionally synthesize AI titles/summaries for closed high-significance
 *    moments — sparse (rate-limited), session-guarded, background priority,
 *    and failure-tolerant (deterministic moments stay valid without it).
 *
 * The hot path (chat/audio/vision/platform notes) is fed directly from store
 * actions and App.tsx, NOT from this hook — perception ingestion must never
 * wait on React rendering.
 */

import { intelligenceSynthesisBudget } from "../lib/intelligenceSynthesisBudget";
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { roomModel } from "../lib/roomModel";
import { collectBotUsernames } from "../lib/channelLearning";
import { isNameMentioned } from "../lib/nameMatch";
import { getActiveThreads } from "../lib/conversationThread";
import { captureSessionScope, isSessionScopeCurrent } from "../lib/sessionScope";
import { getActiveProvider, getApiKey } from "../lib/keys";
import { isSchedulerCancellation, isQueueTimeout } from "../lib/aiScheduler";

/** Mirror flush cadence — the engine is cheap but the store should not churn. */
const FLUSH_INTERVAL_MS = 1_000;
/** Heartbeat flush even when content is unchanged (keeps freshness ages live). */
const HEARTBEAT_FLUSH_MS = 10_000;
// Moment and episode enrichment share one ten-minute budget.

export function useRoomModel() {
  // Last content signature mirrored into the store (skip no-op sets).
  const lastSigRef = useRef("");
  const lastFlushAtRef = useRef(0);

  // 1. Bind to the live session channel. sessionRevision bumps on channel
  // switch (incl. A→B→A), platform switch, and clearAllContext — every one
  // of those is a session boundary that must reset volatile room state.
  // restoreChannelSnapshot re-populates history AFTER this reset.
  useEffect(() => {
    const rebind = () => {
      const channel = useAppStore.getState().streamMetadata.channelName;
      roomModel.setChannel(channel || null);
    };
    rebind();
    let lastRevision = useAppStore.getState().sessionRevision;
    let lastChannel = useAppStore.getState().streamMetadata.channelName;
    const rebindIfNeeded = (revision: number, channel: string) => {
      if (revision !== lastRevision || channel !== lastChannel) {
        lastRevision = revision;
        lastChannel = channel;
        rebind();
      }
    };
    const unsubscribe = useAppStore.subscribe(() => {
      const state = useAppStore.getState();
      // Cheap guard: only act when the session identity fields changed.
      rebindIfNeeded(state.sessionRevision, state.streamMetadata.channelName);
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Tick loop: conversation facts → lifecycle → mirror flush.
  useEffect(() => {
    const interval = setInterval(() => {
      const store = useAppStore.getState();
      const channel = store.streamMetadata.channelName;
      if (!channel) return;

      // Conversation facts: live thread count + recent participants +
      // whether any own-bot account is being addressed right now.
      try {
        const threads = getActiveThreads();
        const recentWindow = Date.now() - 120_000;
        const participants: string[] = [];
        const legacy = typeof window === "undefined" ? null : store.platform === "kick"
          ? window.__kickSession?.username : store.platform === "joystick"
            ? window.__joystickSession?.username : window.__twitchSession?.username;
        const botNames = new Set(collectBotUsernames(store.bots, legacy));
        let directMention = false;
        for (const m of store.chatLog.slice(-12)) {
          if (m.marker || m.selfSent || m.dryRun || m.timestamp < recentWindow || botNames.has(m.user.toLowerCase())) continue;
          if (!participants.includes(m.user) && m.timestamp >= recentWindow) {
            participants.push(m.user);
          }
          if (!directMention && m.text) {
            const lower = m.text.toLowerCase();
            for (const name of botNames) {
              if (isNameMentioned(lower, name)) { directMention = true; break; }
            }
          }
        }
        roomModel.noteConversation({
          activeThreads: threads.filter((t) => t.recentActivity).length,
          participants: participants.slice(0, 8),
          directMention,
        });
      } catch {
        // Thread state is Twitch-only and best-effort — never block the tick.
      }

      roomModel.tick();

      // Mirror into the store only when content actually changed (or on the
      // freshness heartbeat) so Room-Model subscriptions don't rerender storms.
      const state = roomModel.getState();
      const moments = roomModel.getMoments();
      const lastMoment = moments[moments.length - 1];
      const sig = JSON.stringify([
        state && { ...state, updatedAt: 0 },
        moments.length,
        lastMoment && `${lastMoment.id}:${lastMoment.updatedAt}:${lastMoment.title ?? ""}:${lastMoment.status}`,
        moments.map((m) => `${m.id}:${m.updatedAt}:${m.title ?? ""}`).slice(-10),
      ]);
      const now = Date.now();
      if (sig !== lastSigRef.current || now - lastFlushAtRef.current >= HEARTBEAT_FLUSH_MS) {
        lastSigRef.current = sig;
        lastFlushAtRef.current = now;
        store.setRoomModelSnapshot(state, moments);
      }

      maybeSynthesize();
    }, FLUSH_INTERVAL_MS);
    return () => { clearInterval(interval); intelligenceSynthesisBudget.cancel("moment"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3. Sparse AI synthesis of closed high-significance moments.
  //    - Only moments the engine itself queued (significance ≥ 0.75, closed).
  //    - At most one enrichment call per ten minutes across both engines.
  //    - Session-guarded: a result landing after a channel switch is discarded
  //      by both the scope check here and roomModel.applySynthesis's channel check.
  //    - Failure is quiet and non-fatal: the deterministic moment stays valid.
  const maybeSynthesize = () => {
    const store = useAppStore.getState();
    const enabled = store.roomModelSynthesisEnabled;
    const provider = getActiveProvider();
    if (!enabled || !getApiKey(provider) || !roomModel.hasPendingSynthesis()) {
      intelligenceSynthesisBudget.cancel("moment");
      return;
    }
    if (!intelligenceSynthesisBudget.available(Date.now(), "moment")) return;
    const queued = roomModel.drainSynthesisQueue();
    if (queued.length === 0) return;
    const momentId = queued[queued.length - 1];
    const moment = roomModel.getMomentById(momentId);
    if (!moment) return;
    const scope = captureSessionScope();
    const release = intelligenceSynthesisBudget.acquire(Date.now(), "moment");
    if (!release) return;
    import("../lib/ai")
      .then(({ generateMomentSynthesis }) =>
        isSessionScopeCurrent(scope) && useAppStore.getState().roomModelSynthesisEnabled ? generateMomentSynthesis({
          moment,
          activeProvider: provider,
          channel: scope.channel,
        }) : null,
      )
      .then((result) => {
        // Stale-session results are discarded — never attach to a new channel.
        if (!result || !(isSessionScopeCurrent(scope) && useAppStore.getState().roomModelSynthesisEnabled)) return;
        if (result.tokenUsage) {
          useAppStore.getState().recordTokenUsage("moment_synthesis", result.tokenUsage);
        }
        roomModel.applySynthesis(momentId, scope.channel, {
          title: result.title,
          summary: result.summary,
          topicHints: result.topicHints,
          model: provider,
        });
      })
      .catch((e) => {
        if (!isSchedulerCancellation(e) && !isQueueTimeout(e)) {
          console.warn("[RoomModel] Moment synthesis failed (moment stays valid):", e?.message ?? e);
        }
      })
      .finally(() => {
        release();
      });
  };
}

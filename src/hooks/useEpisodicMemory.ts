/**
 * useEpisodicMemory — the wiring hook that consolidates the Room Model's
 * closed Moments into Episodic Memory. Mounted once in App.tsx.
 *
 * Responsibilities (and nothing else):
 * 1. Bind the engine to the live session channel (reset on channel/platform
 *    change — parity with clearAllContext; retained episodes are restored
 *    by restoreChannelSnapshot, same lifecycle as the Room Model).
 * 2. Tick the engine ~1s: feed newly closed moments (deduped by moment id —
 *    only moments that closed during THIS session are eligible), run
 *    lifecycle maintenance (idle close, compaction, archival, caps), and
 *    mirror the episode store into the app store for React consumers and
 *    channel persistence.
 * 3. Optionally synthesize AI titles/summaries for closed high-significance
 *    episodes — sparse (rate-limited), session-guarded, background priority,
 *    and failure-tolerant (deterministic episodes stay valid without it).
 *
 * The engine itself is pure — this hook is the only bridge to the live
 * Room Model and the app store.
 */

import { intelligenceSynthesisBudget } from "../lib/intelligenceSynthesisBudget";
import { useEffect, useRef } from "react";
import { useAppStore } from "../store";
import { roomModel } from "../lib/roomModel";
import { episodicMemory } from "../lib/episodicMemory";
import { captureSessionScope, isSessionScopeCurrent } from "../lib/sessionScope";
import { getActiveProvider, getApiKey } from "../lib/keys";
import { isSchedulerCancellation, isQueueTimeout } from "../lib/aiScheduler";

/** Mirror flush cadence — matches useRoomModel so both stay in step. */
const FLUSH_INTERVAL_MS = 1_000;
/** Heartbeat flush even when content is unchanged. */
const HEARTBEAT_FLUSH_MS = 10_000;
// Moment and episode enrichment share one ten-minute budget.

export function useEpisodicMemory() {
  const lastSigRef = useRef("");
  const lastFlushAtRef = useRef(0);

  // 1. Bind to the live session channel. sessionRevision bumps on channel
  //    switch (incl. A→B→A), platform switch, and clearAllContext — every
  //    one of those is a session boundary that must reset candidates.
  //    restoreChannelSnapshot re-populates retained episodes AFTER this reset.
  useEffect(() => {
    const rebind = () => {
      const channel = useAppStore.getState().streamMetadata.channelName;
      episodicMemory.setChannel(channel || null);
    };
    rebind();
    let lastRevision = useAppStore.getState().sessionRevision;
    let lastChannel = useAppStore.getState().streamMetadata.channelName;
    const unsubscribe = useAppStore.subscribe(() => {
      const state = useAppStore.getState();
      if (state.sessionRevision !== lastRevision || state.streamMetadata.channelName !== lastChannel) {
        lastRevision = state.sessionRevision;
        lastChannel = state.streamMetadata.channelName;
        rebind();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Tick loop: closed moments → episode candidates → lifecycle → mirror.
  useEffect(() => {
    const interval = setInterval(() => {
      const store = useAppStore.getState();
      const channel = store.streamMetadata.channelName;
      if (!channel) return;

      // Feed newly closed moments. The engine dedupes by moment id and
      // skips moments that closed before this session began, so restored
      // history is never reprocessed and duplicates cannot form.
      if (store.episodicMemoryEnabled) {
        episodicMemory.noteMoments(roomModel.getMoments().filter((m) => m.status === "closed"));
      }
      episodicMemory.tick();

      // Mirror into the store only when content actually changed (or on the
      // heartbeat) so Episodic Memory subscriptions don't rerender storms.
      const episodes = episodicMemory.getEpisodes();
      const last = episodes[episodes.length - 1];
      const sig = JSON.stringify([
        episodes.length,
        last && `${last.id}:${last.endedAt}:${last.title}:${last.state}:${last.pinned}`,
        episodes.slice(-10).map((e) => `${e.id}:${e.state}:${e.title}:${e.pinned}:${e.recallCount}:${e.lastRecalledAt ?? 0}`),
      ]);
      const now = Date.now();
      if (sig !== lastSigRef.current || now - lastFlushAtRef.current >= HEARTBEAT_FLUSH_MS) {
        lastSigRef.current = sig;
        lastFlushAtRef.current = now;
        store.setEpisodicSnapshot(episodes);
      }

      maybeSynthesize();
    }, FLUSH_INTERVAL_MS);
    return () => { clearInterval(interval); intelligenceSynthesisBudget.cancel("episode"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3. Sparse AI synthesis of closed high-significance episodes.
  //    - Only episodes the engine itself queued (significance ≥ 0.75).
  //    - At most one enrichment call per ten minutes across both engines.
  //    - Session-guarded: a result landing after a channel switch is
  //      discarded by both the scope check here and applySynthesis's channel
  //      check (a delayed synthesis from Channel A never commits into B).
  //    - Failure is quiet and non-fatal: the deterministic episode stays valid.
  const maybeSynthesize = () => {
    const store = useAppStore.getState();
    const enabled = store.roomModelSynthesisEnabled && store.episodicMemoryEnabled;
    const provider = getActiveProvider();
    if (!enabled || !getApiKey(provider) || !episodicMemory.hasPendingSynthesis()) {
      intelligenceSynthesisBudget.cancel("episode");
      return;
    }
    if (!intelligenceSynthesisBudget.available(Date.now(), "episode")) return;
    const queued = episodicMemory.drainSynthesisQueue();
    if (queued.length === 0) return;
    const episodeId = queued[queued.length - 1];
    const episode = episodicMemory.getEpisodeById(episodeId);
    if (!episode || episode.provenance.aiSynthesized) return;
    const scope = captureSessionScope();
    const release = intelligenceSynthesisBudget.acquire(Date.now(), "episode");
    if (!release) return;
    import("../lib/ai")
      .then(({ generateEpisodeSynthesis }) =>
        isSessionScopeCurrent(scope) && useAppStore.getState().roomModelSynthesisEnabled && useAppStore.getState().episodicMemoryEnabled ? generateEpisodeSynthesis({
          episode,
          activeProvider: provider,
          channel: scope.channel,
        }) : null,
      )
      .then((result) => {
        // Stale-session results are discarded — never attach to a new channel.
        if (!result || !(isSessionScopeCurrent(scope) && useAppStore.getState().roomModelSynthesisEnabled && useAppStore.getState().episodicMemoryEnabled)) return;
        if (result.tokenUsage) {
          useAppStore.getState().recordTokenUsage("episode_synthesis", result.tokenUsage);
        }
        episodicMemory.applySynthesis(episodeId, scope.channel, {
          title: result.title,
          summary: result.summary,
          topics: result.topics,
          kind: result.kind,
          model: provider,
        });
      })
      .catch((e) => {
        if (!isSchedulerCancellation(e) && !isQueueTimeout(e)) {
          console.warn("[EpisodicMemory] Episode synthesis failed (episode stays valid):", e?.message ?? e);
        }
      })
      .finally(() => {
        release();
      });
  };
}

import { useEffect, useRef, type FC } from "react";
import { useAppStore, selectMultiBotActive } from "../store";
import { useAutoForgeBot } from "./useAutoForgeBot";
import { botCoordinator, DEFAULT_FLOOR_GAP_MS } from "../lib/botCoordinator";

/** Supercharge mode shrinks the floor gap so bots can talk closer together. */
const SUPERCHARGE_FLOOR_GAP_MS = 2_000;

/**
 * useMultiBotOrchestrator — mounts one useAutoForgeBot loop per active bot and
 * keeps the BotCoordinator in sync with the bots list.
 *
 * Active only when multi-bot is ACTIVELY engaged: the toggle is on AND at least
 * two bots are authenticated. With 0–1 authed bots the legacy single-bot
 * pipeline keeps running (no dead zone). When multi-bot stands down, the
 * coordinator is reset and no per-bot loops run.
 *
 * Mention routing: handled inside each useAutoForgeBot via per-bot username
 * detection — a directly addressed bot's bid carries the mention, and the
 * semantic coordinator gives it obligation priority (others defer unless the
 * target can't clear the bar). The coordinator guarantees at most one bot
 * speaks per opportunity — or deliberate collective silence.
 */
export function useMultiBotOrchestrator() {
  const multiBotActive = useAppStore(selectMultiBotActive);
  const bots = useAppStore((s) => s.bots);
  const superchargeActive = useAppStore((s) => s.superchargeActive);
  const channelName = useAppStore((s) => s.streamMetadata.channelName);
  // Track which bot ids we've mounted loops for so we can (re)mount on changes.
  const mountedRef = useRef<Set<string>>(new Set());

  // Reset the coordinator whenever multi-bot mode stands down.
  useEffect(() => {
    if (!multiBotActive) {
      botCoordinator.reset();
      mountedRef.current.clear();
    }
  }, [multiBotActive]);

  // Channel scoping: every channel change re-binds the semantic ledger and
  // wipes the floor — no stale Channel-A bid, ledger entry, or floor cooldown
  // can influence a Channel-B window.
  useEffect(() => {
    botCoordinator.setChannel(channelName ?? null);
  }, [channelName]);

  useEffect(() => useAppStore.subscribe((state, previous) => {
    if (state.sessionRevision !== previous.sessionRevision) {
      botCoordinator.reset();
      botCoordinator.setChannel(state.streamMetadata.channelName || null);
    }
  }), []);

  // Supercharge mode: shrink the coordinator floor gap so bots can talk
  // closer together, and relax the semantic saturation pressure (loop
  // detection stays on). Restore the defaults when it's off. (The bid window
  // is left at its default — we still want competing bots to resolve fairly.)
  useEffect(() => {
    botCoordinator.configure({ floorGapMs: superchargeActive ? SUPERCHARGE_FLOOR_GAP_MS : DEFAULT_FLOOR_GAP_MS });
    botCoordinator.setSupercharge(superchargeActive);
  }, [superchargeActive]);

  // Mount a loop for every active, authenticated bot. We render a hidden
  // component per bot that calls useAutoForgeBot (hooks must be called in a
  // component, not in a loop directly).
  if (!multiBotActive) return null;

  return <BotLoopHost bots={bots} />;
}

/** Renders one useAutoForgeBot instance per active+authenticated bot. */
const BotLoopHost: FC<{ bots: ReturnType<typeof useAppStore.getState>["bots"] }> = ({ bots }) => {
  const activeBots = bots.filter((b) => b.active && b.session);
  return (
    <>
      {activeBots.map((b) => (
        <BotLoop key={b.id} botId={b.id} />
      ))}
    </>
  );
};

const BotLoop: FC<{ botId: string }> = ({ botId }) => {
  useAutoForgeBot(botId);
  return null;
};

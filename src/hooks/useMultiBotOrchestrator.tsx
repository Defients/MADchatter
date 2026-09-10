import { useEffect, useRef, type FC } from "react";
import { useAppStore, selectMultiBotActive } from "../store";
import { useAutoForgeBot } from "./useAutoForgeBot";
import { botCoordinator } from "../lib/botCoordinator";

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
 * detection — a message mentioning bot A raises bot A's personaFit (and thus
 * its odds of winning the speaker floor), so mentions naturally route to the
 * mentioned bot. The coordinator guarantees only one bot speaks per cycle.
 */
export function useMultiBotOrchestrator() {
  const multiBotActive = useAppStore(selectMultiBotActive);
  const bots = useAppStore((s) => s.bots);
  // Track which bot ids we've mounted loops for so we can (re)mount on changes.
  const mountedRef = useRef<Set<string>>(new Set());

  // Reset the coordinator whenever multi-bot mode stands down.
  useEffect(() => {
    if (!multiBotActive) {
      botCoordinator.reset();
      mountedRef.current.clear();
    }
  }, [multiBotActive]);

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

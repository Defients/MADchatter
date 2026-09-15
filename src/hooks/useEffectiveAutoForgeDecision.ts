import { useAppStore, selectMultiBotActive } from "../store";
import type { Bot } from "../types";
import type { AutoForgeDecision } from "../lib/ai";

/**
 * Resolves the most recent AutoForge decision for display.
 *
 * In multi-bot mode the legacy loop stands down and per-bot loops write to
 * `bot.runtime.lastAutoForgeDecision` — the top-level `lastAutoForgeDecision`
 * field stays stale. Surfaces like the Core "Last Cycle" panel must merge
 * across active bots (same rule as the AutoForge HUD): pick the decision with
 * the newest timestamp, and report which bot produced it.
 */
export function useEffectiveAutoForgeDecision(): { decision: AutoForgeDecision | null; bot: Bot | null } {
  const lastAutoForgeDecision = useAppStore((s) => s.lastAutoForgeDecision);
  const multiBotActive = useAppStore(selectMultiBotActive);
  const bots = useAppStore((s) => s.bots);

  let decision = lastAutoForgeDecision;
  let decisionBot: Bot | null = null;
  if (multiBotActive) {
    let bestTs = -1;
    for (const b of bots) {
      if (!b.active || !b.session) continue;
      const d = b.runtime?.lastAutoForgeDecision;
      const ts = d?.timestamp ?? b.runtime?.autoForgeLastActionMs ?? 0;
      if (d && ts > bestTs) {
        bestTs = ts;
        decision = d;
        decisionBot = b;
      }
    }
  }
  return { decision, bot: decisionBot };
}

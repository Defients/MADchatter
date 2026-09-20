import type { Bot } from "../types";
import type { AutoForgeDecision } from "./ai";

export interface AutoForgeHistoryEntry {
  decision: AutoForgeDecision;
  bot: Bot | null;
  key: string;
}

function decisionKeyBase(decision: AutoForgeDecision, bot: Bot | null): string {
  return [
    bot?.id ?? "legacy",
    decision.timestamp ?? 0,
    decision.decision,
    decision.action_payload ?? "",
  ].join(":");
}

/**
 * Build the same chronological decision stream for desktop and mobile.
 * Supplying active bots selects multi-bot history; an empty list selects the
 * legacy single-bot history.
 */
export function mergeAutoForgeDecisionHistory(
  legacyHistory: ReadonlyArray<AutoForgeDecision>,
  activeBots: ReadonlyArray<Bot>,
): AutoForgeHistoryEntry[] {
  const raw: Array<{ decision: AutoForgeDecision; bot: Bot | null; sourceOrder: number }> = [];
  let sourceOrder = 0;

  if (activeBots.length > 0) {
    for (const bot of activeBots) {
      for (const decision of bot.runtime.autoForgeDecisionHistory) {
        if (decision) raw.push({ decision, bot, sourceOrder: sourceOrder++ });
      }
    }
  } else {
    for (const decision of legacyHistory) {
      if (decision) raw.push({ decision, bot: null, sourceOrder: sourceOrder++ });
    }
  }

  raw.sort((a, b) => {
    const byTime = (a.decision.timestamp ?? 0) - (b.decision.timestamp ?? 0);
    return byTime || a.sourceOrder - b.sourceOrder;
  });

  const collisionCounts = new Map<string, number>();
  return raw.map((entry) => {
    const base = decisionKeyBase(entry.decision, entry.bot);
    const collision = collisionCounts.get(base) ?? 0;
    collisionCounts.set(base, collision + 1);
    return {
      decision: entry.decision,
      bot: entry.bot,
      key: `${base}:${collision}`,
    };
  });
}

/** null means "follow latest"; a key pins an intentionally browsed entry. */
export function resolveAutoForgeHistorySelection(
  history: ReadonlyArray<AutoForgeHistoryEntry>,
  selectedKey: string | null,
): { entry: AutoForgeHistoryEntry | null; index: number } {
  if (history.length === 0) return { entry: null, index: -1 };
  if (selectedKey) {
    const selectedIndex = history.findIndex((entry) => entry.key === selectedKey);
    if (selectedIndex >= 0) return { entry: history[selectedIndex], index: selectedIndex };
  }
  const index = history.length - 1;
  return { entry: history[index], index };
}

export function navigateAutoForgeHistory(
  history: ReadonlyArray<AutoForgeHistoryEntry>,
  currentIndex: number,
  direction: "previous" | "next",
): string | null {
  if (history.length === 0) return null;
  if (direction === "previous") {
    const index = Math.max(0, currentIndex - 1);
    return history[index]?.key ?? null;
  }
  const index = Math.min(history.length - 1, currentIndex + 1);
  // null is the intentional follow-latest cursor.
  return index >= history.length - 1 ? null : (history[index]?.key ?? null);
}

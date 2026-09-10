import { useEffect } from "react";
import { toast } from "sonner";
import { useAppStore, selectMultiBotActive } from "../store";

/**
 * useBotToggleShortcuts — global digit shortcuts (1–9) that toggle each bot's
 * `active` flag on/off, but only once multi-bot is actually engaged (toggle on
 * AND ≥2 bots authenticated). With 0–1 bots the digits do nothing so they
 * don't collide with any other single-bot usage.
 *
 * Guards:
 *  - Ignored while typing in inputs/textareas/contentEditable.
 *  - Ignored when a modifier (ctrl/meta/alt) is held.
 *  - Only fires for bots that exist at that 1-based index.
 */
export function useBotToggleShortcuts() {
  const multiBotActive = useAppStore(selectMultiBotActive);
  const bots = useAppStore((s) => s.bots);

  useEffect(() => {
    if (!multiBotActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      // Digits 1–9 only (0 is intentionally unused).
      if (e.key < "1" || e.key > "9") return;
      const idx = Number(e.key) - 1;
      const bot = bots[idx];
      if (!bot) return;
      e.preventDefault();
      useAppStore.getState().toggleBotActive(bot.id);
      toast(`${bot.label} ${bot.active ? "paused" : "active"}`, { duration: 1800 });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [multiBotActive, bots]);
}

/**
 * R34L Learning Readout — the honest disclosure surface for R34L mode.
 *
 * Shows what THIS channel has taught R34L: learning state, evidence amounts
 * (recent session vs retained), age, strongest learned traits, emote tiers,
 * and uncertainty — plus a confirm-gated per-channel reset.
 *
 * Every statement rendered here comes from the same `deriveR34lView`
 * derivation that powers the generation prompt block (via
 * resolveCurrentR34lAdaptation) — the UI can never claim knowledge that
 * generation isn't using.
 *
 * Density variants:
 * - `R34lLearningDetails` — full readout + reset (popover / inline expansion)
 * - `R34lInfoPopover` — click-to-open popover shell (Studio header)
 * - `R34lInlineDetails` — expandable inline details (Core settings, mobile)
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, Info, RotateCcw, Snowflake, X } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { cn } from "../lib/utils";
import { useNowTick } from "../hooks/useNowTick";
import { resolveCurrentR34lAdaptation } from "../lib/r34lAdaptation";
import type { R34lView, R34lLearningState } from "../lib/r34lLearning";
import { r34lDesktopShortcutHint, r34lStateLabel } from "../lib/r34lCopy";
import { playSfx } from "../lib/sfx";

// ─── Shared derivation ───────────────────────────────────────────────────────

/** Resolve the current channel's R34L view, refreshing on the shared 1s clock
 *  while `active` (open popover / expanded row). A closed surface owns no
 *  timer and never re-renders on per-message learning writes. */
function useR34lView(active: boolean): { view: R34lView; enabled: boolean; connected: boolean; frozen: boolean } {
  const now = useNowTick(active);
  const enabled = useAppStore((s) => s.r34lEnabled);
  const frozen = useAppStore((s) => s.r34lLearningFrozen);
  const connected = useAppStore((s) => !!s.streamMetadata.channelName?.trim());
  return useMemo(() => {
    const { view } = resolveCurrentR34lAdaptation(now || Date.now());
    return { view, enabled, connected, frozen };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, enabled, connected, frozen]);
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export { r34lStateLabel } from "../lib/r34lCopy";

const STATE_COLORS: Record<R34lLearningState, string> = {
  unlearned: "text-gray-500 bg-white/5 border-white/10",
  collecting: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  usable: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
  established: "text-emerald-300 bg-emerald-500/15 border-emerald-500/40",
  aging: "text-cyan-300 bg-cyan-500/10 border-cyan-500/30",
};

// ─── Full details readout ────────────────────────────────────────────────────

function BandTag({ band, applied }: { band: "collecting" | "emerging" | "established"; applied: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 text-[8px] font-bold uppercase font-mono tracking-wider px-1 py-px rounded border",
        applied
          ? "text-emerald-300 bg-emerald-500/10 border-emerald-500/30"
          : "text-gray-500 bg-white/5 border-white/10",
      )}
    >
      {applied ? (band === "established" ? "established" : "applied") : "observed"}
    </span>
  );
}

/** The complete learning readout: identity, state, evidence, traits, emotes,
 *  uncertainty, and the confirm-gated reset. Used by both the Studio popover
 *  and the Core/mobile inline expansion. */
export function R34lLearningDetails({ showDesktopShortcutHint = true }: { showDesktopShortcutHint?: boolean } = {}) {
  const { view, enabled, connected, frozen } = useR34lView(true);
  const [confirmReset, setConfirmReset] = useState(false);
  const applied = view.statements.filter((s) => s.applied);
  const observed = view.statements.filter((s) => !s.applied);

  return (
    <div className="space-y-2.5 text-left">
      {/* Header: identity + state */}
      <div className="flex items-center gap-1.5 pb-1.5 border-b border-white/5">
        <Brain className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
        <span className="text-[11px] font-bold uppercase font-mono tracking-wider text-emerald-300 truncate">
          What R34L has learned
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={cn("text-[9px] font-bold uppercase font-mono tracking-wider px-1.5 py-0.5 rounded border", STATE_COLORS[view.state])}>
          {view.state}
        </span>
        {frozen && (
          <span className="flex items-center gap-0.5 text-[9px] font-bold uppercase font-mono tracking-wider px-1.5 py-0.5 rounded border text-yellow-300 bg-yellow-500/10 border-yellow-500/30">
            <Snowflake className="w-2.5 h-2.5" />
            frozen
          </span>
        )}
        {connected && (
          <span className="text-[10px] font-mono text-gray-400 truncate">
            #{view.channel || "—"} · {view.platform}
          </span>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-gray-300">
        {r34lStateLabel(view.state, enabled, connected, frozen)}
        {connected && r34lDesktopShortcutHint(frozen, showDesktopShortcutHint) && (
          <span className="text-yellow-300/80"> {r34lDesktopShortcutHint(frozen, showDesktopShortcutHint)}</span>
        )}
      </p>

      {/* Evidence amounts + age */}
      {connected && (view.retainedMessages > 0 || view.recentMessages > 0) && (
        <div className="grid grid-cols-2 gap-1.5">
          <div className="rounded-md bg-black/30 border border-white/5 px-2 py-1.5">
            <div className="text-[9px] font-bold uppercase font-mono text-gray-500 tracking-wider">Retained</div>
            <div className="text-[13px] font-bold text-gray-200 font-mono">{view.retainedMessages.toLocaleString()}</div>
            <div className="text-[9px] text-gray-600">messages, long-term</div>
          </div>
          <div className="rounded-md bg-black/30 border border-white/5 px-2 py-1.5">
            <div className="text-[9px] font-bold uppercase font-mono text-gray-500 tracking-wider">This session</div>
            <div className="text-[13px] font-bold text-gray-200 font-mono">{view.recentMessages.toLocaleString()}</div>
            <div className="text-[9px] text-gray-600">fresh evidence</div>
          </div>
        </div>
      )}
      {connected && view.lastUpdatedAt && (
        <p className="text-[10px] text-gray-500">
          Last learned {formatAge(Date.now() - view.lastUpdatedAt)}
          {view.evidenceAgeMs !== null && view.state === "aging" ? " — history is aging; quiet periods keep it, new chat refreshes it" : ""}
        </p>
      )}

      {/* Traits: applied vs observed */}
      {applied.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] font-bold uppercase font-mono text-emerald-400/80 tracking-wider">
            Affecting output now{enabled ? "" : " (once R34L is on)"}
          </div>
          {applied.map((s) => (
            <div key={s.family} className="flex items-start gap-1.5">
              <BandTag band={s.band} applied />
              <p className="text-[10px] text-gray-300 leading-snug">{s.text}</p>
            </div>
          ))}
        </div>
      )}
      {observed.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] font-bold uppercase font-mono text-gray-500 tracking-wider">
            Observed — not steering output
          </div>
          {observed.map((s) => (
            <div key={s.family} className="flex items-start gap-1.5">
              <BandTag band={s.band} applied={false} />
              <p className="text-[10px] text-gray-500 leading-snug">{s.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* Emotes */}
      {view.emotes.length > 0 && (
        <div className="space-y-1">
          <div className="text-[9px] font-bold uppercase font-mono text-gray-500 tracking-wider">
            Learned emotes
          </div>
          {view.emotes.slice(0, 5).map((e) => (
            <div key={e.name} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[10px] font-mono font-bold text-gray-200">{e.name}</span>
              <span className="text-[9px] text-gray-500">
                ~1 in {Math.max(2, Math.round(1 / Math.max(e.share, 0.001)))} msgs
              </span>
              {e.patterns.length > 0 && (
                <span className="text-[9px] text-gray-600">({e.patterns.join(", ")})</span>
              )}
              {e.usable === "yes" ? (
                <span className="text-[8px] font-bold uppercase font-mono px-1 py-px rounded border text-emerald-300 bg-emerald-500/10 border-emerald-500/30">usable</span>
              ) : (
                <span className="text-[8px] font-bold uppercase font-mono px-1 py-px rounded border text-gray-500 bg-white/5 border-white/10" title="Observed in chat, but bot send-permission can't be verified (platform-native or subscriber emote)">unverified</span>
              )}
              {e.newThisSession && (
                <span className="text-[8px] font-bold uppercase font-mono px-1 py-px rounded border text-cyan-300 bg-cyan-500/10 border-cyan-500/30">new</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Uncertainty */}
      {view.notes.length > 0 && (
        <div className="space-y-0.5">
          {view.notes.map((n) => (
            <p key={n} className="text-[9px] text-amber-400/70 leading-snug">⚠ {n}</p>
          ))}
        </div>
      )}

      {/* Reset — confirm-gated, scoped to this channel+platform only.
          Unavailable while Frozen Learning is on: the freeze preserves
          learned data, so erasing it is blocked until the user unfreezes. */}
      {connected && frozen && (view.retainedMessages > 0 || view.recentMessages > 0) && (
        <div className="pt-1.5 border-t border-white/5">
          <p className="text-[9px] text-yellow-300/70 leading-snug flex items-center gap-1">
            <Snowflake className="w-3 h-3 shrink-0" />
            Reset is unavailable while Frozen Learning is on — learned data is preserved, not erasable.
          </p>
        </div>
      )}
      {connected && !frozen && (view.retainedMessages > 0 || view.recentMessages > 0) && (
        <div className="pt-1.5 border-t border-white/5">
          {confirmReset ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] text-red-300 leading-snug">
                Clear R34L's learned style for #{view.channel} on {view.platform}? Other channels and memories are untouched.
              </span>
              <button
                type="button"
                onClick={() => {
                  useAppStore.getState().resetR34lChannelLearning();
                  setConfirmReset(false);
                  playSfx("clear_context");
                  toast.success("R34L learning reset for this channel");
                }}
                className="text-[9px] font-bold uppercase font-mono px-2 py-1 rounded border text-red-300 bg-red-500/10 border-red-500/40 hover:bg-red-500/20 transition-colors"
              >
                Confirm reset
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="text-[9px] font-bold uppercase font-mono px-2 py-1 rounded border text-gray-500 bg-white/5 border-white/10 hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="flex items-center gap-1 text-[9px] font-bold uppercase font-mono tracking-wider text-gray-600 hover:text-red-300 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Reset learning for this channel
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Popover + inline shells ─────────────────────────────────────────────────

/**
 * Click-to-open learning popover for the Studio header (TuningDeck). Keyboard
 * accessible (real button, Escape closes), viewport-contained (portaled,
 * clamped), and stable: content refreshes on the shared 1s clock only while
 * open, so per-message learning writes never cause flicker elsewhere.
 */
export function R34lInfoPopover({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    setPos({
      top: Math.min(rect.bottom + 8, window.innerHeight - 320),
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
    });
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label="What has R34L learned for this channel?"
        aria-expanded={open}
        onClick={() => { setOpen((v) => !v); playSfx("palette_select"); }}
        className={cn(
          "rounded-md p-1 border border-transparent text-gray-500 hover:text-emerald-300 hover:bg-emerald-500/10 hover:border-emerald-500/30 transition-all",
          open && "text-emerald-300 bg-emerald-500/10 border-emerald-500/30",
          className,
        )}
      >
        <Info className="w-3 h-3" />
      </button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="R34L channel learning details"
          className="fixed z-[90] w-[min(340px,calc(100vw-16px))] max-h-[70vh] overflow-y-auto themed-scroll rounded-lg bg-[#12121a] border border-emerald-500/25 p-3 shadow-2xl"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="flex justify-end -mt-1 -mr-1">
            <button
              type="button"
              aria-label="Close"
              onClick={() => { setOpen(false); btnRef.current?.focus(); }}
              className="p-1 text-gray-600 hover:text-gray-300 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <R34lLearningDetails />
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Expandable inline details for Core settings + mobile (no absolute
 * positioning inside scroll containers — expands under the control).
 */
export function R34lInlineDetails({ showDesktopShortcutHint = true }: { showDesktopShortcutHint?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-1 text-[9px] font-bold uppercase font-mono tracking-wider text-gray-600 hover:text-emerald-300 transition-colors py-0.5"
      >
        <Info className="w-3 h-3" />
        {open ? "Hide channel learning" : "What has R34L learned?"}
      </button>
      {open && (
        <div className="mt-1.5 rounded-lg bg-black/30 border border-emerald-500/15 p-2.5">
          <R34lLearningDetails showDesktopShortcutHint={showDesktopShortcutHint} />
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  X,
  Sliders,
  Users,
  BarChart3,
  Gauge,
  Brain,
  NotebookPen,
  Workflow,
  Lock,
  ScrollText,
  Sparkles,
  ChevronRight,
} from "lucide-react";
import { useAppStore } from "../store";
import { useCoreReadiness } from "../hooks/useCoreReadiness";
import { useEffectiveMode, useStudioAvailable } from "../hooks/useMediaQuery";
import { playSfx } from "../lib/sfx";

/**
 * StudioDiscoveryOverlay — shows 10s after the user completes all Core
 * onboarding steps. Lists Studio-only features the user doesn't have in
 * Core mode so they understand what they're "missing out on". Dismissed
 * via Acknowledge or X — gated by `studioDiscoverySeen` so it only fires
 * once per user.
 */
const STUDIO_FEATURES: {
  icon: typeof Sliders;
  title: string;
  desc: string;
  accent: string;
}[] = [
  {
    icon: Sliders,
    title: "Full Tuning Deck",
    desc: "Granular persona sliders, context token budget, mood lock, and Forge templates — the complete control surface.",
    accent: "text-orange-400",
  },
  {
    icon: Users,
    title: "Multi-Bot Mode",
    desc: "Run multiple bot identities simultaneously with per-bot personas, rate limits, and a speaker coordinator.",
    accent: "text-purple-400",
  },
  {
    icon: BarChart3,
    title: "Analytics Dashboard",
    desc: "Live session stats, sentiment trends, AutoForge decision history, action accuracy, and token spend by feature.",
    accent: "text-cyan-400",
  },
  {
    icon: Gauge,
    title: "Rate Limit Configuration",
    desc: "Fine-tune per-hour and per-window action caps, minimum cooldowns, and per-action rate limits to prevent spam.",
    accent: "text-amber-400",
  },
  {
    icon: Brain,
    title: "AutoMemory Configuration",
    desc: "Configure how MADchatter extracts, stores, and recalls long-term memories — extraction intervals, scope, and limits.",
    accent: "text-purple-400",
  },
  {
    icon: NotebookPen,
    title: "Director Notes",
    desc: "Private streamer-to-bot directives with priority ordering, timed expiry, and per-bot targeting.",
    accent: "text-emerald-400",
  },
  {
    icon: Workflow,
    title: "AutoForge Sequences",
    desc: "Multi-step scripted action sequences with conditional logic, delays, and bot identity selection.",
    accent: "text-blue-400",
  },
  {
    icon: ScrollText,
    title: "Rule Builder",
    desc: "Visual rule engine — trigger actions on chat conditions, keywords, sentiment, or schedule with live dry-run testing.",
    accent: "text-rose-400",
  },
  {
    icon: Lock,
    title: "Advanced AutoForge HUD",
    desc: "Expanded decision HUD with confidence thresholds, dry-run mode, force-check, and real-time decision telemetry.",
    accent: "text-orange-400",
  },
];

export function StudioDiscoveryOverlay() {
  // effectiveMode: only promote Studio to users currently in Core (the
  // overlay is a Core→Studio discovery nudge). When STUDIO is unavailable
  // the overlay still fires (STUDIO stays discoverable as a larger-screen
  // feature), but the "Open Studio" action routes through setInterfaceMode
  // which opens the gate interstitial instead of switching.
  const interfaceMode = useEffectiveMode();
  const studioAvailable = useStudioAvailable();
  const studioDiscoverySeen = useAppStore((s) => s.studioDiscoverySeen);
  const setStudioDiscoverySeen = useAppStore((s) => s.setStudioDiscoverySeen);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const readiness = useCoreReadiness();
  const [visible, setVisible] = useState(false);

  // Fire 10s after onboarding completes — only in (effective) Core mode, once.
  useEffect(() => {
    if (interfaceMode !== "core") return;
    if (studioDiscoverySeen) return;
    if (!readiness.operational) return;
    const timer = setTimeout(() => {
      setVisible(true);
      playSfx("hud_open");
    }, 10000);
    return () => clearTimeout(timer);
  }, [interfaceMode, studioDiscoverySeen, readiness.operational]);

  const dismiss = () => {
    setVisible(false);
    setStudioDiscoverySeen(true);
    playSfx("welcome_dismiss");
  };

  const goToStudio = () => {
    setVisible(false);
    setStudioDiscoverySeen(true);
    // When STUDIO is unavailable this opens the gate interstitial (the store
    // action gates it) rather than switching — no broken layout.
    setInterfaceMode("studio");
    playSfx("welcome_dismiss");
  };

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -20, x: -10 }}
          animate={{ opacity: 1, y: 0, x: 0 }}
          exit={{ opacity: 0, y: -20, x: -10 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="fixed top-4 left-4 z-[100000] w-[360px] max-w-[calc(100vw-2rem)]"
        >
          <div
            className="relative rounded-2xl border border-cyan-500/30 overflow-hidden shadow-2xl"
            style={{
              background:
                "linear-gradient(135deg, rgba(10,12,18,0.97), rgba(8,10,16,0.97))",
              backdropFilter: "blur(18px) saturate(115%)",
              WebkitBackdropFilter: "blur(18px) saturate(115%)",
              boxShadow:
                "0 20px 60px rgba(0,0,0,0.5), 0 0 24px rgba(34,211,238,0.08), inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            {/* Top accent bar */}
            <div className="h-[2px] w-full bg-gradient-to-r from-cyan-500 via-purple-500 to-orange-500" />

            {/* Header */}
            <div className="flex items-start justify-between px-4 pt-4 pb-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center shrink-0">
                  <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                </div>
                <div>
                  <h2 className="text-sm font-black text-gray-100 leading-tight">
                    Explore Studio Mode
                  </h2>
                  <p className="text-[10px] text-gray-500 leading-tight">
                    Features available in Studio
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={dismiss}
                aria-label="Dismiss"
                className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Intro line */}
            <div className="px-4 pb-2">
              <p className="text-[11px] text-gray-400 leading-relaxed">
                You're live in Core Mode. Studio Mode adds these advanced
                controls — the engine stays the same, you just get more
                surface area to tune it.
              </p>
            </div>

            {/* Feature list */}
            <div className="px-4 pb-3 max-h-[50vh] overflow-y-auto">
              <div className="space-y-2">
                {STUDIO_FEATURES.map((f) => {
                  const Icon = f.icon;
                  return (
                    <div
                      key={f.title}
                      className="flex items-start gap-2.5 p-2 rounded-lg bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="shrink-0 mt-0.5">
                        <Icon className={`w-4 h-4 ${f.accent}`} />
                      </div>
                      <div className="min-w-0">
                        <div className={`text-[11px] font-bold ${f.accent} leading-tight`}>
                          {f.title}
                        </div>
                        <div className="text-[10px] text-gray-500 leading-snug mt-0.5">
                          {f.desc}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer actions */}
            <div className="px-4 pb-4 pt-2 border-t border-white/5 flex items-center gap-2">
              <button
                type="button"
                onClick={dismiss}
                className="flex-1 px-3 py-2 rounded-lg text-[11px] font-bold text-gray-400 bg-white/5 border border-white/10 hover:bg-white/10 hover:text-gray-200 transition-all"
              >
                Acknowledge
              </button>
              <button
                type="button"
                onClick={goToStudio}
                className="flex-1 px-3 py-2 rounded-lg text-[11px] font-bold text-white bg-gradient-to-r from-cyan-500 to-blue-500 hover:shadow-lg hover:shadow-cyan-500/30 transition-all flex items-center justify-center gap-1.5"
              >
                Open Studio
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

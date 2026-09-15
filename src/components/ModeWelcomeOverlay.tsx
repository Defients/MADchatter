import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, Sliders, ChevronRight, Check } from "lucide-react";
import { useAppStore } from "../store";
import { playSfx } from "../lib/sfx";
import { VersionBadge } from "./VersionBadge";
import logoUrl from "../../madchatter-logo1.png";

/**
 * ModeWelcomeOverlay — initial Core/Studio mode picker for first-run users.
 *
 * Shows once (gated by `modeWelcomeSeen` in the store). Presents two cards:
 * Core (recommended, focused workflow) and Studio (full control). Selecting
 * either sets `interfaceMode` and marks the welcome as seen.
 */
export function ModeWelcomeOverlay() {
  const visible = useAppStore((s) => !s.modeWelcomeSeen);
  const setModeWelcomeSeen = useAppStore((s) => s.setModeWelcomeSeen);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);

  const choose = (mode: "core" | "studio") => {
    setInterfaceMode(mode);
    setModeWelcomeSeen(true);
    playSfx("welcome_dismiss");
  };

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="fixed inset-0 z-[100001] flex items-center justify-center bg-black/80 backdrop-blur-lg overflow-y-auto py-8"
        >
          {/* Animated gradient backdrop */}
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            {/* Video background — subtle and dimmed */}
            <video
              autoPlay
              loop
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover opacity-[0.18]"
            >
              <source src="/welcome-bg.mp4" type="video/mp4" />
            </video>
            <div className="absolute -top-1/4 -left-1/4 w-1/2 h-1/2 bg-orange-500/8 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: "6s" }} />
            <div className="absolute -bottom-1/4 -right-1/4 w-1/2 h-1/2 bg-cyan-500/8 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: "8s", animationDelay: "2s" }} />
          </div>

          <motion.div
            initial={{ scale: 0.94, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, y: 20 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-3xl mx-4 border border-white/[0.08] rounded-2xl overflow-hidden"
            style={{
              background: `radial-gradient(circle at 50% 18%, rgba(116, 74, 255, 0.065), transparent 35%), linear-gradient(135deg, rgba(255, 118, 0, 0.018), rgba(10, 12, 18, 0.96) 42%, rgba(0, 195, 255, 0.018))`,
              backdropFilter: "blur(18px) saturate(115%)",
              WebkitBackdropFilter: "blur(18px) saturate(115%)",
              boxShadow: "0 24px 80px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.025)",
            }}
          >
            {/* Subtle noise texture — keeps the dark surface from feeling digitally dead */}
            <div className="welcome-card-noise absolute inset-0 pointer-events-none" />

            {/* Top accent bar */}
            <div className="h-[2px] w-full bg-gradient-to-r from-orange-500 via-purple-500 to-cyan-500" />

            <div className="p-6 sm:p-10">
              {/* Header */}
              <div className="text-center mb-8">
                <motion.img
                  src={logoUrl}
                  alt="MADchatter"
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="mx-auto h-20 w-auto mb-3 object-contain"
                  style={{ filter: "drop-shadow(0 0 14px rgba(255, 250, 250, 0.2))" }}
                />
                <span className="opacity-50">
                  <VersionBadge />
                </span>
                <h1 className="text-xl font-black text-gray-100 mt-4 mb-1">
                  Welcome to MADchatter
                </h1>
                <p className="text-sm text-gray-400 max-w-md mx-auto">
                  Choose how much control you want up front.
                </p>
              </div>

              {/* Mode cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                {/* CORE */}
                <motion.button
                  type="button"
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.3, duration: 0.4 }}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => choose("core")}
                  className="group relative text-left bg-gradient-to-b from-orange-500/[0.08] to-[#0a0a0f]/80 border-2 border-orange-500/30 rounded-2xl p-5 transition-all hover:border-orange-500/60 hover:shadow-[0_0_24px_rgba(249,115,22,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50 overflow-hidden"
                >
                  {/* Recommended badge */}
                  <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-0.5 rounded-full bg-orange-500/20 border border-orange-500/40 text-[9px] font-black uppercase tracking-wider text-orange-300">
                    <Sparkles className="w-2.5 h-2.5" />
                    Recommended
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-2xl font-black text-orange-400 tracking-tight">CORE</span>
                  </div>

                  <ul className="space-y-1.5 mb-5">
                    {[
                      "Focused workflow",
                      "Guided setup",
                      "Forge + Chat first",
                    ].map((item) => (
                      <li key={item} className="flex items-center gap-2 text-xs text-gray-300">
                        <Check className="w-3 h-3 text-orange-400 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>

                  <div className="flex items-center justify-center gap-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white font-bold text-sm transition-all group-hover:shadow-lg group-hover:shadow-orange-500/30">
                    START CORE
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </motion.button>

                {/* STUDIO */}
                <motion.button
                  type="button"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.4, duration: 0.4 }}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.99 }}
                  onClick={() => choose("studio")}
                  className="group relative text-left bg-gradient-to-b from-cyan-500/[0.08] to-[#0a0a0f]/80 border-2 border-cyan-500/30 rounded-2xl p-5 transition-all hover:border-cyan-500/60 hover:shadow-[0_0_24px_rgba(34,211,238,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50 overflow-hidden"
                >
                  <div className="absolute top-3 right-3 flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/20 border border-cyan-500/40 text-[9px] font-black uppercase tracking-wider text-cyan-300">
                    <Sliders className="w-2.5 h-2.5" />
                    Full Control
                  </div>

                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-2xl font-black text-cyan-400 tracking-tight">STUDIO</span>
                  </div>

                  <ul className="space-y-1.5 mb-5">
                    {[
                      "Full workspace",
                      "Advanced configuration",
                      "Multi-Bot, tuning, etc.",
                    ].map((item) => (
                      <li key={item} className="flex items-center gap-2 text-xs text-gray-300">
                        <Check className="w-3 h-3 text-cyan-400 shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>

                  <div className="flex items-center justify-center gap-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 text-white font-bold text-sm transition-all group-hover:shadow-lg group-hover:shadow-cyan-500/30">
                    OPEN STUDIO
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </motion.button>
              </div>

              {/* Footer note */}
              <p className="text-center text-[11px] text-gray-500">
                Switch modes anytime. Nothing is lost.
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

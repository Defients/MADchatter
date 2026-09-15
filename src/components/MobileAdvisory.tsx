import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import {
  Monitor,
  Smartphone,
  VolumeX,
  Sparkles,
  LayoutGrid,
  X,
  ArrowRight,
} from "lucide-react";
import { useIsMobile, useIsTouch } from "../hooks/useMediaQuery";
import { useAppStore } from "../store";
import { playSfx } from "../lib/sfx";

/**
 * MobileAdvisory — Beautiful, modern dismissible overlay shown on small/touch viewports in Studio Mode.
 * Explains desktop workstation requirements and guides the user to the mobile-optimized CORE mode.
 */
export function MobileAdvisory() {
  const isMobile = useIsMobile();
  const isTouch = useIsTouch();
  const interfaceMode = useAppStore((s) => s.interfaceMode);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);
  const [dismissed, setDismissed] = useState(false);

  // Re-show on orientation/viewport changes that cross the threshold
  useEffect(() => {
    if (!isMobile && !isTouch) setDismissed(false);
  }, [isMobile, isTouch]);

  // Core mode is intentionally optimized for mobile — only warn in Studio mode
  if (interfaceMode === "core" || dismissed || (!isMobile && !isTouch)) return null;

  const handleDismiss = () => {
    setDismissed(true);
    playSfx("welcome_dismiss");
  };

  const handleSwitchToCore = () => {
    setInterfaceMode("core");
    setDismissed(true);
    playSfx("palette_select");
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[100000] flex items-center justify-center p-4 bg-black/80 backdrop-blur-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Desktop browser recommended"
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0, y: 12 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.92, opacity: 0, y: 12 }}
          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-sm rounded-2xl border border-amber-500/25 overflow-hidden text-center shadow-[0_24px_70px_rgba(0,0,0,0.8),0_0_36px_rgba(245,158,11,0.1)]"
          style={{
            background: "linear-gradient(145deg, rgba(20, 22, 32, 0.98), rgba(12, 14, 22, 0.99))",
          }}
        >
          {/* Top glowing accent bar */}
          <div className="h-[2px] w-full bg-gradient-to-r from-amber-500 via-orange-500 to-yellow-400" />

          {/* Close button */}
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Close notification"
            className="absolute top-3.5 right-3.5 p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>

          <div className="p-5 sm:p-6 space-y-4">
            {/* Ambient Icon Badge */}
            <div className="relative mx-auto mt-1 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-b from-amber-500/20 to-orange-500/5 border border-amber-500/30 shadow-[0_0_24px_rgba(245,158,11,0.22)]">
              <Monitor className="h-7 w-7 text-amber-400 drop-shadow-[0_2px_8px_rgba(245,158,11,0.4)]" strokeWidth={2} />
            </div>

            {/* Headers */}
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-amber-400/90 bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 rounded-full">
                Desktop Recommended
              </div>
              <h2 className="text-lg font-black text-gray-100 tracking-tight">
                Workstation Experience
              </h2>
              <p className="text-xs text-gray-400 leading-relaxed max-w-[20rem] mx-auto">
                MADchatter STUDIO is tailored for desktop Chromium browsers (Chrome & Edge). Several workstation features are limited on mobile:
              </p>
            </div>

            {/* Structured Limitation Cards */}
            <div className="space-y-2 text-left">
              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex items-start gap-2.5">
                <div className="w-6 h-6 rounded-lg bg-orange-500/15 border border-orange-500/25 flex items-center justify-center text-orange-400 shrink-0 mt-0.5">
                  <VolumeX className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-gray-200">System Audio Capture</div>
                  <div className="text-[10px] text-gray-400 leading-snug">Mobile security restricts window/tab capture (getDisplayMedia)</div>
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex items-start gap-2.5">
                <div className="w-6 h-6 rounded-lg bg-cyan-500/15 border border-cyan-500/25 flex items-center justify-center text-cyan-400 shrink-0 mt-0.5">
                  <Sparkles className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-gray-200">Whisper Live Transcription</div>
                  <div className="text-[10px] text-gray-400 leading-snug">Requires desktop WebGPU & ~40 MB local neural model</div>
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/5 flex items-start gap-2.5">
                <div className="w-6 h-6 rounded-lg bg-purple-500/15 border border-purple-500/25 flex items-center justify-center text-purple-400 shrink-0 mt-0.5">
                  <LayoutGrid className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-gray-200">Multi-Column Studio Layout</div>
                  <div className="text-[10px] text-gray-400 leading-snug">Drag-and-drop workspace & keyboard hotkeys need a wider screen</div>
                </div>
              </div>
            </div>

            {/* Mobile CORE Ready Reassurance */}
            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2.5 text-left">
              <div className="w-6 h-6 rounded-lg bg-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
                <Smartphone className="w-3.5 h-3.5" />
              </div>
              <div className="text-[11px] text-emerald-200/90 leading-tight flex-1">
                <span className="font-bold text-emerald-300">CORE Mode is mobile-optimized:</span> Live chat, AI Forge, and stream tuning work seamlessly here!
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-1.5 pt-1">
              <button
                type="button"
                onClick={handleSwitchToCore}
                className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-bold text-xs shadow-[0_0_20px_rgba(249,115,22,0.25)] hover:shadow-[0_0_28px_rgba(249,115,22,0.4)] transition-all flex items-center justify-center gap-1.5 touch-target active:scale-[0.98]"
              >
                <span>Switch to Mobile CORE</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                onClick={handleDismiss}
                className="w-full py-2 px-4 rounded-xl text-xs font-semibold text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-colors touch-target"
              >
                Continue in Studio anyway
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { Monitor, Smartphone, ChevronRight } from "lucide-react";
import { useAppStore } from "../store";
import { playSfx } from "../lib/sfx";

/**
 * StudioGateOverlay — the "STUDIO needs a larger screen" interstitial.
 *
 * Shown when the user attempts to enter STUDIO while the viewport is too
 * narrow to support it (gated by `studioGateOpen` in the store, set by
 * `setInterfaceMode`). This is not an error state — it explains that STUDIO
 * is MADchatter's full desktop workspace and that CORE is the optimized
 * experience for the current screen. The user's preferred mode is never
 * changed by this gate.
 */
export function StudioGateOverlay() {
  const open = useAppStore((s) => s.studioGateOpen);
  const setOpen = useAppStore((s) => s.setStudioGateOpen);

  const close = () => {
    setOpen(false);
    playSfx("welcome_dismiss");
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100002] flex items-center justify-center bg-black/80 backdrop-blur-lg p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="studio-gate-title"
          aria-describedby="studio-gate-desc"
        >
          <motion.div
            initial={{ scale: 0.94, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.94, y: 16 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-md border border-white/[0.08] rounded-2xl overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, rgba(10,12,18,0.97), rgba(8,10,16,0.97))",
              boxShadow:
                "0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            {/* Top accent bar */}
            <div className="h-[2px] w-full bg-gradient-to-r from-orange-500 via-purple-500 to-cyan-500" />

            <div className="p-6 sm:p-8 text-center">
              {/* Icon contrast: large screen vs current small screen */}
              <div className="flex items-center justify-center gap-3 mb-5">
                <div className="relative flex items-end gap-1">
                  <Smartphone className="w-7 h-7 text-orange-400" strokeWidth={2.2} />
                  <Monitor className="w-10 h-10 text-cyan-400/80" strokeWidth={2.2} />
                </div>
              </div>

              <h1
                id="studio-gate-title"
                className="text-lg font-black text-gray-100 mb-2"
              >
                STUDIO needs a larger screen
              </h1>
              <p
                id="studio-gate-desc"
                className="text-sm text-gray-400 leading-relaxed max-w-sm mx-auto mb-1"
              >
                STUDIO is MADchatter's full desktop workspace and needs more
                room to operate properly. CORE provides the optimized
                experience for this screen.
              </p>
              <p className="text-[11px] text-gray-600 leading-relaxed max-w-xs mx-auto mb-6">
                Open MADchatter on a larger display to use STUDIO.
              </p>

              <button
                type="button"
                onClick={close}
                autoFocus
                className="group relative w-full px-5 py-3 rounded-xl font-bold text-sm transition-all duration-300 overflow-hidden bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-[0_0_24px_rgba(249,115,22,0.22)] hover:shadow-[0_0_36px_rgba(249,115,22,0.38)] hover:scale-[1.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/50"
              >
                <span className="relative flex items-center justify-center gap-2">
                  Continue in CORE
                  <ChevronRight className="w-4 h-4" />
                </span>
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

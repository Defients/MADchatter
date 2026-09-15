/**
 * CoreGreeting — minimal first-run greeting for new users.
 *
 * Replaces the feature-encyclopedia Welcome overlay for first-time users.
 * One action ("Start") drops them into Core Mode where the Launchpad
 * guides them through real configuration.
 *
 * The original WelcomeOverlay is retained for manual "Reopen Welcome Screen"
 * access via the command palette — it's a feature reference, not onboarding.
 */

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { Flame } from "lucide-react";
import { playSfx } from "../lib/sfx";
import { useAppStore } from "../store";
import { VersionBadge } from "./VersionBadge";
import logoUrl from "../../madchatter-logo1.png";

const STORAGE_KEY = "madchatter-core-greeting-seen";

export function CoreGreeting() {
  const [visible, setVisible] = useState(false);
  const setInterfaceMode = useAppStore((s) => s.setInterfaceMode);

  useEffect(() => {
    // Only show on genuine first run (no greeting seen AND no old welcome seen).
    // Users who already saw the old Welcome overlay won't see this.
    if (localStorage.getItem(STORAGE_KEY)) return;
    if (localStorage.getItem("madchatter-welcome-seen")) return;
    setVisible(true);
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  const start = () => {
    playSfx("welcome_dismiss");
    // Ensure new users land in Core Mode
    setInterfaceMode("core");
    dismiss();
  };

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/85 backdrop-blur-lg"
        >
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute -top-1/4 -left-1/4 w-1/2 h-1/2 bg-orange-500/8 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: "6s" }} />
            <div className="absolute -bottom-1/4 -right-1/4 w-1/2 h-1/2 bg-purple-500/8 rounded-full blur-[120px] animate-pulse" style={{ animationDuration: "8s", animationDelay: "2s" }} />
          </div>

          <motion.div
            initial={{ scale: 0.92, y: 30 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.92, y: 30 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="relative w-full max-w-md mx-4 bg-gradient-to-b from-[#141419] to-[#0a0a0f] border border-white/[0.08] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.6)] overflow-hidden"
          >
            <div className="h-[2px] w-full bg-gradient-to-r from-orange-500 via-purple-500 to-cyan-500" />

            <div className="p-8 text-center">
              <motion.img
                src={logoUrl}
                alt="MADchatter"
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                className="mx-auto h-20 w-auto mb-3 object-contain"
                style={{ filter: "drop-shadow(0 0 16px rgba(255, 250, 250, 0.25))" }}
              />
              <VersionBadge />
              <p className="text-sm text-gray-400 mt-3 max-w-sm mx-auto leading-relaxed">
                AI stream co-pilot for Twitch, Kick, and Joystick.
              </p>
              <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto leading-relaxed">
                Let's get it talking.
              </p>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.4 }}
                className="mt-8"
              >
                <button
                  onClick={start}
                  className="group relative px-8 py-3 rounded-xl font-bold text-sm transition-all duration-300 overflow-hidden bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-[0_0_30px_rgba(249,115,22,0.25)] hover:shadow-[0_0_40px_rgba(249,115,22,0.4)] hover:scale-105"
                >
                  <span className="absolute inset-0 rounded-xl bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
                  <span className="relative flex items-center gap-2">
                    <Flame className="w-4 h-4" />
                    Start
                  </span>
                </button>
              </motion.div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

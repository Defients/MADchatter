import React, { useEffect, useRef } from "react";
import { ArrowRight, X } from "lucide-react";
import logoUrl from "../../madchatter-logo1.png";

interface MobileWelcomeOverlayProps {
  onDismissToTuning: () => void;
}

export function MobileWelcomeOverlay({ onDismissToTuning }: MobileWelcomeOverlayProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    primaryActionRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismissToTuning();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDismissToTuning]);

  return (
    <div
      className="fixed inset-0 z-[100] overflow-y-auto bg-[#07070c]/90 backdrop-blur-md overscroll-contain"
      style={{
        paddingTop: "max(1rem, env(safe-area-inset-top))",
        paddingRight: "max(1rem, env(safe-area-inset-right))",
        paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        paddingLeft: "max(1rem, env(safe-area-inset-left))",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
    >
      <div className="min-h-full flex items-center justify-center">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-welcome-title"
          aria-describedby="mobile-welcome-description"
          className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#111119]/95 px-5 pb-6 pt-8 shadow-[0_24px_90px_rgba(0,0,0,0.72),0_0_45px_rgba(139,92,246,0.12)]"
        >
          <div className="pointer-events-none absolute -left-16 -top-20 h-44 w-44 rounded-full bg-purple-500/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 -right-16 h-44 w-44 rounded-full bg-cyan-400/10 blur-3xl" />
          <div className="pointer-events-none absolute left-1/3 top-1/2 h-32 w-32 rounded-full bg-orange-500/[0.06] blur-3xl" />

          <button
            type="button"
            onClick={onDismissToTuning}
            aria-label="Close welcome and open Tuning"
            className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="relative text-center">
            <img
              src={logoUrl}
              alt=""
              aria-hidden="true"
              className="mx-auto h-16 w-auto select-none forge-logo-glow"
            />
            <h1 id="mobile-welcome-title" className="mt-3 text-2xl font-black tracking-tight text-white">
              MADchatter
            </h1>
            <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.24em] text-orange-300">
              AI Stream Co-Pilot
            </div>

            <div id="mobile-welcome-description" className="mx-auto mt-6 max-w-sm space-y-3 text-sm leading-relaxed text-gray-300">
              <p>
                MADchatter reads the room using chat, stream context, audio, visuals, and memory—then helps your AI chatter know when and what to say.
              </p>
              <p className="text-gray-400">
                Start in Tuning to connect a stream, choose an AI provider, and shape how your bot behaves.
              </p>
            </div>

            <button
              ref={primaryActionRef}
              type="button"
              onClick={onDismissToTuning}
              className="mt-7 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-orange-400/50 bg-gradient-to-r from-orange-500/25 via-purple-500/20 to-cyan-500/20 px-4 text-sm font-black uppercase tracking-wider text-white shadow-[0_0_24px_rgba(249,115,22,0.12)] transition-all hover:border-orange-300/70 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            >
              Start Tuning
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

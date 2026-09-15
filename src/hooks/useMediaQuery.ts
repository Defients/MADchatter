import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { STUDIO_MIN_WIDTH, isStudioAvailable, setStudioAvailable } from "../lib/studioAvailability";

/**
 * useMediaQuery — SSR-safe, listener-based media query hook.
 * Returns `true` when the query matches the current viewport/capabilities.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** True when the viewport is ≤ 768px (phones / small tablets in portrait). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px)");
}

/** True when the primary pointer is coarse (touch) or there is no hover. */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse), (hover: none)");
}

/** True when the user prefers reduced motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Combined: mobile viewport OR touch-only device. */
export function useIsMobileOrTouch(): boolean {
  const isMobile = useIsMobile();
  const isTouch = useIsTouch();
  return isMobile || isTouch;
}

// ─── STUDIO capability ────────────────────────────────────────────────────
//
// STUDIO is the full desktop workspace and needs a minimum usable width
// (STUDIO_MIN_WIDTH). Below that, CORE — the focused/mobile interface — is
// the supported experience. See src/lib/studioAvailability.ts for the full
// product rule and the preferred-vs-effective mode model.

/** Reactive: true when the viewport is wide enough for STUDIO. */
export function useStudioAvailable(): boolean {
  return useMediaQuery(`(min-width: ${STUDIO_MIN_WIDTH}px)`);
}

/** Reactive: the mode that should actually render.
 *  `effectiveMode = (studioAvailable && !studioForcedCore) ? preferred : "core"`. */
export function useEffectiveMode(): "core" | "studio" {
  const preferred = useAppStore((s) => s.interfaceMode);
  const forced = useAppStore((s) => s.studioForcedCore);
  const studioAvailable = useStudioAvailable();
  return studioAvailable && !forced ? preferred : "core";
}

/** Non-reactive: read the effective mode from the current store + module flag.
 *  Use in event handlers / callbacks (not render paths — those use useEffectiveMode
 *  so they update on viewport changes). */
export function getEffectiveMode(): "core" | "studio" {
  const s = useAppStore.getState();
  return isStudioAvailable() && !s.studioForcedCore ? s.interfaceMode : "core";
}

/**
 * useStudioAvailabilitySync — mount once at the app root.
 *
 * Keeps the module-level capability flag (`isStudioAvailable()`) in sync with
 * the live viewport so the store's `setInterfaceMode` gate (a non-React
 * context) always sees the current capability.
 *
 * Also handles live viewport transitions:
 *  - Shrink across the threshold while the user is effectively in STUDIO:
 *    force them into CORE and show a concise explanation. (Case F)
 *  - Expand across the threshold: do nothing — STUDIO becomes available
 *    again but the user re-enters manually. (Case G — no forced switch.)
 */
export function useStudioAvailabilitySync(): void {
  const studioAvailable = useStudioAvailable();
  const prevAvailableRef = useRef(studioAvailable);

  useEffect(() => {
    setStudioAvailable(studioAvailable);
    const prev = prevAvailableRef.current;
    if (prev && !studioAvailable) {
      // Viewport shrank below the STUDIO threshold. If the user was
      // effectively in STUDIO, transition them safely into CORE with a
      // concise explanation. Their *preferred* mode is preserved.
      const s = useAppStore.getState();
      const wasStudio = s.interfaceMode === "studio" && !s.studioForcedCore;
      if (wasStudio) {
        s.setStudioForcedCore(true);
        toast.info("STUDIO needs more screen space, so MADchatter switched to CORE.", {
          duration: 5000,
        });
      }
    }
    // Expand (false → true): intentionally no auto-switch (Case G).
    prevAvailableRef.current = studioAvailable;
  }, [studioAvailable]);
}

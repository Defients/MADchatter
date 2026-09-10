import { useState, useEffect, useCallback } from "react";

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

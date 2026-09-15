/**
 * studioAvailability — canonical STUDIO capability state.
 *
 * STUDIO is MADchatter's full desktop workspace. It needs a minimum usable
 * width to function (multi-panel docks, draggable widgets, center stage).
 * Below that threshold it is unavailable and CORE (the focused/mobile
 * interface) takes over.
 *
 * Capability is derived from the *available viewport width*, NOT from
 * device/UA sniffing. This naturally handles phones, tablets, foldables,
 * landscape orientation, narrow desktop windows, and future form factors.
 *
 * Two layers:
 *   1. A module-level flag (`studioAvailable`) kept in sync with the live
 *      viewport by `useStudioAvailabilitySync()` (mounted once at the app
 *      root). The store's `setInterfaceMode` reads this so EVERY entry path
 *      (header toggle, command palette, overlays, deep links, persisted
 *      state) honors the same rule without each needing its own viewport
 *      check — the store action is the single chokepoint.
 *   2. A reactive hook (`useStudioAvailable` in useMediaQuery.ts) for
 *      components that need to re-render on viewport changes.
 *
 * Preferred vs effective mode:
 *   - `interfaceMode` (persisted) is the user's *preferred* mode. Opening
 *     MADchatter on a phone never overwrites it.
 *   - `effectiveMode` = (studioAvailable && !studioForcedCore)
 *       ? interfaceMode : "core"  — what actually renders.
 *   - `studioForcedCore` is a transient (non-persisted) flag set when a
 *     viewport shrink forces a STUDIO user into CORE, and on initial mount
 *     when the session starts below the threshold. It prevents an automatic
 *     snap back to STUDIO on viewport expand (the user re-enters manually),
 *     while a fresh load on a large screen still resumes STUDIO normally.
 */

/** Minimum usable viewport width for STUDIO. Empirically chosen from the
 * real layout: STUDIO is a three-panel workspace — left dock (min ~16%),
 * center stage, and a right dock holding the TuningDeck (default ~22%,
 * min 12%). The TuningDeck contains fixed-width controls up to ~280px, so
 * it only fits comfortably when ~22% of the viewport ≥ ~280px → ≈1280px.
 * Below that the rails compress and controls overflow. 1280px covers small
 * laptops and large-tablet landscape (iPad Pro landscape = 1366px) while
 * phones, portrait tablets, and narrow windows get the optimized CORE
 * experience. We do not lower this merely to make STUDIO technically
 * reachable — CORE is the designed experience below it. */
export const STUDIO_MIN_WIDTH = 1280;

let studioAvailable =
  typeof window !== "undefined"
    ? window.innerWidth >= STUDIO_MIN_WIDTH
    : true;

/** Update the module-level capability flag. Called by useStudioAvailabilitySync()
 * on mount and whenever the viewport crosses the threshold. */
export function setStudioAvailable(v: boolean): void {
  studioAvailable = v;
}

/** Read the current capability flag. Used by the store's setInterfaceMode
 * (a non-React context) so the gate works from every entry path. */
export function isStudioAvailable(): boolean {
  return studioAvailable;
}

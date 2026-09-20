export type RangeGestureIntent = "pending" | "horizontal" | "vertical";

export interface RangeGestureState {
  pointerId: number;
  startX: number;
  startY: number;
  intent: RangeGestureIntent;
}

export function beginRangeGesture(pointerId: number, startX: number, startY: number): RangeGestureState {
  return { pointerId, startX, startY, intent: "pending" };
}

/**
 * Resolve a touch range gesture only after movement clears the jitter
 * threshold. Once resolved, intent stays locked for the rest of the gesture.
 */
export function updateRangeGestureIntent(
  state: RangeGestureState,
  currentX: number,
  currentY: number,
  threshold = 7,
): RangeGestureState {
  if (state.intent !== "pending") return state;
  const dx = Math.abs(currentX - state.startX);
  const dy = Math.abs(currentY - state.startY);
  if (Math.max(dx, dy) <= threshold || dx === dy) return state;
  return { ...state, intent: dx > dy ? "horizontal" : "vertical" };
}

export type MobileLengthOption = "short" | "medium" | "long";

export function toggleMobileLengthPreference(current: string | undefined, option: MobileLengthOption): MobileLengthOption | "adaptive" {
  return current === option ? "adaptive" : option;
}

export function isMobileLengthOptionActive(current: string | undefined, option: MobileLengthOption): boolean {
  return current === option;
}

export function isAdaptiveLengthPreference(current: string | undefined): boolean {
  return current === "adaptive" || current === "none";
}

export interface MobileProviderDisclosureState {
  expanded: boolean;
  expandedProvider: string | null;
  apiKeyDraft: string;
}

/** Collapse presentation state only; saved provider configuration is external. */
export function collapseMobileProviderDisclosure(): MobileProviderDisclosureState {
  return { expanded: false, expandedProvider: null, apiKeyDraft: "" };
}

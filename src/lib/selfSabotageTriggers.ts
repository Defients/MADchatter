import { SELF_SABOTAGE_CONFIG } from "./selfSabotageCore";

export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** Pure predicate kept separate from DOM wiring so key-repeat/modifier
 * behavior is regression-testable without a browser. */
export function isSelfSabotageShortcut(event: ShortcutEventLike): boolean {
  return SELF_SABOTAGE_CONFIG.easterEggs.desktop
    && !event.defaultPrevented
    && !event.repeat
    && !event.isComposing
    && !event.metaKey
    && event.ctrlKey
    && event.shiftKey
    && event.altKey
    && event.key.toLowerCase() === "b";
}

/** Rolling, hidden mobile tap recognizer. A successful sequence enters a
 * lockout so a fourth tap cannot become tap one of an accidental retrigger. */
export class MobileSelfSabotageTapSequence {
  private taps: number[] = [];
  private lockedUntil = 0;

  constructor(
    private readonly count = SELF_SABOTAGE_CONFIG.easterEggs.mobileTapCount,
    private readonly windowMs = SELF_SABOTAGE_CONFIG.easterEggs.mobileTapWindowMs,
    private readonly retriggerLockMs = SELF_SABOTAGE_CONFIG.easterEggs.mobileRetriggerLockMs,
  ) {}

  noteTap(now: number): boolean {
    if (!SELF_SABOTAGE_CONFIG.easterEggs.mobile || now < this.lockedUntil) return false;
    this.taps = this.taps.filter((timestamp) => now - timestamp <= this.windowMs);
    this.taps.push(now);
    if (this.taps.length < this.count) return false;
    this.taps = [];
    this.lockedUntil = now + this.retriggerLockMs;
    return true;
  }

  reset(): void {
    this.taps = [];
    this.lockedUntil = 0;
  }
}

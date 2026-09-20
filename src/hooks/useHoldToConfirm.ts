import { useCallback, useEffect, useRef, useState } from "react";
import { createHoldToClear, type HoldToClearController } from "../lib/holdToClear";

/**
 * React binding for the shared Hold-to-Clear controller (see
 * src/lib/holdToClear.ts). Desktop (TheForge) and mobile
 * (CoreMobileWorkspace) previously duplicated this logic — which let the
 * same stale-RAF bug ("Clearing..." stuck at 100%) exist twice. One hook,
 * one deterministic core.
 */
export function useHoldToConfirm({
  durationMs = 1250,
  onConfirm,
}: {
  durationMs?: number;
  onConfirm?: () => void;
}): {
  progress: number;
  isHolding: boolean;
  start: () => void;
  cancel: () => void;
} {
  // Always-current confirm callback without re-creating the controller.
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const ctrlRef = useRef<HoldToClearController | null>(null);
  const [progress, setProgress] = useState(0);
  const [isHolding, setIsHolding] = useState(false);

  useEffect(() => {
    const ctrl = createHoldToClear({
      durationMs,
      onConfirm: () => onConfirmRef.current?.(),
    });
    ctrlRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(() => {
      setProgress(ctrl.getProgress());
      setIsHolding(ctrl.isHolding());
    });
    return () => {
      unsubscribe();
      ctrl.dispose();
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
    };
  }, [durationMs]);

  const start = useCallback(() => ctrlRef.current?.start(), []);
  const cancel = useCallback(() => ctrlRef.current?.cancel(), []);

  return { progress, isHolding, start, cancel };
}

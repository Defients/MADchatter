import { useCallback, useEffect, useRef, useState } from "react";
import { triggerSelfSabBotAge } from "../lib/selfSabotage";
import { MobileSelfSabotageTapSequence } from "../lib/selfSabotageTriggers";

/** Shared mobile logo gesture. The 240ms acknowledgement happens before the
 * controller starts, and the sequence recognizer's lockout eats a fourth tap. */
export function useSelfSabotageLogoTap() {
  const sequence = useRef(new MobileSelfSabotageTapSequence());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [logoGlitch, setLogoGlitch] = useState(false);

  const onLogoTap = useCallback(() => {
    if (!sequence.current.noteTap(Date.now())) return;
    setLogoGlitch(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setLogoGlitch(false);
      void triggerSelfSabBotAge({ source: "mobile_easter_egg", force: true });
    }, 240);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { onLogoTap, logoGlitch };
}

import { useState, useEffect } from "react";
import { useIsMobile, useIsTouch } from "../hooks/useMediaQuery";

/**
 * MobileAdvisory — dismissible overlay shown on small/touch viewports.
 * Explains that MADchatter is built for desktop Chromium browsers and which
 * features won't work on mobile. Users can dismiss to continue anyway.
 */
export function MobileAdvisory() {
  const isMobile = useIsMobile();
  const isTouch = useIsTouch();
  const [dismissed, setDismissed] = useState(false);

  // Re-show on orientation/viewport changes that cross the threshold
  useEffect(() => {
    if (!isMobile && !isTouch) setDismissed(false);
  }, [isMobile, isTouch]);

  if (dismissed || (!isMobile && !isTouch)) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Desktop browser recommended"
    >
      <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-[#131318] p-6 text-center shadow-[var(--elev-4)]">
        {/* Icon */}
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-orange-500/10 border border-orange-500/20">
          <svg className="h-7 w-7 text-orange-400" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
          </svg>
        </div>

        <h2 className="text-lg font-bold text-gray-100 mb-2">Desktop Recommended</h2>
        <p className="text-sm text-gray-400 leading-relaxed mb-4">
          MADchatter is built for desktop Chromium browsers (Chrome / Edge).
          On mobile, some features won't work:
        </p>

        <ul className="text-left text-xs text-gray-500 space-y-1.5 mb-5 mx-auto max-w-[16rem]">
          <li className="flex items-start gap-2">
            <span className="text-orange-400/70 mt-0.5">•</span>
            <span>System audio capture (getDisplayMedia) — unsupported on mobile</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400/70 mt-0.5">•</span>
            <span>Whisper transcription — needs WebGPU + ~40 MB model</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-orange-400/70 mt-0.5">•</span>
            <span>3-column layout, keyboard shortcuts, drag-and-drop</span>
          </li>
        </ul>

        <button
          onClick={() => setDismissed(true)}
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm font-medium text-gray-200 transition-all hover:bg-white/10 active:scale-[0.98] touch-target"
        >
          Continue anyway
        </button>
        <p className="mt-3 text-[11px] text-gray-600">
          You can monitor chat and view analytics, but the full experience needs a desktop browser.
        </p>
      </div>
    </div>
  );
}

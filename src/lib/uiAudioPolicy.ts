/** Central lifecycle policy for optional interface audio. Functional mention
 * alerts and TTS deliberately do not use this gate. */
let pageHidden = false;
let installed = false;

export function isOptionalUiAudioAllowed(doc: Pick<Document, "visibilityState"> | null =
  typeof document !== "undefined" ? document : null): boolean {
  return !!doc && doc.visibilityState === "visible" && !pageHidden;
}

export function installOptionalUiAudioLifecycle(input: {
  onSuspend: () => void;
  onResume: () => void;
}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined" || installed) return () => {};
  installed = true;
  const sync = () => {
    if (document.visibilityState === "hidden" || pageHidden) input.onSuspend();
    else input.onResume();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") pageHidden = false;
    sync();
  };
  const onPageHide = () => { pageHidden = true; input.onSuspend(); };
  const onPageShow = () => { pageHidden = false; sync(); };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  sync();
  return () => {
    installed = false;
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  };
}

/** Deterministic test hook; production lifecycle listeners own this flag. */
export function setOptionalUiPageHiddenForTest(hidden: boolean): void {
  pageHidden = hidden;
}

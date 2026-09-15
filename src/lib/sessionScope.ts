import { useAppStore, selectMultiBotActive } from "../store";
import type { Platform } from "./kick";
// Pure channel normalization lives in its own leaf module so pure consumers
// (coreAutoCheck) can import it without touching the store (see normalizeChannel.ts).
import { normalizeSessionChannel } from "./normalizeChannel";

// Public API stays the same — existing importers keep working.
export { normalizeSessionChannel };

/** A session revision prevents old work from surviving a channel round trip. */
export interface SessionScope {
  revision: number;
  platform: Platform;
  channel: string;
}

export function captureSessionScope(): SessionScope {
  const state = useAppStore.getState();
  return {
    revision: state.sessionRevision,
    platform: state.platform,
    channel: normalizeSessionChannel(state.streamMetadata.channelName),
  };
}

export function isSessionScopeCurrent(scope: SessionScope): boolean {
  const current = captureSessionScope();
  return scope.revision === current.revision &&
    scope.platform === current.platform &&
    scope.channel === current.channel;
}

/** Keeps an interrupted run invalid even if the user immediately restores a toggle. */
export function createAutoForgeExecutionGuard(identityIsCurrent: () => boolean) {
  const scope = captureSessionScope();
  const initial = useAppStore.getState();
  const multiBotActive = selectMultiBotActive(initial);
  let cancelled = false;
  const contextMatches = () => {
    const state = useAppStore.getState();
    return isSessionScopeCurrent(scope) && state.autoForgeEnabled &&
      state.autoForgeDryRun === initial.autoForgeDryRun &&
      state.multiBotEnabled === initial.multiBotEnabled &&
      selectMultiBotActive(state) === multiBotActive && identityIsCurrent();
  };
  const unsubscribe = useAppStore.subscribe(() => {
    if (!contextMatches()) cancelled = true;
  });
  return {
    scope,
    isCurrent: () => !cancelled && contextMatches(),
    dispose: unsubscribe,
    cancel: () => { cancelled = true; unsubscribe(); },
  };
}

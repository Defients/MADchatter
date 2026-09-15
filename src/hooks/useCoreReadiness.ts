/** React adapter for the production readiness policy. */
import { useSyncExternalStore } from "react";
import { useAppStore } from "../store";
import { getActiveProvider, getApiKey, getKeys } from "../lib/keys";
import { isProviderAvailable } from "../lib/providerFallback";
import { deriveCoreReadiness, type ReadinessState } from "../lib/coreReadiness";
export type { CoreStage, CorePhase, ReadinessState } from "../lib/coreReadiness";

// Include health in the snapshot: cooldown expiry must update the UI even
// when neither credentials nor Zustand state changes. No network calls.
function getProviderSnapshot(): string {
  const provider = getActiveProvider();
  return JSON.stringify({ provider, keys: getKeys(), available: isProviderAvailable(provider) });
}
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;
let previousSnapshot = "";
function notifyProviderChange() {
  const next = getProviderSnapshot();
  if (next !== previousSnapshot) {
    previousSnapshot = next;
    listeners.forEach((listener) => listener());
  }
}
function subscribeProvider(listener: () => void) {
  listeners.add(listener);
  if (!interval) {
    previousSnapshot = getProviderSnapshot();
    interval = setInterval(notifyProviderChange, 1000);
    window.addEventListener("storage", notifyProviderChange);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(interval);
      interval = undefined;
      window.removeEventListener("storage", notifyProviderChange);
    }
  };
}

export function useCoreReadiness(): ReadinessState {
  const channel = useAppStore((s) => s.streamMetadata.channelName);
  const connection = useAppStore((s) => s.tmiReadState);
  const personaChosen = useAppStore((s) => s.personaChosen);
  const hasForgedOnce = useAppStore((s) => s.hasForgedOnce);
  const hasSentMessage = useAppStore((s) => s.hasSentMessage);
  const hasEnabledAutoForgeOnce = useAppStore((s) => s.hasEnabledAutoForgeOnce);
  const autoForgeEnabled = useAppStore((s) => s.autoForgeEnabled);
  const autoForgeDryRun = useAppStore((s) => s.autoForgeDryRun);
  // Same-tab key/provider edits already emit this tick; storage handles other tabs.
  useAppStore((s) => s.authTick);
  useSyncExternalStore(subscribeProvider, getProviderSnapshot);
  const provider = getActiveProvider();
  return deriveCoreReadiness({
    channel, connection, personaChosen, hasForgedOnce, hasSentMessage,
    hasEnabledAutoForgeOnce, autoForgeEnabled, autoForgeDryRun,
    aiConfigured: !!getApiKey(provider), aiAvailable: isProviderAvailable(provider),
  });
}

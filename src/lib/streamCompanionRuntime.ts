import { useAppStore, selectMultiBotActive } from "../store";
import { botCoordinator } from "./botCoordinator";
import { participation } from "./participationAwareness";
import { streamCompanion, type CompanionControls, type CompanionReceipt } from "./streamCompanion";

/** Existing sensor/session truth supplies controls; this module creates no sensor or scheduler. */
export function getCompanionControls(now = Date.now(), force = false): CompanionControls {
  const state = useAppStore.getState();
  const names = new Set(state.bots.map(b => b.session?.username.toLowerCase()).filter(Boolean));
  if (typeof window !== "undefined") {
    for (const session of [window.__twitchSession, window.__kickSession, window.__joystickSession]) {
      if (session?.username) names.add(session.username.toLowerCase());
    }
  }
  const humans = state.chatLog.filter(m => !m.marker && !names.has(m.user.toLowerCase()) && now - m.timestamp < 30_000);
  const lanes = state.perceptionSummary?.lanes;
  const usable = (status?: string) => !status || !["disabled", "unavailable", "stale", "error"].includes(status);
  return {
    enabled: state.participationProfile === "stream_companion",
    paused: !state.autoForgeEnabled || (!state.autoForgeAutoCheckEnabled && !force),
    stopped: state.botsGlobalStop,
    quiet: state.participationManualMode !== "auto" || (participation.getExplicitQuietUntil() ?? 0) > now,
    // The existing read connection state covers every platform. Viewer count is not proof.
    offline: ["disconnected", "error"].includes(state.tmiReadState),
    eventFloor: botCoordinator.isAutonomousSpeechSuppressed(now),
    humanConversation: humans.length >= 2 && new Set(humans.map(m => m.user.toLowerCase())).size >= 2,
    minCooldownMs: state.rateLimitConfig.minCooldownMs,
    speechUsable: usable(lanes?.audio.status) && usable(lanes?.audio.stages?.transcription?.status),
    visionUsable: usable(lanes?.vision.status) && usable(lanes?.vision.stages?.semantic?.status),
  };
}

export function getCompanionReceipt(botId = "legacy", now = Date.now()): CompanionReceipt {
  return streamCompanion.inspect(getCompanionControls(now), now, botId);
}

/** Bots and stale chat mentions cannot borrow direct-human priority. Standard is unchanged. */
export function isCompanionHumanMessage(message: { user: string; timestamp: number; marker?: unknown }, now = Date.now()): boolean {
  const state = useAppStore.getState();
  if (state.participationProfile !== "stream_companion") return true;
  if (message.marker || now - message.timestamp > 60_000) return false;
  const names = state.bots.map(b => b.session?.username.toLowerCase()).filter(Boolean);
  if (typeof window !== "undefined") {
    for (const session of [window.__twitchSession, window.__kickSession, window.__joystickSession]) {
      if (session?.username) names.push(session.username.toLowerCase());
    }
  }
  return !names.includes(message.user.toLowerCase());
}

export function companionBotCount(): number {
  const state = useAppStore.getState();
  return selectMultiBotActive(state) ? state.bots.filter(b => b.active && b.session).length : 1;
}

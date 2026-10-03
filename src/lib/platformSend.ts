import type { Platform } from "./kick";
import { sendTwitchMessage, sendTwitchMessageAsBot, getTwitchSession } from "./twitch";
import { sendKickMessage, sendKickMessageAsBot, getKickSession } from "./kick";
import { sendJoystickMessage, getJoystickSession } from "./joystick";

import { useAppStore, selectMultiBotActive } from "../store";
import { captureSessionScope, isSessionScopeCurrent } from "./sessionScope";
import { throwIfSendCancelled } from "./sendCancellation";
import { SendCancelledError } from "./sendCancellation";
import { botCoordinator } from "./botCoordinator";
import { streamCompanion, type CompanionTicket } from "./streamCompanion";
import { getCompanionControls } from "./streamCompanionRuntime";
import { participation } from "./participationAwareness";

export type PlatformSendFn = (channel: string, message: string, signal?: AbortSignal) => Promise<void>;

/**
 * Returns a send function for the given platform.
 *
 * When `botId` is omitted (legacy single-bot mode), the returned function uses
 * the singleton send managers — identical to the original behavior.
 *
 * When `botId` is provided (multi-bot mode), the returned function sends as
 * that specific bot identity via its own per-bot send manager + rate limiter.
 * Joystick ignores `botId` (single-bot for v1).
 *
 * Global stop: unless `opts.bypassGlobalStop` is set (the operator's manual
 * chat input — explicit human intent), every automated send path (AutoForge
 * loops, rule engine, queues, overlays) is blocked at this single chokepoint
 * while `botsGlobalStop` is active. Blocked sends throw SendCancelledError —
 * intentional withdrawal, never retried, never logged as provider failure.
 */
export function getPlatformSendFn(
  platform: Platform,
  botId?: string,
  opts?: { bypassGlobalStop?: boolean; bypassEventFloor?: boolean; eventOwner?: string;
    autoForge?: { profileRevision: number; companion?: CompanionTicket; force?: boolean } },
): PlatformSendFn {
  return async (channel, message, signal) => {
    if (!opts?.bypassGlobalStop && useAppStore.getState().botsGlobalStop) {
      throw new SendCancelledError();
    }
    const floorOwner = botCoordinator.getEventFloorOwner();
    if (!opts?.bypassEventFloor && opts?.eventOwner !== floorOwner && botCoordinator.isAutonomousSpeechSuppressed()) {
      botCoordinator.noteBlockedAutonomous(floorOwner === null);
      throw new SendCancelledError();
    }
    const scope = captureSessionScope();
    const initial = useAppStore.getState();
    const autoForge = opts?.autoForge;
    let reservation: number | null = null;
    let delivered = false;
    const policyCurrent = () => {
      const state = useAppStore.getState();
      if (!autoForge) return true;
      if (state.participationProfileRevision !== autoForge.profileRevision || !state.autoForgeEnabled ||
        state.autoForgeDryRun || (!autoForge.force && !state.autoForgeAutoCheckEnabled)) return false;
      if (state.participationProfile === "stream_companion" &&
        (state.participationManualMode === "quiet" || (participation.getExplicitQuietUntil() ?? 0) > Date.now())) return false;
      if (!autoForge.companion) return true;
      if ((autoForge.companion.botId !== "legacy") !== selectMultiBotActive(state)) return false;
      const controls = getCompanionControls(Date.now(), autoForge.force);
      return reservation === null ? streamCompanion.inspect(controls, Date.now(), autoForge.companion.botId, autoForge.companion).eligible :
        streamCompanion.validateReservation(reservation, controls, Date.now());
    };
    const controller = new AbortController();
    const identity = () => {
      if (botId && platform !== "joystick") {
        const bot = useAppStore.getState().bots.find(b => b.id === botId);
        return bot?.active && bot.platform === platform ? bot.session : null;
      }
      if (platform === "joystick") {
        const session = getJoystickSession();
        return session ? { username: session.username, userId: session.channelId } : null;
      }
      return platform === "kick" ? getKickSession() : getTwitchSession();
    };
    const originalIdentity = identity();
    if (botId && platform !== "joystick" && !originalIdentity) controller.abort();
    const check = () => {
      const current = identity();
      if (!policyCurrent() || !isSessionScopeCurrent(scope) || platform !== scope.platform ||
        (!opts?.bypassGlobalStop && useAppStore.getState().botsGlobalStop) ||
        (!opts?.bypassEventFloor && opts?.eventOwner !== botCoordinator.getEventFloorOwner() && botCoordinator.isAutonomousSpeechSuppressed()) ||
        useAppStore.getState().multiBotEnabled !== initial.multiBotEnabled ||
        current?.username !== originalIdentity?.username || current?.userId !== originalIdentity?.userId) controller.abort();
    };
    const cancel = () => controller.abort();
    const unsubscribe = useAppStore.subscribe(check);
    const unsubscribeFloor = botCoordinator.subscribeEventFloor(check);
    const ticketReceipt = autoForge?.companion ? streamCompanion.inspect(getCompanionControls(), Date.now(), autoForge.companion.botId, autoForge.companion) : null;
    // Cancellation deadline, not a scheduling loop. Even a stalled transport queue
    // must lose permission when its final usable external observation expires.
    const expiry = ticketReceipt?.opportunity ? Math.max(...ticketReceipt.opportunity.evidence.map(e => e.expiresAt)) : null;
    const expiryTimer = expiry === null ? null : setTimeout(cancel, Math.max(0, expiry - Date.now()));
    window.addEventListener("storage", check);
    window.addEventListener("send-identity-changed", check);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      if (autoForge?.companion) {
        reservation = streamCompanion.reserve(autoForge.companion, message, getCompanionControls(Date.now(), autoForge.force), Date.now());
        if (reservation === null) throw new SendCancelledError();
      }
      check();
      throwIfSendCancelled(controller.signal);
      if (platform === "joystick") {
        await sendJoystickMessage(channel, message, window.__joystickChatClient || null, controller.signal);
      } else if (platform === "kick") {
        if (botId) await sendKickMessageAsBot(botId, channel, message, controller.signal);
        else await sendKickMessage(channel, message, controller.signal);
      } else {
        if (botId) await sendTwitchMessageAsBot(botId, channel, message, controller.signal);
        else await sendTwitchMessage(channel, message, controller.signal);
      }
      if (reservation !== null) streamCompanion.complete(reservation, true, Date.now());
      delivered = true;
    } finally {
      if (reservation !== null) streamCompanion.complete(reservation, false, Date.now());
      if (!delivered && autoForge?.companion) streamCompanion.markEvaluated(autoForge.companion, Date.now());
      unsubscribe();
      unsubscribeFloor();
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      window.removeEventListener("storage", check);
      window.removeEventListener("send-identity-changed", check);
      signal?.removeEventListener("abort", cancel);
    }
  };
}

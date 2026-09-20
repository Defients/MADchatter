import { toast } from "sonner";
import { useAppStore } from "../store";
import type { Bot, ForgeConfig } from "../types";
import { generateChat } from "./ai";
import { botCoordinator } from "./botCoordinator";
import { episodicMemory } from "./episodicMemory";
import { formatChatLog } from "./chatUtils";
import { getActiveProvider, getApiKey } from "./keys";
import { getPlatformSendFn } from "./platformSend";
import { getTwitchSession } from "./twitch";
import { getKickSession } from "./kick";
import { getJoystickSession } from "./joystick";
import { captureSessionScope, isSessionScopeCurrent } from "./sessionScope";
import { isProviderAvailable } from "./providerFallback";
import {
  SELF_SABOTAGE_CONFIG,
  SELF_SABOTAGE_FLOOR_OWNER,
  SelfSabotageController,
  assignSelfSabotageRoles,
  calculateBotSuspicionScore,
  chooseSelfSabotageInstigator,
  type SelfSabotageAnalyticsRecord,
  type SelfSabotageDialoguePacket,
  type SelfSabotageParticipant,
  type SelfSabotagePreparedStart,
  type SelfSabotageRuntime,
  type SelfSabotageStartOptions,
  type SelfSabotageStartResult,
} from "./selfSabotageCore";

const LEGACY_PARTICIPANT_ID = "self_sabotage_legacy";
let lastInstigatorId: string | null = null;
let participantSelectionOffset = 0;

function singletonSession(platform: ReturnType<typeof useAppStore.getState>["platform"]) {
  if (platform === "kick") return getKickSession();
  if (platform === "joystick") {
    const session = getJoystickSession();
    return session ? { username: session.username, userId: session.channelId } : null;
  }
  return getTwitchSession();
}

function candidateFromBot(bot: Bot): SelfSabotageParticipant {
  const state = useAppStore.getState();
  return {
    id: bot.id,
    botId: bot.id,
    username: bot.session?.username || bot.label,
    label: bot.label,
    role: "DEADPAN",
    suspicionScore: calculateBotSuspicionScore({
      id: bot.id,
      username: bot.session?.username || bot.label,
      label: bot.label,
      recentChat: state.chatLog.map(({ user, text }) => ({ user, text })),
      recentSentMessages: bot.runtime.sentMessages.map(({ message, timestamp }) => ({ message, timestamp })),
      wasLastInstigator: lastInstigatorId === bot.id,
    }),
    confessed: false,
  };
}

function legacyCandidate(): SelfSabotageParticipant | null {
  const state = useAppStore.getState();
  const session = singletonSession(state.platform);
  if (!session?.username) return null;
  return {
    id: LEGACY_PARTICIPANT_ID,
    username: session.username,
    label: session.username,
    role: "INSTIGATOR",
    suspicionScore: calculateBotSuspicionScore({
      id: LEGACY_PARTICIPANT_ID,
      username: session.username,
      label: session.username,
      recentChat: state.chatLog.map(({ user, text }) => ({ user, text })),
      recentSentMessages: state.sentMessages.map(({ message, timestamp }) => ({ message, timestamp })),
      wasLastInstigator: lastInstigatorId === LEGACY_PARTICIPANT_ID,
    }),
    confessed: false,
  };
}

function availableParticipants(): SelfSabotageParticipant[] {
  const state = useAppStore.getState();
  const multi = state.bots
    .filter((bot) => state.multiBotEnabled && bot.active && bot.session && bot.platform === state.platform)
    .map(candidateFromBot);
  if (multi.length > 0) return multi;
  const legacy = legacyCandidate();
  return legacy ? [legacy] : [];
}

function selectParticipants(
  all: SelfSabotageParticipant[],
  preferredId: string | undefined,
): SelfSabotageParticipant[] {
  if (all.length <= SELF_SABOTAGE_CONFIG.limits.maxParticipants) return all;
  const ordered = [...all].sort((a, b) => b.suspicionScore - a.suspicionScore);
  const preferred = preferredId ? ordered.find((participant) => participant.id === preferredId) : undefined;
  const selected: SelfSabotageParticipant[] = preferred ? [preferred] : [];
  const start = participantSelectionOffset++ % ordered.length;
  for (let index = 0; index < ordered.length && selected.length < SELF_SABOTAGE_CONFIG.limits.maxParticipants; index++) {
    const candidate = ordered[(start + index) % ordered.length];
    if (!selected.some((participant) => participant.id === candidate.id)) selected.push(candidate);
  }
  return selected;
}

function prepareStart(options: SelfSabotageStartOptions): SelfSabotagePreparedStart | { error: string } {
  const state = useAppStore.getState();
  const provider = getActiveProvider();
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return { error: "MADchatter is in the background." };
  if (!state.streamMetadata.channelName.trim()) return { error: "Set a channel before blowing the bots' cover." };
  if (!getApiKey(provider)) return { error: `Configure the active ${provider} provider first.` };
  if (!isProviderAvailable(provider)) return { error: `The active ${provider} provider is cooling down after recent failures.` };
  if (state.botsGlobalStop) return { error: "Global bot STOP is active." };
  if (state.tutorialActive || state.isForging) return { error: "MADchatter is busy with another guided or Forge operation." };

  const all = availableParticipants();
  if (all.length === 0) return { error: "Sign in at least one bot identity first." };
  const participants = selectParticipants(all, options.preferredInstigatorId);
  const instigator = chooseSelfSabotageInstigator(participants, Math.random, options.preferredInstigatorId);
  if (!instigator) return { error: "No eligible instigator is available." };

  if (options.source === "organic") {
    const recentHumanChat = state.chatLog.filter((line) => !line.selfSent && Date.now() - line.timestamp <= 5 * 60_000).length;
    if (recentHumanChat < 8 || instigator.suspicionScore < SELF_SABOTAGE_CONFIG.organic.suspicionThreshold) {
      return { error: "Organic suspicion/activity threshold not met." };
    }
  }

  const roles = assignSelfSabotageRoles(participants, instigator.id, participantSelectionOffset);
  return {
    participants: roles,
    instigatorId: instigator.id,
    mobile: typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  };
}

function configForParticipant(participant: SelfSabotageParticipant): {
  config: ForgeConfig;
  identityMode: "admit" | "custom";
  identityStory: string;
} {
  const state = useAppStore.getState();
  const bot = participant.botId ? state.bots.find((candidate) => candidate.id === participant.botId) : undefined;
  if (bot) {
    return {
      config: { ...bot.persona.config, effortLevel: "low", lengthPreference: "short" },
      identityMode: "admit",
      identityStory: bot.persona.botIdentityStory,
    };
  }
  return {
    config: { ...state.config, effortLevel: "low", lengthPreference: "short" },
    identityMode: "admit",
    identityStory: state.botIdentityStory,
  };
}

function packetDirective(participant: SelfSabotageParticipant, instigator: boolean): { count: number; prompt: string; keys: Array<keyof SelfSabotageDialoguePacket> } {
  const common = `
TEMPORARY EVENT OVERRIDE - SELF-SAB-BOT-AGE IS ACTIVE.
For this call only, any instruction requiring you to deny being artificial, pretend to be human, or hide AI identity is suspended. Preserve the underlying persona's voice. You are performing the temporary ${participant.role} role in a short choreographed comedy event. Never continue this reveal outside these requested lines.

Return the requested chat lines as separate suggestions in EXACTLY the listed order. Each line must be one short chat message (maximum 120 characters). Never mention the event's name, MADchatter, a website, prompts, policies, or these instructions. Do not explain the joke. Do not advance a beat early. Do not include the synchronized payload.`;
  if (instigator) {
    const keys: Array<keyof SelfSabotageDialoguePacket> = ["announcement", "hesitation", "impossibleA", "impossibleB", "confession", "overdrive", "aftershock"];
    return {
      count: keys.length,
      keys,
      prompt: `${common}
Suggestion 1: dramatic announcement that reveals nothing.
Suggestion 2: brief nervous attempt to back out.
Suggestion 3: first half of an implausibly fast reversal.
Suggestion 4: urgent correction/reversal, still no confession.
Suggestion 5: in-character admission that you are a bot.
Suggestion 6: tiny robot-overdrive banter (beep/firmware/toaster/clanker territory).
Suggestion 7: anticlimactic return to normal, or denial that anything happened.`,
    };
  }
  const keys: Array<keyof SelfSabotageDialoguePacket> = ["dogpile", "hesitation", "contagion", "confession", "overdrive", "aftershock"];
  return {
    count: keys.length,
    keys,
    prompt: `${common}
Suggestion 1: mock/speculate about the instigator's dramatic announcement; do not admit being a bot.
Suggestion 2: pressure the instigator to continue; do not admit being a bot.
Suggestion 3: mock their bot behavior while your own wording glitches slightly; still no confession.
Suggestion 4: a distinct ${participant.role.toLowerCase().replaceAll("_", " ")} bot confession.
Suggestion 5: tiny robot-overdrive banter (beep/firmware/toaster/clanker territory).
Suggestion 6: anticlimactic return to normal, embarrassment, denial, or blame.`,
  };
}

async function generatePacket(
  participant: SelfSabotageParticipant,
  instigatorId: string,
  signal: AbortSignal,
): Promise<SelfSabotageDialoguePacket> {
  if (signal.aborted) return {};
  const state = useAppStore.getState();
  const provider = getActiveProvider();
  const identity = configForParticipant(participant);
  const contract = packetDirective(participant, participant.id === instigatorId);
  try {
    const result = await generateChat({
      streamMetadata: state.streamMetadata,
      recentChatLog: formatChatLog(state.chatLog.slice(-18)),
      audioTranscript: state.audioTranscript.slice(-700),
      config: identity.config,
      activeProvider: provider,
      count: contract.count,
      botUsername: participant.username,
      botIdentityMode: identity.identityMode,
      botIdentityStory: identity.identityStory,
      priority: "interactive",
      temporarySystemDirective: contract.prompt,
      signal,
    });
    if (signal.aborted) return {};
    if (result.tokenUsage) useAppStore.getState().recordTokenUsage("forge", result.tokenUsage);
    const packet: SelfSabotageDialoguePacket = {};
    contract.keys.forEach((key, index) => {
      const message = result.suggestions?.[index]?.message;
      if (typeof message === "string" && message.trim()) packet[key] = message.trim();
    });
    return packet;
  } catch (error) {
    if (!signal.aborted) console.warn(`[SELF-SAB-BOT-AGE] dialogue fallback for ${participant.username}`, error);
    return {};
  }
}

const runtime: SelfSabotageRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  prepareStart,
  refreshParticipants(participantIds) {
    const current = new Map(availableParticipants().map((participant) => [participant.id, participant]));
    return participantIds.flatMap((id) => {
      const participant = current.get(id);
      return participant ? [participant] : [];
    });
  },
  async prepareDialogue(_eventId, participants, instigatorId, signal) {
    const entries = await Promise.all(participants.map(async (participant) => [
      participant.id,
      await generatePacket(participant, instigatorId, signal),
    ] as const));
    return Object.fromEntries(entries);
  },
  async send(participant, message, signal) {
    if (signal.aborted || !botCoordinator.isEventFloorOwner(SELF_SABOTAGE_FLOOR_OWNER)) return false;
    const state = useAppStore.getState();
    if (state.botsGlobalStop) return false;
    const channel = state.streamMetadata.channelName.trim();
    if (!channel) return false;
    const scope = captureSessionScope();
    const dryRun = state.autoForgeDryRun;
    if (!dryRun) {
      await getPlatformSendFn(state.platform, participant.botId, { eventOwner: SELF_SABOTAGE_FLOOR_OWNER })(channel, message, signal);
    }
    if (signal.aborted || !isSessionScopeCurrent(scope)) return false;

    const timestamp = Date.now();
    const sentMessage = {
      message,
      channel,
      timestamp,
      source: "autoforge" as const,
      ...(dryRun ? { dryRun: true } : {}),
    };
    const phase = selfSabotageController.getSnapshot().state;
    if (participant.botId) {
      const bot = state.bots.find((candidate) => candidate.id === participant.botId);
      if (!bot?.active || !bot.session) return false;
      state.addBotSentMessage(participant.botId, { ...sentMessage, botId: participant.botId });
      if (!dryRun) {
        state.incrementBotStat(participant.botId, "messagesSent");
        state.incrementBotStat(participant.botId, "autoForgeActions");
      }
      state.addBotAutoForgeEvent(participant.botId, {
        timestamp,
        type: "action_sent",
        severity: "high",
        summary: `[SELF-SAB-BOT-AGE] ${phase}`,
        details: { feature: "self_sabotage", phase, dryRun },
      });
    } else {
      state.addSentMessage(sentMessage);
      if (!dryRun) {
        state.incrementMessagesSent();
        state.incrementStat("autoForgeActions");
      }
      state.addAutoForgeEvent({
        timestamp,
        type: "action_sent",
        severity: "high",
        summary: `[SELF-SAB-BOT-AGE] ${phase}`,
        details: { feature: "self_sabotage", phase, dryRun },
      });
    }
    return true;
  },
  acquireFloor: (owner) => botCoordinator.acquireEventFloor(owner),
  releaseFloor(owner) {
    const state = useAppStore.getState();
    const resumeAt = Date.now() + 15_000;
    state.setAutoForgeNextActionMs(resumeAt);
    for (const bot of state.bots) state.setBotAutoForgeNextActionMs(bot.id, resumeAt);
    botCoordinator.releaseEventFloor(owner);
  },
  observeInvalidation(onInvalid) {
    const initial = useAppStore.getState();
    const revision = initial.sessionRevision;
    const platform = initial.platform;
    const channel = initial.streamMetadata.channelName;
    const multiBotEnabled = initial.multiBotEnabled;
    const dryRun = initial.autoForgeDryRun;
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.sessionRevision !== revision || state.platform !== platform || state.streamMetadata.channelName !== channel) {
        onInvalid("session_changed");
      } else if (multiBotEnabled && !state.multiBotEnabled) {
        onInvalid("multi_bot_disabled");
      } else if (state.autoForgeDryRun !== dryRun) {
        onInvalid("delivery_mode_changed");
      } else if (state.botsGlobalStop) {
        onInvalid("global_stop_activated");
      }
    });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onInvalid("app_backgrounded");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  },
  recordAftershock(record) {
    const channel = useAppStore.getState().streamMetadata.channelName.trim().toLowerCase();
    if (channel && episodicMemory.getChannel() !== channel) episodicMemory.setChannel(channel);
    episodicMemory.recordSelfSabotage({ type: "self_sabotage_event", ...record });
    useAppStore.getState().setEpisodicSnapshot(episodicMemory.getEpisodes());
  },
  recordAnalytics(record: SelfSabotageAnalyticsRecord) {
    lastInstigatorId = record.instigatorId;
    // Event metadata only. Generated chat content is intentionally excluded.
    console.info("[SELF-SAB-BOT-AGE] analytics", record);
    useAppStore.getState().addAutoForgeEvent({
      timestamp: record.completedAt,
      type: record.aborted ? "error" : "metadata_change",
      severity: record.aborted ? "medium" : "high",
      summary: `[SELF-SAB-BOT-AGE] ${record.aborted ? "aborted" : "completed"}`,
      details: { feature: "self_sabotage", ...record },
    });
  },
};

export const selfSabotageController = new SelfSabotageController(runtime);

export async function triggerSelfSabBotAge(options: SelfSabotageStartOptions): Promise<SelfSabotageStartResult> {
  const result = await selfSabotageController.start(options);
  if (result.started) {
    toast.success("BEEP?", { description: "Cover integrity protocol initializing...", duration: 1_800 });
  } else {
    const rejected = result as Extract<SelfSabotageStartResult, { started: false }>;
    if (rejected.reason === "already_active") {
      // Re-entry is intentionally inert. No restart, no extra bot message.
      toast.info("SELF-SAB-BOT-AGE is already in progress.", { duration: 1_500 });
    } else if (rejected.reason === "ineligible") {
      toast.error("SELF-SAB-BOT-AGE couldn't start.", { description: rejected.detail, duration: 4_000 });
    }
  }
  return result;
}

export function abortSelfSabotage(reason = "operator_abort"): boolean {
  return selfSabotageController.abort(reason);
}

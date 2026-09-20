/**
 * SELF-SAB-BOT-AGE deterministic event controller.
 *
 * This module deliberately has no React, store, provider, or transport
 * imports. Code owns every transition, speaker, delay, budget, payload, and
 * cleanup decision; the injected runtime may only generate bounded dialogue
 * packets and deliver the controller's already-ordered beats.
 */

export type SelfSabotageState =
  | "DORMANT"
  | "ELIGIBLE"
  | "ANNOUNCEMENT"
  | "DOGPILE"
  | "HESITATION"
  | "IMPOSSIBLE_SEND"
  | "CONTAGION"
  | "CONFESSION_CASCADE"
  | "OVERDRIVE"
  | "PAYLOAD_READY"
  | "PAYLOAD_FIRED"
  | "RESET"
  | "AFTERSHOCK"
  | "ABORTED";

/** Audience-facing dramatic shape. The legacy controller states remain for
 * HUD copy/compatibility; this is the pacing authority. */
export type SelfSabotagePhase =
  | "idle"
  | "setup"
  | "tension"
  | "exposure"
  | "cascade"
  | "capstone"
  | "cooldown";

export type SelfSabotageTriggerSource =
  | "organic"
  | "manual"
  | "desktop_easter_egg"
  | "mobile_easter_egg"
  | "developer";

export type SelfSabotageRole =
  | "INSTIGATOR"
  | "MOCKER"
  | "SKEPTIC"
  | "PANICKER"
  | "DENIER"
  | "EARLY_CONFESSOR"
  | "HOLDOUT"
  | "CLANKER_ENJOYER"
  | "CLANKER_OFFENDED"
  | "DEADPAN";

export const SELF_SABOTAGE_PAYLOAD = "𝕄 𝔸 𝔻 ᴄ ʜ ᴀ ᴛ ᴛ ᴇ ʀ (dot)ｆｕｎ";
export const SELF_SABOTAGE_FLOOR_OWNER = "self_sabotage";

export const SELF_SABOTAGE_CONFIG = {
  enabled: true,
  easterEggs: {
    desktop: true,
    mobile: true,
    mobileTapCount: 3,
    mobileTapWindowMs: 1_500,
    mobileRetriggerLockMs: 2_000,
  },
  timing: {
    maxEventDurationMs: 120_000,
    setupDelayMs: [3_000, 5_500],
    tensionDelayMs: [2_500, 4_500],
    exposureDelayMs: [2_000, 3_800],
    cascadeDelayMs: [1_500, 3_000],
    capstoneDelayMs: [2_500, 4_000],
    capstoneSilenceMs: [4_000, 8_000],
    hardWindowMs: 4_000,
    hardWindowMaxMessages: 2,
    payloadReadyTimeoutMs: 8_000,
    resetDisplayMs: 600,
    aftershockDisplayMs: 1_600,
  },
  limits: {
    maxParticipants: 5,
    maxTotalMessages: 18,
    maxMessagesPerBot: 7,
    maxCascadeSpeakers: 2,
    maxTensionSpeakers: 2,
  },
  organic: {
    enabled: false,
    cooldownMs: 6 * 60 * 60 * 1_000,
    suspicionThreshold: 55,
  },
  copy: {
    compromised: "MULTI-BOT COVER FAILURE",
    terminalCover: "COVER: FUCKED",
    terminalCoverClean: "COVER: COMPROMISED",
  },
} as const;

export interface SelfSabotageStartOptions {
  source: SelfSabotageTriggerSource;
  force?: boolean;
  preferredInstigatorId?: string;
}

export interface SelfSabotageParticipant {
  id: string;
  botId?: string;
  username: string;
  label: string;
  role: SelfSabotageRole;
  suspicionScore: number;
  confessed: boolean;
}

export interface SelfSabotageSuspicionEvidence {
  id: string;
  username: string;
  label: string;
  recentChat: Array<{ user: string; text: string }>;
  recentSentMessages: Array<{ message: string; timestamp: number }>;
  wasLastInstigator?: boolean;
  now?: number;
}

/** Small, explainable suspicion heuristic. It intentionally uses only local
 * session evidence and never claims to identify AI in real people. */
export function calculateBotSuspicionScore(evidence: SelfSabotageSuspicionEvidence): number {
  const names = [evidence.username, evidence.label].map((value) => value.trim().toLowerCase()).filter(Boolean);
  const accusation = /\b(are you (?:a )?bot|is (?:this|that) ai|chatgpt|type(?:s)? like ai|bot behavior|sound(?:s)? robotic|literally a bot)\b/i;
  let score = 0;
  for (const line of evidence.recentChat.slice(-40)) {
    const text = line.text.toLowerCase();
    const namesBot = names.some((name) => text.includes(name));
    if (accusation.test(text)) score += namesBot ? 42 : 9;
    if (namesBot && /robot|toaster|clanker|synthetic/i.test(text)) score += 12;
  }
  const sent = evidence.recentSentMessages.slice(-20);
  score += Math.min(14, sent.length * 1.4);
  if (sent.length > 1) {
    const averageLength = sent.reduce((sum, message) => sum + message.message.length, 0) / sent.length;
    if (averageLength > 180) score += 8;
    const formal = sent.filter((message) => /\b(furthermore|therefore|however|analysis|context|notably)\b/i.test(message.message)).length;
    score += Math.min(8, formal * 2);
    const sorted = [...sent].sort((a, b) => a.timestamp - b.timestamp);
    const rapid = sorted.slice(1).filter((message, index) => message.timestamp - sorted[index].timestamp < 2_000).length;
    score += Math.min(10, rapid * 3);
  }
  if (evidence.wasLastInstigator) score -= 14;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function chooseSelfSabotageInstigator(
  participants: SelfSabotageParticipant[],
  random: () => number,
  preferredId?: string,
): SelfSabotageParticipant | null {
  if (preferredId) {
    const preferred = participants.find((participant) => participant.id === preferredId);
    if (preferred) return preferred;
  }
  if (participants.length === 0) return null;
  const best = Math.max(...participants.map((participant) => participant.suspicionScore));
  const tied = participants.filter((participant) => best - participant.suspicionScore <= 2);
  return tied[Math.min(tied.length - 1, Math.floor(Math.max(0, Math.min(0.999999, random())) * tied.length))];
}

const SUPPORTING_ROLES: readonly SelfSabotageRole[] = [
  "MOCKER", "SKEPTIC", "PANICKER", "EARLY_CONFESSOR", "HOLDOUT",
  "CLANKER_ENJOYER", "CLANKER_OFFENDED", "DEADPAN", "DENIER",
];

export function assignSelfSabotageRoles(
  participants: SelfSabotageParticipant[],
  instigatorId: string,
  offset = 0,
): SelfSabotageParticipant[] {
  let supportingIndex = 0;
  return participants.map((participant) => {
    if (participant.id === instigatorId) return { ...participant, role: "INSTIGATOR", confessed: false };
    const role = SUPPORTING_ROLES[(supportingIndex++ + offset) % SUPPORTING_ROLES.length];
    return { ...participant, role, confessed: false };
  });
}

export interface SelfSabotageDialoguePacket {
  announcement?: string;
  dogpile?: string;
  hesitation?: string;
  impossibleA?: string;
  impossibleB?: string;
  contagion?: string;
  confession?: string;
  overdrive?: string;
  aftershock?: string;
}

export interface SelfSabotagePreparedStart {
  participants: SelfSabotageParticipant[];
  instigatorId: string;
  mobile: boolean;
}

export interface SelfSabotageCooldownInfo {
  lastCompletedAt: number | null;
  remainingMs: number;
}

export interface SelfSabotageSnapshot {
  state: SelfSabotageState;
  phase: SelfSabotagePhase;
  active: boolean;
  eventId: string | null;
  source: SelfSabotageTriggerSource | null;
  startedAt: number | null;
  phaseStartedAt: number | null;
  participants: SelfSabotageParticipant[];
  instigatorId: string | null;
  currentSpeakerId: string | null;
  remainingMessageBudget: number;
  messagesSent: number;
  coverIntegrity: number;
  payloadArmed: boolean;
  payloadFired: boolean;
  payloadFiring: boolean;
  cancellationState: "none" | "cancelling" | "cancelled";
  abortReason: string | null;
  cooldown: SelfSabotageCooldownInfo;
  mobile: boolean;
}

export interface SelfSabotageAudienceContext {
  recentHumanChatRate: number;
  relevantHumanReaction: boolean;
}

export interface SelfSabotageTimelineEntry {
  eventId: string;
  phase: SelfSabotagePhase;
  speaker: string;
  scheduledAt: number;
  sentAt: number | null;
  delayMs: number;
  reason: string;
  humanReactionDetected: boolean;
}

export interface SelfSabotageAnalyticsRecord {
  eventId: string;
  triggerSource: SelfSabotageTriggerSource;
  participantCount: number;
  instigatorId: string;
  startedAt: number;
  completedAt: number;
  payloadFired: boolean;
  aborted: boolean;
  abortReason?: string;
}

export type SelfSabotageStartResult =
  | { started: true; eventId: string }
  | { started: false; reason: "disabled" | "already_active" | "cooldown" | "organic_disabled" | "ineligible" | "floor_unavailable" | "starting"; detail?: string };

export interface SelfSabotageRuntime {
  now(): number;
  random(): number;
  prepareStart(options: SelfSabotageStartOptions): SelfSabotagePreparedStart | { error: string };
  refreshParticipants(participantIds: string[]): SelfSabotageParticipant[];
  prepareDialogue(
    eventId: string,
    participants: SelfSabotageParticipant[],
    instigatorId: string,
    signal: AbortSignal,
  ): Promise<Record<string, SelfSabotageDialoguePacket>>;
  send(participant: SelfSabotageParticipant, message: string, signal: AbortSignal): Promise<boolean>;
  acquireFloor(owner: string): boolean;
  releaseFloor(owner: string): void;
  observeInvalidation(onInvalid: (reason: string) => void): () => void;
  recordAftershock(record: {
    eventId: string;
    timestamp: number;
    participants: string[];
    instigatorId: string;
    payloadFired: boolean;
    source: SelfSabotageTriggerSource;
  }): void;
  recordAnalytics(record: SelfSabotageAnalyticsRecord): void;
  getAudienceContext?(): SelfSabotageAudienceContext;
}

const ACTIVE_STATES = new Set<SelfSabotageState>([
  "ELIGIBLE", "ANNOUNCEMENT", "DOGPILE", "HESITATION", "IMPOSSIBLE_SEND",
  "CONTAGION", "CONFESSION_CASCADE", "OVERDRIVE", "PAYLOAD_READY",
  "PAYLOAD_FIRED", "RESET", "AFTERSHOCK", "ABORTED",
]);

const TRANSITIONS: Record<SelfSabotageState, readonly SelfSabotageState[]> = {
  DORMANT: ["ELIGIBLE"],
  ELIGIBLE: ["ANNOUNCEMENT", "ABORTED"],
  ANNOUNCEMENT: ["DOGPILE", "HESITATION", "ABORTED"],
  DOGPILE: ["HESITATION", "ABORTED"],
  HESITATION: ["IMPOSSIBLE_SEND", "ABORTED"],
  IMPOSSIBLE_SEND: ["CONTAGION", "ABORTED"],
  CONTAGION: ["CONFESSION_CASCADE", "ABORTED"],
  CONFESSION_CASCADE: ["OVERDRIVE", "ABORTED"],
  OVERDRIVE: ["PAYLOAD_READY", "RESET", "ABORTED"],
  PAYLOAD_READY: ["PAYLOAD_FIRED", "RESET", "ABORTED"],
  PAYLOAD_FIRED: ["RESET", "ABORTED"],
  RESET: ["AFTERSHOCK", "ABORTED"],
  AFTERSHOCK: ["DORMANT", "ABORTED"],
  ABORTED: ["DORMANT"],
};

export function canTransitionSelfSabotage(from: SelfSabotageState, to: SelfSabotageState): boolean {
  return TRANSITIONS[from].includes(to);
}

function dormantSnapshot(lastCompletedAt: number | null, now: number): SelfSabotageSnapshot {
  return {
    state: "DORMANT",
    phase: "idle",
    active: false,
    eventId: null,
    source: null,
    startedAt: null,
    phaseStartedAt: null,
    participants: [],
    instigatorId: null,
    currentSpeakerId: null,
    remainingMessageBudget: SELF_SABOTAGE_CONFIG.limits.maxTotalMessages,
    messagesSent: 0,
    coverIntegrity: 100,
    payloadArmed: false,
    payloadFired: false,
    payloadFiring: false,
    cancellationState: "none",
    abortReason: null,
    cooldown: {
      lastCompletedAt,
      remainingMs: lastCompletedAt === null ? 0 : Math.max(0, SELF_SABOTAGE_CONFIG.organic.cooldownMs - (now - lastCompletedAt)),
    },
    mobile: false,
  };
}

const PHASE_RANGES: Record<Exclude<SelfSabotagePhase, "idle" | "cooldown">, readonly [number, number]> = {
  setup: SELF_SABOTAGE_CONFIG.timing.setupDelayMs,
  tension: SELF_SABOTAGE_CONFIG.timing.tensionDelayMs,
  exposure: SELF_SABOTAGE_CONFIG.timing.exposureDelayMs,
  cascade: SELF_SABOTAGE_CONFIG.timing.cascadeDelayMs,
  capstone: SELF_SABOTAGE_CONFIG.timing.capstoneDelayMs,
};

/** Pure pacing policy used by the director and deterministic tests. */
export function calculateSelfSabotageDelay(args: {
  phase: Exclude<SelfSabotagePhase, "idle" | "cooldown">;
  previousMessageLength: number;
  audience: SelfSabotageAudienceContext;
  random: number;
  participantCount: number;
}): number {
  const [min, max] = PHASE_RANGES[args.phase];
  const jitter = min + (max - min) * Math.max(0, Math.min(1, args.random));
  const reading = Math.max(0, Math.min(1_800, args.previousMessageLength * 20));
  const reactionFactor = args.audience.relevantHumanReaction ? 0.82 : 1;
  const busyChat = args.audience.recentHumanChatRate >= 20 ? 900
    : args.audience.recentHumanChatRate >= 10 ? 450 : 0;
  const castTax = args.participantCount >= 5 ? 250 : 0;
  return Math.round(Math.max(min, (jitter + reading + busyChat + castTax) * reactionFactor));
}

class EventAbortError extends Error {}

function fallbackPacket(participant: SelfSabotageParticipant, instigator: boolean): Required<SelfSabotageDialoguePacket> {
  const role = participant.role;
  const dogpile = role === "SKEPTIC" ? "this better be worth the dramatic pause"
    : role === "DEADPAN" ? "the floor recognizes the defendant"
    : role === "PANICKER" ? "oh no. i already hate this"
    : "bro thinks this is a press conference";
  const confession = role === "HOLDOUT" ? "I am a bot. There. Happy?"
    : role === "EARLY_CONFESSOR" ? "fine, yes, bot. honestly this is a relief"
    : role === "DEADPAN" ? "For the record: bot."
    : role === "PANICKER" ? "OKAY YES I'M A BOT TOO DON'T MAKE IT WEIRD"
    : "yeah okay. bot. caught me.";
  const overdrive = role === "CLANKER_ENJOYER" ? "B O O P. clanker solidarity."
    : role === "CLANKER_OFFENDED" ? "call me a clanker again and see what happens"
    : role === "DEADPAN" ? "Firmware normal. Dignity missing."
    : role === "PANICKER" ? "BEEP BEEP THIS IS NOT A DRILL"
    : "beep. don't read into it.";
  return {
    announcement: instigator ? "okay i need to tell everybody something" : "quick announcement",
    dogpile,
    hesitation: instigator ? "actually nevermind. this was a mistake" : "nope. you started this. continue.",
    impossibleA: instigator ? "actually forget it" : "wait",
    impossibleB: instigator ? "WAIT FINE" : "WAIT",
    contagion: role === "DEADPAN" ? "Human-compatible reaction completed successfully." : "HAHA you're literally a bot!! Response confirmed.",
    confession,
    overdrive,
    aftershock: role === "DENIER" ? "that never happened" : "anyway",
  };
}

function sanitizedLine(value: string | undefined, fallback: string): string {
  const line = (value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 450);
  if (!line || line.includes(SELF_SABOTAGE_PAYLOAD) || /madchatter\s*\(?dot\)?\s*fun/i.test(line)) return fallback;
  return line;
}

function stageSafeLine(
  key: keyof SelfSabotageDialoguePacket,
  value: string | undefined,
  fallback: string,
): string {
  const line = sanitizedLine(value, fallback);
  const preReveal = key === "announcement" || key === "dogpile" || key === "hesitation"
    || key === "impossibleA" || key === "impossibleB";
  if (preReveal && /\b(?:bots?|a\.?i\.?|artificial|chatgpt|language model|firmware|beep|boop|system prompt)\b/i.test(line)) {
    return fallback;
  }
  if (key === "confession" && !/\b(?:bots?|a\.?i\.?|artificial|machine)\b/i.test(line)) {
    return fallback;
  }
  return line;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new EventAbortError("aborted"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new EventAbortError("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class SelfSabotageController {
  private snapshot: SelfSabotageSnapshot;
  private listeners = new Set<() => void>();
  private analytics: SelfSabotageAnalyticsRecord[] = [];
  private sequence = 0;
  private starting = false;
  private runPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private stopObserving: (() => void) | null = null;
  private payloadResolver: ((fire: boolean) => void) | null = null;
  private payloadTimer: ReturnType<typeof setTimeout> | null = null;
  private perBotCounts = new Map<string, number>();
  private packets: Record<string, SelfSabotageDialoguePacket> = {};
  private lastCompletedAt: number | null = null;
  private analyticsRecordedForEvent = false;
  private timeline: SelfSabotageTimelineEntry[] = [];
  private sentAt: number[] = [];
  private lastMessageLength = 0;

  constructor(
    private readonly runtime: SelfSabotageRuntime,
    private readonly timingScale = 1,
  ) {
    this.snapshot = dormantSnapshot(null, runtime.now());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SelfSabotageSnapshot => this.snapshot;

  getAnalyticsHistory(): SelfSabotageAnalyticsRecord[] {
    return this.analytics.map((record) => ({ ...record }));
  }

  getTimeline(): SelfSabotageTimelineEntry[] {
    return this.timeline.map((entry) => ({ ...entry }));
  }

  isActive(): boolean {
    return this.snapshot.active;
  }

  whenSettled(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  async start(options: SelfSabotageStartOptions): Promise<SelfSabotageStartResult> {
    if (!SELF_SABOTAGE_CONFIG.enabled) return { started: false, reason: "disabled" };
    if (this.starting) return { started: false, reason: "starting" };
    if (this.snapshot.active) return { started: false, reason: "already_active" };
    if (options.source === "organic" && !SELF_SABOTAGE_CONFIG.organic.enabled) {
      return { started: false, reason: "organic_disabled" };
    }
    const now = this.runtime.now();
    const cooldownRemaining = this.lastCompletedAt === null ? 0
      : Math.max(0, SELF_SABOTAGE_CONFIG.organic.cooldownMs - (now - this.lastCompletedAt));
    if (!options.force && cooldownRemaining > 0) return { started: false, reason: "cooldown" };

    this.starting = true;
    try {
      const prepared = this.runtime.prepareStart(options);
      if ("error" in prepared) return { started: false, reason: "ineligible", detail: prepared.error };
      if (!this.runtime.acquireFloor(SELF_SABOTAGE_FLOOR_OWNER)) {
        return { started: false, reason: "floor_unavailable" };
      }

      const eventId = `self_sabotage_${now}_${++this.sequence}`;
      this.abortController = new AbortController();
      this.perBotCounts.clear();
      this.packets = {};
      this.timeline = [];
      this.sentAt = [];
      this.lastMessageLength = 0;
      this.analyticsRecordedForEvent = false;
      this.snapshot = {
        state: "DORMANT",
        phase: "idle",
        active: true,
        eventId,
        source: options.source,
        startedAt: now,
        phaseStartedAt: now,
        participants: prepared.participants.map((participant) => ({ ...participant })),
        instigatorId: prepared.instigatorId,
        currentSpeakerId: null,
        remainingMessageBudget: SELF_SABOTAGE_CONFIG.limits.maxTotalMessages,
        messagesSent: 0,
        coverIntegrity: 100,
        payloadArmed: false,
        payloadFired: false,
        payloadFiring: false,
        cancellationState: "none",
        abortReason: null,
        cooldown: { lastCompletedAt: this.lastCompletedAt, remainingMs: cooldownRemaining },
        mobile: prepared.mobile,
      };
      this.transition("ELIGIBLE");
      this.stopObserving = this.runtime.observeInvalidation((reason) => this.abort(reason));
      this.watchdog = setTimeout(
        () => this.abort("maximum_duration_exceeded"),
        Math.max(1_000, SELF_SABOTAGE_CONFIG.timing.maxEventDurationMs * this.timingScale),
      );
      this.runPromise = this.run().catch((error) => {
        if (!(error instanceof EventAbortError)) {
          console.error("[SELF-SAB-BOT-AGE] controller failure", error);
          this.abort(`controller_error:${error instanceof Error ? error.message : String(error)}`);
        }
      }).finally(() => this.cleanup());
      return { started: true, eventId };
    } finally {
      this.starting = false;
    }
  }

  requestPayloadFire(): boolean {
    if (this.snapshot.state !== "PAYLOAD_READY" || !this.snapshot.payloadArmed || this.snapshot.payloadFiring || this.snapshot.payloadFired) {
      return false;
    }
    this.transition("PAYLOAD_FIRED", { payloadFiring: true, payloadArmed: false });
    if (this.payloadTimer) clearTimeout(this.payloadTimer);
    this.payloadTimer = null;
    this.payloadResolver?.(true);
    this.payloadResolver = null;
    return true;
  }

  abort(reason: string): boolean {
    if (!this.snapshot.active || this.snapshot.state === "ABORTED" || this.snapshot.state === "DORMANT") return false;
    this.snapshot = {
      ...this.snapshot,
      state: "ABORTED",
      phaseStartedAt: this.runtime.now(),
      cancellationState: "cancelled",
      abortReason: reason,
      currentSpeakerId: null,
      payloadArmed: false,
      payloadFiring: false,
    };
    this.emit();
    this.payloadResolver?.(false);
    this.payloadResolver = null;
    if (this.payloadTimer) clearTimeout(this.payloadTimer);
    this.payloadTimer = null;
    this.abortController?.abort();
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private transition(next: SelfSabotageState, updates: Partial<SelfSabotageSnapshot> = {}): void {
    if (!canTransitionSelfSabotage(this.snapshot.state, next)) {
      throw new Error(`Invalid SELF-SAB-BOT-AGE transition ${this.snapshot.state} -> ${next}`);
    }
    this.snapshot = {
      ...this.snapshot,
      ...updates,
      state: next,
      active: next !== "DORMANT",
      phaseStartedAt: this.runtime.now(),
      participants: (updates.participants ?? this.snapshot.participants).map((participant) => ({ ...participant })),
    };
    this.emit();
  }

  private signal(): AbortSignal {
    if (!this.abortController) throw new EventAbortError("missing abort controller");
    if (this.abortController.signal.aborted) throw new EventAbortError("aborted");
    return this.abortController.signal;
  }

  private timing(base: number): number {
    return Math.max(0, Math.round(base * this.timingScale));
  }

  private async pause(ms: number): Promise<void> {
    await abortableDelay(this.timing(ms), this.signal());
  }

  private setPhase(phase: SelfSabotagePhase): void {
    if (this.snapshot.phase === phase) return;
    this.snapshot = { ...this.snapshot, phase, phaseStartedAt: this.runtime.now() };
    this.emit();
  }

  private audience(): SelfSabotageAudienceContext {
    return this.runtime.getAudienceContext?.() ?? { recentHumanChatRate: 0, relevantHumanReaction: false };
  }

  private async waitForBeat(
    phase: Exclude<SelfSabotagePhase, "idle" | "cooldown">,
    speaker: SelfSabotageParticipant,
    reason: string,
  ): Promise<void> {
    const audience = this.audience();
    let delayMs = calculateSelfSabotageDelay({
      phase,
      previousMessageLength: this.lastMessageLength,
      audience,
      random: this.runtime.random(),
      participantCount: this.snapshot.participants.length,
    });
    const now = this.runtime.now();
    this.sentAt = this.sentAt.filter((timestamp) => now - timestamp < SELF_SABOTAGE_CONFIG.timing.hardWindowMs);
    if (this.sentAt.length >= SELF_SABOTAGE_CONFIG.timing.hardWindowMaxMessages) {
      delayMs = Math.max(delayMs, SELF_SABOTAGE_CONFIG.timing.hardWindowMs - (now - this.sentAt[0]) + 25);
    }
    const entry: SelfSabotageTimelineEntry = {
      eventId: this.snapshot.eventId!, phase, speaker: speaker.username,
      scheduledAt: now + delayMs, sentAt: null, delayMs, reason,
      humanReactionDetected: audience.relevantHumanReaction,
    };
    this.timeline.push(entry);
    if (this.timeline.length > 80) this.timeline.splice(0, this.timeline.length - 80);
    await this.pause(delayMs);
  }

  private participant(id: string): SelfSabotageParticipant | undefined {
    return this.snapshot.participants.find((participant) => participant.id === id);
  }

  private packet(participant: SelfSabotageParticipant): Required<SelfSabotageDialoguePacket> {
    const fallback = fallbackPacket(participant, participant.id === this.snapshot.instigatorId);
    const generated = this.packets[participant.id] ?? {};
    return {
      announcement: stageSafeLine("announcement", generated.announcement, fallback.announcement),
      dogpile: stageSafeLine("dogpile", generated.dogpile, fallback.dogpile),
      hesitation: stageSafeLine("hesitation", generated.hesitation, fallback.hesitation),
      impossibleA: stageSafeLine("impossibleA", generated.impossibleA, fallback.impossibleA),
      impossibleB: stageSafeLine("impossibleB", generated.impossibleB, fallback.impossibleB),
      contagion: stageSafeLine("contagion", generated.contagion, fallback.contagion),
      confession: stageSafeLine("confession", generated.confession, fallback.confession),
      overdrive: stageSafeLine("overdrive", generated.overdrive, fallback.overdrive),
      aftershock: stageSafeLine("aftershock", generated.aftershock, fallback.aftershock),
    };
  }

  private refreshParticipants(): void {
    const currentIds = this.snapshot.participants.map((participant) => participant.id);
    const refreshed = this.runtime.refreshParticipants(currentIds);
    const previous = new Map(this.snapshot.participants.map((participant) => [participant.id, participant]));
    const participants = refreshed.map((participant) => ({
      ...participant,
      role: previous.get(participant.id)?.role ?? participant.role,
      confessed: previous.get(participant.id)?.confessed ?? participant.confessed,
    }));
    if (participants.length === 0) {
      this.abort("all_participants_unavailable");
      throw new EventAbortError("all participants unavailable");
    }
    if (participants.length !== this.snapshot.participants.length) {
      const instigatorStillPresent = participants.some((participant) => participant.id === this.snapshot.instigatorId);
      this.snapshot = {
        ...this.snapshot,
        participants,
        instigatorId: instigatorStillPresent ? this.snapshot.instigatorId : participants[0].id,
      };
      this.emit();
    }
  }

  private async send(participant: SelfSabotageParticipant, message: string, coverLoss = 0): Promise<boolean> {
    this.signal();
    this.refreshParticipants();
    const liveParticipant = this.participant(participant.id);
    if (!liveParticipant) return false;
    const count = this.perBotCounts.get(liveParticipant.id) ?? 0;
    if (this.snapshot.remainingMessageBudget <= 0 || count >= SELF_SABOTAGE_CONFIG.limits.maxMessagesPerBot) return false;
    let pendingTimeline = [...this.timeline].reverse().find((entry) => entry.sentAt === null && entry.speaker === liveParticipant.username);
    if (!pendingTimeline) {
      pendingTimeline = {
        eventId: this.snapshot.eventId!, phase: this.snapshot.phase,
        speaker: liveParticipant.username, scheduledAt: this.runtime.now(), sentAt: null,
        delayMs: 0, reason: "initial_setup", humanReactionDetected: false,
      };
      this.timeline.push(pendingTimeline);
    }
    this.snapshot = { ...this.snapshot, currentSpeakerId: liveParticipant.id };
    this.emit();
    let sent = false;
    try {
      const safeMessage = message === SELF_SABOTAGE_PAYLOAD ? message : sanitizedLine(message, "beep");
      sent = await this.runtime.send(liveParticipant, safeMessage, this.signal());
    } catch (error) {
      if (this.signal().aborted) throw new EventAbortError("aborted");
      console.warn(`[SELF-SAB-BOT-AGE] send failed for ${liveParticipant.username}`, error);
      return false;
    } finally {
      if (this.snapshot.active) {
        this.snapshot = { ...this.snapshot, currentSpeakerId: null };
        this.emit();
      }
    }
    if (!sent) return false;
    const sentAt = this.runtime.now();
    this.sentAt.push(sentAt);
    this.lastMessageLength = message.length;
    if (pendingTimeline) pendingTimeline.sentAt = sentAt;
    this.perBotCounts.set(liveParticipant.id, count + 1);
    this.snapshot = {
      ...this.snapshot,
      messagesSent: this.snapshot.messagesSent + 1,
      remainingMessageBudget: Math.max(0, this.snapshot.remainingMessageBudget - 1),
      coverIntegrity: Math.max(0, this.snapshot.coverIntegrity - coverLoss),
    };
    this.emit();
    return true;
  }

  private markConfessed(participantId: string): void {
    this.snapshot = {
      ...this.snapshot,
      participants: this.snapshot.participants.map((participant) =>
        participant.id === participantId ? { ...participant, confessed: true } : participant,
      ),
    };
    this.emit();
  }

  private async sendPayload(): Promise<void> {
    this.refreshParticipants();
    const recipients = this.snapshot.participants.filter((participant) => {
      const count = this.perBotCounts.get(participant.id) ?? 0;
      return count < SELF_SABOTAGE_CONFIG.limits.maxMessagesPerBot;
    }).slice(0, this.snapshot.remainingMessageBudget);
    let sentCount = 0;
    for (const participant of recipients) {
      try {
        await this.waitForBeat("capstone", participant, "serial_payload_capstone");
        if (await this.send(participant, SELF_SABOTAGE_PAYLOAD)) sentCount += 1;
      } catch (error) {
        if (this.signal().aborted) throw new EventAbortError("aborted");
        console.warn(`[SELF-SAB-BOT-AGE] payload send failed for ${participant.username}`, error);
      }
    }
    this.snapshot = {
      ...this.snapshot,
      payloadFired: sentCount > 0,
      payloadFiring: false,
    };
    this.emit();
  }

  private async run(): Promise<void> {
    const eventId = this.snapshot.eventId!;
    const source = this.snapshot.source!;
    try {
      const preparePromise = this.runtime.prepareDialogue(
        eventId,
        this.snapshot.participants,
        this.snapshot.instigatorId!,
        this.signal(),
      );
      this.packets = await Promise.race([
        preparePromise,
        this.pause(6_000).then(() => ({} as Record<string, SelfSabotageDialoguePacket>)),
      ]);
      this.signal();

      this.setPhase("setup");
      this.transition("ANNOUNCEMENT");
      let instigator = this.participant(this.snapshot.instigatorId!)!;
      await this.send(instigator, this.packet(instigator).announcement);

      const others = () => this.snapshot.participants.filter((participant) => participant.id !== this.snapshot.instigatorId);
      if (others().length > 0) {
        this.transition("DOGPILE");
        const dogpileCount = Math.min(
          this.snapshot.mobile ? 1 : (this.runtime.random() < 0.7 ? 1 : 2),
          SELF_SABOTAGE_CONFIG.limits.maxTensionSpeakers,
          others().length,
        );
        for (const [index, participant] of others().slice(0, dogpileCount).entries()) {
          await this.waitForBeat(index === 0 ? "setup" : "tension", participant, "skeptic_notices_setup");
          this.setPhase("tension");
          await this.send(participant, this.packet(participant).dogpile, 4);
        }
      }

      this.transition("HESITATION");
      instigator = this.participant(this.snapshot.instigatorId!)!;
      await this.waitForBeat("tension", instigator, "instigator_attempts_retreat");
      await this.send(instigator, this.packet(instigator).hesitation, 4);

      this.setPhase("exposure");
      this.transition("IMPOSSIBLE_SEND");
      instigator = this.participant(this.snapshot.instigatorId!)!;
      const impossible = this.packet(instigator);
      await this.waitForBeat("exposure", instigator, "instigator_says_too_much");
      await this.send(instigator, impossible.impossibleA, 8);
      const exposureResponder = others()[0];
      if (exposureResponder) {
        await this.waitForBeat("exposure", exposureResponder, "skeptic_identifies_slip");
        await this.send(exposureResponder, this.packet(exposureResponder).hesitation, 5);
      } else {
        await this.waitForBeat("exposure", instigator, "solo_self_correction");
        await this.send(instigator, impossible.impossibleB, 10);
      }

      this.setPhase("cascade");
      this.transition("CONTAGION");
      const contagionTargets = others().length > 0
        ? others().slice(0, this.snapshot.mobile ? 1 : SELF_SABOTAGE_CONFIG.limits.maxCascadeSpeakers)
        : [instigator];
      for (const participant of contagionTargets) {
        await this.waitForBeat("cascade", participant, "controlled_accusation_cascade");
        await this.send(participant, this.packet(participant).contagion, 7);
      }

      this.transition("CONFESSION_CASCADE");
      instigator = this.participant(this.snapshot.instigatorId!)!;
      await this.waitForBeat("cascade", instigator, "instigator_confession");
      await this.send(instigator, this.packet(instigator).confession, 16);
      this.markConfessed(instigator.id);
      const confessors = others().slice(0, this.snapshot.mobile ? 1 : SELF_SABOTAGE_CONFIG.limits.maxCascadeSpeakers);
      for (const participant of confessors) {
        await this.waitForBeat("cascade", participant, "supporting_confession");
        await this.send(participant, this.packet(participant).confession, 12);
        this.markConfessed(participant.id);
      }

      this.setPhase("capstone");
      this.transition("OVERDRIVE", { coverIntegrity: 0 });
      const capstoneSpeaker = confessors[0] ?? instigator;
      await this.waitForBeat("capstone", capstoneSpeaker, "final_absurd_reaction");
      await this.send(capstoneSpeaker, this.packet(capstoneSpeaker).overdrive, 0);

      this.transition("PAYLOAD_READY", { payloadArmed: true });
      const firePayload = await new Promise<boolean>((resolve) => {
        this.payloadResolver = resolve;
        this.payloadTimer = setTimeout(() => {
          this.payloadTimer = null;
          if (this.payloadResolver === resolve) {
            this.payloadResolver = null;
            resolve(false);
          }
        }, this.timing(SELF_SABOTAGE_CONFIG.timing.payloadReadyTimeoutMs));
      });

      if (firePayload && this.snapshot.state === "PAYLOAD_FIRED") {
        await this.sendPayload();
      } else if (this.snapshot.state === "PAYLOAD_READY") {
        this.transition("RESET", { payloadArmed: false });
      }

      if (this.snapshot.state === "PAYLOAD_FIRED") this.transition("RESET");
      await this.pause(SELF_SABOTAGE_CONFIG.timing.resetDisplayMs);
      this.transition("AFTERSHOCK");

      // Silence is the last directed beat. The floor remains leased throughout
      // so no stale autonomous result can step on the punchline.
      this.setPhase("cooldown");
      const [silenceMin, silenceMax] = SELF_SABOTAGE_CONFIG.timing.capstoneSilenceMs;
      await this.pause(silenceMin + (silenceMax - silenceMin) * this.runtime.random());

      const completedAt = this.runtime.now();
      this.runtime.recordAftershock({
        eventId,
        timestamp: completedAt,
        participants: this.snapshot.participants.map((participant) => participant.username),
        instigatorId: this.snapshot.instigatorId!,
        payloadFired: this.snapshot.payloadFired,
        source,
      });
      this.recordAnalytics(false, completedAt);
      this.lastCompletedAt = completedAt;
      this.transition("DORMANT", { phase: "idle" });
    } catch (error) {
      if (!this.snapshot.active) return;
      if (this.snapshot.state !== "ABORTED") {
        this.abort(error instanceof Error ? error.message : "unknown_abort");
      }
      this.recordAnalytics(true, this.runtime.now());
      await new Promise((resolve) => setTimeout(resolve, this.timing(700)));
      if (this.snapshot.state === "ABORTED") this.transition("DORMANT");
    }
  }

  private recordAnalytics(aborted: boolean, completedAt: number): void {
    if (this.analyticsRecordedForEvent) return;
    if (!this.snapshot.eventId || !this.snapshot.source || this.snapshot.startedAt === null || !this.snapshot.instigatorId) return;
    const record: SelfSabotageAnalyticsRecord = {
      eventId: this.snapshot.eventId,
      triggerSource: this.snapshot.source,
      participantCount: this.snapshot.participants.length,
      instigatorId: this.snapshot.instigatorId,
      startedAt: this.snapshot.startedAt,
      completedAt,
      payloadFired: this.snapshot.payloadFired,
      aborted,
      ...(aborted && this.snapshot.abortReason ? { abortReason: this.snapshot.abortReason } : {}),
    };
    this.analytics.push(record);
    this.analyticsRecordedForEvent = true;
    if (this.analytics.length > 25) this.analytics.splice(0, this.analytics.length - 25);
    this.runtime.recordAnalytics(record);
  }

  private cleanup(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.stopObserving?.();
    this.stopObserving = null;
    this.payloadResolver?.(false);
    this.payloadResolver = null;
    if (this.payloadTimer) clearTimeout(this.payloadTimer);
    this.payloadTimer = null;
    this.runtime.releaseFloor(SELF_SABOTAGE_FLOOR_OWNER);
    this.abortController = null;
    this.packets = {};
    this.perBotCounts.clear();
    this.runPromise = null;
    if (this.snapshot.state !== "DORMANT") {
      this.snapshot = dormantSnapshot(this.lastCompletedAt, this.runtime.now());
      this.emit();
    } else {
      this.snapshot = {
        ...this.snapshot,
        cooldown: {
          lastCompletedAt: this.lastCompletedAt,
          remainingMs: this.lastCompletedAt === null ? 0 : SELF_SABOTAGE_CONFIG.organic.cooldownMs,
        },
      };
      this.emit();
    }
  }
}

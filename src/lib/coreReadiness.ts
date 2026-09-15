/** Pure readiness policy shared by the UI and regression tests.
 * Milestones remember progress; availability describes the current session.
 */
export type CoreStage =
  | "platform"
  | "ai"
  | "personality"
  | "forge"
  | "send"
  | "autoforge"
  | "operational";

export type CorePhase = "setup" | "activating" | "operational";

export interface ReadinessState {
  stage: CoreStage;
  phase: CorePhase;
  platformReady: boolean;
  aiReady: boolean;
  personalityReady: boolean;
  forgeReady: boolean;
  sendReady: boolean;
  autoForgeReady: boolean;
  operational: boolean;
  /** Essential readiness (5 items: platform, ai, personality, forge, send). */
  essentialReady: boolean;
  /** Count of essential readiness items (excluding optional AutoForge). */
  essentialReadyCount: number;
  /** Total essential items (5: platform, ai, personality, forge, send). */
  essentialTotal: number;
  /** Automation readiness (optional AutoForge). */
  automationReady: boolean;
  /** Whether the optional AutoForge milestone is complete. */
  autoForgeComplete: boolean;
  /** Suggested next action label for the current stage. */
  nextAction: string;
  /** Platform was connected before but is now disconnected. */
  platformError: boolean;
  /** AI provider was working before but is now in cooldown/unavailable. */
  aiError: boolean;
}

export interface CoreReadinessInput {
  channel: string;
  connection: "disconnected" | "connecting" | "connected" | "error";
  aiConfigured: boolean;
  aiAvailable: boolean;
  personaChosen: boolean;
  hasForgedOnce: boolean;
  hasSentMessage: boolean;
  hasEnabledAutoForgeOnce: boolean;
  autoForgeEnabled: boolean;
  autoForgeDryRun: boolean;
}

export function deriveCoreReadiness(input: CoreReadinessInput): ReadinessState {
  const channelSet = !!input.channel.trim().replace(/^#/, "");
  const platformReady = channelSet && input.connection === "connected";
  const aiReady = input.aiConfigured && input.aiAvailable;
  const personalityReady = input.personaChosen;
  const forgeReady = input.hasForgedOnce;
  const sendReady = input.hasSentMessage;
  const autoForgeComplete = input.hasEnabledAutoForgeOnce;
  const essentialReadyCount = [platformReady, aiReady, personalityReady, forgeReady, sendReady].filter(Boolean).length;
  const essentialReady = essentialReadyCount === 5;
  const autoForgeReady = platformReady && aiReady && input.autoForgeEnabled && !input.autoForgeDryRun;
  const returning = forgeReady || sendReady;
  const platformError = channelSet && (input.connection === "error" || (returning && !platformReady));
  const aiError = (input.aiConfigured && !input.aiAvailable) || (forgeReady && !input.aiConfigured);

  let stage: CoreStage = "operational";
  if (!platformReady) stage = "platform";
  else if (!aiReady) stage = "ai";
  else if (!personalityReady) stage = "personality";
  else if (!forgeReady) stage = "forge";
  else if (!sendReady) stage = "send";
  else if (!autoForgeComplete) stage = "autoforge";

  // Returning operators keep their workspace while fixing a connection/provider.
  // This is a presentation choice, never evidence that the session is live.
  let phase: CorePhase = "setup";
  if (personalityReady && (returning || (platformReady && aiReady))) {
    phase = forgeReady && sendReady ? "operational" : "activating";
  }
  const labels: Record<CoreStage, string> = {
    platform: input.connection === "connecting" ? "Connecting to chat" : "Connect your stream",
    ai: "Choose the brain",
    personality: "Give it a vibe",
    forge: "Forge something",
    send: "Send to chat",
    autoforge: "Want it automatic?",
    operational: "MADchatter is live",
  };
  const nextAction = platformError
    ? (input.connection === "connecting" ? "Reconnecting to chat" : "Reconnect to continue")
    : aiError ? "AI provider needs attention" : labels[stage];
  return {
    stage, phase, platformReady, aiReady, personalityReady, forgeReady, sendReady,
    autoForgeReady, operational: essentialReady, essentialReady, essentialReadyCount,
    essentialTotal: 5, automationReady: autoForgeReady, autoForgeComplete,
    nextAction, platformError, aiError,
  };
}

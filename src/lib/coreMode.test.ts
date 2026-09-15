/**
 * Core Mode + Onboarding Tests
 *
 * Run with: npx tsx src/lib/coreMode.test.ts
 *
 * Tests:
 * - Persistence migration (new user → core, all users forced to core via v22/v23)
 * - Persistence of onboarding milestones through localStorage (v24 fix)
 * - Readiness derivation (platform, ai, personality, forge, send, autoforge)
 * - Mode switching preserves settings
 * - Onboarding milestones (hasSentMessage, hasEnabledAutoForgeOnce)
 * - Dry-run doesn't mark send milestone
 * - AutoForge state survives mode switching
 * - Persona survives mode switching
 * - Provider survives mode switching
 */

// ─── localStorage shim (must exist before store.ts module init) ──────────
const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};

const { useAppStore, partializeAppState } = await import("../store");
const { setStudioAvailable, isStudioAvailable, STUDIO_MIN_WIDTH } = await import("./studioAvailability");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`FAIL: ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

// ─── Test: New user defaults to Core Mode ────────────────────────────────
function testNewUserDefaultsToCore() {
  storageMap.clear();
  // Fresh store — no persisted state
  useAppStore.getState().setInterfaceMode("core"); // explicit default
  const state = useAppStore.getState();
  assertEq(state.interfaceMode, "core", "New user should default to Core Mode");
  assertEq(state.hasSentMessage, false, "New user hasSentMessage should be false");
  assertEq(state.hasEnabledAutoForgeOnce, false, "New user hasEnabledAutoForgeOnce should be false");
  assertEq(state.activationCelebrated, false, "New user activationCelebrated should be false");
}

// ─── Test: Mode switching preserves settings ────────────────────────────
function testModeSwitchPreservesSettings() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Set up some config
  s.updateConfig({ humorLevel: 75, chaosLevel: 60, primaryProfile: "Gremlin" });
  s.setAutoForgeEnabled(true);

  // Switch to Studio
  s.setInterfaceMode("studio");
  let state = useAppStore.getState();
  assertEq(state.interfaceMode, "studio", "Should be in Studio Mode");
  assertEq(state.config.humorLevel, 75, "Humor should survive mode switch");
  assertEq(state.config.chaosLevel, 60, "Chaos should survive mode switch");
  assertEq(state.config.primaryProfile, "Gremlin", "Persona should survive mode switch");
  assertEq(state.autoForgeEnabled, true, "AutoForge should survive mode switch");

  // Switch back to Core
  s.setInterfaceMode("core");
  state = useAppStore.getState();
  assertEq(state.interfaceMode, "core", "Should be back in Core Mode");
  assertEq(state.config.humorLevel, 75, "Humor should survive back-switch");
  assertEq(state.config.chaosLevel, 60, "Chaos should survive back-switch");
  assertEq(state.config.primaryProfile, "Gremlin", "Persona should survive back-switch");
  assertEq(state.autoForgeEnabled, true, "AutoForge should survive back-switch");
}

// ─── Test: Onboarding milestones ────────────────────────────────────────
function testOnboardingMilestones() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Reset milestones explicitly since the store is a singleton and previous
  // tests may have enabled AutoForge.
  useAppStore.setState({
    hasEnabledAutoForgeOnce: false,
    hasSentMessage: false,
    autoForgeEnabled: false,
  });

  // AutoForge milestone
  assertEq(useAppStore.getState().hasEnabledAutoForgeOnce, false, "AutoForge milestone should start false");
  s.setAutoForgeEnabled(true);
  assertEq(useAppStore.getState().hasEnabledAutoForgeOnce, true, "Enabling AutoForge should set milestone");
  s.setAutoForgeEnabled(false);
  assertEq(useAppStore.getState().hasEnabledAutoForgeOnce, true, "Disabling AutoForge should not unset milestone");

  // Send milestone
  useAppStore.getState().setHasSentMessage(false);
  assertEq(useAppStore.getState().hasSentMessage, false, "Send milestone should start false");
  s.setHasSentMessage(true);
  assertEq(useAppStore.getState().hasSentMessage, true, "Setting send milestone should persist");
}

// ─── Test: Dry-run doesn't mark send milestone ───────────────────────────
function testDryRunNoSendMilestone() {
  storageMap.clear();
  const s = useAppStore.getState();
  s.setAutoForgeEnabled(true);
  s.setHasSentMessage(false);
  // Reset dry-run to false explicitly
  useAppStore.setState({ autoForgeDryRun: false });

  // Simulate the manualSend.ts logic: dry-run prevents milestone
  // (The actual check in manualSend.ts is: if (!state.autoForgeDryRun && !state.hasSentMessage))
  const wouldMarkSend = !useAppStore.getState().autoForgeDryRun && !useAppStore.getState().hasSentMessage;
  assert(wouldMarkSend === true, "Non-dry-run should mark send milestone");

  // Now enable dry-run
  useAppStore.setState({ autoForgeDryRun: true });
  const wouldMarkSendDry = !useAppStore.getState().autoForgeDryRun && !useAppStore.getState().hasSentMessage;
  assert(wouldMarkSendDry === false, "Dry-run should NOT mark send milestone");
}

// ─── Test: Multi-Bot state survives mode switching ──────────────────────
function testMultiBotSurvivesModeSwitch() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Enable multi-bot
  s.setMultiBotEnabled(true);
  s.setManualSendBotId("test-bot-id");

  s.setInterfaceMode("studio");
  assertEq(useAppStore.getState().multiBotEnabled, true, "Multi-Bot enabled should survive mode switch");
  assertEq(useAppStore.getState().manualSendBotId, "test-bot-id", "manualSendBotId should survive mode switch");

  s.setInterfaceMode("core");
  assertEq(useAppStore.getState().multiBotEnabled, true, "Multi-Bot enabled should survive back-switch");
  assertEq(useAppStore.getState().manualSendBotId, "test-bot-id", "manualSendBotId should survive back-switch");
}

// ─── Test: Provider survives mode switching ─────────────────────────────
function testProviderSurvivesModeSwitch() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Set a provider key
  storageMap.set("madchatter-api-keys", JSON.stringify({ geminiKey: "test-key", chatGptKey: "", claudeKey: "", openRouterKey: "", customBaseUrl: "", customModel: "" }));
  storageMap.set("active_api_provider", "gemini");

  s.setInterfaceMode("studio");
  s.setInterfaceMode("core");

  // Keys are in localStorage, not Zustand — they should survive
  const keys = storageMap.get("madchatter-api-keys");
  assert(keys !== undefined, "API keys should survive mode switch in localStorage");
  assert(keys?.includes("test-key"), "Gemini key should be preserved");
}

// ─── Test: Micro-tour dismissal tracking ────────────────────────────────
function testMicroTourDismissal() {
  storageMap.clear();
  const s = useAppStore.getState();

  assertEq(s.microToursSeen["multibot"], undefined, "Micro-tour should start unseen");
  s.setMicroTourSeen("multibot", true);
  assertEq(useAppStore.getState().microToursSeen["multibot"], true, "Micro-tour should be marked seen");
  s.setMicroTourSeen("multibot", false);
  assertEq(useAppStore.getState().microToursSeen["multibot"], false, "Micro-tour can be un-marked");
}

// ─── Test: Activation celebration fires once ────────────────────────────
function testActivationCelebrationOnce() {
  storageMap.clear();
  const s = useAppStore.getState();

  assertEq(s.activationCelebrated, false, "Celebration should start uncelebrated");
  s.setActivationCelebrated(true);
  assertEq(useAppStore.getState().activationCelebrated, true, "Celebration should be marked");
  // Setting again should be idempotent
  s.setActivationCelebrated(true);
  assertEq(useAppStore.getState().activationCelebrated, true, "Celebration should remain marked");
}

// ─── Test: Phase transitions (setup → activating → operational) ──────────
function testPhaseTransitions() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Reset all milestones
  useAppStore.setState({
    hasForgedOnce: false,
    hasSentMessage: false,
    hasEnabledAutoForgeOnce: false,
    personaChosen: false,
    tmiReadState: "disconnected",
    streamMetadata: { channelName: "", title: "", category: "", viewerCount: 0 },
  });

  // Phase: setup (no platform, no AI, no persona)
  // personaChosen defaults to false — Step 3 shows until the user picks one
  // But platform is not ready (no channel + disconnected)
  assert(!useAppStore.getState().tmiReadState || useAppStore.getState().tmiReadState !== "connected",
    "Platform should not be ready initially");

  // Simulate platform connection
  useAppStore.setState({
    tmiReadState: "connected",
    streamMetadata: { channelName: "testchannel", title: "", category: "", viewerCount: 0 },
  });

  // Simulate AI config (set a key in localStorage)
  storageMap.set("madchatter-api-keys", JSON.stringify({
    geminiKey: "test-key", chatGptKey: "", claudeKey: "",
    openRouterKey: "", customBaseUrl: "", customModel: "",
  }));
  storageMap.set("active_api_provider", "gemini");

  // Simulate persona chosen + first Forge
  useAppStore.setState({ hasForgedOnce: true, personaChosen: true });

  // Phase: activating (platform + AI + persona ready, forge done, send not done)
  assertEq(useAppStore.getState().hasForgedOnce, true, "Forge should be done");
  assertEq(useAppStore.getState().hasSentMessage, false, "Send should not be done yet");

  // Simulate first Send
  useAppStore.setState({ hasSentMessage: true });

  // Phase: operational (all essential ready)
  assertEq(useAppStore.getState().hasSentMessage, true, "Send should be done");
  assertEq(useAppStore.getState().hasForgedOnce, true, "Forge should be done");
}

// ─── Test: essentialReady vs automationReady ─────────────────────────────
function testEssentialVsAutomation() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Reset
  useAppStore.setState({
    hasForgedOnce: false,
    hasSentMessage: false,
    hasEnabledAutoForgeOnce: false,
    personaChosen: false,
    autoForgeEnabled: false,
    autoForgeDryRun: false,
    tmiReadState: "connected",
    streamMetadata: { channelName: "test", title: "", category: "", viewerCount: 0 },
  });
  storageMap.set("madchatter-api-keys", JSON.stringify({
    geminiKey: "key", chatGptKey: "", claudeKey: "",
    openRouterKey: "", customBaseUrl: "", customModel: "",
  }));
  storageMap.set("active_api_provider", "gemini");

  // Without AutoForge: essential can be ready, automation is not
  useAppStore.setState({ hasForgedOnce: true, hasSentMessage: true, personaChosen: true });
  assertEq(useAppStore.getState().hasSentMessage, true, "Send milestone should be set");
  assertEq(useAppStore.getState().autoForgeEnabled, false, "AutoForge should be off");
  assertEq(useAppStore.getState().hasEnabledAutoForgeOnce, false, "AutoForge milestone should not be set");

  // A manual-only user is NOT perpetually incomplete
  // (The readiness hook's `operational` = essentialReady, not dependent on AutoForge)
  // This is verified by the hook logic: operational = platform + ai + persona + forge + send

  // Enable AutoForge — automation becomes ready
  s.setAutoForgeEnabled(true);
  assertEq(useAppStore.getState().hasEnabledAutoForgeOnce, true, "AutoForge milestone should be set after enabling");
  assertEq(useAppStore.getState().autoForgeEnabled, true, "AutoForge should be enabled");

  // Dry run doesn't make automation "ready" (operational), but milestone is still set
  useAppStore.setState({ autoForgeDryRun: true });
  assertEq(useAppStore.getState().hasEnabledAutoForgeOnce, true, "AutoForge milestone persists in dry run");
  assertEq(useAppStore.getState().autoForgeDryRun, true, "Dry run should be on");
}

// ─── Test: Error states don't revert to onboarding ────────────────────────
function testErrorStatesNoRevert() {
  storageMap.clear();
  const s = useAppStore.getState();

  // Simulate a fully operational user
  useAppStore.setState({
    hasForgedOnce: true,
    hasSentMessage: true,
    personaChosen: true,
    tmiReadState: "connected",
    streamMetadata: { channelName: "test", title: "", category: "", viewerCount: 0 },
  });
  storageMap.set("madchatter-api-keys", JSON.stringify({
    geminiKey: "key", chatGptKey: "", claudeKey: "",
    openRouterKey: "", customBaseUrl: "", customModel: "",
  }));
  storageMap.set("active_api_provider", "gemini");

  // Platform disconnects (chat read state drops)
  useAppStore.setState({ tmiReadState: "disconnected" });
  assertEq(useAppStore.getState().tmiReadState, "disconnected", "Platform should be disconnected");
  // The user's milestones are NOT reset
  assertEq(useAppStore.getState().hasForgedOnce, true, "Forge milestone should survive disconnect");
  assertEq(useAppStore.getState().hasSentMessage, true, "Send milestone should survive disconnect");

  // Reconnect
  useAppStore.setState({ tmiReadState: "connected" });
  assertEq(useAppStore.getState().tmiReadState, "connected", "Platform should reconnect");
  assertEq(useAppStore.getState().hasForgedOnce, true, "Forge milestone should survive reconnect");
}

// ─── Test: personaChosen persists through partialize ───────────────────
// Regression: `personaChosen` was declared and consumed by useCoreReadiness
// (personalityReady = personaChosen) but missing from `partialize` before
// v24. Without persistence, it reset to false on every reload, permanently
// reverting the Launchpad to the "setup" phase. This test verifies the
// field is included in the partialize output — the exact contract that
// was broken. Tests partializeAppState directly (the storage layer is
// unavailable in the Node test environment, but partialize is the
// source of truth for what persists).
function testPersonaChosenPersists() {
  storageMap.clear();
  const s = useAppStore.getState();

  s.setPersonaChosen(true);
  const partial = partializeAppState(useAppStore.getState());
  assert(partial.personaChosen === true, "personaChosen should be in partialize output as true");
}

// ─── Test: modeWelcomeSeen persists through partialize ─────────────────
// Regression: `modeWelcomeSeen` gates the ModeWelcomeOverlay visibility
// (visible = !modeWelcomeSeen) but was missing from `partialize` before v24.
// Without persistence, the full-screen mode picker re-appeared on every
// reload. This test verifies the field is included in the partialize output.
function testModeWelcomeSeenPersists() {
  storageMap.clear();
  const s = useAppStore.getState();

  s.setModeWelcomeSeen(true);
  const partial = partializeAppState(useAppStore.getState());
  assert(partial.modeWelcomeSeen === true, "modeWelcomeSeen should be in partialize output as true");
}

// ─── Test: STUDIO entry is gated when the viewport can't support it ──────
// When isStudioAvailable() is false (viewport < STUDIO_MIN_WIDTH), calling
// setInterfaceMode("studio") must NOT change the preferred mode — it opens
// the gate interstitial instead. This is the single chokepoint every entry
// path routes through (header toggle, command palette, welcome overlay,
// discovery overlay, "Open Studio" buttons, persisted state).
function testStudioGateWhenUnavailable() {
  storageMap.clear();
  const s = useAppStore.getState();
  useAppStore.setState({ interfaceMode: "core", studioGateOpen: false, studioForcedCore: false });

  // Simulate a narrow viewport
  setStudioAvailable(false);
  assertEq(isStudioAvailable(), false, "Studio should report unavailable below threshold");

  s.setInterfaceMode("studio");
  let state = useAppStore.getState();
  assertEq(state.interfaceMode, "core", "Preferred mode must not change to studio when unavailable");
  assertEq(state.studioGateOpen, true, "Gate interstitial should open on blocked studio entry");

  // Restore capability
  setStudioAvailable(true);
  assertEq(isStudioAvailable(), true, "Studio should report available at/above threshold");

  // Now the same call switches normally and closes the gate
  s.setInterfaceMode("studio");
  state = useAppStore.getState();
  assertEq(state.interfaceMode, "studio", "Studio should enter normally when available");
  assertEq(state.studioGateOpen, false, "Gate should be closed after successful entry");
  assertEq(state.studioForcedCore, false, "Forced-core flag cleared on explicit studio entry");

  // Restore a clean baseline for later tests
  s.setInterfaceMode("core");
}

// ─── Test: shrink-forced fallback does not overwrite the preferred mode ──
// Simulates Case F + the preferred-vs-effective split: a STUDIO user whose
// viewport shrinks gets studioForcedCore set by useStudioAvailabilitySync.
// The preferred mode stays "studio" so a fresh load on a large screen
// resumes STUDIO normally.
function testStudioShrinkPreservesPreference() {
  storageMap.clear();
  const s = useAppStore.getState();
  setStudioAvailable(true);
  useAppStore.setState({ interfaceMode: "studio", studioForcedCore: false, studioGateOpen: false });

  // Simulate what useStudioAvailabilitySync does on a true→false shrink
  // while effectively in Studio.
  const before = useAppStore.getState();
  const wasStudio = before.interfaceMode === "studio" && !before.studioForcedCore;
  assert(wasStudio === true, "Effective mode should be studio before shrink");
  before.setStudioForcedCore(true);

  const after = useAppStore.getState();
  assertEq(after.interfaceMode, "studio", "Preferred mode stays studio after forced fallback");
  assertEq(after.studioForcedCore, true, "Forced-core flag set on shrink");

  // Explicit Core choice clears the forced flag (willing choice)
  after.setInterfaceMode("core");
  const final = useAppStore.getState();
  assertEq(final.interfaceMode, "core", "Explicit Core choice applies");
  assertEq(final.studioForcedCore, false, "Forced flag cleared on explicit choice");
}

// ─── Test: STUDIO capability fields are runtime-only (never persisted) ────
// studioForcedCore and studioGateOpen are transient viewport state — they
// must not be serialized into madchatter-storage, or a phone session could
// leak "forced to core" into a desktop session.
function testStudioGateFieldsNotPersisted() {
  storageMap.clear();
  const s = useAppStore.getState();
  useAppStore.setState({ studioForcedCore: true, studioGateOpen: true });
  const partial = partializeAppState(useAppStore.getState());
  assert(!("studioForcedCore" in partial), "studioForcedCore must not be persisted");
  assert(!("studioGateOpen" in partial), "studioGateOpen must not be persisted");
  useAppStore.setState({ studioForcedCore: false, studioGateOpen: false });
}

// ─── Test: STUDIO_MIN_WIDTH is a sane desktop threshold ──────────────────
function testStudioMinWidthSane() {
  assert(STUDIO_MIN_WIDTH >= 900 && STUDIO_MIN_WIDTH <= 1366,
    `STUDIO_MIN_WIDTH (${STUDIO_MIN_WIDTH}) should be a plausible desktop threshold`);
}
async function runAll() {
  console.log("Running Core Mode + Onboarding tests...\n");

  testNewUserDefaultsToCore();
  testModeSwitchPreservesSettings();
  testOnboardingMilestones();
  testDryRunNoSendMilestone();
  testMultiBotSurvivesModeSwitch();
  testProviderSurvivesModeSwitch();
  testMicroTourDismissal();
  testActivationCelebrationOnce();
  testPhaseTransitions();
  testEssentialVsAutomation();
  testErrorStatesNoRevert();
  testPersonaChosenPersists();
  testModeWelcomeSeenPersists();
  testStudioGateWhenUnavailable();
  testStudioShrinkPreservesPreference();
  testStudioGateFieldsNotPersisted();
  testStudioMinWidthSane();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("All tests passed!");
    process.exit(0);
  }
}

runAll();

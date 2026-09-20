import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mobilePath = fileURLToPath(new URL("../components/CoreMobileWorkspace.tsx", import.meta.url));
const visionPath = fileURLToPath(new URL("../components/VisualHistoryOverlay.tsx", import.meta.url));
const welcomePath = fileURLToPath(new URL("../components/MobileWelcomeOverlay.tsx", import.meta.url));
const trialPath = fileURLToPath(new URL("../components/MobileFriendTrialCard.tsx", import.meta.url));
const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
const forgeLayoutPath = fileURLToPath(new URL("../components/ForgeLayout.tsx", import.meta.url));
const smartReplyShelfPath = fileURLToPath(new URL("../components/MobileSmartReplyShelf.tsx", import.meta.url));
const mobile = readFileSync(mobilePath, "utf8");
const vision = readFileSync(visionPath, "utf8");
const welcome = readFileSync(welcomePath, "utf8");
const trial = readFileSync(trialPath, "utf8");
const app = readFileSync(appPath, "utf8");
const forgeLayout = readFileSync(forgeLayoutPath, "utf8");
const smartReplyShelf = readFileSync(smartReplyShelfPath, "utf8");

assert.match(mobile, /R34lInlineDetails showDesktopShortcutHint=\{false\}/, "mobile suppresses desktop R34L shortcut hint");
assert.match(mobile, /providerSectionExpanded &&/, "provider inputs are conditionally absent when collapsed");
assert.match(mobile, /aria-expanded=\{providerSectionExpanded\}/, "provider disclosure exposes aria-expanded");
assert.match(mobile, /Previous AutoForge decision/, "mobile telemetry exposes previous navigation");
assert.match(mobile, /Next AutoForge decision/, "mobile telemetry exposes next navigation");
assert.doesNotMatch(mobile, /\(config\.lengthPreference \|\| "short"\) === lvl/, "adaptive length is not visually forced to Short");
assert.match(mobile, /<MobileWelcomeOverlay onDismissToTuning=\{dismissWelcomeToTuning\}/, "mobile CORE owns a temporary welcome overlay");
assert.match(forgeLayout, /interfaceMode === "core"[\s\S]*isMobile \?[\s\S]*<CoreMobileWorkspace/, "mobile onboarding remains scoped to mobile CORE");
assert.match(mobile, /acknowledgeMobileWelcome\(\)[\s\S]*setMobileTab\("tuning"\)[\s\S]*scrollTop = 0/, "both welcome actions share the persisted Tuning-at-top handoff");
assert.doesNotMatch(mobile, />\s*Welcome\s*</, "Welcome is not added to the mobile tab navigation");
assert.match(app, /!isMobile && <ModeWelcomeOverlay \/>/, "mobile enters its dedicated workspace without the CORE/STUDIO picker");
assert.match(app, /!isMobile && <StudioDiscoveryOverlay \/>/, "mobile never receives the later Studio promotion");
assert.match(app, /!isMobile && <StudioGateOverlay \/>/, "mobile never receives the Studio gate");
assert.match(app, /!isMobile && <StatusBar \/>/, "desktop status dock cannot cover Mobile CORE navigation");
assert.doesNotMatch(mobile, /multiBotEnabled|manualSendBotId|setManualSendBotId/, "Mobile CORE exposes no multi-bot controls");
assert.match(
  mobile,
  /if \(!sfxEnabled\) \{[\s\S]*initSfxAudioContext\(\);[\s\S]*setSfxEnabled\(true\);[\s\S]*playSfx\("select_change"\);/,
  "enabling optional SFX initializes audio, commits ON, then demonstrates the setting",
);
assert.match(mobile, /disabled=\{!ttsEnabled\}[\s\S]*aria-disabled=\{!ttsEnabled\}/, "Background TTS has native and ARIA disabled semantics while TTS is off");
assert.equal(mobile.match(/onValueCommit=\{\(\) => playSfx\("slider_commit"\)\}/g)?.length, 3, "mobile sliders sound only through their commit callbacks");
assert.match(mobile, /describeConfidenceThreshold\(autoForgeConfidenceThreshold\)/, "confidence rendering consumes the pure semantic classifier");
assert.match(smartReplyShelf, /source: "smart_reply"/, "mobile reply sends retain the canonical smart_reply source");
assert.ok(
  mobile.indexOf("<MobileFriendTrialCard />") < mobile.indexOf("USABLE_CLOUD_PROVIDERS.map"),
  "Friend Trial is rendered before normal mobile providers",
);
assert.match(mobile, /desc: "Google AI for chat and Forge"/, "Gemini uses capability copy rather than pricing claims");
assert.doesNotMatch(mobile, /Fast & generous free tier|Gemini[^\n]*free tier/i, "Gemini never implies that Friend Trial or a free allowance belongs to Gemini");

assert.match(welcome, /role="dialog"/, "welcome uses dialog semantics");
assert.match(welcome, /aria-modal="true"/, "welcome is modal");
assert.equal(welcome.match(/onClick=\{onDismissToTuning\}/g)?.length, 2, "close and CTA share the same Tuning destination");
assert.match(welcome, /document\.body\.style\.overflow = "hidden"/, "welcome locks underlying page scroll");

assert.match(trial, /fetchTrialStatus\(workerUrl\)/, "mobile trial uses authoritative Worker status");
assert.match(trial, /createTrialSession\(/, "mobile trial uses canonical session creation");
assert.match(trial, /setTrialSession\(result\.token, result\.expiresAt\)/, "mobile trial stores the canonical session");
assert.match(trial, /setActiveProvider\(TRIAL_PROVIDER\)/, "mobile trial activates the canonical provider");
assert.match(trial, /bumpTrialTick\(\)/, "mobile trial invalidates readiness through trialTick");
assert.match(trial, /activatingRef\.current/, "mobile trial guards against duplicate activation taps");
assert.match(trial, /recommendedForNewUser[\s\S]*Recommended first step/, "Friend Trial is visibly highlighted for new provider users");
assert.match(trial, /const visible = shouldShowMobileFriendTrial\(\{[\s\S]*workerConfigured:[\s\S]*turnstileConfigured:[\s\S]*status:[\s\S]*sessionValid,[\s\S]*\}\)/, "Friend Trial visibility does not depend on the selected BYOK provider");
assert.match(trial, /trialStatus\?\.requiresInviteCode/, "invite input follows authoritative status");
assert.doesNotMatch(trial, /Worker URL|Turnstile Site Key|setTrialWorkerUrl|setTrialTurnstileSiteKey/, "compact card exposes no infrastructure controls");
assert.doesNotMatch(trial, /saveKeys\(/, "trial activation and deactivation never mutate BYOK credentials");
assert.match(trial, /trialUsage\.remaining\} \/ \{trialUsage\.limit\} Trial Uses left/, "mobile trial renders the authoritative remaining/limit values");
assert.match(trial, /role="progressbar"/, "mobile trial exposes an accessible allowance meter");
assert.match(trial, /Resets at 12:00 PM ET/, "mobile trial uses DST-safe Eastern Time copy");
assert.match(trial, /Text uses 1 · Vision uses 2/, "mobile trial discloses weighted vision usage compactly");
assert.match(trial, /Today’s Friend Trial is used up/, "mobile trial keeps a clear exhausted state visible");
assert.doesNotMatch(trial, /weighted inference units|30 messages/i, "mobile trial uses human-facing Trial Uses terminology");

assert.match(vision, /flex-wrap items-center gap-1\.5 mb-1 min-w-0 max-w-full overflow-hidden/, "vision status row wraps and contains overflow");
assert.match(vision, /whitespace-nowrap overflow-hidden text-ellipsis/, "vision status badges are width-safe");
assert.match(vision, /flex flex-col min-\[420px\]:flex-row/, "vision image and analysis stack at narrow widths");

console.log("Mobile component structure and overflow regressions passed");

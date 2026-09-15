/**
 * CORE panel dependency tests (STREAM → AUDIO/VISUAL).
 *
 * Run with: npx tsx src/lib/corePanelAvailability.test.ts
 *
 * Locks in the semantics CORE's bottom dock now relies on:
 *   - STREAM is the parent capability (available when a channel is set).
 *   - AUDIO/VISUAL are unavailable without the Stream source.
 *   - Hiding a panel never disables a feature (presentation ≠ capability).
 */

const storageMap = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => storageMap.get(k) ?? null,
  setItem: (k: string, v: string) => { storageMap.set(k, String(v)); },
  removeItem: (k: string) => { storageMap.delete(k); },
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (i: number) => [...storageMap.keys()][i] ?? null,
};

const {
  AUDIO_REQUIRED_REASON,
  VISUAL_REQUIRED_REASON,
  AUDIO_UNSUPPORTED_REASON,
  VISUAL_UNSUPPORTED_REASON,
  computePanelAvailability,
  isPanelAvailable,
  panelUnavailableReason,
  requiresStream,
} = await import("./corePanelAvailability");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.error(`FAIL: ${msg}`); }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual === expected) passed++;
  else {
    failed++;
    failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.error(`FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

console.log("Running Core Panel Availability tests...\n");

// ─── No channel: STREAM is the parent, dependents follow ────────────────────
function testNoStream() {
  const a = computePanelAvailability({ channelName: "" });
  assertEq(a.streamAvailable, false, "empty channel = no stream source");
  assertEq(a.audioAvailable, false, "AUDIO unavailable without STREAM");
  assertEq(a.visualAvailable, false, "VISUAL unavailable without STREAM");
  assertEq(a.memoryAvailable, true, "MEMORY never depends on STREAM");
  assertEq(a.audioReason, AUDIO_REQUIRED_REASON, "AUDIO explains it needs Stream");
  assertEq(a.visualReason, VISUAL_REQUIRED_REASON, "VISUAL explains it needs Stream");
  assertEq(isPanelAvailable(a, "audio"), false, "dock reports AUDIO unavailable");
  assertEq(isPanelAvailable(a, "visual"), false, "dock reports VISUAL unavailable");
  assertEq(isPanelAvailable(a, "memory"), true, "dock keeps MEMORY available");
  assertEq(panelUnavailableReason(a, "visual"), VISUAL_REQUIRED_REASON, "dock surfaces the reason");

  const blank = computePanelAvailability({ channelName: "   " });
  assertEq(blank.streamAvailable, false, "whitespace-only channel is not a stream");
  const hashed = computePanelAvailability({ channelName: "#Shroud" });
  assertEq(hashed.streamAvailable, true, "channel normalization accepts # prefixed names");
}

// ─── Channel present: everything available ──────────────────────────────────
function testStreamPresent() {
  const a = computePanelAvailability({ channelName: "shroud" });
  assertEq(a.streamAvailable, true, "channel = stream source exists");
  assertEq(a.audioAvailable, true, "AUDIO available with STREAM");
  assertEq(a.visualAvailable, true, "VISUAL available with STREAM");
  assertEq(a.audioReason, undefined, "no AUDIO reason when available");
  assertEq(a.visualReason, undefined, "no VISUAL reason when available");
}

// ─── Capability restrictions are distinct from dependency restrictions ──────
function testCapabilityReasons() {
  const mobile = computePanelAvailability({
    channelName: "shroud",
    audioCaptureSupported: false,
    visualCaptureSupported: false,
  });
  assertEq(mobile.streamAvailable, true, "STREAM still available on mobile (embed)");
  assertEq(mobile.audioAvailable, false, "AUDIO unavailable when the browser cannot transcribe");
  assertEq(mobile.visualAvailable, false, "VISUAL unavailable when the browser cannot capture");
  assertEq(mobile.audioReason, AUDIO_UNSUPPORTED_REASON, "capability reason for AUDIO is not a stream reason");
  assertEq(mobile.visualReason, VISUAL_UNSUPPORTED_REASON, "capability reason for VISUAL is not a stream reason");
}

// ── Dependency classification ──────────────────────────────────────────────
function testDependencies() {
  assert(requiresStream("stream"), "STREAM is a stream panel");
  assert(requiresStream("audio"), "AUDIO requires the stream source");
  assert(requiresStream("visual"), "VISUAL requires the stream source");
  assert(!requiresStream("memory"), "MEMORY is not stream-dependent");
  assert(!requiresStream("chat"), "CHAT is not stream-dependent");
}

testNoStream();
testStreamPresent();
testCapabilityReasons();
testDependencies();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("Failures:\n" + failures.join("\n"));
  process.exit(1);
} else {
  console.log("All Core Panel Availability tests passed!");
}
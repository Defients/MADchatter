/**
 * Focused test harness for multi-bot toggle persistence.
 * Run: npx tsx src/store.multibot.test.ts
 *
 * Verifies that disabling and re-enabling multi-bot preserves the bot roster.
 * The store module uses `localStorage` (persist middleware + legacy session
 * keys) — shimmed here with an in-memory Map before import.
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

const { useAppStore } = await import("./store");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const s = () => useAppStore.getState();

// ─── Scenario 1: first-time enable seeds a single primary bot ────────────
console.log("\n[1] First-time enable");
s().enableMultiBot();
check("multiBotEnabled=true", s().multiBotEnabled === true);
check("exactly 1 bot seeded", s().bots.length === 1);
check("bot labeled Primary", s().bots[0].label === "Primary");
check("activeBotId = primary id", s().activeBotId === s().bots[0].id);
const primaryId = s().bots[0].id;

// ─── Scenario 2: add secondary bots, then disable — roster preserved ─────
console.log("\n[2] Disable preserves roster");
const botB = s().addBot({ label: "Bot B", platform: "twitch", active: true });
const botC = s().addBot({ label: "Bot C", platform: "kick", active: false });
s().updateBotPersona(botB, { botIdentityStory: "B's custom identity" });
s().setBotSession(botB, { accessToken: "tok-b", username: "bot_b", userId: "u-b" });
s().setManualSendBotId(botB);
check("3 bots configured", s().bots.length === 3);
check("manualSendBotId = botB", s().manualSendBotId === botB);

s().disableMultiBot();
check("multiBotEnabled=false", s().multiBotEnabled === false);
check("roster NOT wiped — 3 bots remain", s().bots.length === 3, `got ${s().bots.length}`);
check("bot ids preserved", s().bots.some(b => b.id === botB) && s().bots.some(b => b.id === botC));
check("botB persona preserved", s().bots.find(b => b.id === botB)?.persona.botIdentityStory === "B's custom identity");
check("botB session preserved", s().bots.find(b => b.id === botB)?.session?.username === "bot_b");
check("activeBotId preserved", s().activeBotId === primaryId);
check("manualSendBotId preserved", s().manualSendBotId === botB);

// ─── Scenario 3: re-enable restores the same roster ──────────────────────
console.log("\n[3] Re-enable restores roster");
s().enableMultiBot();
check("multiBotEnabled=true", s().multiBotEnabled === true);
check("3 bots restored (no wipe+reseed)", s().bots.length === 3, `got ${s().bots.length}`);
check("primary id stable (not regenerated)", s().bots[0].id === primaryId);
check("botB restored with persona", s().bots.find(b => b.id === botB)?.persona.botIdentityStory === "B's custom identity");
check("botB session intact", s().bots.find(b => b.id === botB)?.session?.accessToken === "tok-b");
check("botC still inactive", s().bots.find(b => b.id === botC)?.active === false);
check("activeBotId still primary", s().activeBotId === primaryId);
check("manualSendBotId still botB", s().manualSendBotId === botB);

// ─── Scenario 4: global state changes while disabled flow back to primary ─
console.log("\n[4] Global edits while disabled sync to primary on re-enable");
s().disableMultiBot();
useAppStore.setState({ longTermMemory: "learned while disabled" });
s().enableMultiBot();
check("primary picked up global LTM", s().bots[0].runtime.longTermMemory === "learned while disabled");

// ─── Scenario 5: disable syncs primary back to global (regression) ────────
console.log("\n[5] Disable still syncs primary → global");
useAppStore.setState((state) => ({
  bots: state.bots.map((b, i) => i === 0
    ? { ...b, runtime: { ...b.runtime, longTermMemory: "primary learned X" } }
    : b),
}));
s().disableMultiBot();
check("global LTM received primary's data", s().longTermMemory === "primary learned X");
check("roster still intact after sync-back", s().bots.length === 3);

// ─── Scenario 6: stale selection ids are sanitized on re-enable ──────────
console.log("\n[6] Stale ids sanitized on re-enable");
s().enableMultiBot();
useAppStore.setState({ activeBotId: "ghost-id", manualSendBotId: "ghost-id-2" });
s().disableMultiBot();
s().enableMultiBot();
check("stale activeBotId → primary", s().activeBotId === primaryId, `got ${s().activeBotId}`);
check("stale manualSendBotId → null", s().manualSendBotId === null);

// ─── Scenario 7: double-enable is a no-op ────────────────────────────────
console.log("\n[7] Idempotent enable");
const rosterRef = s().bots;
s().enableMultiBot();
check("second enable no-op (same array)", s().bots === rosterRef);

// ─── Summary ────────────────────────────────────────────────────────────
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);

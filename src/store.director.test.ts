/**
 * Regression tests for the shared decision-delivery detection helper
 * (isDecisionPayloadSent) used by the desktop AutoForge HUD and the mobile
 * CORE decision Send button, plus the mobile Director 3-active-note cap.
 * Run: npx tsx src/store.director.test.ts
 *
 * The store module uses `localStorage` (persist middleware) — shimmed here
 * with an in-memory Map before import, mirroring store.learning.test.ts.
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
(globalThis as any).window = globalThis;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const { isDecisionPayloadSent } = await import("./lib/autoForgeCore");
const { useAppStore, MOBILE_DIRECTOR_NOTE_LIMIT } = await import("./store");

// ─── isDecisionPayloadSent ──────────────────────────────────────────────────
const sent = [{ message: "that play was insane" }, { message: "  PogChamp  " }];
check("empty payload is never 'sent'", isDecisionPayloadSent("", sent) === false && isDecisionPayloadSent(undefined, sent) === false && isDecisionPayloadSent(null, sent) === false);
check("exact payload match is detected", isDecisionPayloadSent("that play was insane", sent) === true);
check("match is case/whitespace insensitive", isDecisionPayloadSent("  THAT PLAY WAS INSANE ", sent) === true);
check("distinct payload is not falsely 'sent'", isDecisionPayloadSent("that play was mid", sent) === false);
check("historically identical line counts as delivered (strongest available identity)", isDecisionPayloadSent("PogChamp", sent) === true);
check("no history = not sent", isDecisionPayloadSent("anything", []) === false);

// ─── Mobile Director 3-active-note cap ──────────────────────────────────────
const s = () => useAppStore.getState();
s().clearDirectorNotes();
check("mobile limit constant is 3", MOBILE_DIRECTOR_NOTE_LIMIT === 3);
check("first mobile note succeeds", s().addDirectorNoteMobile("thought one") === null);
check("second mobile note succeeds", s().addDirectorNoteMobile("thought two") === null);
check("third mobile note succeeds", s().addDirectorNoteMobile("thought three") === null);
const blockReason = s().addDirectorNoteMobile("a fourth thought");
check("fourth mobile note is blocked with an explanation", typeof blockReason === "string" && blockReason.includes("3"), `reason=${blockReason}`);
check("blocked note was not added", s().directorNotes.filter((n) => n.expiresAt == null || n.expiresAt > Date.now()).length === 3);

// Removing one re-arms creation (remove/replace flow).
const firstNote = s().directorNotes[0];
s().removeDirectorNote(firstNote.id);
check("after removal a new note succeeds", s().addDirectorNoteMobile("replacement thought") === null);
check("active count returns to 3", s().directorNotes.filter((n) => n.expiresAt == null || n.expiresAt > Date.now()).length === 3);

// Desktop path (addDirectorNote) is never blocked by the mobile limit.
check("desktop add is not blocked", (s().addDirectorNote("desktop note"), s().directorNotes.filter((n) => n.expiresAt == null || n.expiresAt > Date.now()).length === 4));

// Reorder drives priority (P1 = highest).
s().clearDirectorNotes();
s().addDirectorNote("alpha");
s().addDirectorNote("beta");
s().addDirectorNote("gamma");
const ids = s().directorNotes.map((n) => n.id);
s().reorderDirectorNotes([ids[2], ids[0], ids[1]]);
check("reorder places notes in the given order", s().directorNotes.map((n) => n.text).join("|") === "gamma|alpha|beta");

// Timed (expired) notes stop counting as active against the mobile cap.
s().clearDirectorNotes();
s().addDirectorNote("will expire", 50);
await new Promise((r) => setTimeout(r, 70));
s().addDirectorNote("still room after expiry");
check("expired notes do not count toward the cap", s().addDirectorNoteMobile("another") === null);

console.log(`\nDirector + decision-send: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

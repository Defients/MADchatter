import assert from "node:assert/strict";
import { installOptionalUiAudioLifecycle, isOptionalUiAudioAllowed, setOptionalUiPageHiddenForTest } from "./uiAudioPolicy";
import { mobileAudioCueAllowed } from "./mobileAudioPolicy";

const visible = { visibilityState: "visible" } as Pick<Document, "visibilityState">;
const hidden = { visibilityState: "hidden" } as Pick<Document, "visibilityState">;

setOptionalUiPageHiddenForTest(false);
assert.equal(isOptionalUiAudioAllowed(visible), true, "foreground document admits optional UI audio");
assert.equal(isOptionalUiAudioAllowed(hidden), false, "hidden document suppresses optional UI audio");
setOptionalUiPageHiddenForTest(true);
assert.equal(isOptionalUiAudioAllowed(visible), false, "pagehide state suppresses callers even if visibility has not caught up");
setOptionalUiPageHiddenForTest(false);
assert.equal(isOptionalUiAudioAllowed(visible), true, "foreground restore admits only future UI events");
assert.equal(mobileAudioCueAllowed("attention_mention", false), true, "direct mention attention remains independent from SFX preference");
assert.equal(mobileAudioCueAllowed("navigation", false), false, "ordinary UI audio still requires SFX preference");

// ── Real lifecycle wiring (§16): the production listeners, not the test hook ─
{
  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  const win = new EventTarget();
  const previousDoc = (globalThis as any).document;
  const previousWin = (globalThis as any).window;
  (globalThis as any).document = doc;
  (globalThis as any).window = win;
  doc.visibilityState = "visible";
  let suspends = 0;
  let resumes = 0;
  const uninstall = installOptionalUiAudioLifecycle({
    onSuspend: () => { suspends += 1; },
    onResume: () => { resumes += 1; },
  });
  assert.equal(resumes, 1, "install in the foreground resumes the optional UI context once");
  assert.equal(suspends, 0, "install in the foreground does not suspend");

  // pagehide (locked phone / backgrounded tab): pageHidden latches + suspend.
  win.dispatchEvent(new Event("pagehide"));
  assert.equal(suspends, 1, "pagehide invokes suspension");
  assert.equal(isOptionalUiAudioAllowed(doc as any), false, "a hidden page event is rejected after pagehide even if visibility has not caught up");

  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(suspends, 2, "visibility→hidden invokes suspension");

  // Foreground restore: no queued sounds are replayed — the policy only
  // flips eligibility; a NEW foreground event is admitted.
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(resumes, 2, "visibility→visible restores eligibility without replaying missed sounds");
  win.dispatchEvent(new Event("pageshow"));
  assert.equal(resumes, 3, "pageshow re-syncs the foreground state");
  assert.equal(isOptionalUiAudioAllowed(doc as any), true, "a new foreground UI event is allowed after restore");

  // pagehide followed directly by pageshow (fast tab juggling) re-syncs.
  win.dispatchEvent(new Event("pagehide"));
  win.dispatchEvent(new Event("pageshow"));
  assert.equal(suspends, 3, "pagehide during foreground transit still suspends");
  assert.equal(resumes, 4, "pageshow after pagehide restores eligibility");
  assert.equal(isOptionalUiAudioAllowed(doc as any), true, "fast pagehide/pageshow round trip ends eligible in the foreground");

  // Teardown removes the wiring.
  uninstall();
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("pagehide"));
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(suspends, 3, "uninstall removes the lifecycle listeners");

  (globalThis as any).document = previousDoc;
  (globalThis as any).window = previousWin;
  setOptionalUiPageHiddenForTest(false);
}

console.log("12/12 optional UI audio policy scenarios passed");

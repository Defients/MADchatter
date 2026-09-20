import assert from "node:assert/strict";
import { r34lDesktopShortcutHint, r34lStateLabel } from "./r34lCopy";

assert.equal(r34lDesktopShortcutHint(true, false), null, "mobile never receives desktop shortcut copy");
assert.match(r34lDesktopShortcutHint(true, true) ?? "", /Ctrl\+click/, "desktop may retain shortcut guidance");
assert.equal(r34lDesktopShortcutHint(false, true), null, "shortcut appears only while frozen");

const off = r34lStateLabel("usable", false, true, false);
assert.match(off, /not applied or updated/, "OFF states no application or learning update");
assert.doesNotMatch(off, /continues/i, "OFF copy never claims passive learning continues");
assert.match(r34lStateLabel("usable", true, true, true), /nothing new is collected or changed/, "FROZEN is apply-only");
assert.match(r34lStateLabel("usable", true, true, false), /active/, "ON applies learned profile");

console.log("R34L OFF/FROZEN/ON copy scenarios passed");

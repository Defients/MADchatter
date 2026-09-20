import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mobilePath = fileURLToPath(new URL("../components/CoreMobileWorkspace.tsx", import.meta.url));
const visionPath = fileURLToPath(new URL("../components/VisualHistoryOverlay.tsx", import.meta.url));
const mobile = readFileSync(mobilePath, "utf8");
const vision = readFileSync(visionPath, "utf8");

assert.match(mobile, /R34lInlineDetails showDesktopShortcutHint=\{false\}/, "mobile suppresses desktop R34L shortcut hint");
assert.match(mobile, /providerSectionExpanded &&/, "provider inputs are conditionally absent when collapsed");
assert.match(mobile, /aria-expanded=\{providerSectionExpanded\}/, "provider disclosure exposes aria-expanded");
assert.match(mobile, /Previous AutoForge decision/, "mobile telemetry exposes previous navigation");
assert.match(mobile, /Next AutoForge decision/, "mobile telemetry exposes next navigation");
assert.doesNotMatch(mobile, /\(config\.lengthPreference \|\| "short"\) === lvl/, "adaptive length is not visually forced to Short");

assert.match(vision, /flex-wrap items-center gap-1\.5 mb-1 min-w-0 max-w-full overflow-hidden/, "vision status row wraps and contains overflow");
assert.match(vision, /whitespace-nowrap overflow-hidden text-ellipsis/, "vision status badges are width-safe");
assert.match(vision, /flex flex-col min-\[420px\]:flex-row/, "vision image and analysis stack at narrow widths");

console.log("Mobile component structure and overflow regressions passed");

/**
 * Prompt regression tests: the canonical stream-support-alert rule must be
 * present in every generation prompt (Forge, Refine, AutoForge) so no
 * surface drifts into host-owned gratitude behavior.
 * Run: npx tsx src/lib/prompts.test.ts
 */
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const prompts = await import("./prompts");
const rule = prompts.PLATFORM_SUPPORT_ALERTS_PROMPT;

check("the canonical rule segment exists", typeof rule === "string" && rule.length > 100);
check("rule bans thanking follows", /Never thank someone for following/i.test(rule));
check("rule bans thanking subs/gifts/cheers/raids/hosting", /resubscribing, gifting, cheering, donating, raiding, or hosting/i.test(rule));
check("rule bans 'thanks for the follow'", /thanks for the follow/i.test(rule));
check("rule bans 'welcome to the community'", /welcome to the community/i.test(rule));
check("rule permits independent conversational reactions", /independent conversational reason/i.test(rule));
check("rule covers vision-seen alerts", /Seeing a support alert on screen/i.test(rule));

for (const [name, prompt] of [
  ["FORGE_SYSTEM_PROMPT", prompts.FORGE_SYSTEM_PROMPT],
  ["REFINE_SYSTEM_PROMPT", prompts.REFINE_SYSTEM_PROMPT],
  ["AUTOFORGE_SYSTEM_PROMPT", prompts.AUTOFORGE_SYSTEM_PROMPT],
] as const) {
  check(`${name} embeds the canonical rule`, prompt.includes(rule));
  check(`${name} rule appears exactly once (no drift)`, prompt.split(rule).length === 2);
}

console.log(`\nPrompts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;

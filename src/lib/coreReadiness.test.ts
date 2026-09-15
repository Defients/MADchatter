import assert from "node:assert/strict";
import { deriveCoreReadiness, type CoreReadinessInput } from "./coreReadiness";

const ready: CoreReadinessInput = {
  channel: "example", connection: "connected", aiConfigured: true, aiAvailable: true,
  personaChosen: true, hasForgedOnce: true, hasSentMessage: true,
  hasEnabledAutoForgeOnce: false, autoForgeEnabled: false, autoForgeDryRun: false,
};
let passed = 0;
function check(name: string, changes: Partial<CoreReadinessInput>, expected: Record<string, unknown>) {
  const actual = deriveCoreReadiness({ ...ready, ...changes });
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key as keyof typeof actual], value, `${name}: ${key}`);
  passed++;
}
check("Manual-only users finish", {}, { operational: true, phase: "operational", stage: "autoforge", automationReady: false });
check("Fresh setup", { channel: "", aiConfigured: false, aiAvailable: false, personaChosen: false, hasForgedOnce: false, hasSentMessage: false }, { phase: "setup", stage: "platform", essentialReadyCount: 0 });
check("Ready for first Forge", { hasForgedOnce: false, hasSentMessage: false }, { phase: "activating", stage: "forge" });
check("Ready for first send", { hasSentMessage: false }, { stage: "send", phase: "activating" });
check("Old Forge cannot authorize missing provider", { aiConfigured: false, aiAvailable: false }, { aiReady: false, aiError: true, operational: false, phase: "operational", stage: "ai" });
check("Cooldown", { aiAvailable: false, autoForgeEnabled: true }, { aiReady: false, automationReady: false, aiError: true });
check("Disconnected", { connection: "disconnected", autoForgeEnabled: true }, { platformReady: false, platformError: true, operational: false, phase: "operational", automationReady: false });
check("Connecting is not connected", { connection: "connecting" }, { platformReady: false, operational: false, nextAction: "Reconnecting to chat" });
check("Errors preserve workspace", { connection: "error" }, { phase: "operational", platformReady: false, platformError: true });
check("Empty channel", { channel: " # " }, { platformReady: false, operational: false });
check("Automation enabled", { autoForgeEnabled: true }, { automationReady: true });
check("Dry run", { autoForgeEnabled: true, autoForgeDryRun: true }, { automationReady: false, operational: true });
check("Past automation is not active automation", { hasEnabledAutoForgeOnce: true }, { stage: "operational", automationReady: false });
check("New user cooldown", { hasForgedOnce: false, hasSentMessage: false, aiAvailable: false }, { aiError: true, phase: "setup", stage: "ai" });
check("Reconnect recovers", {}, { platformError: false, operational: true });

// Exercise credential dispatch, not a replica of it or a made-up storage key.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
} });
const { getApiKey } = await import("./keys");
values.set("autoforge_api_keys", JSON.stringify({ geminiKey: "test-only" }));
assert.equal(getApiKey("openai"), null, "An unrelated saved key cannot configure OpenAI");
assert.equal(deriveCoreReadiness({ ...ready, aiConfigured: !!getApiKey("openai"), aiAvailable: false }).aiReady, false);
passed++;
values.set("autoforge_api_keys", JSON.stringify({ customBaseUrl: "http://example/v1" }));
assert.equal(getApiKey("ollama"), null, "Ollama needs a model");
passed++;
values.set("autoforge_api_keys", JSON.stringify({ customBaseUrl: "http://example/v1", customModel: "test" }));
assert.equal(getApiKey("ollama"), "ollama-local");
passed++;
console.log(`${passed} readiness scenarios passed`);

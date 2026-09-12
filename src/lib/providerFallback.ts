import { getApiKey } from "./keys";

export interface FallbackResult {
  provider: string;
  apiKey: string;
  attempted: string[];
}

export function getFallbackChain(primaryProvider: string): string[] {
  // Only the user-selected provider is used. A stored API key alone does NOT
  // opt a provider into the fallback chain — the user picks exactly one
  // provider in the dropdown and expects only that provider to be used.
  // Silent rerouting to an unselected provider (e.g. OpenRouter just because
  // a key was pasted) causes surprising timeouts and confusing error labels.
  // Health-based cooldown still applies via getHealthyFallbackChain().
  if (!getApiKey(primaryProvider)) return [];
  return [primaryProvider];
}

export function getNextAvailableProvider(exclude: string[]): string | null {
  const all = ["gemini", "openai", "claude", "openrouter", "ollama"];
  for (const p of all) {
    if (!exclude.includes(p) && getApiKey(p)) {
      return p;
    }
  }
  return null;
}

export interface ProviderHealth {
  provider: string;
  failures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  cooldownUntil: number | null;
}

const healthMap = new Map<string, ProviderHealth>();
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

function getHealth(provider: string): ProviderHealth {
  if (!healthMap.has(provider)) {
    healthMap.set(provider, {
      provider,
      failures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      cooldownUntil: null,
    });
  }
  return healthMap.get(provider)!;
}

export function recordProviderFailure(provider: string): void {
  const health = getHealth(provider);
  health.failures++;
  health.lastFailureAt = Date.now();
  if (health.failures >= FAILURE_THRESHOLD) {
    health.cooldownUntil = Date.now() + COOLDOWN_MS;
    console.warn(`[ProviderFallback] ${provider} entering cooldown for ${COOLDOWN_MS / 1000}s after ${health.failures} failures`);
  }
}

export function recordProviderSuccess(provider: string): void {
  const health = getHealth(provider);
  health.failures = 0;
  health.lastSuccessAt = Date.now();
  health.cooldownUntil = null;
}

export function isProviderAvailable(provider: string): boolean {
  const health = getHealth(provider);
  if (health.cooldownUntil && Date.now() < health.cooldownUntil) return false;
  if (health.cooldownUntil && Date.now() >= health.cooldownUntil) {
    health.cooldownUntil = null;
    health.failures = 0;
  }
  return !!getApiKey(provider);
}

export function getHealthyFallbackChain(primaryProvider: string): string[] {
  const chain = getFallbackChain(primaryProvider);
  return chain.filter(isProviderAvailable);
}

export function getProviderHealthStatus(): ProviderHealth[] {
  const all = ["gemini", "openai", "claude", "openrouter", "ollama"];
  return all.map(getHealth);
}

// ─── D3: Provider fallback history ──────────────────────────────────────────
export interface FallbackHistoryEntry {
  timestamp: number;
  fromProvider: string;
  toProvider: string;
  reason: string;
}

const fallbackHistory: FallbackHistoryEntry[] = [];
const MAX_HISTORY = 100;

export function recordFallback(fromProvider: string, toProvider: string, reason: string): void {
  fallbackHistory.push({
    timestamp: Date.now(),
    fromProvider,
    toProvider,
    reason,
  });
  if (fallbackHistory.length > MAX_HISTORY) {
    fallbackHistory.shift();
  }
}

export function getFallbackHistory(): FallbackHistoryEntry[] {
  return [...fallbackHistory];
}

export function getFallbackCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of fallbackHistory) {
    const key = `${entry.fromProvider}→${entry.toProvider}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

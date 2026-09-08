import { getApiKey, getProviderWithKey, getKeys, hasAnyApiKey } from "./keys";

export interface FallbackResult {
  provider: string;
  apiKey: string;
  attempted: string[];
}

export function getFallbackChain(primaryProvider: string): string[] {
  const chain: string[] = [primaryProvider];
  const all = ["gemini", "openai", "claude", "openrouter"];
  for (const p of all) {
    if (p !== primaryProvider && getApiKey(p)) {
      chain.push(p);
    }
  }
  return chain;
}

export function getNextAvailableProvider(exclude: string[]): string | null {
  const all = ["gemini", "openai", "claude", "openrouter"];
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
  const all = ["gemini", "openai", "claude", "openrouter"];
  return all.map(getHealth);
}

import type { InsideJoke } from "../types";
import * as memoryStore from "./memoryStore";

export function getActiveJokes(jokes: InsideJoke[]): InsideJoke[] {
  return jokes.filter((j) => j.status === "active").sort((a, b) => b.strength - a.strength);
}

export function getFadingJokes(jokes: InsideJoke[]): InsideJoke[] {
  return jokes.filter((j) => j.status === "fading").sort((a, b) => b.strength - a.strength);
}

export function getRetiredJokes(jokes: InsideJoke[]): InsideJoke[] {
  return jokes.filter((j) => j.status === "retired").sort((a, b) => b.usageCount - a.usageCount);
}

export function scoreJokeRelevance(joke: InsideJoke, contextText: string): number {
  const lower = contextText.toLowerCase();
  const punchlineLower = joke.punchline.toLowerCase();
  const contextLower = joke.context.toLowerCase();

  let score = joke.strength * 0.4;

  // Direct punchline match in context
  if (lower.includes(punchlineLower)) {
    score += 0.4;
  }

  // Context keyword overlap
  const contextWords = joke.context.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  for (const word of contextWords) {
    if (lower.includes(word)) {
      score += 0.05;
    }
  }

  // Participant mention
  for (const participant of joke.participants) {
    if (lower.includes(participant.toLowerCase())) {
      score += 0.15;
      break;
    }
  }

  return Math.min(1.0, score);
}

export async function recordJokeUsage(jokeId: string, variationText: string): Promise<void> {
  const allJokes = await memoryStore.getAllJokes();
  const joke = allJokes.find((j) => j.id === jokeId);
  if (!joke) return;
  const updated: InsideJoke = {
    ...joke,
    usageCount: joke.usageCount + 1,
    lastUsedAt: Date.now(),
    strength: Math.min(1.0, joke.strength + 0.15),
    status: "active",
    variations: [...joke.variations, { text: variationText, timestamp: Date.now() }].slice(-20),
  };
  await memoryStore.updateJoke(updated);
}

export async function retireJoke(jokeId: string): Promise<void> {
  const allJokes = await memoryStore.getAllJokes();
  const joke = allJokes.find((j) => j.id === jokeId);
  if (!joke) return;
  await memoryStore.updateJoke({ ...joke, status: "retired" });
}

export async function boostJokeStrength(jokeId: string): Promise<void> {
  const allJokes = await memoryStore.getAllJokes();
  const joke = allJokes.find((j) => j.id === jokeId);
  if (!joke) return;
  await memoryStore.updateJoke({
    ...joke,
    strength: Math.min(1.0, joke.strength + 0.2),
    lastUsedAt: Date.now(),
  });
}

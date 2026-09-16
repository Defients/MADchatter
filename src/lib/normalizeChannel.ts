/**
 * Pure channel-name normalization ("#Channel" → "channel").
 *
 * Lives in its own leaf module because several pure modules (coreAutoCheck,
 * channelLearning, …) need it, while sessionScope.ts — the original home —
 * imports the store. Importing normalizeSessionChannel from sessionScope made
 * store.ts → coreAutoCheck.ts → sessionScope.ts → store.ts a circular module
 * graph, crashing any entry point that loaded coreAutoCheck before store.
 * Keep this module import-free.
 */
export function normalizeSessionChannel(channel: string): string {
  return channel.trim().replace(/^#/, "").toLowerCase();
}

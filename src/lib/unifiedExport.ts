import type { PinnedMemory, AutoForgeEvent, AutoMemory, UserProfile, InsideJoke, PersonalityState } from "../types";
import { listAllSnapshots, saveChannelSnapshot, type ChannelSnapshot } from "./channelStore";
import { exportAllData, importAllData, listChannels, clearAllMemoryData } from "./memoryStore";

export const UNIFIED_EXPORT_VERSION = 1;
export const UNIFIED_EXPORT_FORMAT = "madchatter-unified-export";

export interface ChannelExportEntry {
  channel: string;
  ltm: {
    longTermMemory: string;
    pinnedMemories: PinnedMemory[];
    goldenMemoryId: string | null;
  };
  autoForgeEvents: AutoForgeEvent[];
  autoMemory: {
    memories: AutoMemory[];
    profiles: UserProfile[];
    jokes: InsideJoke[];
    personality: PersonalityState | undefined;
  };
}

export interface UnifiedExportFile {
  format: typeof UNIFIED_EXPORT_FORMAT;
  version: typeof UNIFIED_EXPORT_VERSION;
  exportedAt: string;
  exportedBy: string;
  channels: ChannelExportEntry[];
}

/** Build a unified export file containing all (or specified) channels' data. */
export async function buildUnifiedExport(channels?: string[]): Promise<UnifiedExportFile> {
  // Gather all known channels from both stores
  const [snapshotChannels, memoryChannels] = await Promise.all([
    listAllSnapshots(),
    listChannels(),
  ]);
  const allChannels = new Set<string>();
  for (const s of snapshotChannels) allChannels.add(s.channel);
  for (const c of memoryChannels) allChannels.add(c);
  for (const c of channels || []) allChannels.add(c.toLowerCase());

  const entries: ChannelExportEntry[] = [];
  for (const channel of [...allChannels].sort()) {
    // LTM + AutoForge events from channelStore
    const snapshot = snapshotChannels.find((s) => s.channel === channel);
    // Auto-memory from memoryStore
    const autoMemory = await exportAllData(channel);

    entries.push({
      channel,
      ltm: {
        longTermMemory: snapshot?.longTermMemory ?? "",
        pinnedMemories: snapshot?.pinnedMemories ?? [],
        goldenMemoryId: snapshot?.goldenMemoryId ?? null,
      },
      autoForgeEvents: snapshot?.autoForgeEvents ?? [],
      autoMemory,
    });
  }

  return {
    format: UNIFIED_EXPORT_FORMAT,
    version: UNIFIED_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: "MADchatter",
    channels: entries,
  };
}

/** Build a unified export file for a single channel. */
export async function buildSingleChannelExport(channel: string): Promise<UnifiedExportFile> {
  return buildUnifiedExport([channel]);
}

/** Trigger a browser download of the unified export file. */
export function downloadUnifiedExport(file: UnifiedExportFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `madchatter-export-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export type ParseResult = { ok: true; file: UnifiedExportFile } | { ok: false; error: string };

/** Validate and parse a unified export file. Fails safe on any malformation. */
export function parseUnifiedExport(json: string): ParseResult {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }

  if (data.format !== UNIFIED_EXPORT_FORMAT) {
    return { ok: false, error: `Unknown format "${data.format}". Expected "${UNIFIED_EXPORT_FORMAT}".` };
  }
  if (data.version !== UNIFIED_EXPORT_VERSION) {
    return { ok: false, error: `Unsupported version ${data.version}. Expected version ${UNIFIED_EXPORT_VERSION}.` };
  }
  if (!Array.isArray(data.channels)) {
    return { ok: false, error: "Missing or invalid 'channels' array." };
  }

  for (let i = 0; i < data.channels.length; i++) {
    const entry = data.channels[i];
    if (!entry || typeof entry.channel !== "string") {
      return { ok: false, error: `Channel entry ${i} is missing a 'channel' string.` };
    }
    if (typeof entry.ltm !== "object" || entry.ltm === null) {
      return { ok: false, error: `Channel "${entry.channel}" has invalid 'ltm' data.` };
    }
    if (typeof entry.ltm.longTermMemory !== "string") {
      return { ok: false, error: `Channel "${entry.channel}" ltm.longTermMemory must be a string.` };
    }
    if (!Array.isArray(entry.ltm.pinnedMemories)) {
      return { ok: false, error: `Channel "${entry.channel}" ltm.pinnedMemories must be an array.` };
    }
    if (entry.ltm.goldenMemoryId !== null && typeof entry.ltm.goldenMemoryId !== "string") {
      return { ok: false, error: `Channel "${entry.channel}" ltm.goldenMemoryId must be a string or null.` };
    }
    if (!Array.isArray(entry.autoForgeEvents)) {
      return { ok: false, error: `Channel "${entry.channel}" autoForgeEvents must be an array.` };
    }
    if (typeof entry.autoMemory !== "object" || entry.autoMemory === null) {
      return { ok: false, error: `Channel "${entry.channel}" has invalid 'autoMemory' data.` };
    }
  }

  return { ok: true, file: data as UnifiedExportFile };
}

export interface ApplyResult {
  channelsRestored: number;
  errors: string[];
}

/**
 * Apply a unified export file: write each channel's data to the correct stores.
 * Does NOT auto-activate any channel — caller must restore live if desired.
 */
export async function applyUnifiedExport(file: UnifiedExportFile): Promise<ApplyResult> {
  const errors: string[] = [];
  let channelsRestored = 0;

  for (const entry of file.channels) {
    try {
      // Write LTM + AutoForge events to channelStore
      await saveChannelSnapshot(entry.channel, {
        longTermMemory: entry.ltm.longTermMemory,
        pinnedMemories: entry.ltm.pinnedMemories,
        goldenMemoryId: entry.ltm.goldenMemoryId,
        autoForgeEvents: entry.autoForgeEvents,
      });

      // Write auto-memory to memoryStore (channel-scoped)
      await importAllData(entry.channel, entry.autoMemory);

      channelsRestored++;
    } catch (e) {
      errors.push(`Channel "${entry.channel}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { channelsRestored, errors };
}

/** Convenience: get all known channels from both stores (for the Streamer Data UI). */
export async function listAllKnownChannels(): Promise<string[]> {
  const [snapshotChannels, memoryChannels] = await Promise.all([
    listAllSnapshots(),
    listChannels(),
  ]);
  const all = new Set<string>();
  for (const s of snapshotChannels) all.add(s.channel);
  for (const c of memoryChannels) all.add(c);
  return [...all].sort();
}

/** Delete all data for a channel from both stores. */
export async function deleteAllChannelData(channel: string): Promise<void> {
  const { deleteChannelSnapshot } = await import("./channelStore");
  await Promise.all([
    deleteChannelSnapshot(channel),
    clearAllMemoryData(channel),
  ]);
}

import { useAppStore } from "../store";
import * as memoryStore from "./memoryStore";

export interface ChannelExportWorthwhile {
  autoForgeReport: boolean;
  autoMemory: boolean;
  longTermMemory: boolean;
}

export interface ChannelExportResult {
  autoForgeReport: boolean;
  autoMemory: boolean;
  longTermMemory: boolean;
}

/**
 * Compute which of the three channel data sources are "worthwhile" to export
 * before a channel switch. The overlay uses this to decide whether to show
 * and which sources to offer.
 *
 * - AutoForge Report: ≥5 merged events (global + per-bot runtime events).
 *   Below 5 is just startup noise.
 * - Auto-Memory: any IndexedDB data (memories, profiles, jokes, or personality).
 * - Long-Term Memory: non-empty longTermMemory string or any pinned memories.
 */
export function computeChannelExportWorthwhile(): ChannelExportWorthwhile {
  const state = useAppStore.getState();
  const totalAutoForgeEvents =
    state.autoForgeEventLog.length +
    state.bots.reduce((sum, b) => sum + b.runtime.autoForgeEvents.length, 0);
  const autoForgeReport = totalAutoForgeEvents >= 5;
  const autoMemory =
    state.autoMemories.length > 0 ||
    state.userProfiles.length > 0 ||
    state.insideJokes.length > 0;
  const longTermMemory =
    state.longTermMemory.trim().length > 0 || state.pinnedMemories.length > 0;
  return { autoForgeReport, autoMemory, longTermMemory };
}

function triggerDownload(filename: string, data: string): void {
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Export one or more of the three channel data sources as separate JSON files.
 * Downloads are staggered (~250ms) so browsers don't block consecutive
 * downloads. The channel name is included in the filename for traceability.
 *
 * Returns a result map indicating which files were actually downloaded.
 * Sources that are worthwhile=false are skipped (result flag stays false).
 */
export async function exportChannelData(opts: {
  includeAutoForgeReport: boolean;
  includeAutoMemory: boolean;
  includeLongTermMemory: boolean;
  channelName: string;
}): Promise<ChannelExportResult> {
  const result: ChannelExportResult = {
    autoForgeReport: false,
    autoMemory: false,
    longTermMemory: false,
  };
  const safeChannel = opts.channelName.replace(/[^a-z0-9_-]/gi, "_") || "channel";
  const stamp = Date.now();

  // 1. AutoForge Report — merge global + per-bot events (mirrors AutoForgeReport.tsx)
  if (opts.includeAutoForgeReport) {
    const state = useAppStore.getState();
    const global = state.autoForgeEventLog.map((e) => ({
      ...e,
      botName: undefined as string | undefined,
    }));
    const perBot = state.bots.flatMap((b) =>
      b.runtime.autoForgeEvents.map((e) => ({ ...e, botName: b.session?.username })),
    );
    const merged = [...global, ...perBot].sort((a, b) => a.timestamp - b.timestamp);
    if (merged.length > 0) {
      triggerDownload(
        `autoforge-report-${safeChannel}-${stamp}.json`,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            channel: opts.channelName,
            eventCount: merged.length,
            events: merged,
          },
          null,
          2,
        ),
      );
      result.autoForgeReport = true;
      await delay(250);
    }
  }

  // 2. Auto-Memory — IndexedDB export (memories, profiles, jokes, personality)
  if (opts.includeAutoMemory) {
    try {
      const data = await memoryStore.exportAllData();
      const hasData =
        (data.memories?.length ?? 0) > 0 ||
        (data.profiles?.length ?? 0) > 0 ||
        (data.jokes?.length ?? 0) > 0 ||
        data.personality !== undefined;
      if (hasData) {
        triggerDownload(
          `madchatter-auto-memory-${safeChannel}-${stamp}.json`,
          JSON.stringify(
            { exportedAt: new Date().toISOString(), channel: opts.channelName, ...data },
            null,
            2,
          ),
        );
        result.autoMemory = true;
        await delay(250);
      }
    } catch (e) {
      console.warn("[exportChannelData] Auto-Memory export failed:", e);
    }
  }

  // 3. Long-Term Memory — longTermMemory string + pinnedMemories + goldenMemoryId
  if (opts.includeLongTermMemory) {
    const state = useAppStore.getState();
    const hasLtm = state.longTermMemory.trim().length > 0 || state.pinnedMemories.length > 0;
    if (hasLtm) {
      triggerDownload(
        `madchatter-memories-${safeChannel}-${stamp}.json`,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            channel: opts.channelName,
            longTermMemory: state.longTermMemory,
            pinnedMemories: state.pinnedMemories,
            goldenMemoryId: state.goldenMemoryId,
          },
          null,
          2,
        ),
      );
      result.longTermMemory = true;
    }
  }

  return result;
}

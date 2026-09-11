import { useState, useEffect, useCallback, useMemo } from "react";
import type { ChangeEvent } from "react";
import {
  Brain,
  Trash2,
  Download,
  Upload,
  Users,
  Laugh,
  Sparkles,
  TrendingUp,
  X,
  ChevronDown,
  ChevronUp,
  Pencil,
  CheckSquare,
  Square,
  Zap,
  Package,
  HardDrive,
} from "lucide-react";
import { useAppStore } from "../store";
import * as memoryStore from "../lib/memoryStore";
import { runDecayCycle } from "../lib/memoryEngine";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import type { AutoMemory } from "../types";
import { ThemedTooltip } from "./ui/tooltip";
import {
  buildUnifiedExport,
  downloadUnifiedExport,
  parseUnifiedExport,
  applyUnifiedExport,
  buildSingleChannelExport,
  listAllKnownChannels,
  deleteAllChannelData,
} from "../lib/unifiedExport";
import { listAllSnapshots } from "../lib/channelStore";

export function MemoryPanel() {
  const {
    memoryPanelOpen,
    setMemoryPanelOpen,
    autoMemories,
    userProfiles,
    insideJokes,
    personalityState,
    autoMemoryConfig,
    updateAutoMemoryConfig,
    setAutoMemories,
    setUserProfiles,
    setInsideJokes,
    removeAutoMemory,
    removeInsideJoke,
    removeUserProfile,
    updateAutoMemory,
    addAutoMemory,
    streamMetadata,
  } = useAppStore();

  const channel = (streamMetadata?.channelName || "default").toLowerCase();

  const [activeTab, setActiveTab] = useState<"memories" | "profiles" | "jokes" | "personality">("memories");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editStrength, setEditStrength] = useState(0.5);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newMemory, setNewMemory] = useState<{ type: AutoMemory["type"]; subject: AutoMemory["subject"]; content: string; tags: string }>({
    type: "fact",
    subject: "streamer",
    content: "",
    tags: "",
  });

  // C8: Batch memory operations
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showStats, setShowStats] = useState(false);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(autoMemories.map((m) => m.id)));
  }, [autoMemories]);

  const deselectAll = useCallback(() => setSelectedIds(new Set()), []);

  const bulkDelete = useCallback(() => {
    for (const id of selectedIds) {
      removeAutoMemory(id);
    }
    toast.success(`Deleted ${selectedIds.size} memories`);
    setSelectedIds(new Set());
  }, [selectedIds, removeAutoMemory]);

  const bulkStrengthen = useCallback(() => {
    for (const id of selectedIds) {
      const mem = autoMemories.find((m) => m.id === id);
      if (mem) {
        updateAutoMemory(id, { strength: Math.min(1, mem.strength + 0.2) });
      }
    }
    toast.success(`Strengthened ${selectedIds.size} memories`);
    setSelectedIds(new Set());
  }, [selectedIds, autoMemories, updateAutoMemory]);

  // A5: Memory effectiveness stats
  const memStats = useMemo(() => {
    if (autoMemories.length === 0) return null;
    const total = autoMemories.length;
    const totalRefs = autoMemories.reduce((s, m) => s + m.referenceCount, 0);
    const avgStrength = autoMemories.reduce((s, m) => s + m.strength, 0) / total;
    const mostReferenced = [...autoMemories].sort((a, b) => b.referenceCount - a.referenceCount).slice(0, 3);
    const strongest = [...autoMemories].sort((a, b) => b.strength - a.strength).slice(0, 3);
    const dead = autoMemories.filter((m) => m.referenceCount === 0 && m.strength < 0.3);
    const fading = autoMemories.filter((m) => m.strength < 0.3 && m.strength >= 0.15);
    const byType: Record<string, number> = {};
    for (const m of autoMemories) byType[m.type] = (byType[m.type] || 0) + 1;
    return { total, totalRefs, avgStrength, mostReferenced, strongest, dead: dead.length, fading: fading.length, byType };
  }, [autoMemories]);

  const handleClearAll = useCallback(async () => {
    await memoryStore.clearAllMemoryData(channel);
    setAutoMemories([]);
    setUserProfiles([]);
    setInsideJokes([]);
    toast.success(`Auto-memory data cleared for @${channel}`);
  }, [channel, setAutoMemories, setUserProfiles, setInsideJokes]);

  const handleExport = useCallback(async () => {
    const data = await memoryStore.exportAllData(channel);
    const file = {
      format: "madchatter-auto-memory",
      version: 1,
      channel,
      exportedAt: new Date().toISOString(),
      ...data,
    };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `madchatter-auto-memory-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Auto-memory data exported");
  }, [channel]);

  const handleImport = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          // Strip the header fields before passing to importAllData
          const payload = {
            memories: data.memories,
            profiles: data.profiles,
            jokes: data.jokes,
            personality: data.personality,
          };
          await memoryStore.importAllData(channel, payload);
          const [memories, profiles, jokes] = await Promise.all([
            memoryStore.getAllMemories(channel),
            memoryStore.getAllProfiles(channel),
            memoryStore.getAllJokes(channel),
          ]);
          setAutoMemories(memories);
          setUserProfiles(profiles);
          setInsideJokes(jokes);
          toast.success("Auto-memory data imported");
        } catch {
          toast.error("Failed to parse memory file");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [channel, setAutoMemories, setUserProfiles, setInsideJokes],
  );

  const handleRunDecay = useCallback(async () => {
    await runDecayCycle(autoMemoryConfig, channel);
    const [memories, jokes] = await Promise.all([
      memoryStore.getAllMemories(channel),
      memoryStore.getAllJokes(channel),
    ]);
    setAutoMemories(memories);
    setInsideJokes(jokes);
    toast.success("Decay cycle run complete");
  }, [autoMemoryConfig, channel, setAutoMemories, setInsideJokes]);

  // ── Export All / Import All (unified format) ─────────────────────
  const handleExportAll = useCallback(async () => {
    try {
      const file = await buildUnifiedExport();
      downloadUnifiedExport(file);
      toast.success(`Exported ${file.channels.length} channel${file.channels.length !== 1 ? "s" : ""}`);
    } catch (e) {
      toast.error("Failed to build unified export");
      console.error(e);
    }
  }, []);

  const handleImportAll = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const text = ev.target?.result as string;
        const parsed = parseUnifiedExport(text);
        if (!parsed.ok) {
          const errMsg = "error" in parsed ? parsed.error : "Unknown error";
          toast.error(`Import failed: ${errMsg}`);
          return;
        }
        const file = parsed.file;
        try {
          const result = await applyUnifiedExport(file);
          if (result.errors.length > 0) {
            toast.warning(`Restored ${result.channelsRestored} channels with ${result.errors.length} errors`);
          } else {
            toast.success(`Restored ${result.channelsRestored} channel${result.channelsRestored !== 1 ? "s" : ""}`);
          }
          // Reload active channel's data if it was in the file
          if (file.channels.some((c) => c.channel === channel)) {
            const [memories, profiles, jokes] = await Promise.all([
              memoryStore.getAllMemories(channel),
              memoryStore.getAllProfiles(channel),
              memoryStore.getAllJokes(channel),
            ]);
            setAutoMemories(memories);
            setUserProfiles(profiles);
            setInsideJokes(jokes);
          }
          // Refresh streamer list
          refreshStreamerData();
        } catch (e) {
          toast.error("Failed to apply unified import");
          console.error(e);
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [channel, setAutoMemories, setUserProfiles, setInsideJokes],
  );

  // ── Streamer Data section ───────────────────────────────────────
  const [showStreamerData, setShowStreamerData] = useState(false);
  const [streamerList, setStreamerList] = useState<{ channel: string; updatedAt: number | null }[]>([]);

  const refreshStreamerData = useCallback(async () => {
    try {
      const [snapshots, memoryChannels] = await Promise.all([
        listAllSnapshots(),
        memoryStore.listChannels(),
      ]);
      const map = new Map<string, number | null>();
      for (const s of snapshots) map.set(s.channel, s.updatedAt);
      for (const c of memoryChannels) if (!map.has(c)) map.set(c, null);
      const list = [...map.entries()]
        .map(([ch, updatedAt]) => ({ channel: ch, updatedAt }))
        .sort((a, b) => a.channel.localeCompare(b.channel));
      setStreamerList(list);
    } catch (e) {
      console.error("[MemoryPanel] Failed to list streamer data:", e);
    }
  }, []);

  useEffect(() => {
    if (memoryPanelOpen) refreshStreamerData();
  }, [memoryPanelOpen, refreshStreamerData]);

  const handleExportChannel = useCallback(async (ch: string) => {
    try {
      const file = await buildSingleChannelExport(ch);
      downloadUnifiedExport(file);
      toast.success(`Exported @${ch}`);
    } catch (e) {
      toast.error(`Failed to export @${ch}`);
      console.error(e);
    }
  }, []);

  const handleDeleteChannel = useCallback(async (ch: string) => {
    if (!confirm(`Delete all persisted data for @${ch}? This cannot be undone.`)) return;
    try {
      await deleteAllChannelData(ch);
      toast.success(`Deleted data for @${ch}`);
      refreshStreamerData();
    } catch (e) {
      toast.error(`Failed to delete @${ch}`);
      console.error(e);
    }
  }, [refreshStreamerData]);

  // B1: Memory editing
  const startEdit = useCallback((mem: AutoMemory) => {
    setEditingId(mem.id);
    setEditContent(mem.content);
    setEditTags(mem.tags.join(", "));
    setEditStrength(mem.strength);
    setExpandedId(mem.id);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditContent("");
    setEditTags("");
    setEditStrength(0.5);
  }, []);

  const saveEdit = useCallback((id: string) => {
    const tags = editTags.split(",").map(t => t.trim()).filter(Boolean);
    updateAutoMemory(id, {
      content: editContent,
      tags,
      strength: Math.max(0, Math.min(1, editStrength)),
    });
    setEditingId(null);
    toast.success("Memory updated");
  }, [editContent, editTags, editStrength, updateAutoMemory]);

  // B2: Manual memory creation
  const handleCreateMemory = useCallback(() => {
    if (!newMemory.content.trim()) {
      toast.error("Content is required");
      return;
    }
    const tags = newMemory.tags.split(",").map(t => t.trim()).filter(Boolean);
    const mem: AutoMemory = {
      id: `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: newMemory.type,
      subject: newMemory.subject,
      content: newMemory.content.trim(),
      context: "Manually created",
      source: "inferred",
      confidence: 1.0,
      createdAt: Date.now(),
      lastReferencedAt: Date.now(),
      referenceCount: 0,
      strength: 0.7,
      tags,
      isVerified: true,
    };
    addAutoMemory(mem);
    setNewMemory({ type: "fact", subject: "streamer", content: "", tags: "" });
    setIsAddingNew(false);
    toast.success("Memory created");
  }, [newMemory, addAutoMemory]);

  if (!memoryPanelOpen) return null;

  return (
    <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMemoryPanelOpen(false)}>
      <div
        className="relative w-full max-w-3xl max-h-[85vh] bg-[#0F0F1A] border border-purple-500/30 rounded-2xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-purple-400" />
            <h2 className="text-sm font-bold text-white">Auto-Memory System</h2>
            <span className="text-[10px] text-gray-500 ml-2">
              {autoMemories.length} memories · {userProfiles.length} profiles · {insideJokes.length} jokes
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemedTooltip content="Export All (unified)">
              <button
                onClick={handleExportAll}
                className="p-1.5 rounded-lg text-gray-400 hover:text-purple-400 hover:bg-purple-500/10 transition-colors"
              >
                <Package className="w-4 h-4" />
              </button>
            </ThemedTooltip>
            <ThemedTooltip content="Import All (unified)">
              <label className="cursor-pointer p-1.5 rounded-lg text-gray-400 hover:text-purple-400 hover:bg-purple-500/10 transition-colors">
                <Package className="w-4 h-4 rotate-180" />
                <input type="file" accept=".json" className="hidden" onChange={handleImportAll} />
              </label>
            </ThemedTooltip>
            <div className="w-px h-5 bg-white/10" />
            <ThemedTooltip content="Export (this channel)">
              <button
                onClick={handleExport}
                className="p-1.5 rounded-lg text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
              >
                <Download className="w-4 h-4" />
              </button>
            </ThemedTooltip>
            <ThemedTooltip content="Import (this channel)">
              <label className="cursor-pointer p-1.5 rounded-lg text-gray-400 hover:text-green-400 hover:bg-green-500/10 transition-colors">
                <Upload className="w-4 h-4" />
                <input type="file" accept=".json" className="hidden" onChange={handleImport} />
              </label>
            </ThemedTooltip>
            <ThemedTooltip content="Run decay cycle">
              <button
                onClick={handleRunDecay}
                className="p-1.5 rounded-lg text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 transition-colors"
              >
                <TrendingUp className="w-4 h-4" />
              </button>
            </ThemedTooltip>
            <ThemedTooltip content="Clear all (this channel)">
              <button
                onClick={handleClearAll}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </ThemedTooltip>
            <button
              onClick={() => setMemoryPanelOpen(false)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Streamer Data section */}
        <div className="border-b border-white/5">
          <button
            onClick={() => setShowStreamerData(!showStreamerData)}
            className="flex items-center justify-between w-full px-4 py-2 text-[10px] font-bold uppercase tracking-wider text-gray-400 hover:text-gray-200"
          >
            <span className="flex items-center gap-1.5">
              <HardDrive className="w-3 h-3" />
              Streamer Data · {streamerList.length} persisted
            </span>
            <ChevronDown className={cn("w-3 h-3 transition-transform", showStreamerData && "rotate-180")} />
          </button>
          {showStreamerData && (
            <div className="max-h-40 overflow-y-auto px-4 pb-2 space-y-1">
              {streamerList.length === 0 && (
                <div className="text-[10px] text-gray-600 py-2">No persisted streamers yet.</div>
              )}
              {streamerList.map((row) => (
                <div
                  key={row.channel}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 rounded-lg text-[10px]",
                    row.channel === channel ? "bg-purple-500/10 border border-purple-500/30" : "bg-white/5",
                  )}
                >
                  <span className={cn("font-bold", row.channel === channel ? "text-purple-300" : "text-gray-300")}>
                    @{row.channel}
                  </span>
                  {row.channel === channel && <span className="text-[9px] text-purple-400">(active)</span>}
                  <span className="text-gray-600 ml-1">
                    {row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "no snapshot"}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      onClick={() => handleExportChannel(row.channel)}
                      className="p-1 rounded text-gray-500 hover:text-blue-400 hover:bg-blue-500/10"
                    >
                      <Download className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDeleteChannel(row.channel)}
                      className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Enable toggle */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-white/5">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMemoryConfig.enabled}
              onChange={(e) => updateAutoMemoryConfig({ enabled: e.target.checked })}
              className="w-4 h-4 accent-purple-500"
            />
            <span className="text-xs text-gray-300">Auto-Memory Enabled</span>
          </label>
          {personalityState && (
            <div className="flex items-center gap-2 ml-auto text-[10px] text-gray-500">
              <span>Mood: <span className="text-purple-400 font-bold">{personalityState.mood}</span></span>
              <span>Comfort: <span className="text-purple-400 font-bold">{Math.round(personalityState.comfortLevel)}/100</span></span>
              <span>Session: <span className="text-purple-400 font-bold">{personalityState.sessionCount}</span></span>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-4 py-2 border-b border-white/5">
          {([
            { id: "memories", label: "Memories", icon: Sparkles, count: autoMemories.length },
            { id: "profiles", label: "Profiles", icon: Users, count: userProfiles.length },
            { id: "jokes", label: "Inside Jokes", icon: Laugh, count: insideJokes.length },
            { id: "personality", label: "Personality", icon: Brain, count: null },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors",
                activeTab === tab.id
                  ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/5",
              )}
            >
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
              {tab.count !== null && <span className="text-[9px] opacity-60">({tab.count})</span>}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === "memories" && (
            <div className="space-y-1.5">
              {/* A5: Memory Effectiveness Stats */}
              {memStats && (
                <div className="border border-purple-500/20 rounded-lg p-2.5 bg-purple-500/5 space-y-2">
                  <button
                    onClick={() => setShowStats(!showStats)}
                    className="flex items-center justify-between w-full text-[10px] font-bold uppercase tracking-wider text-purple-300"
                  >
                    <span className="flex items-center gap-1.5">
                      <Brain className="w-3 h-3" />
                      Memory Health · {memStats.total} memories · avg strength {(memStats.avgStrength * 100).toFixed(0)}%
                    </span>
                    <ChevronDown className={cn("w-3 h-3 transition-transform", showStats && "rotate-180")} />
                  </button>
                  {showStats && (
                    <div className="space-y-1.5 text-[10px]">
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="p-1.5 bg-black/30 rounded">
                          <div className="text-sm font-bold text-purple-300 tabular-nums">{memStats.totalRefs}</div>
                          <div className="text-[9px] text-gray-500">total refs</div>
                        </div>
                        <div className="p-1.5 bg-black/30 rounded">
                          <div className={cn("text-sm font-bold tabular-nums", memStats.dead > 0 ? "text-red-400" : "text-green-400")}>{memStats.dead}</div>
                          <div className="text-[9px] text-gray-500">dead memories</div>
                        </div>
                        <div className="p-1.5 bg-black/30 rounded">
                          <div className={cn("text-sm font-bold tabular-nums", memStats.fading > 0 ? "text-yellow-400" : "text-green-400")}>{memStats.fading}</div>
                          <div className="text-[9px] text-gray-500">fading</div>
                        </div>
                      </div>
                      {memStats.mostReferenced[0]?.referenceCount > 0 && (
                        <div>
                          <span className="text-gray-500 uppercase font-bold">Top Referenced:</span>
                          {memStats.mostReferenced.map((m) => (
                            <div key={m.id} className="text-gray-400 truncate pl-2">
                              <span className="text-purple-400 font-mono">{m.referenceCount}x</span> {m.content.slice(0, 60)}
                            </div>
                          ))}
                        </div>
                      )}
                      <div>
                        <span className="text-gray-500 uppercase font-bold">By Type:</span>
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {Object.entries(memStats.byType).map(([type, count]) => (
                            <span key={type} className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-gray-400 font-mono">
                              {type}: {count}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* C8: Batch operations toolbar */}
              {selectedIds.size > 0 && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-orange-500/10 border border-orange-500/30">
                  <span className="text-[10px] text-orange-300 font-bold">{selectedIds.size} selected</span>
                  <button onClick={bulkStrengthen} className="text-[10px] px-2 py-1 rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 flex items-center gap-1">
                    <Zap className="w-3 h-3" /> Strengthen
                  </button>
                  <button onClick={bulkDelete} className="text-[10px] px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 flex items-center gap-1">
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                  <button onClick={deselectAll} className="text-[10px] text-gray-400 hover:text-white ml-auto">cancel</button>
                </div>
              )}

              {/* C8: Select all toggle */}
              {autoMemories.length > 0 && !isAddingNew && selectedIds.size === 0 && (
                <button
                  onClick={selectAll}
                  className="text-[9px] text-gray-500 hover:text-purple-400 flex items-center gap-1 px-1"
                >
                  <CheckSquare className="w-3 h-3" /> Select all
                </button>
              )}

              {/* B2: New Memory button */}
              {!isAddingNew && (
                <button
                  onClick={() => setIsAddingNew(true)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-dashed border-purple-500/30 text-purple-400 hover:bg-purple-500/10 hover:border-purple-500/50 transition-colors text-xs font-bold"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  New Memory
                </button>
              )}
              {/* B2: New Memory form */}
              {isAddingNew && (
                <div className="border border-purple-500/30 rounded-lg p-3 space-y-2 bg-purple-500/5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-purple-300">Create New Memory</span>
                    <button onClick={() => setIsAddingNew(false)} className="text-gray-500 hover:text-gray-300">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={newMemory.type}
                      onChange={(e) => setNewMemory({ ...newMemory, type: e.target.value as AutoMemory["type"] })}
                      className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200"
                    >
                      {["fact", "trait", "story", "event", "preference", "opinion", "milestone"].map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                    <select
                      value={newMemory.subject}
                      onChange={(e) => setNewMemory({ ...newMemory, subject: e.target.value as AutoMemory["subject"] })}
                      className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200"
                    >
                      {["streamer", "chatter", "chat_general", "bot_self"].map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </div>
                  <textarea
                    value={newMemory.content}
                    onChange={(e) => setNewMemory({ ...newMemory, content: e.target.value })}
                    placeholder="Memory content..."
                    className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-200 resize-none"
                    rows={2}
                  />
                  <input
                    value={newMemory.tags}
                    onChange={(e) => setNewMemory({ ...newMemory, tags: e.target.value })}
                    placeholder="tags (comma-separated)"
                    className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200"
                  />
                  <button
                    onClick={handleCreateMemory}
                    className="w-full py-1.5 rounded bg-purple-500/30 text-purple-200 hover:bg-purple-500/40 text-xs font-bold transition-colors"
                  >
                    Create Memory
                  </button>
                </div>
              )}
              {autoMemories.length === 0 && !isAddingNew ? (
                <EmptyState icon={Sparkles} label="No memories yet." hint="They'll form automatically as the bot watches chat." />
              ) : (
                [...autoMemories]
                  .sort((a, b) => b.strength - a.strength)
                  .map((mem) => {
                    const isExpanded = expandedId === mem.id;
                    const isSelected = selectedIds.has(mem.id);
                    return (
                      <div
                        key={mem.id}
                        className={cn(
                          "group border rounded-lg p-2.5 transition-colors",
                          isSelected ? "border-orange-500/50 bg-orange-500/5" : "border-white/5 hover:border-purple-500/20"
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <ThemedTooltip content={isSelected ? "Deselect" : "Select"}>
                            <button
                              onClick={() => toggleSelect(mem.id)}
                              className="mt-0.5 shrink-0 text-gray-500 hover:text-orange-400"
                            >
                              {isSelected ? <CheckSquare className="w-3.5 h-3.5 text-orange-400" /> : <Square className="w-3.5 h-3.5" />}
                            </button>
                          </ThemedTooltip>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className={cn(
                                "text-[8px] font-bold uppercase px-1.5 py-0.5 rounded",
                                mem.type === "fact" && "bg-blue-500/20 text-blue-400",
                                mem.type === "trait" && "bg-green-500/20 text-green-400",
                                mem.type === "story" && "bg-purple-500/20 text-purple-400",
                                mem.type === "event" && "bg-orange-500/20 text-orange-400",
                                mem.type === "preference" && "bg-pink-500/20 text-pink-400",
                                mem.type === "opinion" && "bg-yellow-500/20 text-yellow-400",
                                mem.type === "milestone" && "bg-red-500/20 text-red-400",
                              )}>
                                {mem.type}
                              </span>
                              {mem.subjectUsername && (
                                <span className="text-[9px] text-teal-400 font-bold">@{mem.subjectUsername}</span>
                              )}
                              {mem.isVerified && (
                                <span className="text-[8px] text-green-500">✓ verified</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-200 leading-snug">{mem.content}</p>
                            {isExpanded && editingId !== mem.id && (
                              <div className="mt-1.5 space-y-1 text-[10px] text-gray-500">
                                <p><span className="text-gray-400">Context:</span> {mem.context}</p>
                                <p><span className="text-gray-400">Tags:</span> {mem.tags.join(", ") || "none"}</p>
                                <p><span className="text-gray-400">Source:</span> {mem.source} · <span className="text-gray-400">Confidence:</span> {mem.confidence.toFixed(2)} · <span className="text-gray-400">Refs:</span> {mem.referenceCount}</p>
                                <p><span className="text-gray-400">Created:</span> {new Date(mem.createdAt).toLocaleString()}</p>
                              </div>
                            )}
                            {isExpanded && editingId === mem.id && (
                              <div className="mt-1.5 space-y-1.5">
                                <textarea
                                  value={editContent}
                                  onChange={(e) => setEditContent(e.target.value)}
                                  className="w-full bg-black/40 border border-purple-500/30 rounded px-2 py-1 text-xs text-gray-200 resize-none"
                                  rows={2}
                                />
                                <input
                                  value={editTags}
                                  onChange={(e) => setEditTags(e.target.value)}
                                  placeholder="tags (comma-separated)"
                                  className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-gray-200"
                                />
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-gray-500">Strength:</span>
                                  <input
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={editStrength}
                                    onChange={(e) => setEditStrength(Number(e.target.value))}
                                    className="flex-1"
                                  />
                                  <span className="text-[10px] text-gray-400 font-mono">{(editStrength * 100).toFixed(0)}%</span>
                                </div>
                                <div className="flex gap-1.5">
                                  <button
                                    onClick={() => saveEdit(mem.id)}
                                    className="px-2 py-1 rounded bg-purple-500/30 text-purple-200 hover:bg-purple-500/40 text-[10px] font-bold"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={cancelEdit}
                                    className="px-2 py-1 rounded bg-white/5 text-gray-400 hover:bg-white/10 text-[10px]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-purple-500 rounded-full transition-all"
                                style={{ width: `${Math.round(mem.strength * 100)}%` }}
                              />
                            </div>
                            <span className="text-[8px] text-gray-600">{(mem.strength * 100).toFixed(0)}%</span>
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={() => setExpandedId(isExpanded ? null : mem.id)}
                                className="p-0.5 rounded text-gray-500 hover:text-gray-300"
                              >
                                {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              </button>
                              <ThemedTooltip content="Edit memory">
                                <button
                                  onClick={() => startEdit(mem)}
                                  className="p-0.5 rounded text-gray-500 hover:text-purple-400"
                                >
                                  <Pencil className="w-3 h-3" />
                                </button>
                              </ThemedTooltip>
                              <button
                                onClick={() => removeAutoMemory(mem.id)}
                                className="p-0.5 rounded text-gray-500 hover:text-red-400"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>
          )}

          {activeTab === "profiles" && (
            <div className="space-y-1.5">
              {userProfiles.length === 0 ? (
                <EmptyState icon={Users} label="No user profiles yet." hint="They'll build as the bot interacts with chatters." />
              ) : (
                [...userProfiles]
                  .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
                  .map((profile) => (
                    <div key={profile.username} className="group border border-white/5 rounded-lg p-2.5 hover:border-teal-500/20 transition-colors">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-teal-400 text-xs">@{profile.username}</span>
                        <span className={cn(
                          "text-[8px] font-bold uppercase px-1.5 py-0.5 rounded",
                          profile.relationship === "friend" && "bg-green-500/20 text-green-400",
                          profile.relationship === "regular" && "bg-blue-500/20 text-blue-400",
                          profile.relationship === "acquaintance" && "bg-yellow-500/20 text-yellow-400",
                          profile.relationship === "stranger" && "bg-gray-500/20 text-gray-400",
                          profile.relationship === "inner_circle" && "bg-purple-500/20 text-purple-400",
                        )}>
                          {profile.relationship}
                        </span>
                        {profile.isVIP && <span className="text-[8px] text-yellow-400">VIP</span>}
                        <div className="ml-auto flex items-center gap-1.5">
                          <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-teal-500 rounded-full" style={{ width: `${Math.round(profile.rapportScore)}%` }} />
                          </div>
                          <button
                            onClick={() => removeUserProfile(profile.username)}
                            className="p-0.5 rounded text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      {profile.traits.length > 0 && (
                        <p className="text-[10px] text-gray-500 mt-1">Traits: {profile.traits.join(", ")}</p>
                      )}
                      {profile.interests.length > 0 && (
                        <p className="text-[10px] text-gray-500">Interests: {profile.interests.join(", ")}</p>
                      )}
                      {profile.knownFacts.length > 0 && (
                        <p className="text-[10px] text-gray-500">Facts: {profile.knownFacts.slice(0, 3).join("; ")}</p>
                      )}
                      <p className="text-[8px] text-gray-600 mt-1">
                        {profile.totalMessages} msgs · Last seen: {new Date(profile.lastSeenAt).toLocaleDateString()}
                      </p>
                    </div>
                  ))
              )}
            </div>
          )}

          {activeTab === "jokes" && (
            <div className="space-y-1.5">
              {insideJokes.length === 0 ? (
                <EmptyState icon={Laugh} label="No inside jokes yet." hint="They'll emerge as the bot finds patterns in chat." />
              ) : (
                [...insideJokes]
                  .sort((a, b) => b.strength - a.strength)
                  .map((joke) => (
                    <div key={joke.id} className="group border border-white/5 rounded-lg p-2.5 hover:border-orange-500/20 transition-colors">
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className={cn(
                              "text-[8px] font-bold uppercase px-1.5 py-0.5 rounded",
                              joke.status === "active" && "bg-green-500/20 text-green-400",
                              joke.status === "fading" && "bg-yellow-500/20 text-yellow-400",
                              joke.status === "retired" && "bg-gray-500/20 text-gray-500",
                            )}>
                              {joke.status}
                            </span>
                            <span className="text-[9px] text-gray-500">Used {joke.usageCount}x</span>
                          </div>
                          <p className="text-xs text-orange-300 font-bold leading-snug">"{joke.punchline}"</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">{joke.context}</p>
                          <p className="text-[8px] text-gray-600 mt-0.5">
                            Origin: {joke.origin} · Participants: {joke.participants.join(", ")}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-orange-500 rounded-full" style={{ width: `${Math.round(joke.strength * 100)}%` }} />
                          </div>
                          <button
                            onClick={() => removeInsideJoke(joke.id)}
                            className="p-0.5 rounded text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
              )}
            </div>
          )}

          {activeTab === "personality" && (
            <div className="space-y-3">
              {personalityState ? (
                <>
                  <div className="border border-white/5 rounded-lg p-3">
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <Stat label="Mood" value={personalityState.mood} color="text-purple-400" />
                      <Stat label="Comfort Level" value={`${Math.round(personalityState.comfortLevel)}/100`} color="text-teal-400" />
                      <Stat label="Session Count" value={String(personalityState.sessionCount)} color="text-blue-400" />
                      <Stat label="Total Messages Sent" value={String(personalityState.totalMessagesSent)} color="text-orange-400" />
                      <Stat label="Memories Formed (Session)" value={String(personalityState.sessionMemoriesFormed)} color="text-green-400" />
                      <Stat label="Jokes Created (Session)" value={String(personalityState.sessionJokesCreated)} color="text-pink-400" />
                    </div>
                  </div>
                  {personalityState.dominantTraits.length > 0 && (
                    <div className="border border-white/5 rounded-lg p-3">
                      <p className="text-[10px] text-gray-500 mb-1.5 uppercase font-bold">Dominant Traits</p>
                      <div className="flex flex-wrap gap-1.5">
                        {personalityState.dominantTraits.map((trait) => (
                          <span key={trait} className="text-[10px] px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/20">
                            {trait}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {personalityState.relationshipProgression.length > 0 && (
                    <div className="border border-white/5 rounded-lg p-3">
                      <p className="text-[10px] text-gray-500 mb-1.5 uppercase font-bold">Relationship Milestones</p>
                      <div className="space-y-1">
                        {personalityState.relationshipProgression.slice(-10).map((milestone, i) => (
                          <div key={i} className="text-[10px] text-gray-400">
                            <span className="text-gray-600">{new Date(milestone.timestamp).toLocaleDateString()}</span>
                            {" — "}
                            <span className="text-purple-400 font-bold">{milestone.stage}</span>
                            {milestone.note && <span className="text-gray-500">: {milestone.note}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <EmptyState icon={Brain} label="Personality state not initialized. Enable auto-memory to start." />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, label, hint }: { icon: any; label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      <Icon className="w-8 h-8 text-purple-500/20" />
      <div className="flex flex-col items-center gap-1 max-w-xs">
        <span className="text-[11px] text-gray-600 italic text-center">{label}</span>
        {hint && <span className="text-[10px] text-gray-700 text-center leading-snug whitespace-nowrap">{hint}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <p className="text-[9px] text-gray-500 uppercase font-bold">{label}</p>
      <p className={cn("text-sm font-bold", color)}>{value}</p>
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";
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
} from "lucide-react";
import { useAppStore } from "../store";
import * as memoryStore from "../lib/memoryStore";
import { runDecayCycle } from "../lib/memoryEngine";
import { toast } from "sonner";
import { cn } from "../lib/utils";

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
  } = useAppStore();

  const [activeTab, setActiveTab] = useState<"memories" | "profiles" | "jokes" | "personality">("memories");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleClearAll = useCallback(async () => {
    await memoryStore.clearAllMemoryData();
    setAutoMemories([]);
    setUserProfiles([]);
    setInsideJokes([]);
    toast.success("All auto-memory data cleared");
  }, [setAutoMemories, setUserProfiles, setInsideJokes]);

  const handleExport = useCallback(async () => {
    const data = await memoryStore.exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `madchatter-auto-memory-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Auto-memory data exported");
  }, []);

  const handleImport = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          await memoryStore.importAllData(data);
          const [memories, profiles, jokes] = await Promise.all([
            memoryStore.getAllMemories(),
            memoryStore.getAllProfiles(),
            memoryStore.getAllJokes(),
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
    [setAutoMemories, setUserProfiles, setInsideJokes],
  );

  const handleRunDecay = useCallback(async () => {
    await runDecayCycle(autoMemoryConfig);
    const [memories, jokes] = await Promise.all([
      memoryStore.getAllMemories(),
      memoryStore.getAllJokes(),
    ]);
    setAutoMemories(memories);
    setInsideJokes(jokes);
    toast.success("Decay cycle run complete");
  }, [autoMemoryConfig, setAutoMemories, setInsideJokes]);

  if (!memoryPanelOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMemoryPanelOpen(false)}>
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
            <button
              onClick={handleExport}
              className="p-1.5 rounded-lg text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors"
              title="Export"
            >
              <Download className="w-4 h-4" />
            </button>
            <label className="cursor-pointer p-1.5 rounded-lg text-gray-400 hover:text-green-400 hover:bg-green-500/10 transition-colors" title="Import">
              <Upload className="w-4 h-4" />
              <input type="file" accept=".json" className="hidden" onChange={handleImport} />
            </label>
            <button
              onClick={handleRunDecay}
              className="p-1.5 rounded-lg text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 transition-colors"
              title="Run decay cycle"
            >
              <TrendingUp className="w-4 h-4" />
            </button>
            <button
              onClick={handleClearAll}
              className="p-1.5 rounded-lg text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              title="Clear all"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => setMemoryPanelOpen(false)}
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
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
              {autoMemories.length === 0 ? (
                <EmptyState icon={Sparkles} label="No memories yet. They'll form automatically as the bot watches chat." />
              ) : (
                [...autoMemories]
                  .sort((a, b) => b.strength - a.strength)
                  .map((mem) => {
                    const isExpanded = expandedId === mem.id;
                    return (
                      <div
                        key={mem.id}
                        className="group border border-white/5 rounded-lg p-2.5 hover:border-purple-500/20 transition-colors"
                      >
                        <div className="flex items-start gap-2">
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
                            {isExpanded && (
                              <div className="mt-1.5 space-y-1 text-[10px] text-gray-500">
                                <p><span className="text-gray-400">Context:</span> {mem.context}</p>
                                <p><span className="text-gray-400">Tags:</span> {mem.tags.join(", ") || "none"}</p>
                                <p><span className="text-gray-400">Source:</span> {mem.source} · <span className="text-gray-400">Confidence:</span> {mem.confidence.toFixed(2)} · <span className="text-gray-400">Refs:</span> {mem.referenceCount}</p>
                                <p><span className="text-gray-400">Created:</span> {new Date(mem.createdAt).toLocaleString()}</p>
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
                <EmptyState icon={Users} label="No user profiles yet. They'll build as the bot interacts with chatters." />
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
                <EmptyState icon={Laugh} label="No inside jokes yet. They'll emerge as the bot finds patterns in chat." />
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

function EmptyState({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      <Icon className="w-8 h-8 text-purple-500/20" />
      <span className="text-[11px] text-gray-600 italic text-center max-w-xs">{label}</span>
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

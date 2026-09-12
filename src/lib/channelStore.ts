import type {
  PinnedMemory,
  AutoForgeEvent,
  SessionStats,
  EnhancedSessionStats,
  ActionHistoryEntry,
  SentimentReading,
  SentimentSummary,
  ActionAccuracyEntry,
  SentMessage,
  DecisionLogEntry,
  SessionGoal,
  GoalEvaluationResult,
  StreamHealthScore,
  ChatActivityBucket,
  ChatterStats,
  TokenFeatureKey,
  FeatureTokenStats,
  AutoMemory,
  UserProfile,
  InsideJoke,
  PersonalityState,
} from "../types";
import type { AutoForgeDecision } from "./ai";

const DB_NAME = "madchatter-channels";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

/** Per-bot session-scoped runtime state, archived per channel so a bot's
 *  recent context is fresh on switch and restored on switch-back. */
export interface BotSessionSnapshot {
  botId: string;
  sentMessages: SentMessage[];
  actionHistory: ActionHistoryEntry[];
  decisionLog: DecisionLogEntry[];
  sessionStats: SessionStats;
  enhancedStats: EnhancedSessionStats;
  sentimentHistory: SentimentReading[];
  sentimentSummary: SentimentSummary | null;
  actionAccuracy: ActionAccuracyEntry[];
  autoForgeEvents: AutoForgeEvent[];
  lastAutoForgeDecision: AutoForgeDecision | null;
  autoForgeDecisionHistory: AutoForgeDecision[];
  // Channel-derived memory injected into per-bot prompts — archived so the
  // bot's brain for this channel survives a switch-away/switch-back.
  longTermMemory: string;
  pinnedMemories: PinnedMemory[];
  goldenMemoryId: string | null;
  autoMemories: AutoMemory[];
  userProfiles: UserProfile[];
  insideJokes: InsideJoke[];
  personalityState: PersonalityState | null;
}

export interface ChannelSnapshot {
  channel: string;
  updatedAt: number;
  // Long-Term Memory (Zustand-sourced)
  longTermMemory: string;
  pinnedMemories: PinnedMemory[];
  goldenMemoryId: string | null;
  // AutoForge Report (Zustand-sourced, merged global + per-bot)
  autoForgeEvents: AutoForgeEvent[];
  // Session analytics + recent context — all optional so snapshots written
  // before these fields existed still load (missing = fresh start).
  sessionStats?: SessionStats;
  enhancedStats?: EnhancedSessionStats;
  actionHistory?: ActionHistoryEntry[];
  sentimentHistory?: SentimentReading[];
  sentimentSummary?: SentimentSummary | null;
  actionAccuracy?: ActionAccuracyEntry[];
  sentMessages?: SentMessage[];
  decisionLog?: DecisionLogEntry[];
  sessionGoals?: SessionGoal[];
  goalEvaluationResults?: GoalEvaluationResult[];
  streamHealth?: StreamHealthScore | null;
  chatActivityBuckets?: ChatActivityBucket[];
  chatterStats?: Record<string, ChatterStats>;
  tokenUsageByFeature?: Record<TokenFeatureKey, FeatureTokenStats>;
  lastAutoForgeDecision?: AutoForgeDecision | null;
  autoForgeDecisionHistory?: AutoForgeDecision[];
  botSessions?: BotSessionSnapshot[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "channel" });
      }
    };
  });
  return dbPromise;
}

export async function saveChannelSnapshot(
  channel: string,
  snapshot: Omit<ChannelSnapshot, "channel" | "updatedAt">,
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put({ ...snapshot, channel: channel.toLowerCase(), updatedAt: Date.now() });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function loadChannelSnapshot(channel: string): Promise<ChannelSnapshot | null> {
  const db = await openDB();
  return new Promise<ChannelSnapshot | null>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(channel.toLowerCase());
    request.onsuccess = () => resolve((request.result as ChannelSnapshot) || null);
    request.onerror = () => reject(request.error);
  });
}

export async function listChannelSnapshots(): Promise<string[]> {
  const db = await openDB();
  return new Promise<string[]>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onsuccess = () => resolve((request.result as string[]).sort());
    request.onerror = () => reject(request.error);
  });
}

export async function deleteChannelSnapshot(channel: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete(channel.toLowerCase());
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** List all snapshots with their full data (for the Streamer Data UI + unified export). */
export async function listAllSnapshots(): Promise<ChannelSnapshot[]> {
  const db = await openDB();
  return new Promise<ChannelSnapshot[]>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result as ChannelSnapshot[]) || []);
    request.onerror = () => reject(request.error);
  });
}

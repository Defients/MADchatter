import type { AutoMemory, UserProfile, InsideJoke, PersonalityState } from "../types";

const DB_NAME = "madchatter-memory";
const DB_VERSION = 2;

const STORES = {
  memories: "memories",
  profiles: "profiles",
  jokes: "jokes",
  personality: "personality",
  extractionLog: "extractionLog",
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = (event.target as IDBOpenDBRequest).transaction!;
      const fallbackChannel = "default";

      // ── memories: add channel index, backfill existing records ──
      if (!db.objectStoreNames.contains(STORES.memories)) {
        const store = db.createObjectStore(STORES.memories, { keyPath: "id" });
        store.createIndex("channel", "channel", { unique: false });
      } else {
        const store = tx.objectStore(STORES.memories);
        if (!store.indexNames.contains("channel")) {
          store.createIndex("channel", "channel", { unique: false });
        }
        // Backfill channel on existing records that lack it
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const rec = cursor.value as AutoMemory;
            if (rec.channel === undefined) {
              cursor.update({ ...rec, channel: fallbackChannel });
            }
            cursor.continue();
          }
        };
      }

      // ── profiles: recreate with composite keyPath [channel, username] ──
      // The old store used keyPath "username" which collides across channels.
      // Read existing data, delete, recreate with composite key, re-insert.
      if (!db.objectStoreNames.contains(STORES.profiles)) {
        const store = db.createObjectStore(STORES.profiles, { keyPath: ["channel", "username"] });
        store.createIndex("channel", "channel", { unique: false });
      } else {
        const oldStore = tx.objectStore(STORES.profiles);
        const getAllReq = oldStore.getAll();
        getAllReq.onsuccess = () => {
          const existing = (getAllReq.result || []) as UserProfile[];
          db.deleteObjectStore(STORES.profiles);
          const newStore = db.createObjectStore(STORES.profiles, { keyPath: ["channel", "username"] });
          newStore.createIndex("channel", "channel", { unique: false });
          for (const p of existing) {
            newStore.put({ ...p, channel: fallbackChannel });
          }
        };
      }

      // ── jokes: add channel index, backfill existing records ──
      if (!db.objectStoreNames.contains(STORES.jokes)) {
        const store = db.createObjectStore(STORES.jokes, { keyPath: "id" });
        store.createIndex("channel", "channel", { unique: false });
      } else {
        const store = tx.objectStore(STORES.jokes);
        if (!store.indexNames.contains("channel")) {
          store.createIndex("channel", "channel", { unique: false });
        }
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const rec = cursor.value as InsideJoke;
            if (rec.channel === undefined) {
              cursor.update({ ...rec, channel: fallbackChannel });
            }
            cursor.continue();
          }
        };
      }

      // ── personality: out-of-line keys, migrate "current" → "default" ──
      if (!db.objectStoreNames.contains(STORES.personality)) {
        db.createObjectStore(STORES.personality);
      } else {
        const store = tx.objectStore(STORES.personality);
        const getReq = store.get("current");
        getReq.onsuccess = () => {
          if (getReq.result) {
            store.put(getReq.result, fallbackChannel);
            store.delete("current");
          }
        };
      }

      // ── extractionLog: add channel index, backfill existing records ──
      if (!db.objectStoreNames.contains(STORES.extractionLog)) {
        const store = db.createObjectStore(STORES.extractionLog, { keyPath: "id" });
        store.createIndex("channel", "channel", { unique: false });
      } else {
        const store = tx.objectStore(STORES.extractionLog);
        if (!store.indexNames.contains("channel")) {
          store.createIndex("channel", "channel", { unique: false });
        }
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const rec = cursor.value as ExtractionLogEntry;
            if (rec.channel === undefined) {
              cursor.update({ ...rec, channel: fallbackChannel });
            }
            cursor.continue();
          }
        };
      }
    };
  });
  return dbPromise;
}

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = fn(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

function txAll<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T[]>): Promise<T[]> {
  return tx(storeName, mode, fn) as Promise<T[]>;
}

/** Get all records from a store scoped by channel (via the channel index). */
function getAllByChannel<T>(storeName: string, channel: string): Promise<T[]> {
  return openDB().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const index = store.index("channel");
        const request = index.getAll(channel);
        request.onsuccess = () => resolve(request.result as T[]);
        request.onerror = () => reject(request.error);
      }),
  );
}

/** Delete all records matching a channel from a store (via channel index cursor). */
function clearByChannel(storeName: string, channel: string): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const index = store.index("channel");
        const request = index.openCursor(channel);
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      }),
  );
}

// ─── Memories ───────────────────────────────────────────────────

export async function getAllMemories(channel: string): Promise<AutoMemory[]> {
  return getAllByChannel<AutoMemory>(STORES.memories, channel);
}

export async function addMemory(channel: string, memory: AutoMemory): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.put({ ...memory, channel }));
}

export async function addMemories(channel: string, memories: AutoMemory[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.memories, "readwrite");
    const store = transaction.objectStore(STORES.memories);
    for (const m of memories) store.put({ ...m, channel });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function updateMemory(channel: string, memory: AutoMemory): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.put({ ...memory, channel }));
}

export async function deleteMemory(channel: string, id: string): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.delete(id));
}

export async function clearMemories(channel: string): Promise<void> {
  await clearByChannel(STORES.memories, channel);
}

// ─── Profiles ───────────────────────────────────────────────────

export async function getAllProfiles(channel: string): Promise<UserProfile[]> {
  return getAllByChannel<UserProfile>(STORES.profiles, channel);
}

export async function getProfile(channel: string, username: string): Promise<UserProfile | undefined> {
  return openDB().then(
    (db) =>
      new Promise<UserProfile | undefined>((resolve, reject) => {
        const transaction = db.transaction(STORES.profiles, "readonly");
        const store = transaction.objectStore(STORES.profiles);
        // Composite keyPath [channel, username] → lookup by array key
        const request = store.get([channel, username]);
        request.onsuccess = () => resolve(request.result as UserProfile | undefined);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function upsertProfile(channel: string, profile: UserProfile): Promise<void> {
  await tx(STORES.profiles, "readwrite", (store) => store.put({ ...profile, channel }));
}

export async function upsertProfiles(channel: string, profiles: UserProfile[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.profiles, "readwrite");
    const store = transaction.objectStore(STORES.profiles);
    for (const p of profiles) store.put({ ...p, channel });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteProfile(channel: string, username: string): Promise<void> {
  await tx(STORES.profiles, "readwrite", (store) => store.delete([channel, username]));
}

export async function clearProfiles(channel: string): Promise<void> {
  await clearByChannel(STORES.profiles, channel);
}

// ─── Jokes ──────────────────────────────────────────────────────

export async function getAllJokes(channel: string): Promise<InsideJoke[]> {
  return getAllByChannel<InsideJoke>(STORES.jokes, channel);
}

export async function addJoke(channel: string, joke: InsideJoke): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.put({ ...joke, channel }));
}

export async function addJokes(channel: string, jokes: InsideJoke[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.jokes, "readwrite");
    const store = transaction.objectStore(STORES.jokes);
    for (const j of jokes) store.put({ ...j, channel });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function updateJoke(channel: string, joke: InsideJoke): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.put({ ...joke, channel }));
}

export async function deleteJoke(channel: string, id: string): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.delete(id));
}

export async function clearJokes(channel: string): Promise<void> {
  await clearByChannel(STORES.jokes, channel);
}

// ─── Personality ────────────────────────────────────────────────

export async function getPersonality(channel: string): Promise<PersonalityState | undefined> {
  return tx(STORES.personality, "readonly", (store) => store.get(channel) as IDBRequest<PersonalityState | undefined>);
}

export async function savePersonality(channel: string, state: PersonalityState): Promise<void> {
  await tx(STORES.personality, "readwrite", (store) => store.put(state, channel));
}

// ─── Extraction Log ─────────────────────────────────────────────

export interface ExtractionLogEntry {
  id: string;
  channel: string;
  timestamp: number;
  summary: string;
  memoriesFormed: number;
  profilesUpdated: number;
  jokesCreated: number;
}

export async function addExtractionLog(channel: string, entry: Omit<ExtractionLogEntry, "channel">): Promise<void> {
  await tx(STORES.extractionLog, "readwrite", (store) => store.put({ ...entry, channel }));
}

export async function getExtractionLog(channel: string): Promise<ExtractionLogEntry[]> {
  return getAllByChannel<ExtractionLogEntry>(STORES.extractionLog, channel);
}

// ─── Bulk Export / Import (channel-scoped) ──────────────────────

export interface AutoMemoryData {
  memories: AutoMemory[];
  profiles: UserProfile[];
  jokes: InsideJoke[];
  personality: PersonalityState | undefined;
}

export async function exportAllData(channel: string): Promise<AutoMemoryData> {
  const [memories, profiles, jokes, personality] = await Promise.all([
    getAllMemories(channel),
    getAllProfiles(channel),
    getAllJokes(channel),
    getPersonality(channel),
  ]);
  return { memories, profiles, jokes, personality };
}

export async function importAllData(channel: string, data: Partial<AutoMemoryData>): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [STORES.memories, STORES.profiles, STORES.jokes, STORES.personality],
      "readwrite",
    );
    if (data.memories) {
      const store = transaction.objectStore(STORES.memories);
      for (const m of data.memories) store.put({ ...m, channel });
    }
    if (data.profiles) {
      const store = transaction.objectStore(STORES.profiles);
      for (const p of data.profiles) store.put({ ...p, channel });
    }
    if (data.jokes) {
      const store = transaction.objectStore(STORES.jokes);
      for (const j of data.jokes) store.put({ ...j, channel });
    }
    if (data.personality) {
      transaction.objectStore(STORES.personality).put(data.personality, channel);
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Clear all auto-memory data for a specific channel. If channel is omitted, clears ALL channels. */
export async function clearAllMemoryData(channel?: string): Promise<void> {
  const db = await openDB();
  if (channel) {
    await Promise.all([
      clearByChannel(STORES.memories, channel),
      clearByChannel(STORES.profiles, channel),
      clearByChannel(STORES.jokes, channel),
      // personality: delete by key
      tx(STORES.personality, "readwrite", (store) => store.delete(channel)),
      clearByChannel(STORES.extractionLog, channel),
    ]);
  } else {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(
        [STORES.memories, STORES.profiles, STORES.jokes, STORES.personality, STORES.extractionLog],
        "readwrite",
      );
      transaction.objectStore(STORES.memories).clear();
      transaction.objectStore(STORES.profiles).clear();
      transaction.objectStore(STORES.jokes).clear();
      transaction.objectStore(STORES.personality).clear();
      transaction.objectStore(STORES.extractionLog).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

/** List all unique channel names that have any auto-memory data. */
export async function listChannels(): Promise<string[]> {
  const db = await openDB();
  const channels = new Set<string>();
  const storeNames = [STORES.memories, STORES.profiles, STORES.jokes, STORES.personality, STORES.extractionLog];
  await Promise.all(
    storeNames.map(
      (storeName) =>
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(storeName, "readonly");
          const store = transaction.objectStore(storeName);
          // personality uses out-of-line keys (channel names), others use channel index
          if (storeName === STORES.personality) {
            const req = store.openKeyCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                channels.add(cursor.key as string);
                cursor.continue();
              }
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          } else {
            const index = store.index("channel");
            const req = index.openKeyCursor();
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor) {
                channels.add(cursor.key as string);
                cursor.continue();
              }
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          }
        }),
    ),
  );
  return [...channels].sort();
}

/** Export auto-memory data for ALL channels (for unified export). */
export async function exportAllChannelsData(): Promise<Record<string, AutoMemoryData>> {
  const channels = await listChannels();
  const result: Record<string, AutoMemoryData> = {};
  for (const channel of channels) {
    result[channel] = await exportAllData(channel);
  }
  return result;
}

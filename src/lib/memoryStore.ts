import type { AutoMemory, UserProfile, InsideJoke, PersonalityState } from "../types";

const DB_NAME = "madchatter-memory";
const DB_VERSION = 1;

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
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.memories)) {
        db.createObjectStore(STORES.memories, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.profiles)) {
        db.createObjectStore(STORES.profiles, { keyPath: "username" });
      }
      if (!db.objectStoreNames.contains(STORES.jokes)) {
        db.createObjectStore(STORES.jokes, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.personality)) {
        db.createObjectStore(STORES.personality);
      }
      if (!db.objectStoreNames.contains(STORES.extractionLog)) {
        db.createObjectStore(STORES.extractionLog, { keyPath: "id" });
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

// ─── Memories ───────────────────────────────────────────────────

export async function getAllMemories(): Promise<AutoMemory[]> {
  return txAll(STORES.memories, "readonly", (store) => store.getAll() as IDBRequest<AutoMemory[]>);
}

export async function addMemory(memory: AutoMemory): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.put(memory));
}

export async function addMemories(memories: AutoMemory[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.memories, "readwrite");
    const store = transaction.objectStore(STORES.memories);
    for (const m of memories) store.put(m);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function updateMemory(memory: AutoMemory): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.put(memory));
}

export async function deleteMemory(id: string): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.delete(id));
}

export async function clearMemories(): Promise<void> {
  await tx(STORES.memories, "readwrite", (store) => store.clear());
}

// ─── Profiles ───────────────────────────────────────────────────

export async function getAllProfiles(): Promise<UserProfile[]> {
  return txAll(STORES.profiles, "readonly", (store) => store.getAll() as IDBRequest<UserProfile[]>);
}

export async function getProfile(username: string): Promise<UserProfile | undefined> {
  return tx(STORES.profiles, "readonly", (store) => store.get(username) as IDBRequest<UserProfile | undefined>);
}

export async function upsertProfile(profile: UserProfile): Promise<void> {
  await tx(STORES.profiles, "readwrite", (store) => store.put(profile));
}

export async function upsertProfiles(profiles: UserProfile[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.profiles, "readwrite");
    const store = transaction.objectStore(STORES.profiles);
    for (const p of profiles) store.put(p);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteProfile(username: string): Promise<void> {
  await tx(STORES.profiles, "readwrite", (store) => store.delete(username));
}

export async function clearProfiles(): Promise<void> {
  await tx(STORES.profiles, "readwrite", (store) => store.clear());
}

// ─── Jokes ──────────────────────────────────────────────────────

export async function getAllJokes(): Promise<InsideJoke[]> {
  return txAll(STORES.jokes, "readonly", (store) => store.getAll() as IDBRequest<InsideJoke[]>);
}

export async function addJoke(joke: InsideJoke): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.put(joke));
}

export async function addJokes(jokes: InsideJoke[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORES.jokes, "readwrite");
    const store = transaction.objectStore(STORES.jokes);
    for (const j of jokes) store.put(j);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function updateJoke(joke: InsideJoke): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.put(joke));
}

export async function deleteJoke(id: string): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.delete(id));
}

export async function clearJokes(): Promise<void> {
  await tx(STORES.jokes, "readwrite", (store) => store.clear());
}

// ─── Personality ────────────────────────────────────────────────

export async function getPersonality(): Promise<PersonalityState | undefined> {
  return tx(STORES.personality, "readonly", (store) => store.get("current") as IDBRequest<PersonalityState | undefined>);
}

export async function savePersonality(state: PersonalityState): Promise<void> {
  await tx(STORES.personality, "readwrite", (store) => store.put(state, "current"));
}

// ─── Extraction Log ─────────────────────────────────────────────

export interface ExtractionLogEntry {
  id: string;
  timestamp: number;
  summary: string;
  memoriesFormed: number;
  profilesUpdated: number;
  jokesCreated: number;
}

export async function addExtractionLog(entry: ExtractionLogEntry): Promise<void> {
  await tx(STORES.extractionLog, "readwrite", (store) => store.put(entry));
}

export async function getExtractionLog(): Promise<ExtractionLogEntry[]> {
  return txAll(STORES.extractionLog, "readonly", (store) => store.getAll() as IDBRequest<ExtractionLogEntry[]>);
}

// ─── Bulk Export / Import ───────────────────────────────────────

export async function exportAllData(): Promise<{
  memories: AutoMemory[];
  profiles: UserProfile[];
  jokes: InsideJoke[];
  personality: PersonalityState | undefined;
}> {
  const [memories, profiles, jokes, personality] = await Promise.all([
    getAllMemories(),
    getAllProfiles(),
    getAllJokes(),
    getPersonality(),
  ]);
  return { memories, profiles, jokes, personality };
}

export async function importAllData(data: {
  memories?: AutoMemory[];
  profiles?: UserProfile[];
  jokes?: InsideJoke[];
  personality?: PersonalityState;
}): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [STORES.memories, STORES.profiles, STORES.jokes, STORES.personality],
      "readwrite",
    );
    if (data.memories) {
      const store = transaction.objectStore(STORES.memories);
      for (const m of data.memories) store.put(m);
    }
    if (data.profiles) {
      const store = transaction.objectStore(STORES.profiles);
      for (const p of data.profiles) store.put(p);
    }
    if (data.jokes) {
      const store = transaction.objectStore(STORES.jokes);
      for (const j of data.jokes) store.put(j);
    }
    if (data.personality) {
      transaction.objectStore(STORES.personality).put(data.personality, "current");
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function clearAllMemoryData(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [STORES.memories, STORES.profiles, STORES.jokes, STORES.personality],
      "readwrite",
    );
    transaction.objectStore(STORES.memories).clear();
    transaction.objectStore(STORES.profiles).clear();
    transaction.objectStore(STORES.jokes).clear();
    transaction.objectStore(STORES.personality).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

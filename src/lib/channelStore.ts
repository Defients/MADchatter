import type { PinnedMemory, AutoForgeEvent } from "../types";

const DB_NAME = "madchatter-channels";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";

export interface ChannelSnapshot {
  channel: string;
  updatedAt: number;
  // Long-Term Memory (Zustand-sourced)
  longTermMemory: string;
  pinnedMemories: PinnedMemory[];
  goldenMemoryId: string | null;
  // AutoForge Report (Zustand-sourced, merged global + per-bot)
  autoForgeEvents: AutoForgeEvent[];
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

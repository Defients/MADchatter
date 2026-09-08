import tmi from "tmi.js";
import { SendRateLimiter } from "./rateLimiter";

export interface TwitchSession {
  accessToken: string;
  username: string;
  userId: string;
  profileImageUrl?: string;
}

// ─── Persistent TMI Send Connection Manager ─────────────────────────────────
// Instead of connecting/disconnecting for every message, we maintain a
// singleton client that stays alive across sends. This dramatically reduces
// latency (from ~2-5s per send down to <100ms after initial connect).

class TmiSendManager {
  private client: tmi.Client | null = null;
  private connectingPromise: Promise<tmi.Client> | null = null;
  private currentChannel: string | null = null;
  private connectionState: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
  private stateListeners: Set<(state: string) => void> = new Set();

  getState() {
    return this.connectionState;
  }

  onStateChange(listener: (state: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: typeof this.connectionState) {
    this.connectionState = state;
    this.stateListeners.forEach((l) => l(state));
  }

  async getClient(channel: string): Promise<tmi.Client> {
    const session = getTwitchSession();
    if (!session) throw new Error("Not authenticated with Twitch");

    // If channel changed, tear down old connection
    if (this.currentChannel && this.currentChannel !== channel) {
      await this.disconnect();
    }

    // Already connected to the right channel
    if (this.client && this.connectionState === "connected" && this.currentChannel === channel) {
      return this.client;
    }

    // Already connecting — wait for that to finish
    if (this.connectingPromise && this.currentChannel === channel) {
      return this.connectingPromise;
    }

    // Start a new connection
    this.currentChannel = channel;
    this.setState("connecting");

    this.connectingPromise = new Promise<tmi.Client>((resolve, reject) => {
      const client = new tmi.Client({
        connection: { secure: true, reconnect: true },
        identity: {
          username: session.username,
          password: `oauth:${session.accessToken}`,
        },
        channels: [channel],
      });

      client.on("connected", () => {
        this.setState("connected");
      });

      client.on("disconnected", () => {
        this.setState("disconnected");
      });

      client.on("join", () => {
        this.setState("connected");
      });

      client.connect().then(() => {
        this.client = client;
        this.connectingPromise = null;
        resolve(client);
      }).catch((err) => {
        this.connectingPromise = null;
        this.setState("error");
        reject(err);
      });
    });

    return this.connectingPromise;
  }

  async send(channel: string, message: string): Promise<void> {
    const client = await this.getClient(channel);
    await client.say(channel, message);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }
    this.connectingPromise = null;
    this.currentChannel = null;
    this.setState("disconnected");
  }
}

export const tmiSendManager = new TmiSendManager();

// ─── Send Rate Limiter & Deduplication ──────────────────────────────────────
// Twitch enforces chat limits: 20 messages per 30 seconds for regular users,
// 100 per 30s for mods/broadcaster. We use a sliding-window token bucket to
// prevent getting globally muted or banned. Also deduplicates: if the exact
// same message was sent within the last 60s, we block it.

class SendGuard extends SendRateLimiter {
  async send(channel: string, message: string): Promise<void> {
    if (message.length > 500) {
      throw new Error(`Message exceeds Twitch's 500-character limit (${message.length} chars). Trim it before sending.`);
    }

    if (this.isDuplicate(message)) {
      throw new Error("Duplicate message blocked — this exact message was sent within the last 60 seconds.");
    }

    // If rate limited, queue and wait
    if (!this.canSendNow()) {
      const waitMs = this.getWaitMs();
      console.warn(`[SendGuard] Rate limit reached, waiting ${waitMs}ms before sending...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.recordSend(message);
    await tmiSendManager.send(channel, message);
  }
}

export const sendGuard = new SendGuard();

const SESSION_KEY = "twitch_session";
const TWITCH_CLIENT_ID_KEY = "twitch_client_id";
const DEFAULT_CLIENT_ID = import.meta.env.VITE_TWITCH_CLIENT_ID || "lxk6dndt1cv90fd1v8bn5fp6yh0f90";

export function getTwitchClientId(): string {
  const stored = localStorage.getItem(TWITCH_CLIENT_ID_KEY);
  return stored !== null ? stored : DEFAULT_CLIENT_ID;
}

export function setTwitchClientId(id: string): void {
  localStorage.setItem(TWITCH_CLIENT_ID_KEY, id);
}

export function getTwitchSession(): TwitchSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.accessToken && parsed.username) {
        return parsed as TwitchSession;
      }
    }
  } catch {}
  return null;
}

export function setTwitchSession(session: TwitchSession | null): void {
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

export function buildOAuthUrl(clientId: string, redirectUri: string): string {
  const scopes = "chat:read chat:edit user:read:email";
  return `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scopes)}`;
}

export async function validateToken(accessToken: string, clientId: string): Promise<TwitchSession | null> {
  try {
    const res = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": clientId,
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data || !data.data[0]) return null;
    const user = data.data[0];
    return {
      accessToken,
      username: user.login,
      userId: user.id,
      profileImageUrl: user.profile_image_url,
    };
  } catch {
    return null;
  }
}

export async function validateDevToken(accessToken: string, username: string): Promise<TwitchSession> {
  const clientId = getTwitchClientId();
  const cleanToken = accessToken.startsWith("oauth:") ? accessToken.slice(6) : accessToken;

  if (clientId) {
    const validated = await validateToken(cleanToken, clientId);
    if (validated) return validated;
  }

  return {
    accessToken: cleanToken,
    username,
    userId: "dev_" + username,
  };
}

export async function sendTwitchMessage(channel: string, message: string): Promise<void> {
  await sendGuard.send(channel, message);
}

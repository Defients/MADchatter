import { throwIfSendCancelled, notifySendIdentityChange } from "./sendCancellation";
import type { Platform } from "./kick";
import { SendRateLimiter } from "./rateLimiter";

export interface JoystickSession {
  accessToken: string;
  refreshToken?: string;
  username: string;
  channelId?: string;
  expiresAt?: number;
}

interface JwtPayload {
  exp?: number;
  bot_id?: string;
  channel_id?: string;
  aud?: string;
}

export function decodeJoystickJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ─── Joystick ActionCable WebSocket Chat Client ──────────────────────────────
// Joystick's chat uses Rails ActionCable over WebSockets.
// The bot connects once with its basic auth key and subscribes to GatewayChannel.
// Messages from all streamers who installed the bot arrive on the same channel.
// We filter by channelId to only process messages from the current streamer.

const JOYSTICK_API_HOST = "https://api.joystick.tv";
const JOYSTICK_HOST = "https://joystick.tv";
const JOYSTICK_WS_URL = "wss://api.joystick.tv/cable";
const PROXY_BASE = import.meta.env.VITE_JOYSTICK_TOKEN_PROXY || "https://joystick-token-proxy.mcmllnt.workers.dev";
const DEFAULT_JOYSTICK_CLIENT_ID = import.meta.env.VITE_JOYSTICK_CLIENT_ID || "77147cc4-499a-469c-b8ac-b0bfed2336f2";
const DEFAULT_JOYSTICK_CLIENT_SECRET = import.meta.env.VITE_JOYSTICK_CLIENT_SECRET || "hT4eRDiAs5jhyOJbgup-JQ";
const DEFAULT_JOYSTICK_BOT_USERNAME = "defbot";

const GATEWAY_IDENTIFIER = JSON.stringify({ channel: "GatewayChannel" });

type ChatReadState = "disconnected" | "connecting" | "connected" | "error";
export interface JoystickIncomingMessageMeta {
  messageId?: string;
  replyTargetUsername?: string;
}

export class JoystickChatClient {
  private ws: WebSocket | null = null;
  private channelId: string | null = null;
  private channelSlug: string = "";
  private state: ChatReadState = "disconnected";
  private stateListeners: Set<(state: ChatReadState) => void> = new Set();
  private messageListeners: Set<(username: string, content: string, meta?: JoystickIncomingMessageMeta) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelled = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;
  private basicAuthKey: string;

  constructor(basicAuthKey: string) {
    this.basicAuthKey = basicAuthKey;
  }

  onMessage(cb: (username: string, content: string, meta?: JoystickIncomingMessageMeta) => void): void {
    this.messageListeners.add(cb);
  }

  onStateChange(cb: (state: ChatReadState) => void): void {
    this.stateListeners.add(cb);
  }

  getState(): ChatReadState {
    return this.state;
  }

  getChannelId(): string | null {
    return this.channelId;
  }

  setChannelId(id: string): void {
    this.channelId = id;
  }

  private setState(state: ChatReadState) {
    this.state = state;
    this.stateListeners.forEach((l) => l(state));
  }

  async connect(slug: string): Promise<void> {
    this.cancelled = false;
    this.reconnectAttempts = 0;
    this.channelSlug = slug;
    this.setState("connecting");

    // Use channelId from session (extracted from JWT) if available
    const session = getJoystickSession();
    if (session?.channelId) {
      this.channelId = session.channelId;
    }

    // Open WebSocket immediately
    this.openWebSocket();
  }

  private getReconnectDelay(): number {
    const delays = [1000, 2000, 4000, 8000, 15000, 30000];
    return delays[Math.min(this.reconnectAttempts, delays.length - 1)];
  }

  private openWebSocket() {
    if (this.cancelled) return;

    const wsUrl = `${JOYSTICK_WS_URL}?token=${this.basicAuthKey}`;
    this.ws = new WebSocket(wsUrl, ["actioncable-v1-json"]);

    this.ws.onopen = () => {
      const subscribeMsg = {
        command: "subscribe",
        identifier: GATEWAY_IDENTIFIER,
      };
      this.ws?.send(JSON.stringify(subscribeMsg));
    };

    this.ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);

        if (frame.type === "confirm_subscription") {
          this.reconnectAttempts = 0;
          this.setState("connected");
          return;
        }

        if (frame.type === "reject_subscription") {
          console.error("[Joystick WS] Subscription rejected");
          this.setState("error");
          this.cancelled = true;
          return;
        }

        if (frame.type === "ping") {
          // ActionCable ping — no response needed, just keep-alive
          return;
        }

        if (frame.type === "welcome") {
          // Some ActionCable servers send a welcome message before subscribe
          return;
        }

        // Chat messages have identifier + message (no type field)
        if (frame.identifier && frame.message) {
          const msg = frame.message;

          // Always capture channelId from incoming messages
          const msgChannelId = msg.channel_id || msg.channelId;
          if (msgChannelId) {
            this.channelId = msgChannelId;
          }

          if (msg.type === "new_message") {
            const username = msg.author?.username || msg.author?.slug || "user";
            const content = msg.text || "";
            if (content) {
              const rawMessageId = msg.id || msg.message_id;
              const replyTargetUsername = msg.reply_to?.author?.username || msg.reply_to_username;
              this.messageListeners.forEach((l) => l(username, content, {
                ...(rawMessageId != null ? { messageId: String(rawMessageId) } : {}),
                ...(replyTargetUsername ? { replyTargetUsername: String(replyTargetUsername) } : {}),
              }));
            }
          }
          // StreamEvent and UserPresence messages could be handled here in the future
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    this.ws.onerror = () => {
      this.setState("error");
    };

    this.ws.onclose = () => {
      if (this.cancelled) return;

      this.setState("disconnected");

      if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        this.setState("error");
        return;
      }

      const delay = this.getReconnectDelay();
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => {
        if (!this.cancelled) this.openWebSocket();
      }, delay);
    };
  }


  sendMessage(text: string, channelId?: string): boolean {
    const targetChannelId = channelId || this.channelId;
    if (!targetChannelId) {
      console.error("[Joystick WS] Cannot send message — no channelId available");
      return false;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[Joystick WS] Cannot send message — WebSocket not open");
      return false;
    }

    const msg = {
      command: "message",
      identifier: GATEWAY_IDENTIFIER,
      data: JSON.stringify({
        action: "send_message",
        text: text,
        channelId: targetChannelId,
      }),
    };
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  disconnect() {
    this.cancelled = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.reconnectAttempts = 0;
    this.channelId = null;
    this.setState("disconnected");
  }
}

// ─── Joystick Send Manager ───────────────────────────────────────────────────
// Sends messages via the WebSocket connection (not REST, unlike Kick/Twitch).
// Uses the same rate limiting + dedup pattern as the other providers.

class JoystickSendManager extends SendRateLimiter {
  private state: ChatReadState = "disconnected";
  private stateListeners: Set<(state: string) => void> = new Set();

  getState(): ChatReadState {
    return this.state;
  }

  onStateChange(listener: (state: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ChatReadState) {
    this.state = state;
    this.stateListeners.forEach((l) => l(state));
  }

  getRateStatus(): { used: number; max: number; windowMs: number } {
    const now = Date.now();
    this.sendTimestamps = this.sendTimestamps.filter((t) => now - t < this.windowMs);
    return { used: this.sendTimestamps.length, max: this.maxPerWindow, windowMs: this.windowMs };
  }

  async send(channel: string, message: string, chatClient: JoystickChatClient | null, signal?: AbortSignal): Promise<void> {
    if (message.length > 500) {
      throw new Error(`Message exceeds Joystick's 500-character limit (${message.length} chars). Shorten your message and try again.`);
    }

    return this.sendWithRateLimit(message, () => this.deliver(message, chatClient), signal);
  }

  private async deliver(message: string, chatClient: JoystickChatClient | null, signal?: AbortSignal): Promise<void> {

    if (!chatClient) {
      throw new Error("Joystick chat client not connected. Wait for the WebSocket to connect before sending.");
    }

    this.setState("connecting");

    const sent = chatClient.sendMessage(message);
    if (!sent) {
      this.setState("error");
      throw new Error("Failed to send message via Joystick WebSocket. Ensure the connection is active and channelId is resolved.");
    }

    this.setState("connected");
  }
}

export const joystickSendManager = new JoystickSendManager();

// ─── Joystick Session Management ─────────────────────────────────────────────

const JOYSTICK_SESSION_KEY = "joystick_session";
const JOYSTICK_CLIENT_ID_KEY = "joystick_client_id";
const JOYSTICK_CLIENT_SECRET_KEY = "joystick_client_secret";
const JOYSTICK_BOT_USERNAME_KEY = "joystick_bot_username";

export function getJoystickClientId(): string {
  const stored = localStorage.getItem(JOYSTICK_CLIENT_ID_KEY);
  return stored !== null ? stored : DEFAULT_JOYSTICK_CLIENT_ID;
}

export function setJoystickClientId(id: string): void {
  localStorage.setItem(JOYSTICK_CLIENT_ID_KEY, id);
}

export function getJoystickClientSecret(): string {
  const stored = localStorage.getItem(JOYSTICK_CLIENT_SECRET_KEY);
  return stored !== null ? stored : DEFAULT_JOYSTICK_CLIENT_SECRET;
}

export function setJoystickClientSecret(secret: string): void {
  localStorage.setItem(JOYSTICK_CLIENT_SECRET_KEY, secret);
}

export function getJoystickBotUsername(): string {
  const stored = localStorage.getItem(JOYSTICK_BOT_USERNAME_KEY);
  return stored !== null && stored !== "" ? stored : DEFAULT_JOYSTICK_BOT_USERNAME;
}

export function setJoystickBotUsername(name: string): void {
  localStorage.setItem(JOYSTICK_BOT_USERNAME_KEY, name);
}

export function getJoystickBasicAuthKey(): string {
  const clientId = getJoystickClientId();
  const clientSecret = getJoystickClientSecret();
  if (!clientId || !clientSecret) return "";
  return btoa(`${clientId}:${clientSecret}`);
}

export function getJoystickSession(): JoystickSession | null {
  try {
    const raw = localStorage.getItem(JOYSTICK_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.accessToken && parsed.username) {
        return parsed as JoystickSession;
      }
    }
  } catch (e) {
    console.warn("[joystick] Failed to parse stored Joystick session:", e);
  }
  return null;
}

export function setJoystickSession(session: JoystickSession | null): void {
  if (session) {
    localStorage.setItem(JOYSTICK_SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(JOYSTICK_SESSION_KEY);
  }
  notifySendIdentityChange();
}

// ─── Token Refresh ────────────────────────────────────────────────────────────

export async function refreshJoystickToken(session: JoystickSession): Promise<JoystickSession | null> {
  if (!session.refreshToken) {
    return null;
  }

  const clientId = getJoystickClientId();
  const clientSecret = getJoystickClientSecret();
  const basicAuthKey = btoa(`${clientId}:${clientSecret}`);

  try {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", session.refreshToken);

    const res = await fetch(`${JOYSTICK_API_HOST}/api/oauth/token?${params.toString()}`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuthKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (res.status === 400 || res.status === 401) {
        setJoystickSession(null);
      }
      return null;
    }

    const tokenData = await res.json();
    const newSession: JoystickSession = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || session.refreshToken,
      username: session.username,
      channelId: session.channelId,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
    };

    setJoystickSession(newSession);
    return newSession;
  } catch (e) {
    console.error("[Joystick Auth] Token refresh error:", e);
    return null;
  }
}

export async function ensureValidJoystickSession(): Promise<JoystickSession | null> {
  const session = getJoystickSession();
  if (!session) return null;

  if (!session.expiresAt) return session;

  const now = Date.now();
  const bufferMs = 60_000;

  if (now < session.expiresAt - bufferMs) {
    return session;
  }

  const refreshed = await refreshJoystickToken(session);
  if (refreshed) return refreshed;

  return null;
}

// ─── Joystick OAuth2 ─────────────────────────────────────────────────────────

export function buildJoystickOAuthUrl(clientId: string, state: string): string {
  return `${JOYSTICK_HOST}/api/oauth/authorize?response_type=code&client_id=${clientId}&scope=bot&state=${state}`;
}

export async function exchangeJoystickCodeForToken(
  clientId: string,
  code: string,
  clientSecret?: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const secret = clientSecret || DEFAULT_JOYSTICK_CLIENT_SECRET;

  // Use proxy directly — Joystick API doesn't support CORS from browser
  if (PROXY_BASE) {
    const res = await fetch(`${PROXY_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: clientId, client_secret: secret }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Joystick token exchange failed: ${err}`);
    }
    return await res.json();
  }

  // Last resort: direct API (will fail with CORS in browser, but works in non-browser contexts)
  const basicAuthKey = btoa(`${clientId}:${secret}`);
  const params = new URLSearchParams();
  params.set("redirect_uri", "unused");
  params.set("code", code);
  params.set("grant_type", "authorization_code");

  const res = await fetch(`${JOYSTICK_API_HOST}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuthKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Joystick token exchange failed: ${err}`);
  }
  return await res.json();
}


// ─── Channel Info by ID ──────────────────────────────────────────────────────

export interface JoystickChannelInfo {
  username: string;
  slug: string;
  channel_id: string;
  photo_url?: string;
}

export async function fetchJoystickBotInfo(botId: string, accessToken: string): Promise<JoystickChannelInfo | null> {
  const urls = [
    PROXY_BASE ? `${PROXY_BASE}/bot-info/${botId}` : null,
  ].filter(Boolean) as string[];

  for (const url of urls) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
      };
      if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

      const res = await fetch(url, { headers });
      if (!res.ok) {
        continue;
      }
      const data = await res.json();
      return {
        username: data.username || data.slug || data.user?.username || data.bot?.username || "",
        slug: data.slug || data.username || data.bot?.slug || "",
        channel_id: data.channel_id || data.id || data.bot_id || botId,
        photo_url: data.photo_url || data.user?.photo_url || data.bot?.photo_url || "",
      };
    } catch (e) {
      // ignore
    }
  }
  return null;
}

export async function fetchJoystickChannelInfo(channelId: string, accessToken: string): Promise<JoystickChannelInfo | null> {
  // Try proxy first (avoids CORS), then direct API as fallback
  const urls = [
    PROXY_BASE ? `${PROXY_BASE}/channel-info/${channelId}` : null,
    `${JOYSTICK_API_HOST}/api/channels/${channelId}`,
  ].filter(Boolean) as string[];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      });
      if (!res.ok) {
        continue;
      }
      const data = await res.json();
      return {
        username: data.username || data.slug || data.user?.username || "",
        slug: data.slug || data.username || "",
        channel_id: data.channel_id || data.id || data.channelId || channelId,
        photo_url: data.photo_url || data.user?.photo_url || "",
      };
    } catch (e) {
      // ignore
    }
  }
  return null;
}

// ─── Send Message Export ─────────────────────────────────────────────────────

export async function sendJoystickMessage(channel: string, message: string, chatClient: JoystickChatClient | null, signal?: AbortSignal): Promise<void> {
  throwIfSendCancelled(signal);
  // If chatClient doesn't have channelId yet, try to inject from session
  if (chatClient && !chatClient.getChannelId()) {
    const session = getJoystickSession();
    if (session?.channelId) {
      chatClient.setChannelId(session.channelId);
      console.log("[Joystick Send] Injected channelId from session:", session.channelId);
    }
  }
  await joystickSendManager.send(channel, message, chatClient, signal);
}

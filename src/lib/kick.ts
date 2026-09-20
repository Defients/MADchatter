import { throwIfSendCancelled, notifySendIdentityChange } from "./sendCancellation";
import { SendRateLimiter } from "./rateLimiter";
import { useAppStore } from "../store";

export type Platform = "twitch" | "kick" | "joystick";

export interface KickSession {
  accessToken: string;
  refreshToken?: string;
  username: string;
  userId: string;
  broadcasterUserId?: number;
  profileImageUrl?: string;
  expiresAt?: number;
}

// ─── Kick Pusher WebSocket Chat Client ───────────────────────────────────────
// Kick's chat runs on Pusher Channels. We connect to the public WebSocket,
// resolve the channel slug to a chatroom ID, and subscribe to chat events.

const KICK_PUSHER_KEY = import.meta.env.VITE_KICK_PUSHER_KEY || "32cbd69e4b950bf97679";
const KICK_PUSHER_CLUSTER = "us2";
const KICK_API_V2 = "https://kick.com/api/v2";
const KICK_API_V1 = "https://kick.com/api/v1";
const KICK_PUBLIC_API = "https://api.kick.com/public/v1";
const KICK_OAUTH_BASE = "https://id.kick.com";
const PROXY_BASE = import.meta.env.VITE_KICK_TOKEN_PROXY || "https://kick-token-proxy.mcmllnt.workers.dev";
const DEFAULT_KICK_CLIENT_ID = import.meta.env.VITE_KICK_CLIENT_ID || "01KWAJQY86F3740KARPHC3XP6D";
const DEFAULT_KICK_CLIENT_SECRET = import.meta.env.VITE_KICK_CLIENT_SECRET || "1d65cf46b2b732092e9a7cf053832b3bb1c9e02cc377b0bd0d0d896f08f05fee";

interface KickChannelInfo {
  chatroom_id: number;
  user_id: number;
  username: string;
  is_live: boolean;
  livestream?: {
    session_title: string;
    categories?: Array<{ name: string }>;
    viewer_count: number;
  };
}

export async function fetchKickChannelInfo(slug: string, signal?: AbortSignal): Promise<KickChannelInfo | null> {
  throwIfSendCancelled(signal);
  const encSlug = encodeURIComponent(slug);

  const parseV2Api = (data: any): KickChannelInfo | null => {
    if (!data || typeof data !== 'object') return null;
    const chatroomId = data.chatroom?.id || data.chatroom_id;
    if (!chatroomId) return null;
    const userId = Number(data.broadcaster_user_id || data.user_id || 0);
    return {
      chatroom_id: Number(chatroomId),
      user_id: userId,
      username: data.slug || data.username || slug,
      is_live: data.stream?.is_live || data.livestream?.is_live || false,
      livestream: (data.stream || data.livestream) ? {
        session_title: data.stream_title || data.livestream?.session_title || '',
        categories: data.category ? [{ name: data.category.name }] : (data.livestream?.categories?.map((c: any) => ({ name: c.name })) || []),
        viewer_count: data.stream?.viewer_count || data.livestream?.viewer_count || 0,
      } : undefined,
    } as KickChannelInfo;
  };

  const parsePublicApi = (data: any): KickChannelInfo | null => {
    const ch = data.data?.[0] || data;
    if (!ch) return null;
    const chatroomId = ch.chatroom?.id || ch.chatroom_id;
    if (!chatroomId) return null;
    return {
      chatroom_id: chatroomId,
      user_id: ch.broadcaster_user_id || ch.user_id || 0,
      username: ch.slug || ch.username || slug,
      is_live: ch.stream?.is_live || ch.livestream?.is_live || false,
      livestream: (ch.stream || ch.livestream) ? {
        session_title: ch.stream_title || ch.livestream?.session_title || '',
        categories: ch.category ? [{ name: ch.category.name }] : (ch.livestream?.categories?.map((c: any) => ({ name: c.name })) || []),
        viewer_count: ch.stream?.viewer_count || ch.livestream?.viewer_count || 0,
      } : undefined,
    } as KickChannelInfo;
  };

  // Method 1: Direct v2 API (public, no auth needed) — fastest, no proxy dependency
  try {
    const res = await fetch(`${KICK_API_V2}/channels/${encSlug}`, {
      signal,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.ok) {
      const parsed = parseV2Api(await res.json());
      throwIfSendCancelled(signal);
      if (parsed) {
        console.log('[Kick] Channel resolved via direct v2 API:', slug, 'chatroom_id:', parsed.chatroom_id);
        return parsed;
      }
    } else {
      console.warn('[Kick] Direct v2 API returned', res.status, 'for', slug);
    }
  } catch (e) {
    throwIfSendCancelled(signal);
    console.warn('[Kick] Method 1 (direct v2) failed:', e);
  }

  throwIfSendCancelled(signal);
  // Method 2: Direct v1 API (public, no auth needed)
  try {
    const res = await fetch(`${KICK_API_V1}/channels/${encSlug}`, {
      signal,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.ok) {
      const parsed = parseV2Api(await res.json());
      throwIfSendCancelled(signal);
      if (parsed) {
        console.log('[Kick] Channel resolved via direct v1 API:', slug, 'chatroom_id:', parsed.chatroom_id);
        return parsed;
      }
    }
  } catch (e) {
    throwIfSendCancelled(signal);
    console.warn('[Kick] Method 2 (direct v1) failed:', e);
  }

  throwIfSendCancelled(signal);
  // Method 3: Proxy to v1 legacy API (CORS fallback)
  try {
    const res = await fetch(`${PROXY_BASE}/channel/${encSlug}`, { signal });
    if (res.ok) {
      const parsed = parseV2Api(await res.json());
      throwIfSendCancelled(signal);
      if (parsed) {
        console.log('[Kick] Channel resolved via proxy v1:', slug, 'chatroom_id:', parsed.chatroom_id);
        return parsed;
      }
    }
  } catch (e) {
    throwIfSendCancelled(signal);
    console.warn('[Kick] Method 3 (proxy v1) failed:', e);
  }

  throwIfSendCancelled(signal);
  // Method 4: Proxy to official public API (with auth if available)
  const session = getKickSession();
  if (session?.accessToken) {
    try {
      const headers: Record<string, string> = {};
      const res = await fetch(`${PROXY_BASE}/channels?slug=${encSlug}`, {
        signal,
        headers: { 'Authorization': `Bearer ${session.accessToken}` },
      });
      if (res.ok) {
        const parsed = parsePublicApi(await res.json());
        throwIfSendCancelled(signal);
        if (parsed) {
          console.log('[Kick] Channel resolved via proxy public API:', slug, 'chatroom_id:', parsed.chatroom_id);
          return parsed;
        }
      }
    } catch (e) {
      throwIfSendCancelled(signal);
      console.warn('[Kick] Method 4 (proxy + auth) failed:', e);
    }
  }

  console.error('[Kick] All channel resolution methods failed for:', slug);
  return null;
}

export async function fetchKickMetadata(slug: string): Promise<{ title: string; category: string; viewerCount: number } | null> {
  const info = await fetchKickChannelInfo(slug);
  if (!info) return null;
  return {
    title: info.livestream?.session_title || "",
    category: info.livestream?.categories?.[0]?.name || "",
    viewerCount: info.livestream?.viewer_count || 0,
  };
}

type ChatReadState = "disconnected" | "connecting" | "connected" | "error";
export interface KickIncomingMessageMeta {
  messageId?: string;
  replyTargetUsername?: string;
}

export class KickChatClient {
  private ws: WebSocket | null = null;
  private chatroomId: number | null = null;
  private channelSlug: string = "";
  private state: ChatReadState = "disconnected";
  private stateListeners: Set<(state: ChatReadState) => void> = new Set();
  private messageListeners: Set<(username: string, content: string, meta?: KickIncomingMessageMeta) => void> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private cancelled = false;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  private static readonly CHAT_EVENT_NAMES = [
    'App\\Events\\ChatMessageEvent',
    'App\\Events\\ChatMessageSentEvent',
  ];

  onMessage(cb: (username: string, content: string, meta?: KickIncomingMessageMeta) => void): void {
    this.messageListeners.add(cb);
  }

  onStateChange(cb: (state: ChatReadState) => void): void {
    this.stateListeners.add(cb);
  }

  getState(): ChatReadState {
    return this.state;
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

    console.log('[Kick WS] Resolving channel info for:', slug);
    const info = await fetchKickChannelInfo(slug);
    console.log('[Kick WS] Channel info result:', info ? `chatroom_id=${info.chatroom_id}` : 'null');
    if (!info || !info.chatroom_id) {
      this.setState("error");
      throw new Error(
        `Could not resolve Kick channel "${slug}". ` +
        `The channel may not exist, Kick may be down, or all API endpoints are unreachable. ` +
        `Check the channel name and try again.`
      );
    }

    this.chatroomId = info.chatroom_id;
    this.openWebSocket();
  }

  private getReconnectDelay(): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 15s, 30s, 30s, ...
    const delays = [1000, 2000, 4000, 8000, 15000, 30000];
    return delays[Math.min(this.reconnectAttempts, delays.length - 1)];
  }

  private openWebSocket() {
    if (this.cancelled) return;

    const wsUrl = `wss://ws-${KICK_PUSHER_CLUSTER}.pusher.com/app/${KICK_PUSHER_KEY}?protocol=7&client=js&version=8.4.0&flash=false`;
    console.log(`[Kick WS] Connecting (attempt ${this.reconnectAttempts + 1}) to:`, wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[Kick WS] WebSocket opened, waiting for pusher:connection_established');
    };

    this.ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data);
        const eventName = frame.event;
        const channel = frame.channel;

        if (eventName === 'pusher:connection_established') {
          const data = JSON.parse(frame.data);
          console.log('[Kick WS] Connection established, socket ID:', data.socket_id);
          const subscribeMsg = {
            event: 'pusher:subscribe',
            data: {
              auth: '',
              channel: `chatrooms.${this.chatroomId}.v2`,
            },
          };
          this.ws?.send(JSON.stringify(subscribeMsg));
          console.log(`[Kick WS] Sent subscription request for chatrooms.${this.chatroomId}.v2`);
          this.startPing();
        } else if (eventName === 'pusher_internal:subscription_succeeded') {
          console.log(`[Kick WS] Subscription confirmed for ${channel}`);
          this.reconnectAttempts = 0;
          this.setState('connected');
        } else if (eventName === 'pusher:ping') {
          this.ws?.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        } else if (eventName === 'pusher:error') {
          const errData = frame.data || {};
          console.error('[Kick WS] Pusher error:', errData.code, errData.message || errData);
          // 4009 = app disabled, 4100 = reconnect, etc.
          if (errData.code === 4009) {
            console.error('[Kick WS] App disabled by Pusher — stopping reconnection');
            this.setState('error');
            this.cancelled = true;
          }
        } else if (
          KickChatClient.CHAT_EVENT_NAMES.includes(eventName) &&
          channel?.startsWith('chatrooms.')
        ) {
          const data = JSON.parse(frame.data);
          const username = data.sender?.username || data.user?.username || 'user';
          let content = data.content || data.message || '';
          // Strip emote tokens: [emote:id:name] -> name
          content = content.replace(/\[emote:\d+:([^\]]+)\]/g, '$1');
          if (content) {
            const rawMessageId = data.id || data.message_id || data.chat_entry?.id;
            const replyTargetUsername = data.reply_to?.sender?.username || data.reply_to?.user?.username;
            this.messageListeners.forEach((l) => l(username, content, {
              ...(rawMessageId != null ? { messageId: String(rawMessageId) } : {}),
              ...(replyTargetUsername ? { replyTargetUsername: String(replyTargetUsername) } : {}),
            }));
          }
        } else {
          // Log unhandled events at debug level for future investigation
          console.debug('[Kick WS] Unhandled event:', eventName, 'channel:', channel);
        }
      } catch (e) {
        console.warn('[Kick WS] Failed to parse message:', event.data);
      }
    };

    this.ws.onerror = (e) => {
      console.error('[Kick WS] WebSocket error:', e);
      // Don't set 'error' state immediately — onclose will fire and handle reconnection
    };

    this.ws.onclose = (e) => {
      console.log(`[Kick WS] WebSocket closed: code=${e.code} reason="${e.reason}"`);
      this.stopPing();
      if (this.cancelled) return;

      this.setState('disconnected');

      if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        console.error(`[Kick WS] Max reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
        this.setState('error');
        return;
      }

      const delay = this.getReconnectDelay();
      console.log(`[Kick WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})`);
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => {
        if (!this.cancelled) this.openWebSocket();
      }, delay);
    };
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ event: "pusher:ping", data: {} }));
      }
    }, 120000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  disconnect() {
    this.cancelled = true;
    this.stopPing();
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
    this.setState('disconnected');
  }
}

// ─── Kick Send Manager ───────────────────────────────────────────────────────
// Sends messages via Kick's public REST API: POST https://api.kick.com/public/v1/chat

class KickSendManager extends SendRateLimiter {
  private state: ChatReadState = 'disconnected';
  private stateListeners: Set<(state: string) => void> = new Set();
  private channelInfoCache: Map<string, { broadcasterUserId: number; expiresAt: number }> = new Map();
  private ensureValid: (signal?: AbortSignal) => Promise<KickSession | null>;
  private refresh: (session: KickSession, signal?: AbortSignal) => Promise<KickSession | null>;

  constructor(
    ensureValid: (signal?: AbortSignal) => Promise<KickSession | null> = ensureValidKickSession,
    refresh: (session: KickSession, signal?: AbortSignal) => Promise<KickSession | null> = refreshKickToken,
  ) {
    super();
    this.ensureValid = ensureValid;
    this.refresh = refresh;
  }

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

  async send(channel: string, message: string, signal?: AbortSignal): Promise<void> {
    if (message.length > 500) {
      throw new Error(`Message exceeds Kick's 500-character limit (${message.length} chars). Shorten your message and try again.`);
    }

    return this.sendWithRateLimit(message, () => this.deliver(channel, message, signal), signal);
  }

  private async deliver(channel: string, message: string, signal?: AbortSignal): Promise<void> {

    // Ensure we have a valid session (auto-refresh if token is expired)
    throwIfSendCancelled(signal);
    const session = await this.ensureValid(signal);
    throwIfSendCancelled(signal);
    if (!session) {
      throw new Error('Not authenticated with Kick. Please log in via the Kick login button to send chat messages.');
    }
    console.log('[Kick Send] Session valid, token length:', session.accessToken?.length);

    // Resolve broadcaster user ID (the channel owner's ID, not the logged-in user's ID)
    // This must be resolved per-channel, not per-session.
    let broadcasterUserId: number | undefined;
    const cached = this.channelInfoCache.get(channel);
    if (cached && cached.expiresAt > Date.now()) {
      broadcasterUserId = cached.broadcasterUserId;
    } else {
      const info = await fetchKickChannelInfo(channel, signal);
      throwIfSendCancelled(signal);
      if (!info || !info.user_id) {
        throw new Error(`Could not resolve broadcaster_user_id for Kick channel "${channel}". The channel may not exist or all API endpoints are unreachable.`);
      }
      broadcasterUserId = info.user_id;
      this.channelInfoCache.set(channel, { broadcasterUserId, expiresAt: Date.now() + 300000 });
    }

    this.setState('connecting');

    const chatBody = JSON.stringify({
      broadcaster_user_id: broadcasterUserId,
      content: message,
      type: 'user',
    });
    const chatHeaders: Record<string, string> = {
      'Authorization': `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    };

    const attemptSend = async (token: string): Promise<Response> => {
      throwIfSendCancelled(signal);
      // Method 1: Direct API — try first, but only trust the result if it's OK.
      // Kick's chat API requires Origin/Referer headers that browsers can't set,
      // so non-OK responses from direct may be due to missing headers, not real errors.
      // In that case, fall through to proxy which sets those headers server-side.
      try {
        const res = await fetch(`${KICK_PUBLIC_API}/chat`, {
          signal,
          method: 'POST',
          headers: { ...chatHeaders, Authorization: `Bearer ${token}` },
          body: chatBody,
        });
        if (res.ok) {
          return res;
        }
        console.warn('[Kick Send] Direct API returned', res.status, '— trying proxy');
      } catch (e) {
        throwIfSendCancelled(signal);
        console.warn('[Kick Send] Direct API failed, falling back to proxy:', e);
      }

      throwIfSendCancelled(signal);
      // Method 2: Proxy fallback — sets Origin/Referer headers server-side
      const res = await fetch(`${PROXY_BASE}/chat`, {
        signal,
        method: 'POST',
        headers: { ...chatHeaders, Authorization: `Bearer ${token}` },
        body: chatBody,
      });
      return res;
    };

    try {
      let res = await attemptSend(session.accessToken);
      // A confirmed success still belongs in the limiter's duplicate history,
      // even if its caller cancelled while the response was arriving.
      if (signal?.aborted && res.ok) return;
      throwIfSendCancelled(signal);

      // If 401/403, try refreshing the token and retrying once
      if (res.status === 401 || res.status === 403) {
        const errText = await res.text().catch(() => '');
        console.warn(`[Kick Send] Got ${res.status}, attempting token refresh...`, errText);

        throwIfSendCancelled(signal);
        const refreshed = await this.refresh(session, signal);
        throwIfSendCancelled(signal);
        if (refreshed) {
          console.log('[Kick Send] Token refreshed, retrying send...');
          res = await attemptSend(refreshed.accessToken);
          if (signal?.aborted && res.ok) return;
        } else {
          this.setState('error');
          throw new Error(
            `Kick chat send failed (${res.status}) and token refresh failed. ` +
            `Please log out and log back in to Kick. Details: ${errText}`
          );
        }
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`[Kick Send] Chat send failed (${res.status}):`, errText);

        if (res.status === 429) {
          throw new Error(`Kick rate limit exceeded (429). You're sending messages too fast. Wait a moment and try again. (${errText})`);
        }
        if (res.status === 403) {
          throw new Error(
            `Kick chat send forbidden (403). This can happen if:\n` +
            `  1. The channel has chat restrictions (followers-only, subs-only) and you don't qualify.\n` +
            `  2. Your OAuth app lacks the chat:write scope.\n` +
            `  3. Kick's API is blocking third-party requests (known issue #281 on KickDevDocs).\n` +
            `Try sending to your own channel first to rule out channel restrictions. (${errText})`
          );
        }
        if (res.status === 401) {
          throw new Error(`Kick authentication failed (401). Your token is invalid or expired. Please log out and log back in to Kick. (${errText})`);
        }
        throw new Error(`Kick API error ${res.status}: ${errText}`);
      }

      throwIfSendCancelled(signal);
      this.setState('connected');
      console.log('[Kick Send] Message sent successfully to', channel);
    } catch (err) {
      this.setState(signal?.aborted ? 'disconnected' : 'error');
      throwIfSendCancelled(signal);
      throw err;
    }
  }
}

export const kickSendManager = new KickSendManager();

// ─── Multi-Bot: per-identity Kick send managers (additive) ──────────────────
const kickSendManagerRegistry = new Map<string, KickSendManager>();

export function getKickSendManagerForBot(botId: string): KickSendManager {
  let mgr = kickSendManagerRegistry.get(botId);
  if (!mgr) {
    mgr = new KickSendManager(
      (signal) => ensureValidKickSessionForBot(botId, signal),
      (session, signal) => refreshKickTokenForBot(botId, session, signal),
    );
    kickSendManagerRegistry.set(botId, mgr);
  }
  return mgr;
}

export function disposeKickSendManagerForBot(botId: string): void {
  kickSendManagerRegistry.delete(botId);
}

// ─── Kick Session Management ─────────────────────────────────────────────────

const KICK_SESSION_KEY = 'kick_session';
const KICK_CLIENT_ID_KEY = 'kick_client_id';

export function getKickClientId(): string {
  const stored = localStorage.getItem(KICK_CLIENT_ID_KEY);
  return stored !== null ? stored : DEFAULT_KICK_CLIENT_ID;
}

export function setKickClientId(id: string): void {
  localStorage.setItem(KICK_CLIENT_ID_KEY, id);
}

export function getKickSession(): KickSession | null {
  try {
    const raw = localStorage.getItem(KICK_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.accessToken && parsed.username) {
        // NOTE: Do NOT auto-delete expired sessions here.
        // ensureValidKickSession() will attempt a refresh using the stored refreshToken.
        // Only return null if the structure is invalid.
        return parsed as KickSession;
      }
    }
  } catch (e) {
    console.warn("[kick] getKickSession parse error:", e);
  }
  return null;
}

export function setKickSession(session: KickSession | null): void {
  if (session) {
    localStorage.setItem(KICK_SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(KICK_SESSION_KEY);
  }
  notifySendIdentityChange();
}

// ─── Multi-Bot: per-bot Kick session accessors (additive) ───────────────────
// Sessions for additional Kick bots live in the store (bots[].session). The
// legacy kick_session localStorage key above is untouched (single-bot mode).

export function getKickSessionForBot(botId: string): KickSession | null {
  const bot = useAppStore.getState().bots.find((b) => b.id === botId);
  if (bot?.session?.accessToken && bot?.session?.username) {
    return {
      accessToken: bot.session.accessToken,
      refreshToken: bot.session.refreshToken,
      username: bot.session.username,
      userId: bot.session.userId,
      profileImageUrl: bot.session.profileImageUrl,
      expiresAt: bot.session.expiresAt,
    } as KickSession;
  }
  return null;
}

export function setKickSessionForBot(botId: string, session: KickSession | null): void {
  useAppStore.getState().setBotSession(botId, session);
}

export function removeKickSessionForBot(botId: string): void {
  useAppStore.getState().setBotSession(botId, null);
}

// ─── Token Refresh ────────────────────────────────────────────────────────────

export async function refreshKickToken(session: KickSession, signal?: AbortSignal): Promise<KickSession | null> {
  throwIfSendCancelled(signal);
  if (!session.refreshToken) {
    console.warn('[Kick Auth] No refresh_token available — cannot refresh. User must re-authenticate.');
    return null;
  }

  const clientId = getKickClientId();
  const clientSecret = DEFAULT_KICK_CLIENT_SECRET;

  console.log('[Kick Auth] Refreshing token with refresh_token...');

  try {
    // Token refresh must go through the proxy (requires client_secret)
    const res = await fetch(`${PROXY_BASE}/refresh`, {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: session.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    throwIfSendCancelled(signal);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[Kick Auth] Token refresh failed (${res.status}):`, errText);
      // If refresh token is invalid, clear the session
      if (res.status === 400 || res.status === 401) {
        console.warn('[Kick Auth] Refresh token is invalid or expired. Clearing session.');
        throwIfSendCancelled(signal);
        setKickSession(null);
      }
      return null;
    }

    const tokenData = await res.json();
    throwIfSendCancelled(signal);
    const newSession: KickSession = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || session.refreshToken,
      username: session.username,
      userId: session.userId,
      broadcasterUserId: session.broadcasterUserId,
      profileImageUrl: session.profileImageUrl,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
    };

    setKickSession(newSession);
    console.log('[Kick Auth] Token refreshed successfully, new expiresAt:', new Date(newSession.expiresAt!).toISOString());
    return newSession;
  } catch (e) {
    throwIfSendCancelled(signal);
    console.error('[Kick Auth] Token refresh error:', e);
    return null;
  }
}

export async function ensureValidKickSession(signal?: AbortSignal): Promise<KickSession | null> {
  throwIfSendCancelled(signal);
  const session = getKickSession();
  if (!session) return null;

  // No expiresAt — assume valid (e.g. dev token login)
  if (!session.expiresAt) return session;

  const now = Date.now();
  const bufferMs = 60_000; // Refresh if expiring within 60 seconds

  if (now < session.expiresAt - bufferMs) {
    return session;
  }

  console.log(`[Kick Auth] Token ${now > session.expiresAt ? 'expired' : 'expiring soon'}, attempting refresh...`);
  const refreshed = await refreshKickToken(session, signal);
  if (refreshed) return refreshed;

  // Refresh failed — return null so caller can prompt re-auth
  return null;
}

// ─── Multi-Bot: per-bot token refresh + ensure (additive) ───────────────────

export async function refreshKickTokenForBot(botId: string, session: KickSession, signal?: AbortSignal): Promise<KickSession | null> {
  throwIfSendCancelled(signal);
  if (!session.refreshToken) {
    console.warn('[Kick Auth] No refresh_token available — cannot refresh. User must re-authenticate.');
    return null;
  }
  const clientId = getKickClientId();
  const clientSecret = DEFAULT_KICK_CLIENT_SECRET;
  try {
    const res = await fetch(`${PROXY_BASE}/refresh`, {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken, client_id: clientId, client_secret: clientSecret }),
    });
    throwIfSendCancelled(signal);
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        setKickSessionForBot(botId, null);
      }
      return null;
    }
    const tokenData = await res.json();
    throwIfSendCancelled(signal);
    const newSession: KickSession = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || session.refreshToken,
      username: session.username,
      userId: session.userId,
      broadcasterUserId: session.broadcasterUserId,
      profileImageUrl: session.profileImageUrl,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
    };
    setKickSessionForBot(botId, newSession);
    return newSession;
  } catch (e) {
    throwIfSendCancelled(signal);
    console.error('[Kick Auth] Per-bot token refresh error:', e);
    return null;
  }
}

export async function ensureValidKickSessionForBot(botId: string, signal?: AbortSignal): Promise<KickSession | null> {
  throwIfSendCancelled(signal);
  const session = getKickSessionForBot(botId);
  if (!session) return null;
  if (!session.expiresAt) return session;
  const now = Date.now();
  const bufferMs = 60_000;
  if (now < session.expiresAt - bufferMs) return session;
  const refreshed = await refreshKickTokenForBot(botId, session, signal);
  return refreshed ?? null;
}

// ─── Kick OAuth 2.1 + PKCE ───────────────────────────────────────────────────

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64UrlEncode(array.buffer);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(digest);
  return { verifier, challenge };
}

export function buildKickOAuthUrl(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  state: string
): string {
  const scopes = "user:read channel:read chat:write";
  return `${KICK_OAUTH_BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;
}

export async function exchangeKickCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  codeVerifier: string
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(`${KICK_OAUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Kick token exchange failed: ${err}`);
  }
  return await res.json();
}

export async function fetchKickUser(accessToken: string): Promise<{ id: string; username: string; bio?: string; profileImageUrl?: string } | null> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/json, text/plain, */*',
  };

  const parseUser = (data: any) => {
    const user = data.data?.[0] || data;
    if (!user) return null;
    return {
      id: String(user.user_id || user.id),
      username: user.name || user.username,
      profileImageUrl: user.profile_picture,
    };
  };

  // Method 1: Direct official API (should support CORS for OAuth clients)
  try {
    const res = await fetch(`${KICK_PUBLIC_API}/users`, { headers });
    if (res.ok) {
      const parsed = parseUser(await res.json());
      if (parsed) {
        console.log('[Kick Auth] User fetched via direct API:', parsed.username);
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[Kick Auth] Direct user fetch failed, trying proxy:', e);
  }

  // Method 2: Proxy fallback
  try {
    const res = await fetch(`${PROXY_BASE}/users`, { headers });
    if (!res.ok) return null;
    const parsed = parseUser(await res.json());
    if (parsed) console.log('[Kick Auth] User fetched via proxy:', parsed.username);
    return parsed;
  } catch {
    return null;
  }
}

export async function sendKickMessage(channel: string, message: string, signal?: AbortSignal): Promise<void> {
  await kickSendManager.send(channel, message, signal);
}

// Multi-bot: send as a specific Kick bot identity (independent rate limit + dedup).
export async function sendKickMessageAsBot(botId: string, channel: string, message: string, signal?: AbortSignal): Promise<void> {
  await getKickSendManagerForBot(botId).send(channel, message, signal);
}

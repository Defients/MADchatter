import tmi from "tmi.js";
import { toast } from "sonner";
import { SendRateLimiter } from "./rateLimiter";
import { useAppStore } from "../store";
import { findReplyTargetFromMentions } from "./twitchReplyCache";

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
//
// The class is parameterized by a session getter so the legacy singleton
// (tmiSendManager) uses the global single-bot session, while multi-bot mode
// creates one instance per bot identity via createTmiSendManager().

// Twitch NOTICE msg-ids that explain why a chat message was rejected. Surfaced
// to the user via toast so they get the real reason instead of a silent drop.
const TWITCH_NOTICE_MSGIDS: Record<string, string> = {
  msg_verified_email: "Account email isn't verified — Twitch blocks chat until you verify the email on this account (twitch.tv → Settings → Email).",
  msg_channel_blocked: "This account is blocked from the channel.",
  msg_suspended: "This account is suspended.",
  msg_ratelimit: "Rate-limited by Twitch — slow down.",
  msg_duplicate: "Duplicate message blocked by Twitch.",
  msg_emoteonly: "Channel is emote-only right now.",
  msg_subsonly: "Channel is subs-only right now.",
  msg_followersonly: "Channel is followers-only — the account must follow first.",
  msg_followersonly_followed: "Channel is followers-only — the account needs to follow for longer.",
  msg_slowmode: "Slow mode is on — wait before sending again.",
  msg_timedout: "This account is timed out in the channel.",
  msg_bad_characters: "Message blocked (too many repeated/bad characters).",
};

class TmiSendManager {
  private client: tmi.Client | null = null;
  private connectingPromise: Promise<tmi.Client> | null = null;
  private currentChannel: string | null = null;
  private connectionState: "disconnected" | "connecting" | "connected" | "error" = "disconnected";
  private stateListeners: Set<(state: string) => void> = new Set();
  private sessionGetter: () => TwitchSession | null;

  constructor(sessionGetter: () => TwitchSession | null = getTwitchSession) {
    this.sessionGetter = sessionGetter;
  }

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
    const session = this.sessionGetter();
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
        // tmi.js 1.8.5 fetches emotes from Twitch's deprecated Kraken API
        // (api.twitch.tv/kraken/chat/emoticon_images), which is dead in
        // browsers and throws a CORS error every cycle. We don't use tmi's
        // emote parsing (emotes are handled elsewhere), so skip it entirely.
        options: { skipUpdatingEmotesets: true },
        identity: {
          username: session.username,
          password: `oauth:${session.accessToken}`,
        },
        channels: [channel],
      });

      // Surface Twitch chat-rejection notices so the user sees WHY a message
      // didn't go through (e.g. unverified email, channel blocked, rate limit)
      // instead of a silent drop + false "sent" success.
      client.on("notice", (_ch, msgid, msg) => {
        const friendly = TWITCH_NOTICE_MSGIDS[msgid];
        if (friendly) {
          toast.error(`@${session.username}: ${friendly}`, { description: msg });
        }
      });

      client.on("connected", () => {
        this.setState("connected");
      });

      client.on("disconnected", () => {
        this.setState("disconnected");
      });

      // Resolve once the bot has actually JOINED the target channel. tmi.js
      // emits 'join' with self=true on self-join, with the channel in
      // "#channel" form — normalize before comparing to our bare channel name.
      const targetCh = channel.toLowerCase().replace(/^#/, "");
      const joinPromise = new Promise<void>((jResolve) => {
        const onJoin = (jCh: string, _user: string, self: boolean) => {
          if (self && jCh.toLowerCase().replace(/^#/, "") === targetCh) {
            client.removeListener("join", onJoin);
            this.setState("connected");
            jResolve();
          }
        };
        client.on("join", onJoin);
      });

      client.connect().then(() => {
        this.client = client;
        // Race the join against a timeout so we don't hang forever.
        return Promise.race([
          joinPromise,
          new Promise<void>((_, jReject) =>
            setTimeout(() => jReject(new Error(`Couldn't join #${channel} — @${session.username} may need email verification, or is blocked/banned from the channel.`)), 8000),
          ),
        ]);
      }).then(() => {
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

  /**
   * Send a message to a Twitch channel.
   *
   * If `replyToMessageId` is provided, the message is sent as a Twitch reply
   * (using the `@reply-parent-msg-id` IRC tag). This makes the `@username`
   * mention render as a clickable, highlighted mention in Twitch's web chat
   * — even if the mentioned user isn't currently in the channel.
   *
   * Falls back to a regular `client.say()` if the reply tag fails (e.g. the
   * message ID is too old or invalid), so the message still goes through.
   */
  async send(channel: string, message: string, replyToMessageId?: string): Promise<void> {
    const client = await this.getClient(channel);
    if (replyToMessageId) {
      try {
        // Send a raw IRC PRIVMSG with the reply tag. tmi.js 1.8.5 doesn't
        // have a built-in reply method, so we use raw() to send the tagged
        // command directly. The `@reply-parent-msg-id` tag tells Twitch to
        // render this as a threaded reply to the parent message, which
        // forces the parent user's name to render as a clickable mention.
        const chan = channel.startsWith("#") ? channel : `#${channel}`;
        await client.raw(`@reply-parent-msg-id=${replyToMessageId} PRIVMSG ${chan} :${message}`);
        return;
      } catch (e) {
        // Reply tag can fail if the message ID is stale/invalid. Fall back
        // to a regular say() so the message still goes through.
        console.warn(`[twitch] reply tag failed (falling back to regular send):`, e);
      }
    }
    await client.say(channel, message);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch (e) {
        console.warn("[twitch] disconnect error (non-fatal):", e);
      }
    }
    this.connectingPromise = null;
    this.currentChannel = null;
    this.setState("disconnected");
  }
}

// Legacy singleton — uses the global single-bot session. Unchanged behavior.
export const tmiSendManager = new TmiSendManager();

// ─── Multi-Bot: per-identity send managers (additive) ───────────────────────
// One TmiSendManager per bot account, each bound to that bot's session. The
// registry is keyed by botId. Used only when multiBotEnabled === true.

const tmiSendManagerRegistry = new Map<string, TmiSendManager>();

/** Factory: create (or reuse) a TmiSendManager bound to a specific bot's session. */
export function getTmiSendManagerForBot(botId: string): TmiSendManager {
  let mgr = tmiSendManagerRegistry.get(botId);
  if (!mgr) {
    mgr = new TmiSendManager(() => getTwitchSessionForBot(botId));
    tmiSendManagerRegistry.set(botId, mgr);
  }
  return mgr;
}

/** Disconnect + drop a bot's send manager (e.g. on bot removal). */
export function disposeTmiSendManagerForBot(botId: string): void {
  const mgr = tmiSendManagerRegistry.get(botId);
  if (mgr) {
    mgr.disconnect().catch(() => {});
    tmiSendManagerRegistry.delete(botId);
  }
}

// ─── Send Rate Limiter & Deduplication ──────────────────────────────────────
// Twitch enforces chat limits: 20 messages per 30 seconds for regular users,
// 100 per 30s for mods/broadcaster. We use a sliding-window token bucket to
// prevent getting globally muted or banned. Also deduplicates: if the exact
// same message was sent within the last 60s, we block it.

class SendGuard extends SendRateLimiter {
  private doSend: (channel: string, message: string, replyToMessageId?: string) => Promise<void>;

  constructor(doSend: (channel: string, message: string, replyToMessageId?: string) => Promise<void> = (ch, msg, rid) => tmiSendManager.send(ch, msg, rid)) {
    super();
    this.doSend = doSend;
  }

  async send(channel: string, message: string): Promise<void> {
    if (message.length > 500) {
      throw new Error(`Message exceeds Twitch's 500-character limit (${message.length} chars). Trim it before sending.`);
    }

    // Auto-detect @username mentions and attach a reply tag if we have a
    // recent message ID from the mentioned user. This forces Twitch to
    // render the mention as clickable/special text instead of plain text.
    await this.sendWithRateLimit(message, async () => {
      const replyId = findReplyTargetFromMentions(message);
      await this.doSend(channel, message, replyId ?? undefined);
    });
  }
}

export const sendGuard = new SendGuard();

// ─── Multi-Bot: per-bot send guards (additive) ──────────────────────────────
// One SendGuard per bot account → independent per-account rate limit + dedup.
const botSendGuardRegistry = new Map<string, SendGuard>();

function getSendGuardForBot(botId: string): SendGuard {
  let guard = botSendGuardRegistry.get(botId);
  if (!guard) {
    const mgr = getTmiSendManagerForBot(botId);
    guard = new SendGuard((ch, msg, rid) => mgr.send(ch, msg, rid));
    botSendGuardRegistry.set(botId, guard);
  }
  return guard;
}

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
  } catch (e) {
    console.warn("[twitch] getTwitchSession parse error:", e);
  }
  return null;
}

export function setTwitchSession(session: TwitchSession | null): void {
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

// ─── Multi-Bot: per-bot session accessors (additive) ────────────────────────
// Sessions for additional bots live in the store (bots[].session), persisted
// via zustand. The legacy twitch_session localStorage key above is untouched
// and remains the source of truth for single-bot mode.

export function getTwitchSessionForBot(botId: string): TwitchSession | null {
  const bot = useAppStore.getState().bots.find((b) => b.id === botId);
  if (bot?.session?.accessToken && bot?.session?.username) {
    return {
      accessToken: bot.session.accessToken,
      username: bot.session.username,
      userId: bot.session.userId,
      profileImageUrl: bot.session.profileImageUrl,
    };
  }
  return null;
}

export function setTwitchSessionForBot(botId: string, session: TwitchSession | null): void {
  useAppStore.getState().setBotSession(botId, session);
}

export function removeTwitchSessionForBot(botId: string): void {
  useAppStore.getState().setBotSession(botId, null);
}

export function buildOAuthUrl(clientId: string, redirectUri: string, state?: string): string {
  const scopes = "chat:read chat:edit user:read:email";
  const stateParam = state ? `&state=${encodeURIComponent(state)}` : "";
  // force_verify=true makes Twitch show the authorize page every time instead
  // of auto-redirecting with the previously-authorized (cached) account. This
  // surfaces the account switcher / "Log Out" link so the user can pick which
  // account to authorize — used for both the solo login and multi-bot auth so
  // both popups behave identically.
  const forceVerify = "&force_verify=true";
  return `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(scopes)}${stateParam}${forceVerify}`;
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

// Multi-bot: send as a specific bot identity (independent rate limit + dedup).
export async function sendTwitchMessageAsBot(botId: string, channel: string, message: string): Promise<void> {
  await getSendGuardForBot(botId).send(channel, message);
}

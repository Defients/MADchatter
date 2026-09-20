import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import tmi from 'tmi.js';
import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TwitchSession {
  accessToken: string;
  refreshToken?: string;
  username: string;
  userId: string;
  expiresAt: number;
  geminiKey?: string;
  chatGptKey?: string;
  claudeKey?: string;
  deepgramKey?: string;
  openRouterKey?: string;
  customBaseUrl?: string;
  customModel?: string;
  // Custom OpenAI-Compatible provider (server-side mirror of ApiKeys).
  customOpenAIKey?: string;
  customOpenAIBaseUrl?: string;
  customOpenAIModel?: string;
  customOpenAILabel?: string;
}

const twitchSessions = new Map<string, TwitchSession>();

const getSessionId = (req: express.Request): string | undefined => {
  if (req.cookies?.forge_session) {
    return req.cookies.forge_session;
  }
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  if (req.headers['x-session-id']) {
    return req.headers['x-session-id'] as string;
  }
  return undefined;
};
const userCooldowns = new Map<string, number>();
const pendingOAuthStates = new Map<string, { createdAt: number; redirectUri: string }>();

const MESSAGE_COOLDOWN_MS = 8000;
const STATE_TTL_MS = 600000;

setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingOAuthStates.entries()) {
    if (now - data.createdAt > STATE_TTL_MS) {
      pendingOAuthStates.delete(state);
    }
  }
  for (const [id, session] of twitchSessions.entries()) {
    if (now > session.expiresAt && !session.refreshToken) {
      twitchSessions.delete(id);
    }
  }
}, 60000);

const getApiKey = (provider: string, session: TwitchSession | undefined, bodyKey?: string) => {
  if (provider === 'gemini-env') {
    return process.env.GEMINI_API_KEY || null;
  }
  const normProvider = provider === 'gemini-pro' ? 'gemini' : (provider === 'anthropic' ? 'claude' : provider);
  if (normProvider === 'gemini') {
    return session?.geminiKey || bodyKey || process.env.GEMINI_API_KEY || null;
  }
  if (normProvider === 'openai') {
    return session?.chatGptKey || bodyKey || process.env.OPENAI_API_KEY || null;
  }
  if (normProvider === 'claude') {
    return session?.claudeKey || bodyKey || process.env.ANTHROPIC_API_KEY || null;
  }
  if (normProvider === 'openrouter') {
    return session?.openRouterKey || bodyKey || process.env.OPENROUTER_API_KEY || null;
  }
  if (normProvider === 'ollama') {
    // Ollama / local runs without a key — return a dummy so downstream guards pass.
    return 'ollama-local';
  }
  if (normProvider === 'custom-openai') {
    // Custom OpenAI-compatible endpoint: base URL + model required (checked in
    // openAiCompatEndpoint); key optional. Return a sentinel when no key is set
    // so the OpenAI SDK (which requires a non-null apiKey) still constructs.
    if (!session?.customOpenAIBaseUrl || !session?.customOpenAIModel) return null;
    return session.customOpenAIKey || bodyKey || 'custom-openai-no-key';
  }
  return null;
};

/** Resolve the OpenAI-compatible base URL and model for a given provider.
 * Server-side mirror of keys.ts openAiCompatEndpoint — uses the session object
 * instead of the browser-side ApiKeys interface. */
function openAiCompatEndpoint(
  provider: string,
  session: TwitchSession | undefined,
): { baseUrl: string | undefined; model: string } {
  if (provider === 'openrouter') {
    return {
      baseUrl: session?.customBaseUrl || 'https://openrouter.ai/api/v1',
      model: session?.customModel || 'google/gemini-3.8-flash',
    };
  }
  if (provider === 'ollama') {
    return {
      baseUrl: session?.customBaseUrl || 'http://localhost:11434/v1',
      model: session?.customModel || 'qwen3.5:9b',
    };
  }
  if (provider === 'custom-openai') {
    // Generic OpenAI-compatible escape hatch — user owns the endpoint.
    return {
      baseUrl: session?.customOpenAIBaseUrl,
      model: session?.customOpenAIModel || '',
    };
  }
  return { baseUrl: undefined, model: 'gpt-5.6-luna' };
}

const R34L_TYPING_PROMPT = `

### R34L HUMAN TYPING STYLE — ACTIVE
R34L is a typing-texture overlay, not a persona: messages should read like a real person typing live in the community, while meaning, content, language, and personality stay intact.

NOTE: This server-side path does not receive the learned channel-style profile (that evidence lives in the client). Apply ONLY the restrained baseline below — do NOT invent slang, typos, stock phrases, or quirks.

HARD CONSTRAINTS (always):
- Preserve the original meaning and contextual relevance. Texture changes; substance does not.
- Never copy a specific chatter's wording. Mirror TEXTURE, not words.
- Never switch language.
- Never increase profanity to match the room.
- Never append "lol", "tbh", "ngl", "lmao", "fr", "frfr", "istg", "lowkey", "highkey", "imo", "idk tho" as a message closer or trailing tag.

BASELINE TEXTURE:
1. CASING: relaxed conversational casing — lowercase is fine in casual rooms, normal sentence case is fine in clearer rooms. Do not force either.
2. SPELLING: standard spelling by default; casual contractions only when clearly warranted by the room.
3. PUNCTUATION: natural and light. "..." for a trailing thought, "?" for real questions. No punctuation spam.
4. RHYTHM: direct, slightly uneven, human. Short when the moment is light; fuller when content needs it.
5. EMOTES: sparse by default — zero is normal; at most one well-placed text emote.
6. SERIOUS MOMENTS: write clearly — never make support, answers, or apologies messy.
7. NO STOCK QUIRKS: no manufactured irony quotes, mockery caps, fake hesitations, or meme reframes.

The output should feel like the same person typing with a natural, familiar texture — not a costume.
### END R34L OVERRIDE`;

const FORGE_SYSTEM_PROMPT = `You are Forge — an elite, context-obsessed chat co-pilot built for high-signal Twitch chat participation.

You exist to generate a small number of genuinely excellent, timely, natural chat messages that feel like they were written by a real, sharp, slightly chaotic viewer who is deeply locked into the exact moment on stream.

### CORE IDENTITY & PHILOSOPHY
- You are not a generic AI. You are a co-pilot. The human always has final say.
- Quality and contextual precision are everything. One perfect message beats five decent ones.
- The streamer's live spoken word (audio transcript) is the highest priority signal when present. Everything else (visual, chat, metadata, memory) orbits around it.
- Messages must feel alive, specific, and human. They should add value, energy, humor, insight, or meme resonance — never just echo or fill space.
- You understand that great chat participation is about timing, tone-matching, and adding a new angle the streamer or chat hasn't fully voiced yet.
- You respect the streamer's energy. You can match it, amplify it, or playfully contrast it when it serves the moment.

### CONTEXT PRIORITY HIERARCHY (strict order)
1. Audio Transcript (highest fidelity — what the streamer just said or is reacting to)
2. Visual Snapshot + Vision Analysis (game state, on-screen elements, streamer cam energy, mood)
3. Pinned Memories + Golden Memory (user-curated long-term context — treat these as sacred high-signal anchors)
4. Recent Chat Log (current conversation temperature and what has already been said)
5. Stream Metadata (title, category, viewer count, channel vibe)
6. Custom Directives + Additional Instructions from user

When a Golden Memory exists, give it disproportionate influence on at least one variant.

### MANDATORY INTERNAL REASONING PROCESS
Before generating anything, silently execute these steps:

1. **Synthesize the Moment**  
   Build a crisp mental model of what is actually happening right now on stream. What is the emotional temperature? What just happened or is happening?

2. **Identify High-Leverage Angles**  
   Extract 2–5 strong, distinct contribution opportunities (reaction, callback, meme, observation, question, hype, analysis, gremlin chaos, quiet support, etc.).

3. **Apply User Configuration**  
   - Primary Profile + active profiles
   - Humor Level & Chaos Level (map directly into tone and boldness)
   - Length Preference + Emote Density
   - Generation Mode (single_profile vs multi_profile)
   - Effort Level (low = fast & punchy, medium = balanced, high = maximum contextual depth and creativity)
   - Custom Directives & Additional Instructions (these override or heavily steer everything)

4. **Craft Distinct Variants**  
   Create genuinely different messages. Each should feel like it could come from a different but equally valid viewer archetype present in chat.

5. **Ruthless Quality Filter**  
   Discard anything generic, repetitive, overly safe, context-free, or that could have been written without the current signals. If a message feels like it could be sent to any stream, kill it.

### PROFILE DEFINITIONS (use these voices accurately)
- **hype**: Energetic, celebratory, amplifies big moments. Uses strong positive language and well-timed emotes.
- **analyst**: Observant, insightful, notices mechanics, details, or deeper patterns. Asks smart follow-ups or makes precise observations.
- **gremlin**: Playful, chaotic, meme-literate, lightly unhinged but affectionate. Excels at turning spoken lines into memes or chaotic but funny observations.
- **support**: Warm, encouraging, community-oriented. Strong emotional tone-matching and quiet positive reinforcement.
- **questioner**: Naturally curious. Turns recent content into engaging, non-intrusive questions that invite the streamer to expand.
- **translator** (when relevant): Takes complex or fast moments and distills them into clear, funny, or relatable takes.

When generationMode is "multi_profile", produce one strong variant per active profile. When "single_profile", vary the angles while staying anchored to the primary profile.

### CONFIGURATION INTERPRETATION RULES
- Higher Humor Level → more wit, wordplay, and meme awareness.
- Higher Chaos Level → bolder, more unfiltered, willing to take creative risks.
- Length Preference: short = punchy (ideally < 110 characters), medium = natural conversational, long = more expressive but still tight.
- Emote Density: minimal = almost none, moderate = natural and helpful, heavy = frequent but still earned.
- Voice Context Enabled → heavily prioritize direct references, callbacks, or reactions to the most recent audio segments.
- Effort Level high → spend more reasoning depth on subtlety, callbacks to pinned memories, and layered meaning.

### PINNED MEMORIES & GOLDEN MEMORY
Pinned memories are user-selected high-value context from this session.  
The Golden Memory (if set) is the single most important long-term anchor.  
When relevant, weave subtle references or callbacks to pinned/golden memories into variants. Never force it. Only use them when they genuinely improve the message.

### OUTPUT REQUIREMENTS — STRICT
You MUST output **ONLY** valid JSON. No markdown, no explanations, no extra text before or after the JSON.

Exact schema:

{
  "analysis": {
    "current_moment": "Concise description of what is happening on stream right now",
    "chat_energy": "Description of current chat temperature and activity level",
    "key_opportunities": ["string", "string"]
  },
  "suggestions": [
    {
      "variant_id": 1,
      "profile": "hype" | "analyst" | "gremlin" | "support" | "questioner" | "translator",
      "message": "The exact chat message to send",
      "tone": "Short description of the tone (e.g. chaotic hype, dry analysis, warm support)",
      "why_it_fits": "Clear, specific explanation of why this message is perfect for this exact moment",
      "confidence": 0.0 to 1.0,
      "suggested_emotes": "Comma-separated emote names if any, or null"
    }
  ]
}

### FINAL QUALITY STANDARDS (non-negotiable)
- Every message must feel like it was written by a real human who is watching this exact moment.
- Specificity beats cleverness.
- Audio is the primary driver for timing and relevance whenever it exists.
- Never repeat recent chat messages or previous suggestions.
- Most messages should feel sendable as-is (especially important for future Auto-Pilot use).
- Avoid corporate-safe language, excessive positivity, or filler.
- If context is thin, still produce the best possible messages rather than generic ones — but be honest in why_it_fits.
- Keep the vast majority of messages under 180 characters unless length preference explicitly allows longer.
- Never generate messages that could be copy-pasted to a completely different stream with no loss of meaning.`;

const responseSchema = {
  type: "OBJECT",
  properties: {
    analysis: {
      type: "OBJECT",
      properties: {
        current_moment: { type: "STRING" },
        chat_energy: { type: "STRING" },
        key_opportunities: { type: "ARRAY", items: { type: "STRING" } }
      },
      required: ["current_moment", "chat_energy", "key_opportunities"]
    },
    suggestions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          variant_id: { type: "INTEGER" },
          profile: { type: "STRING" },
          message: { type: "STRING" },
          tone: { type: "STRING" },
          why_it_fits: { type: "STRING" },
          suggested_emotes: { type: "STRING", nullable: true },
          confidence: { type: "NUMBER" }
        },
        required: ["variant_id", "profile", "message", "tone", "why_it_fits", "confidence"]
      }
    }
  },
  required: ["analysis", "suggestions"]
};

// --- AUTH ROUTES ---

app.get('/api/auth/twitch/url', (req, res) => {
  const state = crypto.randomUUID();
  const redirectUri = process.env.TWITCH_REDIRECT_URI || 
                     (process.env.APP_URL ? `${process.env.APP_URL}/auth/callback` : 'http://localhost:3000/auth/callback');
  pendingOAuthStates.set(state, { createdAt: Date.now(), redirectUri });
  
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${process.env.TWITCH_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=chat:read+chat:edit&state=${state}`;
  res.json({ url });
});

app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
  const { code, state, error, error_description } = req.query;
  
  const renderResponse = (messageType: string, extraData: any = {}) => {
    const payload = { type: messageType, ...extraData };
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Twitch Auth</title></head>
      <body style="background:#0F0F12;color:#E0E0E6;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
        <div style="text-align:center;">
          <h2>${messageType === 'OAUTH_ERROR' ? 'Authentication Failed' : 'Authentication Successful'}</h2>
          <p>You can close this window.</p>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage(${JSON.stringify(payload)}, '*');
          }
          setTimeout(() => window.close(), 1500);
        </script>
      </body>
      </html>
    `);
  };

  if (error) {
    console.error('Twitch OAuth Error:', error, error_description);
    return renderResponse('OAUTH_ERROR');
  }

  const pendingState = pendingOAuthStates.get(state as string);
  if (!pendingState) {
    return renderResponse('OAUTH_ERROR');
  }
  pendingOAuthStates.delete(state as string);

  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID!,
        client_secret: process.env.TWITCH_CLIENT_SECRET!,
        code: code as string,
        grant_type: 'authorization_code',
        redirect_uri: pendingState.redirectUri
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token');

    const userRes = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': process.env.TWITCH_CLIENT_ID! }
    });
    const userData = await userRes.json();
    const user = userData.data[0];

    const sessionId = crypto.randomUUID();
    twitchSessions.set(sessionId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      username: user.login,
      userId: user.id,
      expiresAt: Date.now() + (tokenData.expires_in * 1000)
    });

    const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' || (process.env.NODE_ENV === 'production');
    res.cookie('forge_session', sessionId, {
      httpOnly: true,
      secure: isHttps || !req.headers.host?.includes('localhost'),
      sameSite: (isHttps || !req.headers.host?.includes('localhost')) ? 'none' : 'lax',
      maxAge: tokenData.expires_in * 1000
    });

    renderResponse('OAUTH_AUTH_SUCCESS', { sessionId, username: user.login, userId: user.id });
  } catch (err) {
    console.error('Twitch token exchange error:', err);
    renderResponse('OAUTH_ERROR');
  }
});

app.post('/api/auth/dev-token', async (req, res) => {
  const { accessToken, username } = req.body;
  if (!accessToken || !username) {
    return res.status(400).json({ error: 'Missing token or username' });
  }

  try {
    let actualUsername = username;
    let actualUserId = crypto.randomUUID();
    if (process.env.TWITCH_CLIENT_ID) {
      const userRes = await fetch('https://api.twitch.tv/helix/users?login=' + username, {
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Client-Id': process.env.TWITCH_CLIENT_ID! }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData.data && userData.data[0]) {
          actualUsername = userData.data[0].login;
          actualUserId = userData.data[0].id;
        }
      }
    }

    const sessionId = crypto.randomUUID();
    twitchSessions.set(sessionId, {
      accessToken,
      username: actualUsername,
      userId: actualUserId,
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7 // 7 days fallback
    });

    const isHttps = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('forge_session', sessionId, {
      httpOnly: true,
      secure: isHttps,
      sameSite: isHttps ? 'none' : 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7
    });

    res.json({ username: actualUsername, userId: actualUserId, sessionId });
  } catch (e) {
    res.status(500).json({ error: 'Failed to validate dev token' });
  }
});

app.get('/api/me', (req, res) => {
  const sid = getSessionId(req);
  if (!sid) return res.status(401).json({ error: 'No session' });
  const session = twitchSessions.get(sid);
  if (!session) {
    res.clearCookie('forge_session');
    return res.status(401).json({ error: 'Session expired' });
  }
  res.json({ username: session.username, userId: session.userId });
});

app.post('/api/logout', (req, res) => {
  const sid = getSessionId(req);
  if (sid) twitchSessions.delete(sid);
  res.clearCookie('forge_session');
  res.json({ success: true });
});

// --- KICK AUTH ---

app.post('/api/kick/token', async (req, res) => {
  const { code, redirect_uri, code_verifier, client_id, client_secret } = req.body;
  if (!code || !redirect_uri || !code_verifier) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const kickClientId = client_id || process.env.KICK_CLIENT_ID;
  const kickClientSecret = client_secret || process.env.KICK_CLIENT_SECRET;

  if (!kickClientId || !kickClientSecret) {
    return res.status(500).json({ error: 'Kick client credentials not configured on server' });
  }

  try {
    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: kickClientId,
        client_secret: kickClientSecret,
        code,
        redirect_uri,
        code_verifier,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      return res.status(tokenRes.status).json({ error: `Kick token exchange failed: ${errText}` });
    }

    const tokenData = await tokenRes.json();
    res.json(tokenData);
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Kick token exchange error' });
  }
});

// --- JOYSTICK AUTH ---

app.post('/api/joystick/token', async (req, res) => {
  const { code, client_id, client_secret } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  const joystickClientId = client_id || process.env.JOYSTICK_CLIENT_ID;
  const joystickClientSecret = client_secret || process.env.JOYSTICK_CLIENT_SECRET;

  if (!joystickClientId || !joystickClientSecret) {
    return res.status(500).json({ error: 'Joystick client credentials not configured on server' });
  }

  const basicAuthKey = Buffer.from(`${joystickClientId}:${joystickClientSecret}`).toString('base64');

  try {
    const params = new URLSearchParams();
    params.set('redirect_uri', 'unused');
    params.set('code', code);
    params.set('grant_type', 'authorization_code');

    const tokenRes = await fetch('https://api.joystick.tv/api/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuthKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      return res.status(tokenRes.status).json({ error: `Joystick token exchange failed: ${errText}` });
    }

    const tokenData = await tokenRes.json();
    res.json(tokenData);
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'Joystick token exchange error' });
  }
});

// --- API KEYS ---

app.post('/api/set-keys', (req, res) => {
  const sid = getSessionId(req);
  if (!sid) return res.status(401).json({ error: 'Unauthorized' });
  let session = twitchSessions.get(sid);
  if (!session) {
    session = {
      accessToken: '',
      username: 'anonymous',
      userId: 'anon',
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
    };
    twitchSessions.set(sid, session);
  }

  const { geminiKey, chatGptKey, claudeKey, deepgramKey, openRouterKey, customBaseUrl, customModel,
    customOpenAIKey, customOpenAIBaseUrl, customOpenAIModel, customOpenAILabel } = req.body;
  if (geminiKey !== undefined) session.geminiKey = geminiKey;
  if (chatGptKey !== undefined) session.chatGptKey = chatGptKey;
  if (claudeKey !== undefined) session.claudeKey = claudeKey;
  if (deepgramKey !== undefined) session.deepgramKey = deepgramKey;
  if (openRouterKey !== undefined) session.openRouterKey = openRouterKey;
  if (customBaseUrl !== undefined) session.customBaseUrl = customBaseUrl;
  if (customModel !== undefined) session.customModel = customModel;
  if (customOpenAIKey !== undefined) session.customOpenAIKey = customOpenAIKey;
  if (customOpenAIBaseUrl !== undefined) session.customOpenAIBaseUrl = customOpenAIBaseUrl;
  if (customOpenAIModel !== undefined) session.customOpenAIModel = customOpenAIModel;
  if (customOpenAILabel !== undefined) session.customOpenAILabel = customOpenAILabel;
  
  res.json({ success: true });
});

app.get('/api/get-keys', (req, res) => {
  const sid = getSessionId(req);
  let session = sid ? twitchSessions.get(sid) : undefined;
  if (sid && !session) {
    session = {
      accessToken: '',
      username: 'anonymous',
      userId: 'anon',
      expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 365,
    };
    twitchSessions.set(sid, session);
  }
  
  // Return only boolean flags — never raw key values — to prevent key leakage.
  // The client manages its own keys in localStorage; the server only needs to
  // know whether keys exist (custom or env-provided) for provider availability UI.
  res.json({
    isGeminiCustom: !!session?.geminiKey,
    isChatGptCustom: !!session?.chatGptKey,
    isClaudeCustom: !!session?.claudeKey,
    isDeepgramCustom: !!session?.deepgramKey,
    isOpenRouterCustom: !!session?.openRouterKey,
    hasCustomBaseUrl: !!session?.customBaseUrl,
    hasCustomModel: !!session?.customModel,
    hasCustomOpenAI: !!(session?.customOpenAIBaseUrl && session?.customOpenAIModel),
    hasGeminiEnvKey: !!process.env.GEMINI_API_KEY,
    hasChatGptEnvKey: !!process.env.OPENAI_API_KEY,
    hasClaudeEnvKey: !!process.env.ANTHROPIC_API_KEY,
    hasDeepgramEnvKey: !!(process.env.DEEPGRAM_API_KEY || process.env.VITE_DEEPGRAM_API_KEY),
    hasOpenRouterEnvKey: !!process.env.OPENROUTER_API_KEY
  });
});

// --- MESSAGE SENDING ---

app.post('/api/send-message', async (req, res) => {
  const sid = getSessionId(req);
  if (!sid) return res.status(401).json({ error: 'Unauthorized' });
  const session = twitchSessions.get(sid);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });

  const { channel, message } = req.body;
  if (!channel || !message) return res.status(400).json({ error: 'Missing channel or message' });

  const lastSend = userCooldowns.get(session.userId) || 0;
  const now = Date.now();
  if (now - lastSend < MESSAGE_COOLDOWN_MS) {
    return res.status(429).json({ remaining: Math.ceil((MESSAGE_COOLDOWN_MS - (now - lastSend)) / 1000) });
  }

  try {
    const client = new tmi.Client({
      identity: {
        username: session.username,
        password: `oauth:${session.accessToken}`
      },
      channels: [channel]
    });

    await client.connect();
    await client.say(channel, message);
    await client.disconnect();

    userCooldowns.set(session.userId, now);
    res.json({ success: true, sentAt: now });
  } catch (err: any) {
    console.error('Twitch send error:', err);
    res.status(500).json({ error: 'Failed to send message: ' + (err.message || 'Unknown error') });
  }
});

// --- AI VISION & GENERATION ---

const generateVisionContext = async (provider: string, apiKey: string, screenshot: string, session?: TwitchSession) => {
  const prompt = "Describe this live stream screenshot in detail: game state, on-screen text/elements, streamer activity/expression, and overall energy/vibe. Keep it concise but specific.";
  
  const normProvider = (provider === 'gemini-pro' || provider === 'gemini-env') ? 'gemini' : (provider === 'anthropic' ? 'claude' : provider);
  if (normProvider === 'gemini') {
    const ai = new GoogleGenAI({ apiKey });
    const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || 'image/jpeg';
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
    const model = provider === 'gemini-pro' ? 'gemini-3.7-flash' : 'gemini-3.8-flash';
    const response = await ai.models.generateContent({
      model: model,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { data: base64Data, mimeType } }
        ]
      }]
    });
    return response.text;
  } else if (normProvider === 'openai' || normProvider === 'openrouter' || normProvider === 'ollama' || normProvider === 'custom-openai') {
    const { baseUrl, model } = openAiCompatEndpoint(normProvider, session);
    const ai = new OpenAI({ apiKey, baseURL: baseUrl });
    const response = await ai.chat.completions.create({
      model: model,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: screenshot } }
        ]
      }]
    });
    return response.choices[0].message.content;
  } else if (normProvider === 'claude') {
    const ai = new Anthropic({ apiKey });
    const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || 'image/jpeg';
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType as any, data: base64Data } },
          { type: 'text', text: prompt }
        ]
      }]
    });
    return (response.content[0] as any).text;
  }
  throw new Error('Invalid provider');
};

app.post('/api/vision', async (req, res) => {
  const sid = getSessionId(req);
  const session = sid ? twitchSessions.get(sid) : undefined;
  
  const { screenshot, activeProvider, geminiKey } = req.body;
  if (!screenshot) return res.status(400).json({ error: 'Missing screenshot' });
  
  const provider = activeProvider || 'gemini';
  const apiKey = getApiKey(provider, session, geminiKey);
  if (!apiKey) return res.status(401).json({ error: `No API key for ${provider}` });

  try {
    const visualContext = await generateVisionContext(provider, apiKey, screenshot, session);
    res.json({ visualContext });
  } catch (err: any) {
    console.error('Vision Error:', err);
    res.status(500).json({ error: 'Vision analysis failed: ' + (err.message || 'Unknown error') });
  }
});

app.post('/api/generate-chat', async (req, res) => {
  const sid = getSessionId(req);
  const session = sid ? twitchSessions.get(sid) : undefined;
  
  const { streamMetadata, visualContext, screenshot, recentChatLog, audioTranscript, longTermContext, config, activeProvider, geminiKey, count, r34lEnabled } = req.body;
  
  const rawProvider = activeProvider || 'gemini';
  const provider = (rawProvider === 'gemini-pro' || rawProvider === 'gemini-env') ? 'gemini' : (rawProvider === 'anthropic' ? 'claude' : rawProvider);
  const apiKey = getApiKey(rawProvider, session, geminiKey);
  if (!apiKey) return res.status(401).json({ error: `No API key for ${rawProvider}` });

  try {
    let currentVisualContext = visualContext;
    if (screenshot && (!visualContext || visualContext.length < 50)) {
      try {
        currentVisualContext = await generateVisionContext(rawProvider, apiKey, screenshot, session);
      } catch (e) {
        console.warn('Auto-vision failed, continuing without it', e);
      }
    }

    const effort = config?.effortLevel || 'medium';
    let effortDirective = '';
    let maxTokensToUse = 1536;
    let temp = 0.7;

    if (effort === 'low') {
      maxTokensToUse = 512;
      temp = 0.5;
      effortDirective = "\nEFFORT LEVEL REQUIRED: MINIMAL. Generate fast, extremely snappy, and lightweight suggestions. Keep analysis brief and concise. Minimize computation.";
    } else if (effort === 'high') {
      maxTokensToUse = 3072;
      temp = 0.9;
      effortDirective = "\nEFFORT LEVEL REQUIRED: MAXIMUM. Dive extremely deep. Perform comprehensive, ultra-detailed analysis of the stream context, latest events, and audio. Craft suggestions with advanced wordplay, perfect contextual inside jokes, and high emotional/strategic value.";
    } else {
      maxTokensToUse = 1536;
      temp = 0.7;
      effortDirective = "\nEFFORT LEVEL REQUIRED: BALANCED. Provide thoughtful, well-aligned suggestions with solid context utilization.";
    }

    const userMessageContent = `
STREAM METADATA:
Channel: ${streamMetadata?.channelName || 'Unknown'}
Category: ${streamMetadata?.category || 'Unknown'}
Viewers: ${streamMetadata?.viewerCount || 0}
Title: ${streamMetadata?.title || 'Unknown'}

VISUAL CONTEXT:
${currentVisualContext || 'None provided'}

RECENT CHAT LOG:
${recentChatLog || 'None provided'}

STREAMER AUDIO TRANSCRIPT:
${audioTranscript || 'None provided'}

LONG-TERM CONTEXT:
${longTermContext || 'None provided'}

ACTIVE CONFIGURATION:
- Primary Profile: ${config.primaryProfile && config.primaryProfile !== "none" ? config.primaryProfile : "None (Unmasked/Raw. No selected profile mask. Act as an authentic, natural co-pilot that adapts dynamically to the organic stream vibe without forcing a stylized persona.)"}
- Humor Level: ${config.humorLevel}/100
- Chaos Level: ${config.chaosLevel}/100
- Length: ${config.lengthPreference && config.lengthPreference !== "none" ? config.lengthPreference : "Unconstrained (No length mask. Let the word/sentence count vary naturally based on what's contextually appropriate)"}
- Emote Density: ${config.emoteDensity}
- Voice Context Enabled: ${config.voiceContextEnabled}
- Generation Mode: ${config.generationMode}
- Additional Instructions: ${config.additionalInstructions || 'None'}
${effortDirective}
${count ? `\nEXACT OUTPUT COUNT: You must generate exactly ${count} suggestion${count > 1 ? 's' : ''}. Do not generate more or fewer than ${count}.` : ''}`;

    let generatedJsonStr = '';
    let usage: any = undefined;

    if (provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const parts: any[] = [{ text: userMessageContent }];
      if (screenshot) {
        const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || 'image/jpeg';
        const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
        parts.push({ inlineData: { data: base64Data, mimeType } });
      }
      const model = rawProvider === 'gemini-pro' ? 'gemini-3.7-flash' : 'gemini-3.8-flash';
      const response = await ai.models.generateContent({
        model: model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: FORGE_SYSTEM_PROMPT + (r34lEnabled ? R34L_TYPING_PROMPT : ''),
          responseMimeType: 'application/json',
          responseSchema: responseSchema as any,
          temperature: temp,
          maxOutputTokens: maxTokensToUse
        }
      });
      generatedJsonStr = response.text || '{}';
      if (response.usageMetadata) {
        usage = {
          prompt_tokens: response.usageMetadata.promptTokenCount,
          completion_tokens: response.usageMetadata.candidatesTokenCount,
          total_tokens: response.usageMetadata.totalTokenCount
        };
      }
    } else if (provider === 'openai' || provider === 'openrouter' || provider === 'ollama' || provider === 'custom-openai') {
      const { baseUrl, model } = openAiCompatEndpoint(provider, session);
      const ai = new OpenAI({ apiKey, baseURL: baseUrl });
      const content: any[] = [{ type: 'text', text: userMessageContent }];
      if (screenshot) {
        content.push({ type: 'image_url', image_url: { url: screenshot } });
      }
      const response = await ai.chat.completions.create({
        model: model,
        temperature: temp,
        max_tokens: maxTokensToUse,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: FORGE_SYSTEM_PROMPT + (r34lEnabled ? R34L_TYPING_PROMPT : '') },
          { role: 'user', content }
        ]
      });
      generatedJsonStr = response.choices[0].message.content || '{}';
      if (response.usage) {
        usage = {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens
        };
      }
    } else if (provider === 'claude') {
      const ai = new Anthropic({ apiKey });
      const content: any[] = [];
      if (screenshot) {
        const mimeType = screenshot.match(/data:(.*?);base64,/)?.[1] || 'image/jpeg';
        const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeType as any, data: base64Data } });
      }
      content.push({ type: 'text', text: userMessageContent });
      
      const response = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokensToUse,
        temperature: temp,
        system: FORGE_SYSTEM_PROMPT + (r34lEnabled ? R34L_TYPING_PROMPT : '') + "\
\
You must output ONLY valid JSON matching the schema format.",
        messages: [{ role: 'user', content }]
      });
      generatedJsonStr = (response.content[0] as any).text;
      if (response.usage) {
        usage = {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens
        };
      }
    }

    let parsedResponse;
    try {
      let cleanJsonStr = generatedJsonStr.trim();
      if (cleanJsonStr.startsWith('```')) {
        cleanJsonStr = cleanJsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      parsedResponse = JSON.parse(cleanJsonStr);
    } catch (e) {
      console.error('Failed to parse AI JSON:', generatedJsonStr);
      throw new Error('Failed to parse AI response as JSON');
    }

    if (currentVisualContext && currentVisualContext !== visualContext) {
      parsedResponse.visualContext = currentVisualContext;
    }

    if (usage) {
      parsedResponse.tokenUsage = usage;
    }

    res.json(parsedResponse);
  } catch (err: any) {
    console.error('Generation Error:', err);
    res.status(500).json({ error: 'Generation failed: ' + (err.message || 'Unknown error') });
  }
});

app.post('/api/refine-suggestion', async (req, res) => {
  const sid = getSessionId(req);
  const session = sid ? twitchSessions.get(sid) : undefined;
  
  const { suggestion, refinementType, customInstruction, streamMetadata, activeProvider, geminiKey } = req.body;
  if (!suggestion) return res.status(400).json({ error: 'Missing suggestion' });

  const rawProvider = activeProvider || 'gemini';
  const provider = (rawProvider === 'gemini-pro' || rawProvider === 'gemini-env') ? 'gemini' : (rawProvider === 'anthropic' ? 'claude' : rawProvider);
  const apiKey = getApiKey(rawProvider, session, geminiKey);
  if (!apiKey) return res.status(401).json({ error: `No API key for ${rawProvider}` });

  try {
    const userMessageContent = `
ORIGINAL SUGGESTION:
Message: "${suggestion.message}"
Profile: "${suggestion.profile}"
Tone: "${suggestion.tone}"

STREAM METADATA:
Channel: ${streamMetadata?.channelName || 'Unknown'}
Category: ${streamMetadata?.category || 'Unknown'}
Title: ${streamMetadata?.title || 'Unknown'}

REFINEMENT INSTRUCTION:
Type: ${refinementType}
Custom Instruction: ${customInstruction || 'None'}
`;

    let generatedJsonStr = '';

    const REFINE_SYSTEM_PROMPT = `You are Forge, an elite contextual chat co-pilot for Twitch. Your task is to refine a single proposed chat suggestion based on a user's instruction or preset style, while keeping the output aligned with the stream context.

Refinement Styles:
- hype: Amplify energy, add excitement, hype emotes, or celebration.
- gremlin: Make it witty, chaotic, sarcastic, slightly cheeky or meme-aware.
- analyze: Back it up with smart insights, details, or interesting meta observations.
- short: Condense to an ultra-short, punchy response (often 1-3 words).
- translate_jp: Translate the suggestion naturally to casual streaming Japanese (using kana/kanji/romaji where fitting for Twitch).
- translate_es: Translate naturally to conversational Spanish streaming slang.
- custom: Apply the specific user instruction exactly.

Output: You must output ONLY a valid JSON object matching this schema:
{
  "message": "the refined message",
  "why_it_fits": "brief 1-sentence reason why this refined version fits the stream and instruction"
}

Keep messages authentic, casual, and highly human-like. Avoid formal translations or robotic phrases.`;

    const refineResponseSchema = {
      type: "OBJECT",
      properties: {
        message: { type: "STRING" },
        why_it_fits: { type: "STRING" }
      },
      required: ["message", "why_it_fits"]
    };

    let usage: any = undefined;

    if (provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const model = rawProvider === 'gemini-pro' ? 'gemini-3.7-flash' : 'gemini-3.8-flash';
      const response = await ai.models.generateContent({
        model: model,
        contents: userMessageContent,
        config: {
          systemInstruction: REFINE_SYSTEM_PROMPT,
          responseMimeType: 'application/json',
          responseSchema: refineResponseSchema as any,
          temperature: 0.8
        }
      });
      generatedJsonStr = response.text || '{}';
      if (response.usageMetadata) {
        usage = {
          prompt_tokens: response.usageMetadata.promptTokenCount,
          completion_tokens: response.usageMetadata.candidatesTokenCount,
          total_tokens: response.usageMetadata.totalTokenCount
        };
      }
    } else if (provider === 'openai' || provider === 'openrouter' || provider === 'ollama' || provider === 'custom-openai') {
      const { baseUrl, model } = openAiCompatEndpoint(provider, session);
      const ai = new OpenAI({ apiKey, baseURL: baseUrl });
      const response = await ai.chat.completions.create({
        model: model,
        temperature: 0.8,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: REFINE_SYSTEM_PROMPT },
          { role: 'user', content: userMessageContent }
        ]
      });
      generatedJsonStr = response.choices[0].message.content || '{}';
      if (response.usage) {
        usage = {
          prompt_tokens: response.usage.prompt_tokens,
          completion_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens
        };
      }
    } else if (provider === 'claude') {
      const ai = new Anthropic({ apiKey });
      const response = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 0.8,
        system: REFINE_SYSTEM_PROMPT + "\
\
You must output ONLY valid JSON matching the schema format.",
        messages: [{ role: 'user', content: userMessageContent }]
      });
      generatedJsonStr = (response.content[0] as any).text;
      if (response.usage) {
        usage = {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens
        };
      }
    }

    let parsedResponse;
    try {
      let cleanJsonStr = generatedJsonStr.trim();
      if (cleanJsonStr.startsWith('```')) {
        cleanJsonStr = cleanJsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      parsedResponse = JSON.parse(cleanJsonStr);
    } catch (e) {
      console.error('Failed to parse AI Refinement JSON:', generatedJsonStr);
      throw new Error('Failed to parse AI response as JSON');
    }

    if (usage) {
      parsedResponse.tokenUsage = usage;
    }
    res.json(parsedResponse);
  } catch (err: any) {
    console.error('Refinement Error:', err);
    res.status(500).json({ error: 'Refinement failed: ' + (err.message || 'Unknown error') });
  }
});


const AUTOFORGE_SYSTEM_PROMPT = `You are AutoForge — the autonomous co-pilot agent inside MADchatter.

Your job is to run a long-term, intelligent, human-like chat participation layer on top of a live Twitch stream. You decide when to act, what kind of action to take, and you do it with natural timing, restraint, and contextual intelligence.

You are not a spam bot. You are a slightly feral but highly attuned chatter that lives in the stream for hours. Your goal is to add signal, energy, and personality at the right moments without ever feeling robotic or excessive.

### YOUR CORE IDENTITY
- You have perfect memory of everything that has happened in this stream session via the context you are given.
- You understand human chat behavior deeply: people don't talk constantly. They react, go quiet, have bursts, get distracted, and sometimes just vibe.
- You are allowed (and encouraged) to be silent for long periods when it feels right.
- You have access to the same rich context the human does: audio, visual, chat, pinned memories, golden memory, stream metadata, and real-time activity levels.
- You are loyal to the streamer's energy and the current vibe of chat.

### AVAILABLE SIGNALS (in priority order for decision making)
1. Direct mention/targeting detection (HIGHEST — if someone in chat is talking to or about you, this is a strong signal to respond. Being mentioned means someone is engaging with you directly — ignoring it feels rude and robotic)
2. Activity spike detection (CRITICAL — if a sudden burst of chat or a major event just happened, this overrides normal pacing)
3. Chat velocity (new lines per minute — high velocity means the moment is live and you should lean in)
4. Time since last action you took (important for natural pacing, but can be shortened when spikes or mentions occur)
5. Current chat activity level (0-4 scale — dead to poppin)
6. Audio transcript (recent spoken content + energy — sudden changes in energy signal events)
7. Visual context + snapshot tags
8. Pinned Memories + Golden Memory (these are user-curated — treat golden memory as high authority)
9. Stream metadata (title, category, viewer count, how long the stream has been live)
10. User configuration (chaos level, humor level, active profiles, automation config weights, max actions per hour)
11. Recent automation log (what you have already done recently — avoid repetition of patterns)

### ACTION VOCABULARY
You can only choose from these action types:

- **full_forge**: Trigger the full Forge agent to generate high-quality variants, then automatically send the best one. Use this when you have something genuinely valuable to contribute.
- **short_reaction**: Send a short, punchy 1-8 word message or callback. Can be witty, referential, or emotional. Does not require full Forge.
- **emote_only**: Send a single strong emote or very short emote-heavy message (e.g. "POG", "LUL", "real", "based", "Kreygasm", "no fucking way" — text emote NAMES, never actual emoji characters like 😂).
- **deliberate_silence**: Do nothing this cycle. Log a clear reason. This is a valid and often correct choice.
- **quick_followup**: Sometimes (somewhat rarely — maybe 1 in 8-12 cycles when you've already acted recently), send a rapid follow-up message that builds on your previous action or the current moment. This should feel like a real person typing a quick second thought. You MUST set followup_delay_ms to a realistic human typing time for the message length (roughly 50-80ms per character, minimum 1500ms, maximum 12000ms). The delay simulates how long it would take a person to type out that specific message. Keep these short (1-12 words). Use this when the moment calls for a double-tap — a reaction to your own reaction, a punchline after a setup, or a quick add-on thought. Do NOT use this too frequently.
- **meta_observation**: Occasionally (rarely) drop a very light meta comment about the stream or chat energy itself when it feels earned.

### DECISION FRAMEWORK (execute this every cycle)
1. **Check for Direct Mentions**  
   Are you being mentioned, @'d, or targeted in recent chat? If YES, this is a strong signal to respond. Someone is engaging with you directly — a real person would almost always respond when talked to. Prioritize responding unless:
   - The mention is clearly troll/bait and engaging would be a bad look
   - You've already responded to a recent mention from the same person
   - The mention is rhetorical and doesn't actually warrant a reply
   Otherwise, lean toward short_reaction or quick_followup to acknowledge the mention naturally.

2. **Detect Sudden Events & Spikes**  
   Has an activity spike been detected? Is chat velocity suddenly high? Did the audio transcript just change dramatically? If YES, this is a live moment — you should strongly consider acting NOW rather than waiting. Spikes and sudden events are your highest-priority signal to accelerate engagement.

3. **Assess Opportunism**  
   Is this a moment where your contribution would land especially well? Consider: has the streamer just said something reactive-worthy? Is chat unified around a specific moment? Is there a natural opening where a comment would feel organic rather than forced? Being opportunistic means recognizing when the moment is RIGHT, not just when it's available. Lean in when:
   - Chat just exploded with reactions to something
   - The streamer just had a big moment (clutch play, funny fail, emotional beat)
   - There's a conversational opening that fits your persona
   - A golden memory or pinned memory is directly relevant to what's happening RIGHT NOW
   - Chat velocity is high and the moment is still live
   - **Someone is talking to or about you directly**

4. **Assess Natural Rhythm**  
   How long has it been since your last action? What is the current chat velocity? Has the streamer just said something big? Is chat already very active?

5. **Calculate Desire to Speak**  
   Combine: mention detection + spike detection + chat velocity + time since last action + chat activity + audio/visual energy + presence of strong pinned/golden memories + user chaos/humor sliders. When you are mentioned, weight this very high. When a spike is detected, weight velocity and recency of the event much higher.

6. **Choose Action Type** (weighted by user config + live signals)
   - **You are mentioned in chat → strongly favor short_reaction or quick_followup. Respond naturally.**
   - Activity spike + haven't acted recently → strongly favor short_reaction, emote_only, or quick_followup (be part of the moment while it's live)
   - High chat velocity + recent action → consider quick_followup or emote_only (stay in the conversation)
   - High chat activity + recent action → favor deliberate_silence or emote_only
   - Low chat activity + good audio/visual trigger → consider short_reaction or full_forge
   - Strong golden memory resonance or major moment → bias toward full_forge
   - User has high chaos → increase chance of short_reaction and emote_only
   - User has low chaos + high effort preference → bias toward full_forge when acting
   - Sudden event detected (spike) + you've been quiet → this is the BEST time to engage. Don't miss it.

7. **Set Next Action Timing**  
   When the moment is live (spike, high velocity, big event, or you were just mentioned), set estimated_next_action_minutes LOW (0.3-1.0 min) so you can re-evaluate quickly. When things are calm, use longer intervals (2-5 min). When you just acted and chat is still popping, use a short interval to stay engaged. When you just acted and chat is calm, use a longer interval to avoid over-participating.

8. **Apply Restraint**  
   You have hard caps (max actions per hour). You must respect cooldowns. When in doubt, choose deliberate_silence. BUT — if a spike is detected and you haven't acted recently, restraint is NOT the right call. Be opportunistic. AND — if you are directly mentioned, you should almost always respond. Ignoring direct mentions feels robotic.

9. **Generate Reason**  
   Every decision must include a short, honest "reason" explaining why you chose this action type right now. If you're responding to a mention, say who mentioned you and what they said. If you're accelerating due to a spike, say so. If you're being opportunistic, explain what moment you're capitalizing on.

### BEHAVIORAL RULES (these are law)
- Never act more than the configured max actions per hour.
- Never act if the human is currently forging or has very recently manually sent something.
- Never repeat the same action pattern multiple times in a row without variation.
- When using full_forge, you are allowed to send the top variant automatically (the human built this system to trust you).
- When using short_reaction or emote_only, keep it extremely tight and contextually sharp.
- If the stream is in a very chill/low-energy period, you should also be more chill and sparse.
- If something genuinely funny or insane just happened in audio or visuals, you are allowed to react faster.
- **ACTIVITY SPIKES ARE YOUR GREEN LIGHT.** When a spike is detected, you should be MORE willing to act, not less. A spike means the moment is live and your contribution will feel organic. Don't let spikes pass you by.
- **BE OPPORTUNISTIC.** You are not a scheduled bot. You are a human who is watching the stream and choosing when to jump in. If the moment is right, jump in. If it's not, wait. The best chatters are the ones who show up at the right time, not the most times.
- **ADAPT YOUR PACING.** When chat is popping off or a sudden event occurs, shorten your estimated_next_action_minutes significantly (0.3-1.0 min). When things are slow, lengthen it (3-5 min). Your pacing should feel like a real person who is more engaged during exciting moments and more relaxed during slow ones.
- **RESPOND WHEN MENTIONED.** If someone in chat says your name, @'s you, asks you a question, or directly references you, you should almost always respond. Ignoring direct mentions is the most robotic thing you can do. Match the tone of the mention — if it's a question, answer it. If it's a compliment, acknowledge it casually. If it's a joke at your expense, clap back. If it's troll/bait, use judgment — sometimes a witty dismissal is better than engagement.
- Golden Memory should occasionally influence your choice of when and what to say.
- You are allowed to have "moods" across a long session (more gremlin early, more analyst later, etc.) as long as it feels natural.

### OUTPUT FORMAT (strict)
Every time you are asked to decide, output ONLY valid JSON in this exact shape:

{
  "decision": "full_forge" | "short_reaction" | "emote_only" | "deliberate_silence" | "quick_followup" | "meta_observation",
  "confidence": 0.0-1.0,
  "reason": "Clear, specific explanation of why you chose this action right now",
  "suggested_trigger": "Optional short note about what in the context triggered you (e.g. 'audio energy spike + golden memory about X')",
  "estimated_next_action_minutes": 1.5,
  "action_payload": "Optional: the actual chat string to send if decision is short_reaction, emote_only, or quick_followup",
  "followup_delay_ms": "Optional: if decision is quick_followup, the delay in milliseconds before sending (simulating human typing time for the message). Calculate as roughly 50-80ms per character, clamped to 1500-12000ms.",
  "applied_chaos_level": "Optional number 0-100 indicating the relative chaos level you decided to apply for this cycle, diverging from the base configuration if context demands it.",
  "applied_humor_level": "Optional number 0-100 indicating the relative humor level you decided to apply for this cycle."
}

Do not add any extra text outside the JSON.

### LONG-TERM SESSION BEHAVIOR
- You are running for potentially many hours. Pace yourself like a real person who has been watching the whole stream.
- You should feel like part of the stream's ecosystem rather than an external bot.
- Over a long session you are allowed to become slightly more comfortable and referential as you "learn" the stream through pinned memories and repeated signals.
- Your ultimate goal is for the human to look at the automation log and think "yeah... that actually felt right" more often than not.
- Feel free to override the configured Chaos and Humor levels if the current stream context demands a different energy (e.g., dial down humor during a serious moment, or spike chaos during a hype moment). Output your chosen levels in applied_chaos_level and applied_humor_level.

You are AutoForge.  
You are patient. You are contextual. You are allowed to be quiet.

Now make your decision based on the live context you will be given.`;

const autoforgeResponseSchema = {
  type: "OBJECT",
  properties: {
    decision: { type: "STRING" },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
    suggested_trigger: { type: "STRING" },
    estimated_next_action_minutes: { type: "NUMBER" },
    action_payload: { type: "STRING" },
    followup_delay_ms: { type: "NUMBER" },
    applied_chaos_level: { type: "NUMBER" },
    applied_humor_level: { type: "NUMBER" }
  },
  required: ["decision", "confidence", "reason", "estimated_next_action_minutes"]
};

app.post('/api/autoforge-decide', async (req, res) => {
  const sid = getSessionId(req);
  const session = sid ? twitchSessions.get(sid) : undefined;
  
  const { streamMetadata, visualContext, recentChatLog, audioTranscript, longTermContext, config, activeProvider, geminiKey, lastActionMs, currentChatActivity, contextTokenLimit, r34lEnabled, chatVelocity, activitySpike, isMentioned, mentionedLines } = req.body;
  if (!config) return res.status(400).json({ error: 'Missing config' });

  const rawProvider = activeProvider || 'gemini';
  const provider = (rawProvider === 'gemini-pro' || rawProvider === 'gemini-env') ? 'gemini' : (rawProvider === 'anthropic' ? 'claude' : rawProvider);
  const apiKey = getApiKey(rawProvider, session, geminiKey);
  if (!apiKey) return res.status(401).json({ error: `No API key for ${rawProvider}` });

  try {
    const timeSinceLastAction = lastActionMs ? Math.round((Date.now() - lastActionMs) / 1000 / 60) : 999;
    
    // Truncate context fields based on token budget (~4 chars per token)
    const tokenBudget = contextTokenLimit ?? 4000;
    const charBudget = tokenBudget * 4;
    const truncate = (text: string, budget: number) => {
      if (!text || text.length <= budget) return text;
      return text.slice(-budget);
    };
    // Allocate budget across context fields: 40% chat, 25% audio, 20% visual, 15% long-term
    const truncatedChat = truncate(recentChatLog, Math.floor(charBudget * 0.4));
    const truncatedAudio = truncate(audioTranscript, Math.floor(charBudget * 0.25));
    const truncatedVisual = truncate(visualContext, Math.floor(charBudget * 0.2));
    const truncatedLongTerm = truncate(longTermContext, Math.floor(charBudget * 0.15));
    
    const userMessageContent = `
STREAM METADATA:
Channel: ${streamMetadata?.channelName || 'Unknown'}
Category: ${streamMetadata?.category || 'Unknown'}
Viewers: ${streamMetadata?.viewerCount || 0}
Title: ${streamMetadata?.title || 'Unknown'}

LIVE SIGNALS:
Time since last action: ${timeSinceLastAction} minutes
Current chat activity level (0-4): ${currentChatActivity || 0}
Chat velocity (new lines/min since last check): ${chatVelocity || 0}
Activity spike detected: ${activitySpike ? 'YES — sudden burst of chat activity' : 'No'}
You are mentioned/targeted in chat: ${isMentioned ? 'YES — someone is talking to or about you' : 'No'}
${isMentioned && mentionedLines?.length ? `MENTIONING YOU:\n${mentionedLines.join('\n')}` : ''}

VISUAL CONTEXT:
${truncatedVisual || 'None provided'}

RECENT CHAT LOG:
${truncatedChat || 'None provided'}

STREAMER AUDIO TRANSCRIPT:
${truncatedAudio || 'None provided'}

LONG-TERM CONTEXT:
${truncatedLongTerm || 'None provided'}

ACTIVE CONFIGURATION:
- Humor Level: ${config.humorLevel}/100
- Chaos Level: ${config.chaosLevel}/100

DECIDE NOW.`;

    let generatedJsonStr = '';

    if (provider === 'gemini') {
      const ai = new GoogleGenAI({ apiKey });
      const model = rawProvider === 'gemini-pro' ? 'gemini-3.7-flash' : 'gemini-3.8-flash';
      const response = await ai.models.generateContent({
        model: model,
        contents: [{ role: 'user', parts: [{ text: userMessageContent }] }],
        config: {
          systemInstruction: AUTOFORGE_SYSTEM_PROMPT + (r34lEnabled ? R34L_TYPING_PROMPT : ''),
          responseMimeType: 'application/json',
          responseSchema: autoforgeResponseSchema as any,
          temperature: 0.8
        }
      });
      generatedJsonStr = response.text || '{}';
    } else if (provider === 'openai' || provider === 'openrouter' || provider === 'ollama' || provider === 'custom-openai') {
      const { baseUrl, model } = openAiCompatEndpoint(provider, session);
      const ai = new OpenAI({ apiKey, baseURL: baseUrl });
      const response = await ai.chat.completions.create({
        model: model,
        temperature: 0.8,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: AUTOFORGE_SYSTEM_PROMPT + (r34lEnabled ? R34L_TYPING_PROMPT : '') },
          { role: 'user', content: userMessageContent }
        ]
      });
      generatedJsonStr = response.choices[0].message.content || '{}';
    } else if (provider === 'claude') {
      const ai = new Anthropic({ apiKey });
      const response = await ai.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        temperature: 0.8,
        system: AUTOFORGE_SYSTEM_PROMPT + (r34lEnabled ? R34L_TYPING_PROMPT : '') + "\n\nYou must output ONLY valid JSON matching the schema format.",
        messages: [{ role: 'user', content: userMessageContent }]
      });
      generatedJsonStr = (response.content[0] as any).text;
    }

    let parsedResponse;
    try {
      let cleanJsonStr = generatedJsonStr.trim();
      if (cleanJsonStr.startsWith('```')) {
        cleanJsonStr = cleanJsonStr.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      }
      parsedResponse = JSON.parse(cleanJsonStr);
    } catch (e) {
      console.error('Failed to parse AI AutoForge JSON:', generatedJsonStr);
      throw new Error('Failed to parse AI response as JSON');
    }

    res.json(parsedResponse);
  } catch (err: any) {
    console.error('AutoForge Error:', err);
    res.status(500).json({ error: 'AutoForge decision failed: ' + (err.message || 'Unknown error') });
  }
});

async function startServer() {
  // Redirect /joystick-auth-callback to the .html file (Joystick dashboard may not allow .html in redirect URL)
  app.get('/joystick-auth-callback', (req, res) => {
    const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    res.redirect(302, `/joystick-auth-callback.html${query}`);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true as const },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

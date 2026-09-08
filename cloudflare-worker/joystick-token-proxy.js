// Cloudflare Worker — Joystick.tv API Proxy (ES Module format)
// Deploy via Cloudflare Dashboard → Workers & Pages → Create Worker → Paste this code
// Routes:
//   POST /token    → token exchange (api.joystick.tv/api/oauth/token)
//   POST /refresh  → token refresh (api.joystick.tv/api/oauth/token)
//   GET  /stream-settings → stream settings (api.joystick.tv/api/users/stream-settings)
//   GET  /channel-info/:id → channel info by ID (api.joystick.tv/api/channels/:id)
//   GET  /bot-info/:id     → bot info by ID (tries /api/bots/:id, /api/users/:id)

const JOYSTICK_TOKEN_URL = "https://api.joystick.tv/api/oauth/token";
const JOYSTICK_API_BASE = "https://api.joystick.tv/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Basic-Auth",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Token exchange (POST /token)
    if (url.pathname === "/token" && request.method === "POST") {
      return handleTokenExchange(request);
    }

    // Token refresh (POST /refresh)
    if (url.pathname === "/refresh" && request.method === "POST") {
      return handleTokenRefresh(request);
    }

    // Stream settings (GET /stream-settings) — requires basic auth, not JWT
    if (url.pathname === "/stream-settings" && request.method === "GET") {
      return handleStreamSettings(request);
    }

    // Channel info by ID (GET /channel-info/:id)
    const channelMatch = url.pathname.match(/^\/channel-info\/(.+)$/);
    if (channelMatch && request.method === "GET") {
      return handleProxyGet(request, JOYSTICK_API_BASE + "/channels/" + channelMatch[1]);
    }

    // Bot info by ID (GET /bot-info/:id) — tries multiple API paths
    const botMatch = url.pathname.match(/^\/bot-info\/(.+)$/);
    if (botMatch && request.method === "GET") {
      return handleBotInfo(request, botMatch[1]);
    }

    // Echo testing (POST /echo) — sends a test message to the bot over WebSocket
    if (url.pathname === "/echo" && request.method === "POST") {
      return handleEcho(request);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  },
};

function corsResponse(body, status) {
  return new Response(body, {
    status: status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

async function handleTokenExchange(request) {
  try {
    const body = await request.json();
    const { code, client_id, client_secret } = body;

    if (!code || !client_id) {
      return corsResponse(JSON.stringify({ error: "Missing code or client_id" }), 400);
    }

    const secret = client_secret || "";
    const basicAuthKey = btoa(`${client_id}:${secret}`);

    const params = new URLSearchParams();
    params.set("redirect_uri", "unused");
    params.set("code", code);
    params.set("grant_type", "authorization_code");

    const tokenRes = await fetch(JOYSTICK_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuthKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: params.toString(),
    });

    const tokenText = await tokenRes.text();
    return corsResponse(tokenText, tokenRes.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

async function handleTokenRefresh(request) {
  try {
    const body = await request.json();
    const { refresh_token, client_id, client_secret } = body;

    if (!refresh_token || !client_id) {
      return corsResponse(JSON.stringify({ error: "Missing refresh_token or client_id" }), 400);
    }

    const secret = client_secret || "";
    const basicAuthKey = btoa(`${client_id}:${secret}`);

    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("refresh_token", refresh_token);

    const tokenRes = await fetch(JOYSTICK_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuthKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: params.toString(),
    });

    const tokenText = await tokenRes.text();
    return corsResponse(tokenText, tokenRes.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

async function handleStreamSettings(request) {
  try {
    // Stream settings requires basic auth (client_id:client_secret)
    // Extract from the request body or use query params, or derive from Authorization header
    const authHeader = request.headers.get("Authorization");
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };
    
    // If we have a Bearer token, try it first, then fall back to basic auth
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    
    // Try with Bearer token first
    let res = await fetch(JOYSTICK_API_BASE + "/users/stream-settings", { headers });
    
    // If 401, try with basic auth using client_id from query param or default
    if (res.status === 401) {
      const url = new URL(request.url);
      const clientId = url.searchParams.get("client_id") || "77147cc4-499a-469c-b8ac-b0bfed2336f2";
      const clientSecret = url.searchParams.get("client_secret") || "hT4eRDiAs5jhyOJbgup-JQ";
      const basicAuthKey = btoa(`${clientId}:${clientSecret}`);
      
      const basicHeaders = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Authorization": `Basic ${basicAuthKey}`,
      };
      // Also pass the Bearer token as a separate header if available
      if (authHeader && authHeader.startsWith("Bearer ")) {
        basicHeaders["X-Access-Token"] = authHeader.replace("Bearer ", "");
      }
      
      console.log("[StreamSettings] Bearer returned 401, retrying with basic auth");
      res = await fetch(JOYSTICK_API_BASE + "/users/stream-settings", { headers: basicHeaders });
    }
    
    const text = await res.text();
    console.log(`[StreamSettings] Final response: ${res.status}`);
    return corsResponse(text, res.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

async function handleProxyGet(request, targetUrl) {
  try {
    const authHeader = request.headers.get("Authorization");
    const headers = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    };
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const res = await fetch(targetUrl, { headers });
    const text = await res.text();
    console.log(`[ProxyGet] ${targetUrl} → ${res.status}: ${text.substring(0, 200)}`);
    return corsResponse(text, res.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

async function handleBotInfo(request, botId) {
  // Try multiple API paths with both bearer and basic auth
  const authHeader = request.headers.get("Authorization");
  const basicAuthHeader = request.headers.get("X-Basic-Auth");

  const paths = [
    `/bots/${botId}`,
    `/users/${botId}`,
    `/bots/me`,
  ];

  const authHeaders = [];
  if (authHeader) authHeaders.push(authHeader);
  if (basicAuthHeader) authHeaders.push(`Basic ${basicAuthHeader}`);

  for (const path of paths) {
    for (const auth of authHeaders.length > 0 ? authHeaders : [null]) {
      try {
        const headers = {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        };
        if (auth) headers["Authorization"] = auth;

        const res = await fetch(JOYSTICK_API_BASE + path, { headers });
        if (res.ok) {
          const text = await res.text();
          return corsResponse(text, 200);
        }
        console.log(`[BotInfo] ${path} with ${auth ? auth.substring(0, 20) : 'no auth'} returned ${res.status}`);
      } catch (e) {
        // try next
      }
    }
  }

  return corsResponse(JSON.stringify({ error: "Bot not found", botId }), 404);
}

async function handleEcho(request) {
  try {
    const body = await request.json();
    const { client_id, client_secret, sample } = body;

    if (!client_id) {
      return corsResponse(JSON.stringify({ error: "Missing client_id" }), 400);
    }

    const secret = client_secret || "";
    const basicAuthKey = btoa(`${client_id}:${secret}`);

    const res = await fetch("https://api.joystick.tv/echo", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basicAuthKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      body: JSON.stringify({ sample: sample || { event: "SendMessage", data: "!test 123" } }),
    });

    const text = await res.text();
    return corsResponse(text, res.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

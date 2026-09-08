// Cloudflare Worker — Kick API Proxy (Service Worker format)
// Deploy via Cloudflare Dashboard → Workers & Pages → Create Worker → Paste this code
// Routes:
//   POST /              → token exchange (id.kick.com/oauth/token)
//   POST /refresh       → token refresh (id.kick.com/oauth/token)
//   GET  /users         → user info (api.kick.com/public/v1/users)
//   POST /chat          → send chat (api.kick.com/public/v1/chat)
//   GET  /channel/*     → channel info (kick.com/api/v1/channels/*)
//   GET  /v2/channel/*  → channel info (kick.com/api/v2/channels/*)

const KICK_TOKEN_URL = "https://id.kick.com/oauth/token";
const KICK_API_BASE = "https://api.kick.com/public/v1";
const KICK_LEGACY_API = "https://kick.com/api/v1";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    event.respondWith(new Response(null, { headers: CORS_HEADERS }));
    return;
  }

  // Token exchange (POST /)
  if (url.pathname === "/" && request.method === "POST") {
    event.respondWith(handleTokenExchange(request));
    return;
  }

  // Token refresh (POST /refresh)
  if (url.pathname === "/refresh" && request.method === "POST") {
    event.respondWith(handleTokenRefresh(request));
    return;
  }

  // User info (GET /users)
  if (url.pathname === "/users" && request.method === "GET") {
    event.respondWith(handleProxyGet(request, KICK_API_BASE + "/users"));
    return;
  }

  // Send chat (POST /chat)
  if (url.pathname === "/chat" && request.method === "POST") {
    event.respondWith(handleProxyPost(request, KICK_API_BASE + "/chat"));
    return;
  }

  // Channel info via public API (GET /channels?slug=xxx)
  if (url.pathname === "/channels" && request.method === "GET") {
    const search = url.search; // includes ?slug=xxx
    event.respondWith(handleProxyGet(request, KICK_API_BASE + "/channels" + search));
    return;
  }

  // Channel info via legacy API (GET /channel/:slug)
  if (url.pathname.startsWith("/channel/") && request.method === "GET") {
    const slug = url.pathname.replace("/channel/", "");
    event.respondWith(handleProxyGet(request, KICK_LEGACY_API + "/channels/" + slug));
    return;
  }

  // Channel info via v2 API (GET /v2/channel/:slug)
  if (url.pathname.startsWith("/v2/channel/") && request.method === "GET") {
    const slug = url.pathname.replace("/v2/channel/", "");
    event.respondWith(handleProxyGet(request, "https://kick.com/api/v2/channels/" + slug));
    return;
  }

  event.respondWith(new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  }));
});

function corsResponse(body, status) {
  return new Response(body, {
    status: status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

async function handleProxyGet(request, targetUrl) {
  try {
    const authHeader = request.headers.get("Authorization");
    const headers = {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Referer": "https://kick.com/",
      "Origin": "https://kick.com",
    };
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const res = await fetch(targetUrl, {
      headers: headers,
    });
    const text = await res.text();
    if (!res.ok) {
      console.log("[kick-proxy] GET " + targetUrl + " status: " + res.status + " body: " + text.substring(0, 500));
    }
    return corsResponse(text, res.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

async function handleProxyPost(request, targetUrl) {
  try {
    const authHeader = request.headers.get("Authorization");
    const body = await request.text();
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Referer": "https://kick.com/",
      "Origin": "https://kick.com",
    };
    if (authHeader) {
      headers["Authorization"] = authHeader;
    }
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: headers,
      body: body,
    });
    const text = await res.text();
    if (!res.ok) {
      console.log("[kick-proxy] POST " + targetUrl + " status: " + res.status + " body: " + text.substring(0, 500));
    }
    return corsResponse(text, res.status);
  } catch (e) {
    return corsResponse(JSON.stringify({ error: e.message || "Proxy error" }), 500);
  }
}

async function handleTokenExchange(request) {
  try {
    const body = await request.json();
    const { code, redirect_uri, code_verifier, client_id, client_secret } = body;

    if (!code || !redirect_uri || !code_verifier || !client_id || !client_secret) {
      return corsResponse(JSON.stringify({ error: "Missing required parameters" }), 400);
    }

    const params = new URLSearchParams();
    params.set("grant_type", "authorization_code");
    params.set("client_id", client_id);
    params.set("client_secret", client_secret);
    params.set("code", code);
    params.set("redirect_uri", redirect_uri);
    params.set("code_verifier", code_verifier);

    const tokenRes = await fetch(KICK_TOKEN_URL, {
      method: "POST",
      headers: {
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

    if (!refresh_token || !client_id || !client_secret) {
      return corsResponse(JSON.stringify({ error: "Missing required parameters: refresh_token, client_id, client_secret" }), 400);
    }

    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("client_id", client_id);
    params.set("client_secret", client_secret);
    params.set("refresh_token", refresh_token);

    const tokenRes = await fetch(KICK_TOKEN_URL, {
      method: "POST",
      headers: {
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


// Deno Deploy — Kick API Proxy
// Deploy: deno deploy --project=<your-project> --entrypoint=deno/kick-proxy.ts
// Or:    deploy from GitHub at https://dash.deno.com
//
// Routes:
//   POST /           → token exchange (id.kick.com/oauth/token)
//   GET  /users      → user info (api.kick.com/public/v1/users)
//   POST /chat       → send chat (api.kick.com/public/v1/chat)
//   GET  /channel    → channel info (kick.com/api/v1/channels/:slug)  ?slug=xxx

const KICK_TOKEN_URL = "https://id.kick.com/oauth/token";
const KICK_API_BASE = "https://api.kick.com/public/v1";
const KICK_LEGACY_API = "https://kick.com/api/v1";

const BROWSER_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Referer": "https://kick.com/",
  "Origin": "https://kick.com",
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonRes(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/+/, "") || "/";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // Token exchange: POST /
  if (path === "/" && req.method === "POST") {
    try {
      const body = await req.json();
      const { code, redirect_uri, code_verifier, client_id, client_secret } = body;

      if (!code || !redirect_uri || !code_verifier || !client_id || !client_secret) {
        return jsonRes(JSON.stringify({ error: "Missing required parameters" }), 400);
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
          ...BROWSER_HEADERS,
        },
        body: params.toString(),
      });

      const tokenText = await tokenRes.text();
      return jsonRes(tokenText, tokenRes.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: (e as Error).message || "Proxy error" }), 500);
    }
  }

  // User info: GET /users
  if (path === "users" && req.method === "GET") {
    try {
      const authHeader = req.headers.get("Authorization");
      const headers = { ...BROWSER_HEADERS };
      if (authHeader) headers["Authorization"] = authHeader;
      const res = await fetch(`${KICK_API_BASE}/users`, { headers });
      const text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: (e as Error).message || "Proxy error" }), 500);
    }
  }

  // Send chat: POST /chat
  if (path === "chat" && req.method === "POST") {
    try {
      const authHeader = req.headers.get("Authorization");
      const headers: Record<string, string> = { "Content-Type": "application/json", ...BROWSER_HEADERS };
      if (authHeader) headers["Authorization"] = authHeader;
      const body = await req.text();
      const res = await fetch(`${KICK_API_BASE}/chat`, {
        method: "POST",
        headers,
        body,
      });
      const text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: (e as Error).message || "Proxy error" }), 500);
    }
  }

  // Channel info via public API: GET /channels?slug=xxx
  if (path === "channels" && req.method === "GET") {
    try {
      const slug = url.searchParams.get("slug");
      if (!slug) return jsonRes(JSON.stringify({ error: "Missing slug parameter" }), 400);
      const authHeader = req.headers.get("Authorization");
      const headers = { ...BROWSER_HEADERS };
      if (authHeader) headers["Authorization"] = authHeader;
      const res = await fetch(`${KICK_API_BASE}/channels?slug=${encodeURIComponent(slug)}`, { headers });
      const text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: (e as Error).message || "Proxy error" }), 500);
    }
  }

  // Channel info via legacy API: GET /channel?slug=xxx
  if (path === "channel" && req.method === "GET") {
    try {
      const slug = url.searchParams.get("slug");
      if (!slug) return jsonRes(JSON.stringify({ error: "Missing slug parameter" }), 400);
      const res = await fetch(`${KICK_LEGACY_API}/channels/${encodeURIComponent(slug)}`, {
        headers: BROWSER_HEADERS,
      });
      const text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: (e as Error).message || "Proxy error" }), 500);
    }
  }

  return jsonRes(JSON.stringify({ error: "Not found" }), 404);
}

Deno.serve(handler);

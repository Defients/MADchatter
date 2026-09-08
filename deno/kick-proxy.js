// Deno Deploy Playground — Kick API Proxy
// Paste this entire file into the playground at https://dash.deno.com

const KICK_TOKEN_URL = "https://id.kick.com/oauth/token";
const KICK_API_BASE = "https://api.kick.com/public/v1";
const KICK_LEGACY_API = "https://kick.com/api/v1";

const BROWSER_HEADERS = {
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
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

function jsonRes(body, status) {
  if (status === undefined) status = 200;
  return new Response(body, {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders()),
  });
}

async function handler(req) {
  const url = new URL(req.url);
  var path = url.pathname.replace(/^\/+/, "") || "/";

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // Token exchange: POST /
  if (path === "/" && req.method === "POST") {
    try {
      const body = await req.json();
      var params = new URLSearchParams();
      params.set("grant_type", "authorization_code");
      params.set("client_id", body.client_id);
      params.set("client_secret", body.client_secret);
      params.set("code", body.code);
      params.set("redirect_uri", body.redirect_uri);
      params.set("code_verifier", body.code_verifier);

      var tokenHeaders = Object.assign(
        { "Content-Type": "application/x-www-form-urlencoded" },
        BROWSER_HEADERS
      );

      var tokenRes = await fetch(KICK_TOKEN_URL, {
        method: "POST",
        headers: tokenHeaders,
        body: params.toString(),
      });

      var tokenText = await tokenRes.text();
      return jsonRes(tokenText, tokenRes.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: String(e) }), 500);
    }
  }

  // User info: GET /users
  if (path === "users" && req.method === "GET") {
    try {
      var authHeader = req.headers.get("Authorization");
      var userHeaders = Object.assign({}, BROWSER_HEADERS);
      if (authHeader) userHeaders["Authorization"] = authHeader;
      var res = await fetch(KICK_API_BASE + "/users", { headers: userHeaders });
      var text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: String(e) }), 500);
    }
  }

  // Send chat: POST /chat
  if (path === "chat" && req.method === "POST") {
    try {
      var authHeader = req.headers.get("Authorization");
      var chatHeaders = Object.assign({ "Content-Type": "application/json" }, BROWSER_HEADERS);
      if (authHeader) chatHeaders["Authorization"] = authHeader;
      var body = await req.text();
      var res = await fetch(KICK_API_BASE + "/chat", {
        method: "POST",
        headers: chatHeaders,
        body: body,
      });
      var text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: String(e) }), 500);
    }
  }

  // Channel info via public API: GET /channels?slug=xxx
  if (path === "channels" && req.method === "GET") {
    try {
      var slug = url.searchParams.get("slug");
      if (!slug) return jsonRes(JSON.stringify({ error: "Missing slug parameter" }), 400);
      var authHeader = req.headers.get("Authorization");
      var chHeaders = Object.assign({}, BROWSER_HEADERS);
      if (authHeader) chHeaders["Authorization"] = authHeader;
      var res = await fetch(
        KICK_API_BASE + "/channels?slug=" + encodeURIComponent(slug),
        { headers: chHeaders }
      );
      var text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: String(e) }), 500);
    }
  }

  // Channel info via legacy API: GET /channel?slug=xxx
  if (path === "channel" && req.method === "GET") {
    try {
      var slug = url.searchParams.get("slug");
      if (!slug) return jsonRes(JSON.stringify({ error: "Missing slug parameter" }), 400);
      var res = await fetch(
        KICK_LEGACY_API + "/channels/" + encodeURIComponent(slug),
        { headers: BROWSER_HEADERS }
      );
      var text = await res.text();
      return jsonRes(text, res.status);
    } catch (e) {
      return jsonRes(JSON.stringify({ error: String(e) }), 500);
    }
  }

  return jsonRes(JSON.stringify({ error: "Not found" }), 404);
}

Deno.serve(handler);

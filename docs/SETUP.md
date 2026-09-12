# Setup and troubleshooting

[← Back to the README](../README.md)

This guide distinguishes the browser app, the optional Express backend, and the external services used by the current integrations. It describes the source in this checkout; live platform login and provider availability require separate verification.

## Local browser app

Use Node.js **22.12 or newer** with npm. The locked React Vite plugin requires Node `^20.19.0 || >=22.12.0`; the README uses the Node 22 line as its baseline.

```sh
npm ci
npm run dev
```

Open the exact URL Vite prints. Its normal port is **5173**, but it may choose another if that port is occupied. Changing between `localhost`, `127.0.0.1`, or ports changes the browser origin and therefore the saved settings and sessions you see.

The frontend loads AI credentials from **Settings → API Config**. Its normal generation path calls provider SDKs from the browser. A server environment key does not automatically configure this path.

### First-session checklist

1. Choose an AI provider, enter its key, and use **Save Keys**. Selecting Ollama requires an endpoint and model instead of a cloud key.
2. Connect the intended platform account and enter a channel.
3. Select the stream through **Capture**. For stream audio, share audio in the browser's capture chooser; transcription also needs a working Deepgram or local Whisper path.
4. Set persona and context, then Forge a batch and review it before sending.
5. To explore autonomous behavior, turn on **Dry Run** in the HUD before enabling AutoForge. AI requests may still incur charges, and manual sends remain active.

The Forge setup checklist includes authentication, channel, provider, and capture. Desktop capture capability depends on the browser, operating system, and selected capture source.

## Ollama / local models

Install [Ollama](https://ollama.com/) and download a model suitable for your hardware. The app currently prefills `qwen3.5:9b`; to use that tag:

```sh
ollama pull qwen3.5:9b
```

In **Settings → API Config**, select **Ollama**, then set:

| Setting | Value |
| --- | --- |
| Custom API Base URL | `http://localhost:11434/v1` |
| Custom Model Name | The exact downloaded tag, such as `qwen3.5:9b`. |

Click **Save Keys**. The green Ollama indicator means no key is required; it is not a successful connection or model-health test.

If the browser reports an origin/CORS error, allow the actual MADchatter origin. For a PowerShell session using Vite on port 5173, first quit an existing Ollama tray/server instance, then run:

```powershell
$env:OLLAMA_ORIGINS = "http://localhost:5173"
ollama serve
```

For a POSIX shell:

```sh
OLLAMA_ORIGINS=http://localhost:5173 ollama serve
```

Substitute the app's actual origin if different. These examples set the variable for the launched process; a separately managed Ollama service needs its own environment configuration. Ollama documents this in its [environment and origin configuration guide](https://docs.ollama.com/faq). Its [OpenAI-compatible API documentation](https://docs.ollama.com/api/openai-compatibility) describes the `/v1` endpoint.

Choose a model that can return the structured output MADchatter expects. Vision features additionally need a model that accepts images. A downloaded text model alone does not establish vision support.

Local inference does not make the whole app offline. Platform chat, emotes, model downloads, cloud transcription or speech, and fallback providers can still use the network. In fallback-enabled paths, configured cloud keys can allow a request to leave the local endpoint.

## Optional Express backend

`server.ts` contains OAuth/session, token-exchange, generation, vision, and send routes. It uses `dotenv/config`, which loads **`.env` by default**, and listens on `PORT` or **3000**.

For backend work, copy [`.env.example`](../.env.example) to a private `.env` and fill only the variables needed for your integration. If `.env` already exists, edit it rather than overwriting it. This template configures backend paths; it does not populate browser Settings.

| Variable | Backend use |
| --- | --- |
| `PORT` | Listening port; defaults to `3000`. |
| `NODE_ENV` | Development serves the UI through Vite; `production` serves the built `dist/` directory. |
| `APP_URL` | Base URL used to construct the backend Twitch callback when no explicit redirect is supplied. |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Credentials for the backend Twitch authorization-code flow. |
| `TWITCH_REDIRECT_URI` | Explicit backend Twitch callback; otherwise `APP_URL` plus `/auth/callback`, or `http://localhost:3000/auth/callback`. |
| `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` | Fallback credentials for the backend Kick token-exchange route. |
| `JOYSTICK_CLIENT_ID`, `JOYSTICK_CLIENT_SECRET` | Fallback credentials for the backend Joystick token-exchange route. |
| `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` | Provider-key fallbacks for backend generation routes. |
| `DEEPGRAM_API_KEY` | Used by the backend key retrieval route. |

Start the backend with:

```sh
npm run server
```

In development, this command also serves the frontend using Vite middleware. Open `http://localhost:3000` unless you changed `PORT`. You do not need a second Vite process for this mode.

If you run `npm run dev` separately, its `/api` proxy targets `http://localhost:3000`. Changing the backend port also requires adjusting that proxy. The current browser login and generation paths do not automatically switch to the backend's corresponding routes.

**Current backend limitations:** sessions live in process memory and are lost on restart. Express is present in the lockfile through the dependency tree but is not declared directly in `package.json`, despite the import in `server.ts`; resolve that dependency declaration before packaging the backend independently.

## Authentication and hosting

The current browser integrations have deployment-specific dependencies:

| Integration | Current browser flow |
| --- | --- |
| Twitch | Login redirects to the project-hosted `https://madchatter.fun/auth-callback.html` page. Settings can change the client ID, but the hook's callback URL is fixed. |
| Kick | Login redirects to `https://madchatter.fun/kick-auth-callback.html`. Token operations use an external proxy by default. |
| Joystick | Uses its callback and external proxy flow. Its send path currently uses one platform identity. |

Public frontend configuration includes `VITE_TWITCH_CLIENT_ID`, `VITE_KICK_CLIENT_ID`, `VITE_JOYSTICK_CLIENT_ID`, `VITE_KICK_TOKEN_PROXY`, and `VITE_JOYSTICK_TOKEN_PROXY`. Client IDs can also be supplied in Settings. Changing proxy variables requires restarting Vite or rebuilding the frontend.

**Values prefixed with `VITE_` are browser configuration, not secret storage.** The current source also contains client-secret defaults and browser-side token-exchange handling. An independent deployment needs those credentials and exchange paths reviewed and moved behind an appropriate server boundary; do not put fresh private secrets in frontend variables.

For independent hosting, review callback URLs, provider app registrations, callback message handling, proxy endpoints, credential handling, and token refresh together. Setting `APP_URL` or backend client IDs alone does not reconfigure the frontend. The included Express routes and proxy implementations are source material for that work, not proof that a new deployment is ready.

The frontend build goes into `dist/`:

```sh
npm run lint
npm run build
npm run preview
```

`preview` serves the built frontend locally. It does not deploy the app, start the Express backend, or provision OAuth/proxy services.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Installation fails with a Node engine error | Use Node 22.12 or newer, then retry `npm ci`. |
| AI is unconfigured after editing an environment file | Enter the provider key in the browser app's Settings and click Save Keys. |
| Provider returns a model or access error | Confirm your account has access to the requested model. OpenRouter and Ollama expose a custom model field; other providers use identifiers selected by the code/UI. |
| Ollama is green but requests fail | Confirm the server is running, the model tag is downloaded, the endpoint ends in `/v1`, and the browser origin is allowed. |
| Login popup fails or never returns | Allow popups and check the registered callback, project callback availability, and configured proxy. Local startup alone does not make authentication local. |
| A second bot signs in as the first account | Switch accounts on the platform's authorization page before approving the next bot identity. |
| Multi-bot mode is enabled but the single-bot loop runs | At least two bots must be active and authenticated. Joystick does not have a per-bot send path. |
| No stream audio is transcribed | Check audio sharing in the capture chooser and the transcription provider. Local Whisper downloads model files and attempts WebGPU, with a fallback path when initialization fails. |
| AutoForge is quiet | Inspect the HUD for Dry Run, confidence decisions, cooldowns, connection state, stream status, and deliberate silence. |
| Settings or memories appear missing | Check the browser profile and exact site origin. Clearing site data removes persisted data. |

When reporting a problem, include the app revision, browser/OS, platform, provider/model, reproduction steps, and a redacted error message. Say whether it occurs in single-bot or multi-bot mode and whether Dry Run was enabled. Never include live keys or tokens.

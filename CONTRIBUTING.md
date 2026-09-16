# Contributing to MADchatter

[← Back to the README](README.md)

MADchatter combines live chat, AI providers, browser media, and autonomous message sending. Useful contributions make those workflows clearer, more reliable, and easier to control.

## Start with a focused change

- For a bug, describe the trigger, expected behavior, actual behavior, and steps to reproduce it.
- For UI or documentation improvements, include a screenshot or a concrete before/after example when it helps.
- Discuss new features before implementing them. Prefer focused fixes and polish; avoid unrelated refactors.
- Check the repository's [MIT License](LICENSE) before proposing reuse or redistribution.

## Local development

Follow the [setup guide](docs/SETUP.md). Use Node 22.12 or newer and install from the lockfile with `npm ci`.

Before considering a change complete, run:

```sh
npm run lint
npm test
npm run build
```

All three commands must exit successfully. `lint` is TypeScript checking only. `npm test` discovers the TypeScript regression suites and runs them in isolated processes, plus the channel-switch, manual-send, platform-send, rule-engine, and send-cancellation integration harnesses. Each suite has a two-minute timeout; failures return a nonzero exit code and include diagnostic output. Platform delivery is replaced with local fakes in the integration harnesses. Browser externalization warnings from the Anthropic SDK, mixed dynamic/static import warnings, and large-chunk warnings are known build messages documented in [AGENTS.md](AGENTS.md).

Manually verify the behavior you changed. For UI changes, check layout and interaction in the relevant desktop viewport. For platform or AutoForge changes, distinguish simulated or Dry Run behavior from authenticated delivery. Use a channel/account you are authorized to test, and state which provider/platform paths you actually exercised.

## Preserve these contracts

- **Single-bot compatibility:** Multi-Bot Mode is additive. Preserve copy-on-enable and sync-back-on-disable behavior.
- **Send accounting:** Manual sends and smart replies must update sent history, statistics, and the event log.
- **Provider routing:** Use the shared OpenAI-compatible endpoint helper instead of duplicating endpoint/model selection.
- **Persistence:** New persisted fields require the appropriate settings-version bump and migration.
- **R34L style:** Preserve the prompt's exclusions and the chat-style analyzer's handling of forced slang closers.
- **Credentials:** Keep private keys, tokens, environment files, and unredacted session exports out of patches and screenshots.

See [AGENTS.md](AGENTS.md) for the detailed conventions and implementation notes. Verify source behavior when a guide and implementation differ.

## Source map

| Location | Responsibility |
| --- | --- |
| `src/App.tsx` | Application shell, integration hooks, and global shortcuts. |
| `src/store.ts`, `src/types.ts` | Application state, persistence, and domain types. |
| `src/components/` | Forge workspace, settings, tuning, bot controls, and overlays. |
| `src/lib/ai.ts`, `src/lib/prompts.ts`, `src/lib/keys.ts` | Generation, prompt construction, and provider configuration. |
| `src/hooks/useAutoForge.ts`, `src/hooks/useAutoForgeBot.ts` | Single-bot and per-bot autonomous loops. |
| `src/hooks/useMultiBotOrchestrator.tsx`, `src/lib/botCoordinator.ts` | Bot-loop mounting and autonomous speaker selection. |
| `src/hooks/useNowTick.ts` | The app's single shared 1-second clock for all relative-time labels. |
| `src/lib/platformSend.ts` | Platform and identity-aware send routing. |
| `src/lib/memoryEngine.ts`, `src/lib/memoryStore.ts`, `src/lib/memoryRetrieval.ts` | Memory extraction, browser storage, and retrieval. |
| `server.ts` | Additional backend OAuth, session, and AI routes. |
| `public/`, `cloudflare-worker/`, `deno/` | Static assets, callbacks, and proxy implementations. |

## Make the review easy

Describe the problem and resulting behavior, list the checks you ran and their outcomes, and identify anything you could not verify. Add a sanitized screenshot for visible changes. Update the README, setup guide, or existing changelog when behavior changes their instructions.

Do not describe a passing build as proof of live authentication, provider availability, or production readiness.

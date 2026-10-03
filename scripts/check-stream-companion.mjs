import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Actual store, both hooks, policy, semantic coordinator and canonical delivery.
// Only React mounting, providers, sounds and platform I/O are local fixtures.
const storage = new Map();
globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
globalThis.window = Object.assign(new EventTarget(), { localStorage });
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const fx = globalThis.__companionFixture = { calls: [], writes: [], mode: 'short_reaction', holdDecision: null, holdForge: null, holdDelivery: null, refs: new Map(), effects: new Map(), current: null, index: 0 };
let clock = 10_000_000;
Date.now = () => clock;
const timers = new Map();
let timerSeq = 0;
globalThis.setTimeout = (cb, ms = 0) => { const id = ++timerSeq; timers.set(id, { cb, at: clock + ms }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.setInterval = (cb, ms) => { const id = ++timerSeq; timers.set(id, { cb, at: clock + ms, ms }); return id; };
globalThis.clearInterval = id => timers.delete(id);
globalThis.fetch = async url => { throw new Error(`Unexpected network request: ${url}`); };

const mocks = {
  react: `const f = globalThis.__companionFixture;
    export function useRef(value) { const refs = f.refs.get(f.current); const i = f.index++; return refs[i] ?? (refs[i] = { current: value }); }
    export function useEffect(callback) { const key = f.current + ':' + f.index++; if (!f.effects.has(key)) f.effects.set(key, callback() ?? (() => {})); }
    export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
    export function useCallback(fn) { return fn; }
    export function useDebugValue() {}
    export function useMemo(fn) { return fn(); }
    export default { useSyncExternalStore, useCallback, useDebugValue };
  `,
  ai: `const f = globalThis.__companionFixture;
    export async function autoforgeDecide(params) { f.calls.push(params); if (f.holdDecision) await f.holdDecision.promise;
      return { decision: f.mode, confidence: 0.99, reason: 'Local grounded fixture', action_payload: 'The shortcut has a loyalty program', estimated_next_action_minutes: 4, followup_delay_ms: 3000 }; }
    export async function generateChat(params) { f.forgeParams = params; if (f.holdForge) await f.holdForge.promise; if (f.failForge) { f.failForge = false; throw new f.CancelledAI(); } return { suggestions: [{ message: 'The route has started charging a respawn toll', best: true }], analysis: '' }; }
    export function rankVariants(variants) { return variants; }
  `,
  keys: `export const TRIAL_PROVIDER = 'trial'; export const CUSTOM_OPENAI_PROVIDER = 'custom-openai';
    export function getActiveProvider() { return 'fixture'; } export function getApiKey() { return 'fixture-only'; }
    export function getKeys() { return {}; } export function saveKeys() {} export function hasAnyApiKey() { return true; }
    export function getProviderWithKey() { return 'fixture'; } export function setActiveProvider() {}
    export function isOpenAICompatibleProvider() { return false; } export function openAiCompatEndpoint() { throw new Error('Unexpected real provider'); }
  `,
  sonner: `export const toast = { error() {}, success() {}, info() {}, warning() {} };`,
};
for (const name of ['twitch', 'kick', 'joystick', 'tts', 'sound', 'sfx', 'notifications']) {
  const source = await readFile(`src/lib/${name}.ts`, 'utf8');
  const names = [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]);
  const exports = names.map(n => {
    if (/^get(Twitch|Kick|Joystick)Session$/.test(n)) return `export function ${n}() { return globalThis.__companionFixture.session; }`;
    if (/^send(Twitch|Kick|Joystick)Message(AsBot)?$/.test(n)) return `export async function ${n}(...args) {
      const f = globalThis.__companionFixture; const signal = args.at(-1); if (signal?.aborted) throw new globalThis.__companionFixture.Cancelled();
      f.deliveryStarts++;
      if (f.failDelivery) { f.failDelivery = false; throw new Error('Local delivery failure fixture'); }
      if (f.holdDelivery) await Promise.race([f.holdDelivery.promise, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new globalThis.__companionFixture.Cancelled()), { once: true }))]);
      if (signal?.aborted) throw new globalThis.__companionFixture.Cancelled(); f.writes.push(args.filter(a => typeof a === 'string'));
    }`;
    return `export function ${n}() {}`;
  });
  exports.push('export const ELEVENLABS_VOICES = [];');
  mocks[name] = exports.join('\n');
}
const workspace = resolve(process.cwd());
const directory = await mkdtemp(join(workspace, '.companion-check-'));
let api;
try {
  const outfile = join(directory, 'fixture.mjs');
  const bundle = await build({
    stdin: { contents: `
      export { useAppStore } from './src/store';
      export { useAutoForge } from './src/hooks/useAutoForge';
      export { useAutoForgeBot } from './src/hooks/useAutoForgeBot';
      export { streamCompanion } from './src/lib/streamCompanion';
      export { botCoordinator } from './src/lib/botCoordinator';
      export { actionRateLimiter, removeBotRateLimiter } from './src/lib/actionRateLimiter';
      export { getPlatformSendFn } from './src/lib/platformSend';
      export { SendCancelledError } from './src/lib/sendCancellation';
      export { AIRequestCancelledError } from './src/lib/aiScheduler';
    `, resolveDir: workspace }, bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'local-companion-fixtures', setup(builder) {
      builder.onResolve({ filter: /^zustand(\/(middleware|react|vanilla))?$/ }, ({ path }) => ({ path: resolve('node_modules/zustand/esm', path.includes('/') ? path.split('/').at(-1) + '.mjs' : 'index.mjs') }));
      builder.onResolve({ filter: /^(react|sonner|\.?\.\/lib\/(ai|keys|twitch|kick|joystick|tts|sound|sfx|notifications)|\.\/(ai|keys|twitch|kick|joystick|tts|sound|sfx|notifications))$/ }, ({ path }) => {
        const name = path.split('/').at(-1); return { path: name, namespace: 'fixture' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path] }));
    } }],
  });
  await writeFile(outfile, bundle.outputFiles[0].text);
  api = await import(pathToFileURL(outfile).href);
} finally {
  if (dirname(resolve(directory)) !== workspace) throw new Error('Unexpected fixture directory');
  await rm(directory, { recursive: true, force: true });
}
const { useAppStore: store, streamCompanion: policy, botCoordinator: coordinator } = api;
const initial = store.getState();
fx.Cancelled = api.SendCancelledError;
fx.CancelledAI = api.AIRequestCancelledError;
let ids = [];
function render() {
  for (const [key, hook] of [['legacy', () => api.useAutoForge()], ...ids.map(id => [id, () => api.useAutoForgeBot(id)])]) {
    fx.current = key; fx.index = 0;
    if (!fx.refs.has(key)) fx.refs.set(key, []);
    hook();
  }
}
async function flush() { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)); }
async function advance(ms) {
  clock += ms; render();
  const due = [...timers.entries()].filter(([, t]) => t.at <= clock);
  for (const [id, timer] of due) {
    if (!timers.has(id)) continue;
    if (timer.ms) timer.at = clock + timer.ms; else timers.delete(id);
    timer.cb();
  }
  await flush(); render();
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function reset(multi = false) {
  for (const cleanup of fx.effects.values()) cleanup();
  timers.clear(); fx.refs.clear(); fx.effects.clear(); fx.calls = []; fx.writes = []; fx.mode = 'short_reaction'; fx.holdDecision = fx.holdForge = fx.holdDelivery = null;
  fx.failForge = fx.failDelivery = false;
  fx.deliveryStarts = 0;
  store.setState(initial, true); policy.reset(); coordinator.setChannel('alpha'); coordinator.reset();
  api.actionRateLimiter.reset();
  fx.session = { username: 'fixturebot', userId: 'local1', accessToken: 'fixture-only' };
  window.__twitchSession = fx.session;
  store.getState().updateStreamMetadata({ channelName: 'alpha', viewerCount: 0 });
  store.setState({ autoForgeEnabled: true, autoForgeAutoCheckEnabled: true, autoForgeDryRun: false, tmiReadState: 'connected', isForging: false, firstMessageModeEnabled: false, autoForgeNextActionMs: clock + 300_000 });
  store.getState().setParticipationProfile('stream_companion');
  ids = [];
  if (multi) {
    for (let i = 0; i < 2; i++) ids.push(store.getState().addBot({ label: `Local bot ${i}`, platform: 'twitch', active: true, session: { ...fx.session, username: `fixture${i}`, userId: `id${i}` } }));
    store.setState({ multiBotEnabled: true });
    for (const id of ids) { api.removeBotRateLimiter(id); store.getState().setBotAutoForgeNextActionMs(id, clock + 300_000); }
  }
  render();
}
function speech() { store.getState().appendAudioTranscript('I keep taking this shortcut and it keeps killing me', 'streamer'); }
let passed = 0;
async function scenario(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

for (const multi of [false, true]) {
  const label = multi ? 'multi-bot' : 'legacy';
  await scenario(`${label}: fresh speech beats quiet-chat backoff at zero viewers`, async () => {
    reset(multi); clock += 360_000; speech(); await advance(1000); await advance(3000); await advance(15_000); await advance(3000);
    assert.ok(fx.calls.length > 0); assert.ok(fx.calls[0].companionContext.includes('shortcut'));
    assert.equal(fx.writes.length, 1);
    assert.equal(policy.inspect({ enabled: true, paused: false, stopped: false, quiet: false, offline: false, eventFloor: false, humanConversation: false, minCooldownMs: 15_000 }, clock).contributionsLastHour, 1);
  });
  await scenario(`${label}: analyzed visuals alone support a zero-chat opener`, async () => {
    reset(multi);
    store.getState().setVisualSnapshot('data:local-scene', ['The player falls into a lava pit beside the shortcut'], 'auto', 0.08);
    await advance(1000); await advance(3000); await advance(15_000); await advance(3000);
    assert.equal(fx.writes.length, 1);
    assert.match(fx.calls[0].companionContext, /visual/);
  });
  await scenario(`${label}: unchanged evidence and synthetic activity do not cause another model call`, async () => {
    reset(multi); fx.mode = 'deliberate_silence'; speech(); await advance(1000); await advance(15_000); await advance(30_000);
    const count = fx.calls.length;
    store.getState().appendAudioTranscript("[09:00] 'I keep taking this shortcut and it keeps killing me'", 'streamer');
    await advance(30_000);
    assert.equal(fx.calls.length, count);
  });
  for (const action of ['short_reaction', 'full_forge', 'quick_followup']) {
    await scenario(`${label}: ${action} withdraws when profile changes across an await/delay`, async () => {
      reset(multi); fx.mode = action;
      if (action === 'full_forge') fx.holdForge = deferred(); else if (action === 'short_reaction') fx.holdDecision = deferred();
      speech(); await advance(1000); if (action !== "quick_followup" || multi) await advance(3000);
      assert.ok(fx.calls.length > 0);
      store.getState().setParticipationProfile('standard');
      fx.holdForge?.resolve(); fx.holdDecision?.resolve(); await advance(10_000);
      assert.equal(fx.writes.length, 0);
    });
  }
  await scenario(`${label}: Auto-Check OFF stays paused and Interval retains its deadline`, async () => {
    reset(multi); store.getState().setAutoForgeAutoCheckCadence('interval', 60_000); store.getState().setAutoForgeAutoCheckEnabled(false); speech();
    const deadline = multi ? store.getState().bots[0].runtime.autoForgeNextActionMs : store.getState().autoForgeNextActionMs;
    await advance(30_000); assert.equal(fx.calls.length, 0);
    assert.equal(multi ? store.getState().bots[0].runtime.autoForgeNextActionMs : store.getState().autoForgeNextActionMs, deadline);
    store.getState().setAutoForgeAutoCheckEnabled(true);
    const due = multi ? store.getState().bots[0].runtime.autoForgeNextActionMs : store.getState().autoForgeNextActionMs;
    await advance(1000); assert.equal(fx.calls.length, 0);
    assert.equal(multi ? store.getState().bots[0].runtime.autoForgeNextActionMs : store.getState().autoForgeNextActionMs, due);
  });
  await scenario(`${label}: Dry Run spends no real budget and marks no successful send`, async () => {
    reset(multi); store.setState({ autoForgeDryRun: true, hasSentMessage: false }); speech(); await advance(1000); await advance(15_000);
    assert.ok(fx.calls.length > 0); assert.equal(fx.writes.length, 0); assert.equal(store.getState().hasSentMessage, false);
    const controls = { enabled: true, paused: false, stopped: false, quiet: false, offline: false, eventFloor: false, humanConversation: false, minCooldownMs: 15_000 };
    assert.equal(policy.inspect(controls, clock).contributionsLastHour, 0);
  });
  await scenario(`${label}: Dry Run silence previews cannot train channel learning`, async () => {
    reset(multi); fx.mode = 'deliberate_silence';
    store.setState({ autoForgeDryRun: true, chatLog: [
      { id: 'pre-a', user: 'alice', text: 'The last jump was close', timestamp: clock - 40_000 },
      { id: 'pre-b', user: 'bob', text: 'Try the other platform', timestamp: clock - 39_000 },
    ] });
    const before = JSON.stringify(store.getState().learningProfiles);
    speech(); await advance(1000); await advance(3000);
    assert.ok(fx.calls.length > 0);
    store.setState({ chatLog: [...store.getState().chatLog, ...['alice', 'bob', 'charlie'].map((user, index) => ({
      id: `after-${index}`, user, text: 'The next attempt worked', timestamp: clock + index + 1,
    }))] });
    await advance(60_000);
    assert.equal(JSON.stringify(store.getState().learningProfiles), before);
    assert.equal(fx.writes.length, 0);
  });
  for (const fault of ['failForge', 'failDelivery']) {
    await scenario(`${label}: ${fault} releases permission for a bounded retry on fresh evidence`, async () => {
      reset(multi); fx.mode = fault === 'failForge' ? 'full_forge' : 'short_reaction'; fx[fault] = true;
      speech(); await advance(1000); await advance(3000);
      const controls = { enabled: true, paused: false, stopped: false, quiet: false, offline: false, eventFloor: false, humanConversation: false, minCooldownMs: 15_000 };
      if (!multi) assert.equal(fx.writes.length, 0);
      // Another bot may legitimately win after the first bot's fixture failure.
      assert.equal(policy.inspect(controls, clock).contributionsLastHour, fx.writes.length);
      const receipt = policy.inspect(controls, clock, multi ? ids[0] : 'legacy');
      assert.equal(receipt.eligible, false);
      await advance(40_000); await advance(3000);
      assert.equal(fx.writes.length, 1);
      assert.equal(policy.inspect(controls, clock).contributionsLastHour, 1);
    });
  }
}
await scenario('Standard still skips a quiet zero-viewer room', async () => {
  reset(); store.getState().setParticipationProfile('standard'); clock += 360_000; speech(); await advance(1000);
  assert.equal(fx.calls.length, 0); assert.equal(fx.writes.length, 0);
});
await scenario('A spoken negative instruction during generation suppresses the optional action', async () => {
  reset(); speech(); fx.holdDecision = deferred(); await advance(1000);
  store.getState().appendAudioTranscript('fixturebot, stop talking.', 'streamer');
  fx.holdDecision.resolve(); await flush(); assert.equal(fx.writes.length, 0);
});
await scenario('Force retains operator priority while Auto-Check is paused', async () => {
  reset(); store.getState().setAutoForgeAutoCheckEnabled(false); render();
  window.dispatchEvent(new Event('autoforge-force-check')); await flush();
  assert.equal(fx.writes.length, 1);
});
for (const patch of [{ botsGlobalStop: true }, { participationManualMode: 'quiet' }, { participationManualMode: 'direct_only' }]) {
  await scenario(`Canonical queued delivery cancels on ${Object.keys(patch)[0]} without spending budget`, async () => {
    reset(); speech(); fx.holdDelivery = deferred();
    await advance(1000); assert.equal(fx.writes.length, 0);
    store.setState(patch); fx.holdDelivery.resolve(); await flush();
    assert.equal(fx.writes.length, 0);
  });
}
await scenario('Exclusive event-floor lease cancels queued optional speech immediately', async () => {
  reset(); speech(); fx.holdDelivery = deferred(); await advance(1000);
  assert.equal(coordinator.acquireEventFloor('local-event'), true);
  fx.holdDelivery.resolve(); await flush(); assert.equal(fx.writes.length, 0);
  coordinator.releaseEventFloor('local-event', 0);
});
await scenario('Queued optional speech expires even without any store ticks', async () => {
  reset(); speech(); fx.holdDelivery = deferred(); await advance(1000);
  // Invoke cancellation deadlines only, withholding the engine heartbeat/store mirrors.
  clock += 100_000;
  for (const [id, timer] of [...timers]) if (!timer.ms && timer.at <= clock) { timers.delete(id); timer.cb(); }
  fx.holdDelivery.resolve(); await flush(); assert.equal(fx.writes.length, 0);
});
await scenario('A queued per-bot contribution cannot outlive effective multi-bot ownership', async () => {
  reset(true); speech(); fx.holdDelivery = deferred(); await advance(1000); await advance(3000);
  assert.ok(fx.deliveryStarts > 0, 'The fixture must reach the transport queue before ownership changes');
  store.setState({ bots: store.getState().bots.map((bot, index) => index === 1 ? { ...bot, active: false } : bot) });
  fx.holdDelivery.resolve(); await flush(); assert.equal(fx.writes.length, 0);
});
await scenario('Provider fixture cancellation cannot deliver into a channel round trip', async () => {
  reset(); speech(); fx.holdDecision = deferred(); await advance(1000);
  store.getState().updateStreamMetadata({ channelName: 'beta' }); store.getState().updateStreamMetadata({ channelName: 'alpha' });
  fx.holdDecision.resolve(); await flush(); assert.equal(fx.writes.length, 0);
});
for (const cleanup of fx.effects.values()) cleanup();
console.log(`${passed} actual-hook/canonical-delivery scenarios passed; local provider/delivery fixtures, zero network calls.`);

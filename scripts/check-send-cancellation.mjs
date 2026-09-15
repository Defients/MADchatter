import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getEventListeners } from 'node:events';

// Real send managers, routing, store, session scopes and retry queue. All I/O
// terminates at these local fakes; no authenticated connection is created.
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
};
globalThis.window = Object.assign(new EventTarget(), { localStorage });
const fx = globalThis.__sendTest = { clients: [], writes: [], requests: [] };
const bundle = await build({
  stdin: { contents: `
    export { useAppStore } from './src/store';
    export { getPlatformSendFn } from './src/lib/platformSend';
    export { tmiSendManager, sendGuard, setTwitchSession } from './src/lib/twitch';
    export { kickSendManager, setKickSession, getKickSession } from './src/lib/kick';
    export { joystickSendManager } from './src/lib/joystick';
    export { MessageQueue } from './src/lib/messageQueue';
    export { SendCancelledError } from './src/lib/sendCancellation';
    export { createAutoForgeExecutionGuard } from './src/lib/sessionScope';
    export { sendManualMessage } from './src/lib/manualSend';
  `, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external',
  define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'local-delivery', setup(builder) {
    builder.onResolve({ filter: /^(tmi\.js|sonner)$/ }, ({ path }) => ({ path, namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents:
      path === 'sonner' ? 'export const toast = { error() {}, info() {}, success() {}, warning() {} };'
        : `import { EventEmitter } from 'node:events';
          export default { Client: class extends EventEmitter {
            constructor(options) { super(); this.channel = options.channels[0]; globalThis.__sendTest.clients.push(this); }
            connect() { return globalThis.__sendTest.connect(this); }
            disconnect() { this.emit('disconnected'); return Promise.resolve(); }
            say(channel, message) { return globalThis.__sendTest.write('say', message); }
            raw(message) { return globalThis.__sendTest.write('raw', message); }
          } };`,
    }));
  } }],
});
const workspace = resolve(process.cwd());
const directory = await mkdtemp(join(workspace, '.send-cancellation-check-'));
let api;
try {
  const outfile = join(directory, 'fixture.mjs');
  await writeFile(outfile, bundle.outputFiles[0].text);
  api = await import(pathToFileURL(outfile).href);
} finally {
  if (dirname(resolve(directory)) !== workspace) throw new Error('Unexpected test output directory');
  await rm(directory, { recursive: true, force: true });
}
const { useAppStore: store, getPlatformSendFn: send, SendCancelledError: Cancelled } = api;
const initial = store.getState();
let activeSubscriptions = 0;
const subscribe = store.subscribe;
store.subscribe = listener => {
  activeSubscriptions++;
  const unsubscribe = subscribe(listener);
  return () => { activeSubscriptions--; unsubscribe(); };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function abortable(signal) {
  return new Promise((_, reject) => {
    const cancel = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  });
}
async function reset(platform = 'twitch') {
  await api.tmiSendManager.disconnect();
  store.setState(initial, true);
  store.setState({ platform, multiBotEnabled: false, sessionRevision: 0 });
  store.getState().updateStreamMetadata({ channelName: 'alpha' });
  api.setTwitchSession({ username: 'fixture', userId: '1', accessToken: 'local-only' });
  api.setKickSession({ username: 'fixture', userId: '1', accessToken: 'local-only' });
  for (const manager of [api.sendGuard, api.kickSendManager, api.joystickSendManager]) {
    manager.sendTimestamps = []; manager.recentMessages.clear();
  }
  api.kickSendManager.channelInfoCache.clear();
  fx.clients = []; fx.writes = []; fx.requests = [];
  fx.connect = client => { queueMicrotask(() => client.emit('join', '#' + client.channel, 'fixture', true)); return Promise.resolve(); };
  fx.write = async (kind, message) => { fx.writes.push({ kind, message }); };
  fx.fetch = async url => String(url).includes('/channels/')
    ? Response.json({ chatroom: { id: 2 }, user_id: 3 }) : Response.json({});
  globalThis.fetch = (url, options = {}) => { fx.requests.push({ url: String(url), signal: options.signal }); return fx.fetch(url, options); };
}
let passed = 0;
async function scenario(name, run) {
  await run();
  assert.equal(activeSubscriptions, 0, 'store subscriptions must be released');
  assert.equal(getEventListeners(window, 'storage').length, 0);
  assert.equal(getEventListeners(window, 'send-identity-changed').length, 0);
  passed++; console.log(`PASS ${name}`);
}

await scenario('Twitch connection cancellation prevents late join/send and permits recovery', async () => {
  await reset(); const connected = deferred(); fx.connect = () => connected.promise;
  const controller = new AbortController();
  const pending = assert.rejects(send('twitch')('alpha', 'withdrawn', controller.signal), Cancelled);
  await tick(); const retired = fx.clients[0]; controller.abort(); await pending; await tick();
  assert.equal(retired.listenerCount('join'), 0);
  fx.connect = client => { queueMicrotask(() => client.emit('join', '#alpha', 'fixture', true)); return Promise.resolve(); };
  await send('twitch')('alpha', 'new');
  connected.resolve(); retired.emit('join', '#alpha', 'fixture', true); retired.emit('disconnected'); await tick();
  assert.equal(api.tmiSendManager.getState(), 'connected');
  assert.deepEqual(fx.writes.map(w => w.message), ['new']);
});
await scenario('Twitch socket connection alone cannot admit a send before self-join', async () => {
  await reset(); fx.connect = async client => { client.emit('connected'); };
  const controller = new AbortController();
  const pending = assert.rejects(send('twitch')('alpha', 'waiting for join', controller.signal), Cancelled);
  await tick(); assert.equal(fx.writes.length, 0); controller.abort(); await pending; await tick();
  assert.equal(fx.clients[0].listenerCount('join'), 0);
});
await scenario('Twitch synchronous connect failure leaves the manager reusable', async () => {
  await reset(); fx.connect = () => { throw new Error('local connect failure'); };
  await assert.rejects(send('twitch')('alpha', 'failed connection'), /local connect failure/);
  fx.connect = client => { queueMicrotask(() => client.emit('join', '#alpha', 'fixture', true)); return Promise.resolve(); };
  await send('twitch')('alpha', 'recovered');
  assert.deepEqual(fx.writes.map(w => w.message), ['recovered']);
});
await scenario('Twitch join deadline retires listeners and a later request can reconnect', async () => {
  await reset(); fx.connect = async () => {};
  const realTimer = globalThis.setTimeout;
  let timeout;
  globalThis.setTimeout = (callback, ms, ...args) => ms === 8000
    ? (timeout = callback, realTimer(() => {}, 8000)) : realTimer(callback, ms, ...args);
  try {
    const pending = assert.rejects(send('twitch')('alpha', 'join timeout'), /within 8 seconds/);
    await tick(); timeout(); await pending;
    assert.equal(fx.clients[0].listenerCount('join'), 0);
    assert.equal(api.tmiSendManager.getState(), 'error');
  } finally { globalThis.setTimeout = realTimer; }
  fx.connect = client => { queueMicrotask(() => client.emit('join', '#alpha', 'fixture', true)); return Promise.resolve(); };
  await send('twitch')('alpha', 'after timeout');
});
await scenario('Twitch cancelled raw reply does not fall back to say', async () => {
  await reset(); const write = deferred(); fx.write = async kind => { fx.writes.push({ kind }); return write.promise; };
  const controller = new AbortController();
  const pending = assert.rejects(api.tmiSendManager.send('alpha', 'reply', 'parent', controller.signal), Cancelled);
  await tick(); controller.abort(); write.reject(new Error('raw failed')); await pending;
  assert.deepEqual(fx.writes.map(w => w.kind), ['raw']);
});
for (const change of ['channel round trip', 'mode round trip', 'base identity']) {
  await scenario(`routing cancels queued send on ${change}`, async () => {
    await reset(); const write = deferred(); fx.write = () => write.promise;
    const first = assert.rejects(send('twitch')('alpha', 'in flight'), Cancelled);
    await tick();
    const queued = assert.rejects(send('twitch')('alpha', 'queued'), Cancelled);
    if (change === 'channel round trip') {
      store.getState().updateStreamMetadata({ channelName: 'beta' });
      store.getState().updateStreamMetadata({ channelName: 'alpha' });
    } else if (change === 'mode round trip') { store.setState({ multiBotEnabled: true }); store.setState({ multiBotEnabled: false }); }
    else api.setTwitchSession({ username: 'replacement', userId: '2', accessToken: 'local-only' });
    await Promise.all([first, queued]); write.resolve(); await tick();
    assert.equal(api.sendGuard.getRateStatus().used, 1, 'queued cancellation uses no capacity');
  });
}
await scenario('per-bot identity replacement cancels connection preparation', async () => {
  await reset(); store.setState({ multiBotEnabled: true });
  const botId = store.getState().addBot({ label: 'Fixture', active: true, platform: 'twitch', session: { username: 'bot', userId: '1', accessToken: 'local-only' } });
  const connect = deferred(); fx.connect = () => connect.promise;
  const pending = assert.rejects(send('twitch', botId)('alpha', 'old identity'), Cancelled);
  await tick(); store.setState({ bots: store.getState().bots.map(bot => ({ ...bot, session: { ...bot.session, userId: 'replacement' } })) });
  await pending; connect.resolve(); await tick(); assert.equal(fx.writes.length, 0);
});
await scenario('an initially inactive bot cannot enter delivery', async () => {
  await reset(); store.setState({ multiBotEnabled: true });
  const botId = store.getState().addBot({ label: 'Inactive', active: false, platform: 'twitch', session: { username: 'bot', userId: '1', accessToken: 'local-only' } });
  await assert.rejects(send('twitch', botId)('alpha', 'inactive'), Cancelled);
  assert.equal(fx.clients.length, 0);
});
await scenario('AutoForge off/on propagates sticky cancellation to rate waits', async () => {
  await reset(); store.setState({ autoForgeEnabled: true });
  const guard = api.createAutoForgeExecutionGuard(() => true);
  api.sendGuard.sendTimestamps = Array(20).fill(Date.now());
  const pending = assert.rejects(send('twitch')('alpha', 'waiting', guard.signal), Cancelled);
  await tick(); store.getState().setAutoForgeEnabled(false); store.getState().setAutoForgeEnabled(true);
  await pending; guard.dispose(); assert.equal(guard.signal.aborted, true); assert.equal(fx.writes.length, 0);
});
for (const stage of ['lookup', 'direct', 'proxy', 'refresh', 'initial refresh']) {
  await scenario(`Kick cancellation during ${stage} prevents later fallback/retry`, async () => {
    await reset('kick');
    api.setKickSession({ username: 'fixture', userId: '1', accessToken: 'local-only', refreshToken: 'local-refresh', ...(stage === 'initial refresh' ? { expiresAt: 1 } : {}) });
    let reached = false;
    fx.fetch = async (url, options) => {
      const path = String(url);
      const lookup = path.includes('/channels/');
      const direct = path.includes('api.kick.com') && path.endsWith('/chat');
      const refresh = path.endsWith('/refresh');
      if ((stage === 'lookup' && lookup) || (stage === 'direct' && direct) ||
        (stage === 'proxy' && !direct && path.endsWith('/chat')) || ((stage === 'refresh' || stage === 'initial refresh') && refresh)) {
        reached = true; return abortable(options.signal);
      }
      if (lookup) return Response.json({ chatroom: { id: 2 }, user_id: 3 });
      return new Response('', { status: 401 });
    };
    const controller = new AbortController();
    const pending = assert.rejects(send('kick')('alpha', 'cancel-' + stage, controller.signal), Cancelled);
    await tick(); assert.ok(reached); const count = fx.requests.length;
    controller.abort(); await pending; await tick();
    assert.equal(fx.requests.length, count);
    assert.ok(fx.requests.every(request => request.signal instanceof AbortSignal));
    assert.equal(api.getKickSession().accessToken, 'local-only');
  });
}
await scenario('Kick ordinary proxy fallback and refresh retry remain available', async () => {
  await reset('kick'); api.setKickSession({ username: 'fixture', userId: '1', accessToken: 'local-only', refreshToken: 'local-refresh' });
  let chats = 0;
  fx.fetch = async url => {
    if (String(url).includes('/channels/')) return Response.json({ chatroom: { id: 2 }, user_id: 3 });
    if (String(url).endsWith('/refresh')) return Response.json({ access_token: 'local-renewed' });
    chats++; return new Response('', { status: chats < 3 ? 401 : 200 });
  };
  await send('kick')('alpha', 'normal retry'); assert.equal(chats, 3); assert.equal(api.getKickSession().accessToken, 'local-renewed');
});
await scenario('Kick late confirmed success preserves duplicate protection after cancellation', async () => {
  await reset('kick'); const response = deferred();
  fx.fetch = async url => String(url).includes('/channels/')
    ? Response.json({ chatroom: { id: 2 }, user_id: 3 }) : response.promise;
  const controller = new AbortController();
  const pending = assert.rejects(send('kick')('alpha', 'confirmed', controller.signal), Cancelled);
  await tick(); controller.abort(); await pending;
  response.resolve(Response.json({})); await tick();
  await assert.rejects(send('kick')('alpha', 'confirmed'), /Duplicate message/);
  assert.equal(fx.requests.filter(request => request.url.endsWith('/chat')).length, 1);
});
await scenario('Joystick cancelled rate wait never writes to WebSocket', async () => {
  await reset('joystick'); api.joystickSendManager.sendTimestamps = Array(20).fill(Date.now());
  window.__joystickChatClient = { getChannelId: () => 'fixture', sendMessage: () => { assert.fail('cancelled WebSocket send'); } };
  const controller = new AbortController();
  const pending = assert.rejects(send('joystick')('alpha', 'waiting', controller.signal), Cancelled);
  await tick(); controller.abort(); await pending;
  assert.equal(api.joystickSendManager.getRateStatus().used, 20);
});
await scenario('retry queue clear cancels active wait and abandons ready snapshot', async () => {
  await reset(); api.sendGuard.sendTimestamps = Array(20).fill(Date.now());
  const queue = new api.MessageQueue(); queue.enqueue('first', 'alpha', 'twitch'); queue.enqueue('second', 'alpha', 'twitch');
  const processing = queue.processQueue(); await tick(); queue.clear(); await processing;
  assert.equal(queue.getDepth(), 0); assert.equal(fx.writes.length, 0);
  api.sendGuard.sendTimestamps = [];
  queue.enqueue('new', 'alpha', 'twitch'); await queue.processQueue(); assert.equal(queue.getDepth(), 0);
  assert.deepEqual(fx.writes.map(w => w.message), ['new']);
});
await scenario('session-cancelled retry entry is dropped rather than scheduled again', async () => {
  await reset(); api.sendGuard.sendTimestamps = Array(20).fill(Date.now());
  const queue = new api.MessageQueue(); queue.enqueue('old', 'alpha', 'twitch');
  queue.enqueue('also old', 'alpha', 'twitch');
  const pending = queue.processQueue(); await tick(); store.getState().updateStreamMetadata({ channelName: 'beta' }); await pending;
  assert.equal(queue.getDepth(), 0); assert.equal(fx.writes.length, 0);
});
await scenario('manual cancellation leaves history untouched and releases its pending-send lock', async () => {
  await reset(); api.sendGuard.sendTimestamps = Array(20).fill(Date.now());
  const before = store.getState().sentMessages.length;
  const pending = assert.rejects(api.sendManualMessage({ channel: 'alpha', message: 'manual fixture' }), Cancelled);
  await tick(); api.setTwitchSession(null); await pending;
  assert.equal(store.getState().sentMessages.length, before);
  api.setTwitchSession({ username: 'fixture', userId: '1', accessToken: 'local-only' });
  api.sendGuard.sendTimestamps = [];
  await api.sendManualMessage({ channel: 'alpha', message: 'manual fixture' });
  assert.equal(store.getState().sentMessages.length, before + 1);
  assert.deepEqual(fx.writes.map(w => w.message), ['manual fixture']);
});
await api.tmiSendManager.disconnect();
console.log(`${passed} send-cancellation integration scenarios passed; zero network calls.`);

import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Real adapters and limiter; replace network, storage and UI boundaries only.
// Every fetch is handled locally; unexpected endpoints fail the test.
const bundle = await build({
  stdin: { contents: `
    export { sendGuard, tmiSendManager } from './src/lib/twitch';
    export { kickSendManager } from './src/lib/kick';
    export { joystickSendManager } from './src/lib/joystick';
  `, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'local-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(tmi\.js|sonner|\.\.\/store)$/ }, ({ path }) => ({ path, namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents:
      path === 'tmi.js' ? 'export default { Client: class { constructor() { throw new Error("Unexpected live Twitch connection"); } } };'
      : path === 'sonner' ? 'export const toast = { error() {} };'
      : 'export const useAppStore = { getState: () => ({ bots: [] }) };',
    }));
  } }],
});
globalThis.localStorage = { getItem: (key) => key === 'kick_session'
  ? JSON.stringify({ username: 'fixture', accessToken: 'fixture-only', userId: '1' }) : null };
let kickDeliver;
globalThis.fetch = async (url, options) => {
  if (String(url).endsWith('/channels/fixture')) return Response.json({ chatroom: { id: 2 }, user_id: 3 });
  assert.ok(String(url).endsWith('/chat'), `Unexpected endpoint: ${url}`);
  return kickDeliver(JSON.parse(options.body).content);
};
const { sendGuard, tmiSendManager, kickSendManager, joystickSendManager } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=platform-send-fixture.mjs').toString('base64')}`
);
let twitchDeliver;
tmiSendManager.send = (_channel, message) => twitchDeliver(message);
let joystickDeliver;
const client = { sendMessage: (message) => joystickDeliver(message) };
const adapters = [
  { name: 'Twitch', send: (message) => sendGuard.send('fixture', message),
    set: (deliver) => { twitchDeliver = deliver; } },
  { name: 'Kick', send: (message) => kickSendManager.send('fixture', message),
    set: (deliver) => { kickDeliver = async (message) => { await deliver(message); return Response.json({}); }; } },
  { name: 'Joystick', send: (message) => joystickSendManager.send('fixture', message, client),
    set: (deliver) => { joystickDeliver = (message) => { deliver(message); return true; }; } },
];

let scenarios = 0;
for (const adapter of adapters) {
  let sent = 0;
  adapter.set(() => { sent++; });
  await assert.rejects(adapter.send('x'.repeat(501)), /500-character/);
  assert.equal(sent, 0);
  scenarios++;

  const pair = await Promise.allSettled([adapter.send('duplicate'), adapter.send('duplicate')]);
  assert.equal(pair.filter((r) => r.status === 'fulfilled').length, 1, `${adapter.name}: concurrent duplicate`);
  assert.equal(sent, 1);
  scenarios++;

  // Kick may try its existing proxy fallback; both attempts fail locally.
  adapter.set(() => { throw new Error('fixture offline'); });
  await assert.rejects(adapter.send('retry'), /fixture offline/);
  adapter.set(() => { sent++; });
  await adapter.send('retry');
  assert.equal(sent, 2, `${adapter.name}: failed message can be retried`);
  scenarios++;

  console.log(`PASS ${adapter.name}: size validation, concurrent deduplication, failed-send retry`);
}
console.log(`PASS: ${scenarios} platform-send integration scenarios (local transports, zero network calls).`);

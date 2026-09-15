import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Bundle the real send helper against local fakes. No credentials or network calls.
const fixture = { state: null, delivery: null };
globalThis.__manualSendCheck = fixture;
const bundle = await build({
  entryPoints: ['src/lib/manualSend.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'fake-platform', setup(builder) {
    builder.onResolve({ filter: /^(\.\.\/store|\.\/platformSend)$/ }, ({ path }) => ({ path, namespace: 'fake' }));
    builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents: path === '../store'
      ? 'export const useAppStore = { getState: () => globalThis.__manualSendCheck.state }; export const selectMultiBotActive = () => false;'
      : 'export const getPlatformSendFn = (platform, botId) => (channel, message) => globalThis.__manualSendCheck.delivery({ platform, botId, channel, message });' }));
  } }],
});
const { sendManualMessage } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + '\n//# sourceURL=manual-send-fixture.mjs').toString('base64')}`);
const methods = ['setLastManualSendMs', 'addBotSentMessage', 'incrementBotStat', 'addBotAutoForgeEvent', 'addSentMessage', 'incrementMessagesSent', 'incrementStat', 'addAutoForgeEvent', 'setHasSentMessage'];
let deliveries, calls;
function reset(overrides = {}) {
  deliveries = []; calls = [];
  fixture.state = { multiBotEnabled: false, platform: 'twitch', bots: [], manualSendBotId: 'stale', sessionRevision: 0, streamMetadata: { channelName: 'channel' }, hasSentMessage: true, ...overrides };
  for (const method of methods) fixture.state[method] = (...args) => calls.push([method, ...args]);
  fixture.delivery = async (value) => { deliveries.push(value); };
}
const bot = (id, platform = 'twitch', active = true) => ({ id, platform, active, session: { username: id } });
const send = (extra = {}) => sendManualMessage({ message: ' hello ', channel: ' channel ', ...extra });

reset();
await send();
assert.deepEqual(deliveries, [{ platform: 'twitch', botId: undefined, channel: 'channel', message: 'hello' }]);
assert.deepEqual(calls.map(([name]) => name), ['setLastManualSendMs', 'addSentMessage', 'incrementMessagesSent', 'incrementStat', 'addAutoForgeEvent']);

reset({ multiBotEnabled: true, bots: [bot('first'), bot('chosen')], manualSendBotId: 'chosen' });
await send({ source: 'smart_reply' });
assert.equal(deliveries[0].botId, 'chosen');
assert.deepEqual(calls.filter(([name]) => name === 'incrementBotStat').map((call) => call.slice(1)), [['chosen', 'messagesSent'], ['chosen', 'manualActions']]);
assert.equal(calls.at(-1)[2].details.source, 'smart_reply');
assert.ok(!calls.some(([name]) => name === 'addSentMessage'));

reset({ multiBotEnabled: true, bots: [bot('wrong', 'kick'), bot('inactive', 'twitch', false), bot('valid')] });
await send();
assert.equal(deliveries[0].botId, 'valid');
await assert.rejects(send({ botId: 'wrong' }), /active, signed-in bot/);
assert.equal(deliveries.length, 1);

reset({ multiBotEnabled: true, bots: [] });
await assert.rejects(send(), /active, signed-in bot/);
assert.equal(deliveries.length, 0);

reset({ multiBotEnabled: true, platform: 'joystick', bots: [bot('ignored', 'joystick')] });
await send();
assert.equal(deliveries[0].botId, undefined);
assert.ok(calls.some(([name]) => name === 'addSentMessage'));

reset();
fixture.delivery = async () => { throw new Error('simulated failure'); };
await assert.rejects(send(), /simulated failure/);
assert.equal(calls.length, 0);
fixture.delivery = async (value) => { deliveries.push(value); };
await send();
assert.equal(deliveries.length, 1, 'failed sends release their pending lock');

reset();
let finish;
fixture.delivery = (value) => { deliveries.push(value); return new Promise((resolve) => { finish = resolve; }); };
const pending = send();
assert.equal(calls.length, 0, 'accounting waits for confirmed delivery');
await assert.rejects(send(), /already being sent/);
assert.equal(deliveries.length, 1);
finish();
await pending;
assert.equal(calls.filter(([name]) => name === 'addSentMessage').length, 1);

reset();
await assert.rejects(send({ message: ' ' }), /Write a message/);
await assert.rejects(send({ channel: ' ' }), /Set a channel/);
assert.equal(deliveries.length, 0);
reset();
await send({ source: 'autoforge' });
assert.equal(calls.find(([name]) => name === 'addSentMessage')[1].source, 'autoforge');
assert.deepEqual(calls.find(([name]) => name === 'incrementStat').slice(1), ['autoForgeActions']);
assert.ok(!calls.some(([name]) => name === 'setLastManualSendMs'));
assert.equal(calls.at(-1)[1].details.source, 'autoforge');
// A transport result from an earlier session must not contaminate current history.
for (const change of [
  () => { fixture.state = { ...fixture.state, streamMetadata: { channelName: 'other' } }; },
  () => { fixture.state = { ...fixture.state, platform: 'kick' }; },
  () => { fixture.state = { ...fixture.state, sessionRevision: 2 }; }, // A -> B -> A or context reset
  () => { fixture.state = { ...fixture.state, multiBotEnabled: true }; },
]) {
  reset();
  fixture.delivery = () => new Promise((resolve) => { finish = resolve; });
  const oldSend = send();
  change();
  finish();
  await oldSend;
  assert.equal(calls.length, 0, 'stale completion does not update current session');
}

for (const change of [
  () => { fixture.state.bots = []; },
  () => { fixture.state.bots = [bot('chosen', 'twitch', false)]; },
  () => { fixture.state.bots = [{ ...bot('chosen'), session: { username: 'replacement' } }]; },
]) {
  reset({ multiBotEnabled: true, bots: [bot('chosen')] });
  fixture.delivery = () => new Promise((resolve) => { finish = resolve; });
  const oldSend = send();
  change();
  finish();
  await oldSend;
  assert.equal(calls.length, 0, 'removed, inactive, or replaced bot receives no accounting');
}

reset({ hasSentMessage: false, autoForgeDryRun: true });
await send();
assert.ok(calls.some(([name]) => name === 'setHasSentMessage'), 'real manual send counts even when AutoForge is in dry run');

reset({ hasSentMessage: false });
await send({ dryRun: true });
assert.equal(deliveries.length, 0);
assert.ok(calls.some(([name]) => name === 'addSentMessage'));
assert.ok(!calls.some(([name]) => ['setHasSentMessage', 'incrementMessagesSent', 'incrementStat', 'setLastManualSendMs'].includes(name)));

reset();
fixture.delivery = () => new Promise((resolve) => { finish = resolve; });
const normalizedPending = send();
await assert.rejects(send({ channel: '#CHANNEL' }), /already being sent/);
finish();
await normalizedPending;

delete globalThis.__manualSendCheck;
console.log('PASS: 19 manual-send regression scenarios (local fakes, zero network calls).');

// Run: node scripts/check-rule-engine.mjs (real store, local transport/audio/toasts).
import assert from 'node:assert/strict';
import type { AutoForgeRule, RuleEngineContext } from '../types';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
Object.defineProperty(globalThis, 'window', { value: Object.assign(new EventTarget(), {
  localStorage: globalThis.localStorage,
}) });
type Delivery = { platform: string; botId?: string; channel: string; message: string };
const effects = {
  deliveries: [] as Delivery[],
  notices: [] as { level: string; args: unknown[] }[],
  send: async (delivery: Delivery) => { effects.deliveries.push(delivery); },
};
Object.assign(globalThis, { __ruleTest: effects });
const { useAppStore } = await import('../store');
const { fireRule, evaluateAllRules, evaluateRule, dryRunRule } = await import('./ruleEngine');
const initial = useAppStore.getState();
const originalTimer = globalThis.setTimeout;
const originalSubscribe = useAppStore.subscribe;
let subscriptions = 0;
useAppStore.subscribe = (listener) => {
  subscriptions++;
  const unsubscribe = originalSubscribe(listener);
  return () => { subscriptions--; unsubscribe(); };
};
const timers: (() => void)[] = [];
globalThis.setTimeout = ((callback: () => void) => {
  timers.push(callback);
  return timers.length;
}) as unknown as typeof setTimeout;
const ctx: RuleEngineContext = {
  chatVelocity: 10, sentimentLabel: null, timeSinceLastActionMs: 0,
  recentChatText: '', isMentioned: true, activitySpike: false,
  streamHealthLabel: null, hypeLevel: 0, uniqueChatters: 1, viewerCount: 1,
  audioEnergyRms: 0, autoForgeEnabled: true, currentMood: null,
  consecutiveSilence: 0, activeBotCount: 1,
};
function rule(overrides: Partial<AutoForgeRule> = {}): AutoForgeRule {
  return {
    id: 'rule', name: 'Existing rule', description: '', enabled: true,
    conditions: [{ id: 'condition', type: 'mention_detected' }], conditionOperator: 'and',
    actions: [{ id: 'send', type: 'send_message', payload: 'hello', delayMs: 10 }],
    cooldownMs: 1000, lastFiredMs: 0, maxFires: 0, fireCount: 0, createdAt: 0,
    ...overrides,
  };
}
function reset(rules = [rule()]) {
  assert.equal(subscriptions, 0, 'execution subscriptions must be disposed');
  timers.length = 0;
  effects.deliveries.length = 0;
  effects.notices.length = 0;
  effects.send = async (delivery) => { effects.deliveries.push(delivery); };
  useAppStore.setState(initial, true);
  useAppStore.setState({ platform: 'twitch', multiBotEnabled: false, autoForgeRules: rules });
  useAppStore.getState().updateStreamMetadata({ channelName: 'alpha' });
}
function releaseDelay() {
  assert.equal(timers.length, 1, 'one action should be waiting');
  timers.shift()!();
}
function addBot() {
  useAppStore.setState({ multiBotEnabled: true });
  return useAppStore.getState().addBot({ label: 'Bot', active: true, platform: 'twitch',
    session: { username: 'bot', userId: 'bot-id', accessToken: 'local-fixture' } });
}
let passed = 0;
const failures: string[] = [];
async function scenario(name: string, run: () => Promise<void> | void) {
  try { await run(); assert.equal(subscriptions, 0); passed++; }
  catch (error) { failures.push(name); console.error(name, error); }
}
try {
  await scenario('unchanged delayed send keeps channel, identity, counters and success', async () => {
    reset();
    const botId = addBot();
    const pending = fireRule(rule(), ctx, botId);
    releaseDelay();
    const result = await pending;
    assert.equal(result.actionsExecuted, 1);
    assert.equal(result.reason, 'Fired successfully');
    assert.deepEqual(effects.deliveries, [{ platform: 'twitch', botId, channel: 'alpha', message: 'hello' }]);
    assert.equal(useAppStore.getState().autoForgeRules[0].fireCount, 1);
    assert.equal(effects.notices.at(-1)?.level, 'success');
  });
  for (const change of ['channel', 'round-trip', 'platform', 'revision', 'mode-round-trip']) {
    await scenario(`delayed action cancelled on ${change}`, async () => {
      reset();
      const pending = fireRule(rule(), ctx);
      if (change === 'channel' || change === 'round-trip') {
        useAppStore.getState().updateStreamMetadata({ channelName: 'beta' });
        if (change === 'round-trip') useAppStore.getState().updateStreamMetadata({ channelName: 'alpha' });
      } else if (change === 'platform') useAppStore.getState().setPlatform('kick');
      else if (change === 'revision') useAppStore.setState({ sessionRevision: useAppStore.getState().sessionRevision + 1 });
      else { useAppStore.setState({ multiBotEnabled: true }); useAppStore.setState({ multiBotEnabled: false }); }
      releaseDelay();
      const result = await pending;
      assert.match(result.reason, /Cancelled/);
      assert.equal(result.actionsExecuted, 0);
      assert.equal(effects.deliveries.length, 0);
      assert.equal(effects.notices.length, 0);
    });
  }
  for (const change of ['removed', 'deactivated-restored', 'username', 'user-id', 'session', 'platform']) {
    await scenario(`bot ${change} invalidates delayed send`, async () => {
      reset();
      const botId = addBot();
      const bots = useAppStore.getState().bots;
      const pending = fireRule(rule(), ctx, botId);
      useAppStore.setState({ bots: change === 'removed' ? [] : bots.map(bot => bot.id !== botId ? bot : {
        ...bot, active: change !== 'deactivated-restored',
        platform: change === 'platform' ? 'kick' : bot.platform,
        session: change === 'session' ? null : { ...bot.session!,
          username: change === 'username' ? 'replacement' : bot.session!.username,
          userId: change === 'user-id' ? 'replacement-id' : bot.session!.userId },
      }) });
      if (change === 'deactivated-restored') useAppStore.setState({ bots });
      releaseDelay();
      assert.match((await pending).reason, /Cancelled/);
      assert.equal(effects.deliveries.length, 0);
      assert.equal(effects.notices.length, 0);
    });
  }
  await scenario('stale batch skips later actions and later rules', async () => {
    const first = rule({ actions: [rule().actions[0], { id: 'hype', type: 'set_hype_level', hypeLevel: 5, delayMs: 0 }] });
    const second = rule({ id: 'second', actions: [{ id: 'hype', type: 'set_hype_level', hypeLevel: 5, delayMs: 0 }] });
    reset([first, second]);
    const pending = evaluateAllRules([first, second], ctx);
    useAppStore.getState().updateStreamMetadata({ channelName: 'beta' });
    releaseDelay();
    assert.equal((await pending).length, 1);
    assert.equal(useAppStore.getState().hypeLevel, initial.hypeLevel);
    assert.equal(useAppStore.getState().autoForgeRules[1].fireCount, 0);
  });
  for (const reject of [false, true]) {
    await scenario(`late transport ${reject ? 'failure' : 'success'} stops sequence and suppresses notices`, async () => {
      const current = rule({ actions: [
        { ...rule().actions[0], delayMs: 0 },
        { id: 'hype', type: 'set_hype_level', hypeLevel: 5, delayMs: 0 },
      ] });
      reset([current]);
      let finish!: () => void;
      effects.send = () => new Promise<void>((resolve, fail) => { finish = () => reject ? fail(null) : resolve(); });
      const pending = fireRule(current, ctx);
      useAppStore.getState().updateStreamMetadata({ channelName: 'beta' });
      finish();
      const result = await pending;
      assert.match(result.reason, /Cancelled/);
      assert.equal(result.actionsExecuted, 0);
      assert.equal(useAppStore.getState().hypeLevel, initial.hypeLevel);
      assert.equal(effects.notices.length, 0);
    });
  }
  await scenario('failed action reports partial completion and continues remaining actions', async () => {
    const current = rule({ actions: [{ ...rule().actions[0], delayMs: 0 },
      { id: 'hype', type: 'set_hype_level', hypeLevel: 5, delayMs: 0 }] });
    reset([current]);
    effects.send = async () => { throw new Error('local delivery failed'); };
    const result = await fireRule(current, ctx);
    assert.equal(result.actionsExecuted, 1);
    assert.match(result.reason, /failed/);
    assert.equal(effects.notices.at(-1)?.level, 'warning');
    assert.equal(useAppStore.getState().hypeLevel, 5);
  });
  await scenario('throwing non-send action releases guard and continues', async () => {
    const current = rule({ actions: [
      { id: 'mood', type: 'clear_mood_lock', delayMs: 0 },
      { id: 'hype', type: 'set_hype_level', hypeLevel: 5, delayMs: 0 }] });
    reset([current]);
    useAppStore.setState({ setMoodLock: () => { throw new Error('local action failed'); } });
    const result = await fireRule(current, ctx);
    assert.equal(result.actionsExecuted, 1);
    assert.match(result.reason, /failed/);
  });
  await scenario('intentional AutoForge disable preserves subsequent rule actions', async () => {
    const current = rule({ actions: [
      { id: 'off', type: 'toggle_autoforge', enabled: false, delayMs: 0 },
      { id: 'hype', type: 'set_hype_level', hypeLevel: 5, delayMs: 0 }] });
    reset([current]);
    useAppStore.setState({ autoForgeEnabled: true });
    assert.equal((await fireRule(current, ctx)).actionsExecuted, 2);
    assert.equal(useAppStore.getState().autoForgeEnabled, false);
  });
  await scenario('condition preview matches execution and cooldown/fire limits remain intact', async () => {
    reset();
    for (const conditionOperator of ['and', 'or'] as const) {
      const empty = rule({ conditions: [], conditionOperator });
      assert.equal(dryRunRule(empty, ctx).overall, false);
      assert.equal(evaluateRule(empty, ctx).shouldFire, false);
    }
    assert.equal(dryRunRule(rule(), ctx).overall, true);
    assert.equal((await fireRule(rule({ enabled: false }), ctx)).fired, false);
    assert.equal((await fireRule(rule({ maxFires: 1, fireCount: 1 }), ctx)).fired, false);
    assert.equal((await fireRule(rule({ lastFiredMs: Date.now() }), ctx)).fired, false);
    assert.equal(timers.length, 0);
  });
} finally {
  globalThis.setTimeout = originalTimer;
  useAppStore.subscribe = originalSubscribe;
  useAppStore.setState(initial, true);
}
console.log(`${passed} rule-engine scenarios passed; ${failures.length} failed.`);
if (failures.length) throw new Error(`Failed: ${failures.join(', ')}`);

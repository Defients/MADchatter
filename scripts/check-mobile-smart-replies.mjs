import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const outputDir = resolve('audit-output/mobile-ux-closure');
async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

let appServer = null;
const qaUrl = process.env.QA_URL || `http://127.0.0.1:${await reservePort()}`;

async function startAppServer() {
  if (process.env.QA_URL) return;
  const port = new URL(qaUrl).port;
  appServer = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', port, '--strictPort'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let diagnostics = '';
  appServer.stdout.on('data', (chunk) => { diagnostics += String(chunk); });
  appServer.stderr.on('data', (chunk) => { diagnostics += String(chunk); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (appServer.exitCode !== null) throw new Error(`QA app server exited early (${appServer.exitCode}).\n${diagnostics}`);
    try {
      const response = await fetch(qaUrl);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for QA app server at ${qaUrl}.\n${diagnostics}`);
}

async function stopAppServer() {
  if (!appServer || appServer.exitCode !== null) return;
  appServer.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => appServer.once('exit', resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (appServer.exitCode === null) appServer.kill('SIGKILL');
}
const viewports = [
  ...[320, 360, 390, 430, 768].flatMap((width) =>
    [667, 720, 844, 900].map((height) => ({ width, height }))),
];
const screenshotViewports = new Set(['320x667', '360x720', '390x667', '390x844', '430x900', '768x900']);

async function firstExecutable(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next standard installation path.
    }
  }
  throw new Error(
    'No Chromium-family browser found. Set QA_CHROMIUM or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.',
  );
}

const executablePath = await firstExecutable([
  process.env.QA_CHROMIUM,
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
]);

await mkdir(outputDir, { recursive: true });
await startAppServer();
process.once('exit', () => {
  if (appServer?.exitCode === null) appServer.kill('SIGTERM');
});
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];
let desktopStatusDock = null;

function initStorage() {
  localStorage.setItem('madchatter_mobile_welcome_seen_v1', '1');
  localStorage.setItem('madchatter-welcome-seen', '1');
  sessionStorage.setItem('core-mobile-composer-discovered', '1');
  sessionStorage.setItem('core-telemetry-collapsed', '1');
  localStorage.setItem('active_api_provider', 'gemini');
  localStorage.setItem('autoforge_api_keys', JSON.stringify({ geminiKey: 'qa-local-placeholder' }));
  localStorage.setItem('madchatter-storage', JSON.stringify({ version: 35, state: {
    interfaceMode: 'core', modeWelcomeSeen: true, studioDiscoverySeen: true,
    smartRepliesEnabled: true, autoForgeEnabled: false, sfxEnabled: false,
    ttsEnabled: false, ttsBackgroundEnabled: false,
    personaChosen: true, hasForgedOnce: true, hasSentMessage: true,
    platform: 'twitch',
  }}));
}

async function seedWorkspace(page) {
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    if (!useAppStore.persist.hasHydrated()) {
      await new Promise((resolve) => {
        const unsubscribe = useAppStore.persist.onFinishHydration(() => {
          unsubscribe();
          resolve();
        });
      });
    }
    const now = Date.now();
    const state = useAppStore.getState();
    const chatLog = Array.from({ length: 14 }, (_, index) => ({
      id: `qa-chat-${index}`,
      user: `viewer${index + 1}`,
      text: index % 3 === 0
        ? 'That clutch play changed the whole round.'
        : index % 3 === 1
          ? 'Chat is tracking the comeback now.'
          : 'One more clean push and this is ours.',
      timestamp: now - (14 - index) * 900,
      sentiment: index % 4 === 0 ? 'positive' : index % 5 === 0 ? 'negative' : 'neutral',
      badges: index === 0 ? ['subscriber'] : [],
    }));
    const sentimentHistory = chatLog.map((message, index) => ({
      timestamp: message.timestamp,
      label: message.sentiment,
      score: index % 5 === 0 ? 0.72 : 0.54,
      username: message.user,
      text: message.text,
    }));
    useAppStore.setState({
      streamMetadata: { ...state.streamMetadata, channelName: 'qa_channel' },
      tmiReadState: 'connected',
      personaChosen: true,
      hasForgedOnce: true,
      hasSentMessage: true,
      chatLog,
      sentimentHistory,
      sentMessages: [
        { id: 'qa-sent-1', message: 'Manual operator line', channel: 'qa_channel', timestamp: now - 2000, source: 'manual' },
        { id: 'qa-sent-2', message: 'Approved mention reply', channel: 'qa_channel', timestamp: now - 1000, source: 'smart_reply' },
      ],
      visualSnapshotUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      visualContextTags: ['QA active visual observation'],
      activeVisualSnapshotId: 'qa-visual-1',
      visualSnapshotHistory: [{
        id: 'qa-visual-1',
        url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        tags: ['QA active visual observation'],
        timestamp: now,
        source: 'manual',
        delta: 0.42,
      }],
    });
  });
}

async function openContext(page) {
  await page.getByRole('tab', { name: 'Context workspace' }).click();
  await page.getByRole('tabpanel', { name: 'Context workspace' }).waitFor({ state: 'visible' });
}

async function assertViewportBaseline(page, viewport) {
  const key = `${viewport.width}x${viewport.height}`;
  await openContext(page);
  const roomRead = page.getByRole('button', { name: /Room Read/i }).first();
  try {
    await roomRead.waitFor({ state: 'visible', timeout: 8_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async () => {
      const state = (await import('/src/store.ts')).useAppStore.getState();
      return {
        channel: state.streamMetadata.channelName,
        connection: state.tmiReadState,
        personaChosen: state.personaChosen,
        hasForgedOnce: state.hasForgedOnce,
        hasSentMessage: state.hasSentMessage,
        body: document.body.innerText.slice(0, 1200),
      };
    });
    throw new Error(`Room Read missing at ${key}: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  assert.equal(await roomRead.getAttribute('aria-expanded'), 'false', `Room Read defaults collapsed at ${key}`);
  assert.equal(await page.locator('[data-mobile-composer="expanded"]').count(), 0, `composer is idle/collapsed at ${key}`);
  assert.equal(await page.locator('[data-mobile-telemetry="collapsed"]').count(), 1, `telemetry is collapsed at ${key}`);
  assert.equal(await page.getByRole('button', { name: /snapshot/i }).count() > 0, true, `stable snapshot action exists at ${key}`);

  const rowMetrics = await page.evaluate(() => {
    const scroll = document.querySelector('[data-mobile-chat-scroll]');
    if (!scroll) return { total: 0, complete: 0 };
    const viewportRect = scroll.getBoundingClientRect();
    const rows = [...scroll.querySelectorAll('[data-chat-id^="qa-chat-"]')];
    return {
      total: rows.length,
      complete: rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= viewportRect.top - 0.5 && rect.bottom <= viewportRect.bottom + 0.5;
      }).length,
    };
  });
  const minimumRows = viewport.height <= 720 ? 3 : 4;
  assert.equal(rowMetrics.total, 14, `ordinary chat fixture is deterministic at ${key}`);
  assert.equal(rowMetrics.complete >= minimumRows, true, `${minimumRows}+ complete chat rows at ${key}; got ${rowMetrics.complete}`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, `no horizontal page overflow at ${key}`);
  return { key, completeRows: rowMetrics.complete, minimumRows };
}

async function assertChannelGeometry(page, viewport) {
  await page.getByRole('tab', { name: 'Tuning workspace' }).click();
  const row = page.locator('[data-channel-edit-row]').first();
  await row.waitFor({ state: 'visible' });
  const geometry = await row.evaluate((element) => {
    const prefix = element.querySelector('[data-channel-prefix]').getBoundingClientRect();
    const input = element.querySelector('[data-channel-input]').getBoundingClientRect();
    const set = element.querySelector('[data-channel-set]').getBoundingClientRect();
    return {
      hashInputDelta: Math.abs((prefix.top + prefix.height / 2) - (input.top + input.height / 2)),
      inputSetDelta: Math.abs((input.top + input.height / 2) - (set.top + set.height / 2)),
      left: Math.min(prefix.left, input.left, set.left),
      right: Math.max(prefix.right, input.right, set.right),
      overlap: prefix.right > input.left + 0.5,
    };
  });
  assert.equal(geometry.hashInputDelta <= 1.5, true, `Hash/input centers differ <=1.5px at ${viewport.width}px`);
  assert.equal(geometry.inputSetDelta <= 1.5, true, `input/SET centers differ <=1.5px at ${viewport.width}px`);
  assert.equal(geometry.left >= -0.5 && geometry.right <= viewport.width + 0.5, true, `channel row stays in viewport at ${viewport.width}px`);
  assert.equal(geometry.overlap, false, `Hash prefix does not overlap input at ${viewport.width}px`);
  await openContext(page);
  return geometry;
}

async function assertRepresentativeStates(page) {
  const policy = await page.evaluate(async () => {
    const audio = await import('/src/lib/sfx.ts');
    const lifecycle = await import('/src/lib/uiAudioPolicy.ts');
    const { useAppStore } = await import('/src/store.ts');
    useAppStore.setState({ sfxEnabled: true });
    audio.resetOptionalUiAudioDiagnostics();
    lifecycle.setOptionalUiPageHiddenForTest(true);
    audio.playSfx('navigation');
    audio.playSfx('setting_toggle');
    audio.playSfx('drawer_open');
    audio.playSfx('channel_set');
    audio.playAutoCheckTick(3);
    const hidden = audio.getOptionalUiAudioDiagnostics();
    lifecycle.setOptionalUiPageHiddenForTest(false);
    audio.playSfx('navigation');
    const restored = audio.getOptionalUiAudioDiagnostics();
    return { hidden, restored };
  });
  assert.deepEqual(policy.hidden, { attempted: 5, allowed: 0, suppressed: 5 }, 'hidden optional UI/tick audio is centrally suppressed');
  assert.equal(policy.restored.allowed, 1, 'foreground restore admits a new intentional sound without replay');

  // Real lifecycle wiring (not the test hook): synthetic browser events
  // through the actual visibilitychange/pagehide/pageshow listeners the app
  // installed. The real page stays foreground; the events drive the policy.
  const lifecycle = await page.evaluate(async () => {
    const audio = await import('/src/lib/sfx.ts');
    audio.resetOptionalUiAudioDiagnostics();
    window.dispatchEvent(new Event('pagehide'));
    audio.playSfx('navigation');
    const hiddenEvents = audio.getOptionalUiAudioDiagnostics();
    window.dispatchEvent(new Event('pageshow'));
    audio.playSfx('navigation');
    const restoredEvents = audio.getOptionalUiAudioDiagnostics();
    return { hiddenEvents, restoredEvents };
  });
  assert.deepEqual(lifecycle.hiddenEvents, { attempted: 1, allowed: 0, suppressed: 1 }, 'real pagehide wiring suppresses optional UI audio');
  assert.equal(lifecycle.restoredEvents.allowed, 1, 'real pageshow wiring admits a new foreground sound without replay');

  const timer = await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    const realNow = Date.now;
    const anchors = [];
    for (const ms of [30_000, 60_000, 120_000, 300_000, 5_940_000]) {
      const before = Date.now();
      useAppStore.getState().setAutoForgeAutoCheckCadence('interval', ms);
      const deadline = useAppStore.getState().autoForgeNextActionMs;
      anchors.push({ ms, delta: deadline - before });
      useAppStore.getState().setAutoForgeNextActionMs(deadline - 10_000);
      useAppStore.getState().setAutoForgeNextActionMs(deadline + 10_000);
      if (useAppStore.getState().autoForgeNextActionMs !== deadline) throw new Error('model pacing mutated Interval deadline');
      useAppStore.getState().recordAutoForgeCheckAttempt(deadline);
      if (useAppStore.getState().autoForgeNextActionMs !== deadline + ms) throw new Error('attempt did not re-anchor exactly once');
    }
    return { anchors, intervalMs: useAppStore.getState().autoForgeAutoCheckIntervalMs, nowType: typeof realNow };
  });
  for (const anchor of timer.anchors) assert.equal(Math.abs(anchor.delta - anchor.ms) < 50, true, `exact ${anchor.ms}ms deadline anchor`);
  assert.equal(timer.intervalMs, 5_940_000, 'CUSTOM 99M survives runtime store');
  await page.evaluate(async () => (await import('/src/store.ts')).useAppStore.getState().setPlatform('kick'));
  await page.locator('svg[aria-label="Kick"]').first().waitFor({ state: 'visible' });
  const hideVideo = page.getByRole('button', { name: 'Hide stream video' });
  await hideVideo.click();
  const showVideo = page.getByRole('button', { name: 'Show stream video' });
  await showVideo.waitFor({ state: 'visible' });
  await showVideo.click();
  await hideVideo.waitFor({ state: 'visible' });
  await page.evaluate(async () => (await import('/src/store.ts')).useAppStore.getState().setPlatform('twitch'));
  await page.locator('svg[aria-label="Twitch"]').first().waitFor({ state: 'visible' });

  const roomRead = page.getByRole('button', { name: /Room Read/i }).first();
  await roomRead.click();
  assert.equal(await roomRead.getAttribute('aria-expanded'), 'true');
  await roomRead.click();
  assert.equal(await roomRead.getAttribute('aria-expanded'), 'false');

  const pulseButton = page.getByRole('button', { name: 'Inspect recent Chat Pulse sentiment' });
  await pulseButton.click();
  const pulse = page.getByRole('dialog', { name: 'Chat Pulse inspector' });
  await pulse.waitFor({ state: 'visible' });
  assert.match(await pulse.innerText(), /Dominant.*Trend.*Samples/is);
  await page.keyboard.press('Escape');
  await pulse.waitFor({ state: 'hidden' });
  await pulseButton.click();
  await page.mouse.click(4, 80);
  await pulse.waitFor({ state: 'hidden' });
  await pulseButton.click();
  await pulse.getByRole('button', { name: 'Close Pulse Inspector' }).click();
  await pulse.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Compose a chat message' }).click();
  const composer = page.locator('[data-mobile-composer="expanded"]');
  await composer.waitFor({ state: 'visible' });
  const textarea = composer.locator('textarea');
  await textarea.fill('Draft survives focus and timing');
  await page.waitForTimeout(4750);
  assert.equal(await composer.isVisible(), true, 'non-empty composer remains expanded');
  await textarea.fill('');
  await textarea.blur();
  await composer.waitFor({ state: 'hidden', timeout: 6_000 });
  await page.getByRole('button', { name: 'Compose a chat message' }).click();
  await composer.waitFor({ state: 'visible' });
  await composer.locator('textarea').fill('Draft remains behind Smart Replies');

  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    useAppStore.setState({
      smartRepliesLoading: false,
      smartReplies: [{
        id: 'qa-r1', text: 'I think chat already chose chaos.', timestamp: Date.now(),
        mentionMessageId: 'qa-mention', mentionedUsername: 'viewer123', botUsername: 'BotName',
      }],
      smartReplyNotice: {
        state: 'ready', messageId: 'qa-mention', username: 'viewer123', botUsername: 'BotName',
        text: '@BotName what do you think?', receivedAt: Date.now(),
      },
    });
  });
  const shelf = page.getByRole('region', { name: 'Smart Replies' });
  await shelf.waitFor({ state: 'visible' });
  await composer.waitFor({ state: 'hidden' });
  for (const tab of ['Forge workspace', 'Tuning workspace']) {
    await page.getByRole('tab', { name: tab }).click();
    assert.equal(await shelf.isVisible(), false, `full Smart Reply tray does not shrink ${tab}`);
    assert.equal(await page.getByRole('button', { name: 'Open Smart Replies in Context' }).isVisible(), true, `compact Smart Reply notice remains reachable on ${tab}`);
  }
  await page.getByRole('button', { name: 'Open Smart Replies in Context' }).click();
  await shelf.waitFor({ state: 'visible' });
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    useAppStore.setState({ smartReplies: [], smartReplyNotice: null, smartRepliesLoading: false });
  });
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.locator('textarea').inputValue(), 'Draft remains behind Smart Replies', 'Smart Reply replacement preserves the operator draft');

  await page.getByRole('button', { name: 'Open supporting audio and memory context' }).click();
  const supporting = page.getByText('Supporting Context', { exact: true });
  await supporting.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close supporting context' }).click();
  await supporting.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Open sent message history' }).click();
  const sentSheet = page.getByRole('dialog', { name: /sent message history/i });
  await sentSheet.waitFor({ state: 'visible' });
  const sentText = await sentSheet.innerText();
  assert.match(sentText, /Manual operator line/i);
  assert.match(sentText, /Approved mention reply/i);
  await page.keyboard.press('Escape');
  await sentSheet.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open sent message history' }).click();
  await sentSheet.waitFor({ state: 'visible' });
  await sentSheet.getByRole('button', { name: /close/i }).click();
  await sentSheet.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Open visual snapshot history' }).click();
  await page.getByText('Visual Snapshot History', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByText('Live', { exact: true }).count(), 1, 'active visual is identified');
  await page.getByRole('button', { name: 'Clear visual snapshot history' }).click();
  await page.getByRole('button', { name: 'Confirm clear visual history' }).click();
  await page.getByText('No visual snapshots captured yet.').waitFor({ state: 'visible' });
  const cleared = await page.evaluate(async () => {
    const state = (await import('/src/store.ts')).useAppStore.getState();
    return {
      url: state.visualSnapshotUrl,
      tags: state.visualContextTags,
      activeId: state.activeVisualSnapshotId,
      historyLength: state.visualSnapshotHistory.length,
    };
  });
  assert.equal(cleared.url, null);
  assert.deepEqual(cleared.tags, []);
  assert.equal(cleared.activeId, null);
  assert.equal(cleared.historyLength, 0);
  await page.getByRole('button', { name: 'Close visual snapshot history' }).click();

  const telemetry = page.locator('[data-mobile-telemetry]');
  await page.getByRole('button', { name: 'Expand status strip' }).press('Enter');
  assert.equal(await telemetry.getAttribute('data-mobile-telemetry'), 'compact');
  await page.getByRole('button', { name: 'Toggle system telemetry' }).click();
  assert.equal(await telemetry.getAttribute('data-mobile-telemetry'), 'expanded');
}

// ── Real CUSTOM timer control + persistence (390x844) ──────────────────────
// Exercises the ACTUAL Mobile cadence control (never direct Zustand mutation
// on this acceptance path) and the persisted CUSTOM value through the app's
// own persistence path. Composer motion validation continues in
// assertComposerMotion below.
async function assertCustomTimerAndComposer(page) {
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    useAppStore.setState({ autoForgeEnabled: true, sfxEnabled: true });
  });
  await page.getByRole('tab', { name: 'Tuning workspace' }).click();
  const cadence = page.getByRole('radiogroup', { name: 'Auto-Check cadence' });
  await cadence.waitFor({ state: 'visible' });
  const state = async () => page.evaluate(async () => {
    const s = (await import('/src/store.ts')).useAppStore.getState();
    return { mode: s.autoForgeAutoCheckMode, intervalMs: s.autoForgeAutoCheckIntervalMs };
  });
  const sfxAllowed = async () => page.evaluate(async () => (await import('/src/lib/sfx.ts')).getOptionalUiAudioDiagnostics().allowed);
  const resetSfx = () => page.evaluate(async () => { (await import('/src/lib/sfx.ts')).resetOptionalUiAudioDiagnostics(); });

  // Choose CUSTOM — the numeric control appears.
  await cadence.getByRole('radio', { name: 'Custom', exact: true }).click();
  const custom = page.getByRole('textbox', { name: 'Custom Auto-Check minutes' });
  await custom.waitFor({ state: 'visible' });

  // Enter commits exactly once (blur owns the commit; Enter only blurs).
  await resetSfx();
  await custom.fill('5');
  await custom.press('Enter');
  await page.waitForTimeout(150);
  assert.deepEqual(await state(), { mode: 'interval', intervalMs: 300_000 }, 'CUSTOM 5 via Enter commits exactly 300000ms');
  assert.equal(await custom.inputValue(), '5', 'displayed selection reflects CUSTOM 5');
  for (const preset of ['Smart', '30s', '1m', '2m']) {
    assert.equal(await cadence.getByRole('radio', { name: preset }).getAttribute('aria-checked'), 'false', `${preset} deselected by CUSTOM 5`);
  }
  assert.equal(await sfxAllowed(), 1, 'Enter commit plays the selection SFX exactly once');

  // Blur commits exactly once.
  await resetSfx();
  await custom.fill('99');
  await custom.blur();
  await page.waitForTimeout(150);
  assert.deepEqual(await state(), { mode: 'interval', intervalMs: 5_940_000 }, 'CUSTOM 99 via blur commits exactly 5940000ms');
  assert.equal(await sfxAllowed(), 1, 'blur commit plays the selection SFX exactly once');

  // Partial blank draft never mutates the scheduler.
  await resetSfx();
  await custom.fill('');
  await custom.blur();
  await page.waitForTimeout(150);
  assert.equal((await state()).intervalMs, 5_940_000, 'blank draft does not mutate the scheduler');
  assert.equal(await sfxAllowed(), 0, 'blank draft produces no selection SFX');

  // 0 clamps once to CUSTOM 1 (the 1m preset takes over the control slot).
  await custom.fill('0');
  await custom.blur();
  await page.waitForTimeout(150);
  assert.equal((await state()).intervalMs, 60_000, '0 clamps to CUSTOM 1 (60000ms)');

  // 100 clamps once to CUSTOM 99.
  await cadence.getByRole('radio', { name: 'Custom', exact: true }).click();
  const custom2 = page.getByRole('textbox', { name: 'Custom Auto-Check minutes' });
  await custom2.waitFor({ state: 'visible' });
  await custom2.fill('100');
  await custom2.blur();
  await page.waitForTimeout(150);
  assert.deepEqual(await state(), { mode: 'interval', intervalMs: 5_940_000 }, '100 clamps to CUSTOM 99 (5940000ms)');

  // Reload through the app's own persistence path — CUSTOM 99 survives.
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(await state(), { mode: 'interval', intervalMs: 5_940_000 }, 'CUSTOM 99M persists through the real persistence path');
  await page.getByRole('tab', { name: 'Tuning workspace' }).click();
  const custom3 = page.getByRole('textbox', { name: 'Custom Auto-Check minutes' });
  await custom3.waitFor({ state: 'visible' });
  assert.equal(await custom3.inputValue(), '99', 'remounted control displays the persisted CUSTOM 99');
  await assertComposerMotion(page);
}
// Composer motion validation (390x844, no reduced motion): the exit phase is
// measurable (opacity/height animation), the element finally unmounts, the
// chat viewport re-expands, and the draft survives Smart Reply takeover.
async function assertComposerMotion(page) {
  await page.getByRole('tab', { name: 'Context workspace' }).click();
  const chatScroll = page.locator('[data-mobile-chat-scroll]');
  const scrollHeight = () => chatScroll.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  const collapsedHeight = await scrollHeight();
  await page.getByRole('button', { name: 'Compose a chat message' }).click();
  const composer = page.locator('[data-mobile-composer="expanded"]');
  await composer.waitFor({ state: 'visible' });
  await composer.locator('textarea').fill('Animated exit draft');
  const expandedHeight = await scrollHeight();
  await page.evaluate(() => {
    const w = window;
    w.__composerExitSamples = [];
    const start = performance.now();
    const sample = () => {
      const el = document.querySelector('[data-mobile-composer="expanded"]');
      w.__composerExitSamples.push({
        t: Math.round(performance.now() - start),
        attached: !!el,
        opacity: el ? Number(getComputedStyle(el).opacity) : null,
        height: el ? Math.round(el.getBoundingClientRect().height) : null,
      });
      if (performance.now() - start < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // Smart Reply takeover closes the composer through the AnimatePresence exit.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    useAppStore.setState({
      smartRepliesLoading: false,
      smartReplies: [{
        id: 'qa-exit-r1', text: 'Takeover reply', timestamp: Date.now(),
        mentionMessageId: 'qa-exit-mention', mentionedUsername: 'viewer1', botUsername: 'BotName',
      }],
      smartReplyNotice: {
        state: 'ready', messageId: 'qa-exit-mention', username: 'viewer1', botUsername: 'BotName',
        text: '@BotName react?', receivedAt: Date.now(),
      },
    });
  });
  await composer.waitFor({ state: 'detached', timeout: 6_000 });
  const samples = await page.evaluate(() => window.__composerExitSamples);
  const exitSamples = samples.filter((s) => s.attached && (s.opacity < 1 || s.height < expandedHeight));
  assert(exitSamples.length > 0, `composer exit is animated rather than instant (first samples: ${JSON.stringify(samples.slice(0, 4))})`);
  await page.getByRole('region', { name: 'Smart Replies' }).waitFor({ state: 'visible' });

  // The draft survives the takeover and returns with the composer.
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store.ts');
    useAppStore.setState({ smartReplies: [], smartReplyNotice: null, smartRepliesLoading: false });
  });
  await composer.waitFor({ state: 'visible' });
  assert.equal(await composer.locator('textarea').inputValue(), 'Animated exit draft', 'draft survives the Smart Reply takeover and returns');

  // Closing the composer re-expands the chat viewport.
  await composer.locator('textarea').fill('');
  await composer.locator('textarea').blur();
  await composer.waitFor({ state: 'detached', timeout: 7_000 });
  const finalHeight = await scrollHeight();
  assert.equal(finalHeight > expandedHeight, true, `chat viewport expands after the composer unmounts (${finalHeight} vs ${expandedHeight})`);
  assert.equal(finalHeight >= collapsedHeight, true, 'chat viewport returns to at least its collapsed size');
}


try {
  for (const viewport of viewports) {
    const key = `${viewport.width}x${viewport.height}`;
    process.stdout.write(`QA ${key}\n`);
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      // Keep QA hermetic without turning blocked third-party embeds into
      // synthetic frame errors: documents receive an inert page, other
      // external resources receive an empty success response.
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
      return route.fulfill({
        status: 200,
        contentType: route.request().resourceType() === 'document' ? 'text/html' : 'text/plain',
        body: route.request().resourceType() === 'document' ? '<!doctype html><title>QA embed stub</title>' : '',
      });
    });
    await context.addInitScript(initStorage);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(qaUrl, { waitUntil: 'networkidle' });
    await seedWorkspace(page);
    const baseline = await assertViewportBaseline(page, viewport);
    const channelGeometry = await assertChannelGeometry(page, viewport);
    if (key === '390x844') await assertRepresentativeStates(page);
    assert.deepEqual(pageErrors, [], `no uncaught page errors at ${key}`);
    if (screenshotViewports.has(key)) {
      await page.screenshot({ path: resolve(outputDir, `mobile-${key}.png`), fullPage: true });
    }
    results.push({ ...baseline, channelGeometry, noOverflow: true, pageErrors: 0, representativeStates: key === '390x844' });
    await context.close();
  }

  process.stdout.write('QA desktop-status-dock\n');
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await desktopContext.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await desktopContext.addInitScript(initStorage);
  const desktopPage = await desktopContext.newPage();
  const desktopErrors = [];
  desktopPage.on('pageerror', (error) => desktopErrors.push(error.message));
  await desktopPage.goto(qaUrl, { waitUntil: 'networkidle' });
  await seedWorkspace(desktopPage);
  const dock = desktopPage.locator('[data-tutorial="statusbar"]');
  await dock.waitFor({ state: 'visible' });
  const dockBounds = await dock.boundingBox();
  assert(dockBounds, 'desktop Status Dock has render bounds');
  assert.equal(dockBounds.x >= 0 && dockBounds.y >= 0 && dockBounds.x + dockBounds.width <= 1281 && dockBounds.y + dockBounds.height <= 901, true, 'desktop Status Dock remains in viewport');
  await desktopPage.getByRole('button', { name: 'Show sent message log' }).click();
  const desktopLog = desktopPage.getByText('Sent Message Log', { exact: true });
  await desktopLog.waitFor({ state: 'visible' });
  assert.match(await dock.innerText(), /Manual operator line/i);
  assert.match(await dock.innerText(), /Approved mention reply/i);
  assert.deepEqual(desktopErrors, [], 'desktop Status Dock has no uncaught page errors');
  await desktopPage.screenshot({ path: resolve(outputDir, 'desktop-status-dock.png'), fullPage: true });
  desktopStatusDock = { viewport: '1280x900', visible: true, inViewport: true, sharedHistory: true, pageErrors: 0 };
  await desktopContext.close();

  process.stdout.write('QA custom timer + composer motion (390x844)\n');
  const motionContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await motionContext.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  await motionContext.addInitScript(initStorage);
  const motionPage = await motionContext.newPage();
  const motionErrors = [];
  motionPage.on('pageerror', (error) => motionErrors.push(error.message));
  await motionPage.goto(qaUrl, { waitUntil: 'networkidle' });
  await seedWorkspace(motionPage);
  await assertCustomTimerAndComposer(motionPage);
  assert.deepEqual(motionErrors, [], 'custom timer + composer motion section has no uncaught page errors');
  await motionPage.screenshot({ path: resolve(outputDir, 'mobile-custom-timer.png'), fullPage: true });
  const motionSummary = { viewport: '390x844', customTimerUi: true, custom99Persists: true, composerAnimatedExit: true, draftSurvivesTakeover: true, pageErrors: 0 };
  await motionContext.close();

  await writeFile(resolve(outputDir, 'results.json'), JSON.stringify({ executablePath, qaUrl, desktopStatusDock, motionSummary, results }, null, 2));
  console.log(JSON.stringify({ executablePath, viewports: results.length, desktopStatusDock, motionSummary, results }, null, 2));
} finally {
  await browser.close();
  await stopAppServer();
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional browser QA tooling is isolated from application dependencies.
const { chromium } = await import(pathToFileURL(resolve('audit-output/qa-tools/node_modules/playwright/index.mjs')).href);
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.QA_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const directory = resolve('audit-output/intelligence-rc');
await mkdir(directory, { recursive: true });
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await context.routeWebSocket(url => url.hostname !== '127.0.0.1', socket => socket.close());
  await context.addInitScript(() => {
    localStorage.setItem('madchatter-core-greeting-seen', '1');
    localStorage.setItem('madchatter-welcome-seen', '1');
    if (!localStorage.getItem('madchatter-storage')) localStorage.setItem('madchatter-storage', JSON.stringify({version: 29, state: {
      modeWelcomeSeen: true, studioDiscoverySeen: true, interfaceMode: 'core',
      personaChosen: true, hasForgedOnce: true, hasSentMessage: true, activationCelebrated: true,
      autoForgeEnabled: false, sfxEnabled: false,
    }}));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.QA_URL || 'http://127.0.0.1:5182', { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const { useAppStore: store } = await import('/src/store.ts');
    store.getState().updateStreamMetadata({ channelName: 'localfixture' });
    store.setState({ autoForgeEnabled: false, modeWelcomeSeen: true });
  });
  for (const width of [1600, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    await page.waitForTimeout(1100);
    const stop = page.getByRole('button', { name: 'Stop all automated bot sends', exact: true });
    assert.ok(await stop.count() > 0, `STOP exists at ${width}`);
    await stop.filter({ visible: true }).first().click();
    const resume = page.getByRole('button', { name: 'Resume automated bot sends', exact: true }).filter({ visible: true }).first();
    assert.equal(await resume.getAttribute('aria-pressed'), 'true');
    await resume.click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `horizontal overflow at ${width}`);
    await page.screenshot({ path: resolve(directory, `core-${width}.png`), fullPage: true });
    results.push({ scenario: `Core ${width}: visible STOP/resume and no horizontal overflow`, passed: true });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(async () => (await import('/src/store.ts')).useAppStore.getState().setInterfaceMode('studio'));
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: 'Stop all automated bot sends', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: 'Resume automated bot sends', exact: true }).filter({ visible: true }).first().click();
  await page.screenshot({ path: resolve(directory, 'studio-1600.png'), fullPage: true });
  assert.ok((await page.locator('body').innerText()).includes('2.0.0-rc.1'), 'release version rendered');
  results.push({ scenario: 'Studio renders and authoritative RC version is visible', passed: true });
  await page.getByRole('button', { name: 'Open system configuration' }).filter({ visible: true }).first().click();
  const episodes = page.getByRole('checkbox', { name: 'Remember shared episodes' });
  const enrichment = page.getByRole('checkbox', { name: 'AI enrichment for moments and episodes' });
  await episodes.uncheck(); await enrichment.uncheck();
  await page.screenshot({ path: resolve(directory, 'intelligence-settings.png'), fullPage: true });
  assert.deepEqual(await page.evaluate(async () => {
    const s = (await import('/src/store.ts')).useAppStore.getState();
    return [s.episodicMemoryEnabled, s.roomModelSynthesisEnabled];
  }), [false, false]);
  await page.keyboard.press('Escape');
  const restored = await page.evaluate(async () => {
    const { useAppStore: store } = await import('/src/store.ts');
    const { roomModel } = await import('/src/lib/roomModel.ts');
    store.getState().clearAllContext();
    store.getState().addStreamEvent('Fixture raid with 100 viewers', { kind: 'raid', actor: 'fixture', magnitude: 100 });
    const hadOpenMoment = roomModel.getMoments().some(m => m.status === 'open');
    await store.getState().saveCurrentChannelSnapshot();
    store.getState().clearAllContext();
    await store.getState().restoreChannelSnapshot('localfixture');
    return { hadOpenMoment, allClosed: store.getState().roomMoments.every(m => m.status === 'closed'),
      mirrorMatches: JSON.stringify(store.getState().roomMoments) === JSON.stringify(roomModel.getMoments()),
      retained: store.getState().roomMoments.length };
  });
  assert.equal(restored.hadOpenMoment, true);
  assert.equal(restored.allClosed, true); assert.equal(restored.mirrorMatches, true); assert.ok(restored.retained > 0);
  results.push({ scenario: 'Real IndexedDB restore mirrors force-closed engine history', passed: true });
  await page.reload({ waitUntil: 'networkidle' });
  assert.deepEqual(await page.evaluate(async () => {
    const s = (await import('/src/store.ts')).useAppStore.getState();
    return [s.episodicMemoryEnabled, s.roomModelSynthesisEnabled];
  }), [false, false]);
  results.push({ scenario: 'Settings controls are reachable and preferences survive reload', passed: true });
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  await writeFile(resolve(directory, 'browser-results.json'), JSON.stringify({ results, errors, externalRequestsBlocked: true }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser.close();
}

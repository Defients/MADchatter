import assert from 'node:assert/strict';
import { mkdir, writeFile, access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const output = resolve('audit-output/stream-companion');
await mkdir(output, { recursive: true });
const workspace = resolve('.');
const fixture = await mkdtemp(resolve(workspace, '.companion-ui-'));
// Render the real production app. A QA-only transform exposes its existing
// store to seed sensor truth; repository sources and production output stay uninstrumented.
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
  const path = resolve(fixture, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(fixture + '/') && !path.startsWith(fixture + '\\')) { response.writeHead(403).end(); return; }
  try { const bytes = await readFile(path); response.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream'); response.end(bytes); }
  catch { response.writeHead(404).end(); }
});
let browser;
const results = [];
try {
  console.log('Building the local UI fixture from the real app...');
  await build({ logLevel: 'error', build: { outDir: fixture, emptyOutDir: false }, plugins: [{
    name: 'companion-qa-store', transform(code, id) {
      if (id.replaceAll('\\', '/').endsWith('/src/main.tsx')) return code + '\nglobalThis.__companionQAStore = useAppStore;';
      if (id.replaceAll('\\', '/').endsWith('/src/lib/actionRateLimiter.ts')) return code + '\nglobalThis.__hudQALimiter = actionRateLimiter;';
    },
  }] });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const paths = [process.env.QA_CHROMIUM, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].filter(Boolean);
  let executablePath;
  for (const path of paths) { try { await access(path); executablePath = path; break; } catch {} }
  assert(executablePath, 'Set QA_CHROMIUM to an installed Chromium browser.');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const surface of [
    { name: 'core', width: 1520, height: 1000 },
    { name: 'mobile', width: 390, height: 844 },
    { name: 'studio', width: 1600, height: 1100 },
    { name: 'studio-narrow', width: 1280, height: 900 },
  ]) {
    const context = await browser.newContext({ viewport: surface, reducedMotion: 'reduce' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket(/^(?!ws:\/\/127\.0\.0\.1:).*/, socket => socket.close());
    await context.addInitScript(() => {
      if (localStorage.getItem('companion-qa-seeded')) return;
      localStorage.setItem('companion-qa-seeded', '1');
      localStorage.setItem('madchatter_mobile_welcome_seen_v1', '1');
      localStorage.setItem('madchatter-welcome-seen', '1');
      sessionStorage.setItem('core-mobile-composer-discovered', '1');
      sessionStorage.setItem('core-telemetry-collapsed', '1');
      localStorage.setItem('madchatter-storage', JSON.stringify({ version: 36, state: {
        interfaceMode: 'core', participationProfile: 'standard', modeWelcomeSeen: true, studioDiscoverySeen: true,
        personaChosen: true, hasForgedOnce: true, hasSentMessage: true,
        autoForgeEnabled: false, autoForgeAutoCheckEnabled: false, sfxEnabled: false,
        ttsEnabled: false, ttsBackgroundEnabled: false,
      }}));
    });
    const page = await context.newPage();
    const pending = new Set();
    page.on('request', r => pending.add(r.url()));
    page.on('requestfinished', r => pending.delete(r.url()));
    page.on('requestfailed', r => pending.delete(r.url()));
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    try { await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    catch (error) { console.error('Pending requests:', [...pending]); throw error; }
    await page.waitForFunction(() => window.__companionQAStore?.persist.hasHydrated());
    async function openControl() {
      if (surface.name.startsWith('studio')) {
        await page.evaluate(() => { const useAppStore = window.__companionQAStore; useAppStore.getState().setInterfaceMode('studio'); useAppStore.getState().setIsAutoForgeHUDOpen(true); });
        await page.locator('button:has(svg.lucide-maximize-2)').first().click();
      } else if (surface.name === 'mobile') {
        await page.getByRole('tab', { name: 'Tuning workspace' }).click();
      } else {
        await page.locator('button[aria-expanded]').filter({ hasText: /AutoForge/ }).first().click();
      }
      return page.getByRole('switch', { name: 'Stream Companion', exact: true }).filter({ visible: true }).first();
    }
    let toggle = await openControl();
    await toggle.waitFor({ state: 'visible' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.scrollIntoViewIfNeeded();
    const box = await toggle.boundingBox();
    assert(box.height >= 44 && box.width >= 44, JSON.stringify(box));
    assert(box.x >= 0 && box.x + box.width <= surface.width, 'Control overflows viewport');
    await toggle.focus();
    assert(await toggle.evaluate(el => el === document.activeElement));
    await toggle.press('Space');
    await page.waitForFunction(() => window.__companionQAStore.getState().participationProfile === 'stream_companion');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    const panel = toggle.locator('..').locator('..');
    await panel.getByText('Paused by your controls', { exact: true }).waitFor();
    const collapsedBox = await panel.boundingBox();
    assert(collapsedBox.height <= 56, `Collapsed control is too tall: ${collapsedBox.height}`);
    const disclosure = panel.getByRole('button', { name: 'Stream Companion details', exact: true });
    const description = panel.getByText('Participate from streamer speech and visuals, even when chat is quiet.', { exact: true });
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await description.isVisible(), false);
    const snapshot = await page.evaluate(() => {
      const s = window.__companionQAStore.getState();
      return { autoForge: s.autoForgeEnabled, autoCheck: s.autoForgeAutoCheckEnabled, saved: JSON.parse(localStorage.getItem('madchatter-storage')).state.participationProfile };
    });
    assert.deepEqual(snapshot, { autoForge: false, autoCheck: false, saved: 'stream_companion' });
    await page.screenshot({ path: resolve(output, `${surface.name}.png`), fullPage: false });
    await disclosure.focus(); await disclosure.press('Enter');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    await description.waitFor({ state: 'visible' });
    await panel.getByText('One shared budget across all bots.', { exact: true }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'Disclosure changed the mode');
    await page.screenshot({ path: resolve(output, `${surface.name}-expanded.png`), fullPage: false });
    await disclosure.press('Space');
    assert.equal(await description.isVisible(), false);
    let hudPanels;
    if (surface.name.startsWith('studio')) {
      const rateDisclosure = page.getByRole('button', { name: 'Rate Limit Status details', exact: true });
      const participationDisclosure = page.getByRole('button', { name: 'Participation details', exact: true });
      const ratePanel = rateDisclosure.locator('..').locator('..');
      const participationPanel = participationDisclosure.locator('..').locator('..');
      const rateDetails = page.locator(`[id="${await rateDisclosure.getAttribute('aria-controls')}"]`);
      const participationDetails = page.locator(`[id="${await participationDisclosure.getAttribute('aria-controls')}"]`);
      const readControls = () => page.evaluate(() => {
        const s = window.__companionQAStore.getState();
        return { mode: s.participationManualMode, awareness: s.participationAwarenessEnabled, stopped: s.botsGlobalStop, autoForge: s.autoForgeEnabled };
      });
      const baseline = await readControls();
      const heights = [];
      for (const [button, details, card] of [[rateDisclosure, rateDetails, ratePanel], [participationDisclosure, participationDetails, participationPanel]]) {
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        assert.equal(await details.isVisible(), false);
        const cardBox = await card.boundingBox();
        heights.push(cardBox.height);
        assert(cardBox.height <= 56 && cardBox.x >= 0 && cardBox.x + cardBox.width <= surface.width, JSON.stringify(cardBox));
        const target = await button.boundingBox();
        assert(target.height >= 44 && target.width >= 44);
        await button.focus(); await button.press('Enter');
        assert.equal(await button.getAttribute('aria-expanded'), 'true');
        await details.waitFor({ state: 'visible' });
        assert.deepEqual(await readControls(), baseline, 'Opening details changed participation');
        await button.press('Space');
        assert.equal(await details.isVisible(), false);
      }
      // STOP must remain immediately operable with details collapsed.
      const stop = participationPanel.getByRole('button', { name: 'Stop all automated bot sends', exact: true });
      const stopBox = await stop.boundingBox();
      assert(stopBox.height >= 44 && stopBox.width >= 44);
      await stop.focus(); await stop.press('Space');
      await page.waitForFunction(() => window.__companionQAStore.getState().botsGlobalStop);
      assert.equal(await participationDisclosure.getAttribute('aria-expanded'), 'false');
      await participationPanel.getByText('Automated sends stopped', { exact: true }).first().waitFor();
      const resume = participationPanel.getByRole('button', { name: 'Resume automated bot sends', exact: true });
      await resume.press('Enter');
      assert.deepEqual(await readControls(), baseline);
      // Limits continue updating while folded, including a full quota with no cooldown.
      await page.evaluate(() => {
        window.__hudQALimiter.reset();
        window.__hudQALimiter.updateConfig({ maxActionsPerHour: 1, maxActionsPerTenMinutes: 8, minCooldownMs: 0 });
        window.__hudQALimiter.recordAction();
      });
      await rateDisclosure.getByText('Limit reached', { exact: true }).waitFor();
      await page.evaluate(() => {
        window.__hudQALimiter.updateConfig({ maxActionsPerHour: 30, maxActionsPerTenMinutes: 8, minCooldownMs: 15000 });
        window.__hudQALimiter.recordAction();
      });
      await rateDisclosure.getByText(/Cooldown · \d+s/).waitFor();
      await page.evaluate(() => window.__hudQALimiter.reset());
      await rateDisclosure.getByText('Ready', { exact: true }).waitFor();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(750); // Let the app's click trail clear before visual evidence.
      await page.screenshot({ path: resolve(output, `${surface.name}-hud-collapsed.png`) });
      // The original mode and awareness actions remain reachable behind details.
      await participationDisclosure.click();
      await page.evaluate(() => window.__companionQAStore.setState({ autoForgeEnabled: true }));
      for (const [label, mode, status] of [['Quiet', 'quiet', 'Listening'], ['Direct only', 'direct_only', 'Direct replies only'], ['Auto', 'auto', 'Participating']]) {
        const modeButton = participationDetails.getByRole('button', { name: label, exact: true });
        await modeButton.press('Enter');
        await page.waitForFunction(m => window.__companionQAStore.getState().participationManualMode === m, mode);
        assert.equal(await modeButton.getAttribute('aria-pressed'), 'true');
        await participationDisclosure.getByText(status, { exact: true }).waitFor();
      }
      const awareness = participationDetails.getByRole('button', { name: 'Awareness on', exact: true });
      await awareness.press('Space');
      await page.waitForFunction(() => !window.__companionQAStore.getState().participationAwarenessEnabled);
      await participationDisclosure.getByText('Awareness off', { exact: true }).waitFor();
      await participationDetails.getByRole('button', { name: 'Awareness off (manual modes still apply)', exact: true }).press('Enter');
      await page.evaluate(() => window.__companionQAStore.setState({ autoForgeEnabled: false }));
      assert.deepEqual(await readControls(), baseline);
      await rateDisclosure.click();
      await page.mouse.move(1, 1);
      await page.waitForTimeout(750);
      await page.screenshot({ path: resolve(output, `${surface.name}-hud-expanded.png`) });
      await rateDisclosure.click(); await participationDisclosure.click();
      hudPanels = { collapsedHeights: heights, keyboardDisclosure: true, stopWhileCollapsed: true, modesAndAwareness: true, rateStates: ['ready', 'limit_reached', 'cooldown'] };
    }
    // Status follows current evidence and sensor truth, without contacting a provider.
    await page.evaluate(() => {
      const useAppStore = window.__companionQAStore;
      useAppStore.setState({ autoForgeEnabled: true, autoForgeAutoCheckEnabled: true, tmiReadState: 'connected', perceptionSummary: null });
      useAppStore.getState().appendAudioTranscript('The shortcut keeps killing me every time I use it', 'streamer');
    });
    await panel.getByText('Following streamer speech', { exact: true }).waitFor();
    await page.evaluate(() => window.__companionQAStore.getState().setAudioTranscript(''));
    await panel.getByText('Waiting for fresh stream activity', { exact: true }).waitFor();
    await page.evaluate(() => window.__companionQAStore.setState({ autoForgeEnabled: false, autoForgeAutoCheckEnabled: false }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    toggle = await openControl();
    await toggle.waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'Preference did not survive reload');
    await toggle.focus(); await toggle.press('Enter');
    await page.waitForFunction(() => window.__companionQAStore.getState().participationProfile === 'standard');
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    assert.deepEqual(errors, [], `Uncaught browser errors: ${errors.join('\n')}`);
    results.push({ surface: surface.name, status: 'PASS', touchTarget: box, collapsedHeight: collapsedBox.height, collapsibleDetails: true, hudPanels, keyboard: 'Space / Enter', persistence: 'reload', statusTransitions: ['paused', 'speech', 'waiting'], reducedMotion: true });
    console.log(`PASS ${surface.name}: placement, touch, keyboard, status and persistence`);
    await context.close();
  }
  await writeFile(resolve(output, 'ui-results.json'), JSON.stringify({ results, externalRequests: 'blocked; no credentials or live sends' }, null, 2));
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
  if (dirname(resolve(fixture)) !== workspace) throw new Error('Unexpected UI fixture directory');
  await rm(fixture, { recursive: true, force: true });
}

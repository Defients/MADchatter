import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(resolve('audit-output/qa-tools/node_modules/playwright/index.mjs')).href);
const outputDir = resolve('audit-output/mobile-smart-replies');
await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.QA_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const results = [];

try {
  for (const width of [320, 360, 390, 430, 768]) {
    const context = await browser.newContext({ viewport: { width, height: width === 768 ? 900 : 844 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await context.addInitScript(() => {
      localStorage.setItem('madchatter_mobile_welcome_seen_v1', '1');
      localStorage.setItem('madchatter-welcome-seen', '1');
      localStorage.setItem('madchatter-storage', JSON.stringify({ version: 34, state: {
        interfaceMode: 'core', modeWelcomeSeen: true, studioDiscoverySeen: true,
        smartRepliesEnabled: true, autoForgeEnabled: false, sfxEnabled: false,
        ttsEnabled: false, ttsBackgroundEnabled: false,
      }}));
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(process.env.QA_URL || 'http://localhost:5173', { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store.ts');
      useAppStore.setState({
        smartRepliesLoading: true,
        smartReplyNotice: {
          state: 'loading', messageId: 'qa-mention', username: 'viewer123', botUsername: 'BotName',
          text: '@BotName what do you think?', receivedAt: Date.now(),
        },
      });
    });
    const shelf = page.getByRole('region', { name: 'Smart Replies' });
    await shelf.waitFor({ state: 'visible' });
    assert.match(await shelf.innerText(), /Mention detected.*generating replies/i);

    for (const tab of ['Context workspace', 'Forge workspace', 'Tuning workspace']) {
      await page.getByRole('tab', { name: tab }).click();
      assert.equal(await shelf.isVisible(), true, `Smart Reply shelf remains visible on ${tab} at ${width}px`);
    }

    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store.ts');
      useAppStore.setState({
        smartRepliesLoading: false,
        smartReplies: [
          { id: 'qa-r1', text: 'That depends—how brave are we feeling?', timestamp: Date.now(), mentionMessageId: 'qa-mention', mentionedUsername: 'viewer123', botUsername: 'BotName' },
          { id: 'qa-r2', text: 'I think chat already chose chaos.', timestamp: Date.now(), mentionMessageId: 'qa-mention', mentionedUsername: 'viewer123', botUsername: 'BotName' },
        ],
        smartReplyNotice: {
          state: 'ready', messageId: 'qa-mention', username: 'viewer123', botUsername: 'BotName',
          text: '@BotName what do you think?', receivedAt: Date.now(),
        },
      });
    });
    assert.equal(await shelf.getByRole('button').filter({ has: page.locator('svg') }).count() >= 2, true);

    const backgroundTts = page.getByRole('button', { name: /Background TTS/i });
    await backgroundTts.scrollIntoViewIfNeeded();
    assert.equal(await backgroundTts.isDisabled(), true, `Background TTS disabled while TTS off at ${width}px`);
    const tts = page.getByRole('button', { name: /^Text-to-Speech \(TTS\)/i });
    await tts.click();
    assert.equal(await backgroundTts.isEnabled(), true, `Background TTS enabled after TTS on at ${width}px`);

    for (const [value, label] of [[0.2, 'AGGRESSIVE'], [0.5, 'ACTIVE'], [0.7, 'BALANCED'], [0.8, 'CAUTIOUS'], [0.95, 'STRICT']]) {
      await page.evaluate(async ({ value }) => (await import('/src/store.ts')).useAppStore.getState().setAutoForgeConfidenceThreshold(value), { value });
      assert.match(await page.locator('body').innerText(), new RegExp(label));
    }

    const bodyText = await page.locator('body').innerText();
    assert.equal(/bot roster|add bot|choose bot/i.test(bodyText), false, `no Mobile CORE multi-bot controls at ${width}px`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false, `no horizontal page overflow at ${width}px`);
    assert.deepEqual(pageErrors, [], `no uncaught page errors at ${width}px`);
    await page.screenshot({ path: resolve(outputDir, `mobile-${width}.png`), fullPage: true });
    results.push({ width, smartReplyAllTabs: true, backgroundTtsHierarchy: true, confidenceSemantics: true, noMultiBotControls: true, noOverflow: true });
    await context.close();
  }
  await writeFile(resolve(outputDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}

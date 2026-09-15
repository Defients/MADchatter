import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the real rule engine, session guard and store with local delivery,
// toast and audio fakes. No credentials, network requests or browser are needed.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(join(workspace, '.rule-engine-check-'));
try {
  const outfile = join(directory, 'check.mjs');
  await build({
    entryPoints: ['src/lib/ruleEngine.test.ts'], outfile,
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'local-rule-effects', setup(builder) {
      builder.onResolve({ filter: /^(\.\/platformSend|\.\/sfx|sonner)$/ }, ({ path }) => ({ path, namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, ({ path }) => ({ contents:
        path === './platformSend'
          ? 'export const getPlatformSendFn = (platform, botId) => (channel, message) => globalThis.__ruleTest.send({ platform, botId, channel, message });'
          : path === './sfx' ? 'export const playSfx = () => {};'
          : 'export const toast = Object.fromEntries(["success", "warning", "error", "info"].map(level => [level, (...args) => globalThis.__ruleTest.notices.push({ level, args })]));',
      }));
    } }],
  });
  await import(pathToFileURL(outfile).href);
} finally {
  if (dirname(resolve(directory)) !== workspace) throw new Error('Unexpected test output directory');
  await rm(directory, { recursive: true, force: true });
}

import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep the real store, queue, caches and switch helper. Replace only live
// delivery adapters: these scenarios never send or use platform credentials.
const workspace = resolve(process.cwd());
const directory = await mkdtemp(join(workspace, '.channel-switch-check-'));
try {
  const outfile = join(directory, 'check.mjs');
  await build({
    entryPoints: ['src/lib/channelSwitch.test.ts'], outfile,
    bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'no-platform-delivery', setup(builder) {
      builder.onResolve({ filter: /^\.\/platformSend$/ }, () => ({ path: 'platformSend', namespace: 'fake' }));
      builder.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
        contents: 'export function getPlatformSendFn() { throw new Error("Unexpected live delivery in channel switch test"); }',
      }));
    } }],
  });
  await import(pathToFileURL(outfile).href);
} finally {
  if (dirname(resolve(directory)) !== workspace) throw new Error('Unexpected test output directory');
  await rm(directory, { recursive: true, force: true });
}

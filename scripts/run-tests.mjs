import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? discover(join(directory, entry.name))
    : entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []));
  return files.flat().sort();
}

// Each suite owns its browser fakes and may call process.exit. Isolate suites
// in separate processes and preserve their exit codes, including timeouts.
const channelSuite = resolve(root, 'src/lib/channelSwitch.test.ts');
const suites = (await discover(resolve(root, 'src'))).filter((file) => file !== channelSuite)
  .map((file) => ({ name: relative(root, file), args: ['--import', 'tsx', file] }));
for (const script of ['check-channel-switch.mjs', 'check-manual-send.mjs', 'check-platform-send.mjs']) {
  suites.push({ name: `scripts/${script}`, args: [resolve(root, 'scripts', script)] });
}
let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, suite.args, {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAIL ${suite.name}\n${result.stdout || ''}${result.stderr || ''}${result.error || ''}`);
  } else {
    console.log(`PASS ${suite.name}`);
  }
}
console.log(`\n${suites.length - failed}/${suites.length} suites passed; ${failed} failed.`);
process.exitCode = failed ? 1 : 0;

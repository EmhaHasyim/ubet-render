// Local convenience wrapper for `bun run bundle`:
// sets the updater signing env vars from ~/.tauri/ubet-render.key (without
// them `tauri build` fails — or hangs on the interactive password prompt —
// because createUpdaterArtifacts requires the key), runs `tauri build`,
// then copies the installer + signature into ./build.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const keyPath = join(homedir(), '.tauri', 'ubet-render.key');
if (!existsSync(keyPath)) {
  console.error(`Updater signing key not found: ${keyPath}`);
  console.error(
    'Generate it once with: bun run tauri signer generate -w ~/.tauri/ubet-render.key -p ""',
  );
  process.exit(1);
}

const result = spawnSync('bun', ['run', 'tauri', 'build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8').trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  },
});
if (result.status !== 0) process.exit(result.status ?? 1);

await import('./copy-bundle.mjs');

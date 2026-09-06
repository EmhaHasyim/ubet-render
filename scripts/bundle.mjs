// Local convenience wrapper for `bun run bundle`:
// sets the updater signing env vars from ~/.tauri/ubet-render.key (without
// them `tauri build` fails — or hangs on the interactive password prompt —
// because createUpdaterArtifacts requires the key), runs `tauri build`,
// then copies the installer + signature into ./build.
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

// Copy the freshly built Windows installer from Tauri's bundle dir to
// ./build at the repo root, so the artifact is easy to reach after
// `bun run bundle`. Pure local convenience: CI release pipelines read
// straight from src-tauri/target/release/bundle.
const bundleDir = resolve('src-tauri/target/release/bundle/nsis');
const outDir = resolve('build');
// Bundle dir accumulates artifacts from older builds; only copy the
// artifacts matching the version currently declared in tauri.conf.json.
let version;
try {
  version = JSON.parse(
    readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
} catch {
  console.error('Could not read version from src-tauri/tauri.conf.json');
  process.exit(1);
}

if (!statSync(bundleDir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`Bundle dir not found: ${bundleDir}`);
  console.error('Run `bun run tauri build` first.');
  process.exit(1);
}

// Clear stale artifacts from previous versions so ./build always holds
// exactly the latest bundle pair.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = readdirSync(bundleDir).filter(
  (f) => /\.(exe|sig)$/i.test(f) && f.includes(version),
);
for (const f of files) {
  copyFileSync(join(bundleDir, f), join(outDir, f));
}

console.log(`Installer copied to ${outDir}:`);
for (const f of files) console.log(`  ${join(outDir, f)}`);

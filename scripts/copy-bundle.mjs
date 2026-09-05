// Copies the freshly built Windows installer from Tauri's bundle dir to
// ./build at the repo root, so the artifact is easy to reach after
// `bun run bundle`. Pure local convenience: CI release pipelines read
// straight from src-tauri/target/release/bundle.
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const bundleDir = resolve('src-tauri/target/release/bundle/nsis');
const outDir = resolve('build');
// Bundle dir accumulates artifacts from older builds; only copy the
// artifacts matching the version currently declared in tauri.conf.json.
const version = JSON.parse(
  readFileSync(resolve('src-tauri/tauri.conf.json'), 'utf8'),
).version;

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

// One-command version bump: `bun run release:prepare 0.4.2`.
//
// Writes the version to package.json, src-tauri/Cargo.toml and
// src-tauri/tauri.conf.json, re-syncs both lockfiles, then re-reads
// everything to prove they agree. Refuses to run from a drifted state.
// Tagging (`git tag v0.4.2`) stays manual — a version you didn't mean
// to ship is worse than one more command.
//
// Run from the repo root (same assumption as scripts/bundle.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const [next] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
  fail('Usage: bun run release:prepare <x.y.z> (bare version, no leading v)');
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    fail(`${p} is missing or not valid JSON`);
  }
};
const writeJson = (p, obj) => {
  // Preserve each file's existing line endings so a version bump never
  // reformats the file.
  const eol = readFileSync(p, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`.replaceAll('\n', eol));
};

const pkgPath = 'package.json';
const confPath = 'src-tauri/tauri.conf.json';
const cargoPath = 'src-tauri/Cargo.toml';
const cargoLockPath = 'src-tauri/Cargo.lock';

const cargoSrc = readFileSync(cargoPath, 'utf8');
const headEnd = cargoSrc.indexOf('[build-dependencies]');
const head = headEnd === -1 ? '' : cargoSrc.slice(0, headEnd);
const cargoVer = head.match(/^version = "(.*)"$/m)?.[1];
const current = [readJson(pkgPath).version, readJson(confPath).version];
current.push(cargoVer);
if (new Set(current).size !== 1 || !current[0]) {
  fail(
    `versions already drifted: package.json=${current[0]} ` +
      `tauri.conf.json=${current[1]} Cargo.toml=${current[2]}`,
  );
}
const prev = current[0];
if (next === prev) fail(`already at ${next} — nothing to do`);

// package.json (round-trip clean — full rewrite is zero-noise)
const pkg = readJson(pkgPath);
pkg.version = next;
writeJson(pkgPath, pkg);

// tauri.conf.json is NOT round-trip clean (hand-collapsed arrays), so
// patch just the version line — byte-preserving for everything else.
// Verified single occurrence; the re-read below proves the result.
const confSrc = readFileSync(confPath, 'utf8');
const confAnchor = `"version": "${prev}"`;
if (!confSrc.includes(confAnchor)) {
  fail('version line not found in tauri.conf.json');
}
writeFileSync(confPath, confSrc.replace(confAnchor, `"version": "${next}"`));

// Cargo.toml — only the [package] header, never dependency versions.
const nextHead = head.replace(/^version = ".*"$/m, `version = "${next}"`);
if (nextHead === head) fail('version line not found in Cargo.toml [package]');
writeFileSync(cargoPath, nextHead + cargoSrc.slice(headEnd));

// Lockfiles: bun re-resolves (fast, offline); the Cargo.lock root entry
// is patched as text (same anchor cargo itself uses) to avoid a slow
// toolchain invocation for a one-line change.
execFileSync('bun', ['install'], { stdio: 'inherit' });
const lockAnchor = `name = "ubet-render"\nversion = "${prev}"`;
const lockSrc = readFileSync(cargoLockPath, 'utf8');
if (!lockSrc.includes(lockAnchor)) fail('Cargo.lock root entry not found');
writeFileSync(
  cargoLockPath,
  lockSrc.replace(lockAnchor, `name = "ubet-render"\nversion = "${next}"`),
);

// Prove it: re-read from disk, including the exact command CI runs.
for (const [name, v] of [
  ['package.json', readJson(pkgPath).version],
  ['tauri.conf.json', readJson(confPath).version],
  [
    'Cargo.toml',
    readFileSync(cargoPath, 'utf8').match(/^version = "(.*)"$/m)?.[1],
  ],
]) {
  if (v !== next) fail(`${name} still at ${v}`);
}
const lockAfter = readFileSync(cargoLockPath, 'utf8');
if (!lockAfter.includes(`name = "ubet-render"\nversion = "${next}"`)) {
  fail('Cargo.lock not updated');
}
execFileSync('bun', ['install', '--frozen-lockfile'], { stdio: 'ignore' });

console.log(
  `version ${prev} → ${next} across 5 files. Next: commit + tag v${next}`,
);

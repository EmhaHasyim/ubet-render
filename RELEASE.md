# Release Process

How to cut a release. The `Release` workflow (`.github/workflows/release.yml`)
does the heavy lifting:

- pushing to `main` builds the signed Windows installer and uploads it as a
  workflow artifact (downloadable from the Actions tab);
- pushing a `v*` tag additionally creates a GitHub Release with the installer,
  its updater signature (`.sig`), and `latest.json`.

## Prerequisites (one-time)

- **Signing keypair** — lives in `~/.tauri/ubet-render.key` (+ `.pub`) on the
  dev machine, never in the repo. **Back it up.** Losing it means existing
  installs can never receive updates again.
- **GitHub secret** — `TAURI_SIGNING_PRIVATE_KEY` in repo Settings → Secrets
  and variables → Actions, containing the full content of
  `~/.tauri/ubet-render.key`. The key has no password. Without this secret,
  CI builds fail.

## Steps

1. **Bump the version** in all three manifests so they match the tag you are
   about to push (the Release tag is derived from `tauri.conf.json`):

   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
   - `package.json`

   Update the version footer in `README.md` and add a `CHANGELOG.md` entry.

2. **Push main** (builds + uploads the installer artifact):

   ```bash
   git push origin main
   ```

3. **Push the tag** (must equal the version in `tauri.conf.json`):

   ```bash
   git tag v0.4.0
   git push origin v0.4.0
   ```

   This creates the GitHub Release with installer, signature, and
   `latest.json`.

4. **Verify** the run finished green and the update manifest is reachable:
   https://github.com/EmhaHasyim/ubet-render/releases/latest/download/latest.json

## Rollback

The in-app updater only upgrades — it never downgrades. To roll back a bad
release, revert the change and ship it as the next patch version (e.g.
`v0.4.1`). Interrupted renders resume from the on-disk state file, so a
force-quit mid-render is not data loss.

## Local builds

`bun run bundle` builds the signed installer and copies the `.exe` + `.sig`
into `build/` at the repo root. It reads the signing key from
`~/.tauri/ubet-render.key` automatically; no environment setup needed.

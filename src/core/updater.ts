/**
 * Self-update check for production builds.
 *
 * Runs once on app startup (see App.tsx) and silently installs a newer
 * release when one exists. On Windows the updater auto-exits the app during
 * install, so the user simply reopens it to get the new version — no manual
 * restart handling needed (the plugin's `on_before_exit` handles the exit).
 *
 * Skipped in dev/browser mode: there is no Tauri IPC there.
 */
import { check } from '@tauri-apps/plugin-updater';
import { createLogger } from './logger';
import { notify } from './notify';
import { showToast } from './toast';

const log = createLogger('updater');

export async function checkForUpdates(): Promise<void> {
  if (import.meta.env.DEV) return;
  try {
    const update = await check();
    if (!update) return;
    log.info(`Update v${update.version} found, downloading...`);
    showToast(`Update v${update.version} found — downloading...`, {
      variant: 'info',
      ttl: 5000,
    });
    await update.downloadAndInstall();
    log.info('Update installed');
    showToast(
      `Update v${update.version} installed — reopen the app to apply it`,
      {
        variant: 'success',
        ttl: 8000,
      },
    );
    void notify(
      'Update installed',
      `v${update.version} is ready — reopen the app to apply it.`,
    );
  } catch (err) {
    // Best-effort: a failed check (offline, GitHub down) must never break startup.
    log.warn('Update check failed:', err);
  }
}

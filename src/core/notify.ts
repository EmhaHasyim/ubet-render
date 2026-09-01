import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { createLogger } from './logger';

// Replaces 1 ad-hoc console.error call; see `src/core/logger.ts`.
const log = createLogger('notify');

// Cache the permission grant so we don't re-request on every call.
let permissionCached: boolean | null = null;

async function ensurePermission(): Promise<boolean> {
  // Cache the outcome for the session: a granted permission is stable, and a
  // denied/not-granted decision is remembered by the OS, so re-querying (or
  // worse, re-prompting) on every notification would be both noisy and
  // useless.
  if (permissionCached !== null) return permissionCached;
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === 'granted';
    }
    permissionCached = granted;
    return granted;
  } catch {
    // Transient IPC failure (plugin not ready during early startup, IPC
    // hiccup): do NOT cache. Caching `false` here would silently disable
    // notifications for the rest of the session even though the failure was
    // one-off; the next notify() call re-checks instead.
    return false;
  }
}

export async function notify(title: string, body: string) {
  try {
    if (await ensurePermission()) {
      await sendNotification({ title, body });
    }
  } catch (err) {
    log.error('Notification failed:', err);
  }
}

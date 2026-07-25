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
    permissionCached = false;
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

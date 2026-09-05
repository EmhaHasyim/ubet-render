// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsPermissionGranted = vi.fn();
const mockRequestPermission = vi.fn();
const mockSendNotification = vi.fn();

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission: mockRequestPermission,
  sendNotification: mockSendNotification,
}));

let notify: typeof import('./notify').notify;

async function reloadNotify() {
  vi.resetModules();
  vi.doMock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: mockIsPermissionGranted,
    requestPermission: mockRequestPermission,
    sendNotification: mockSendNotification,
  }));
  const mod = await import('./notify');
  notify = mod.notify;
}

describe('notify — extended coverage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await reloadNotify();
  });

  it('handles isPermissionGranted throwing in ensurePermission', async () => {
    mockIsPermissionGranted.mockRejectedValue(new Error('IPC down'));

    await expect(notify('T', 'B')).resolves.toBeUndefined();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('handles requestPermission returning non-granted string', async () => {
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue('prompt'); // not 'granted'

    await expect(notify('T', 'B')).resolves.toBeUndefined();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('caches denial result correctly (does not re-request)', async () => {
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue('denied');

    await notify('First', 'Call');
    await notify('Second', 'Call');

    // Only one isPermissionGranted call (cached)
    expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('handles sendNotification throwing inside notify try block', async () => {
    mockIsPermissionGranted.mockResolvedValue(true);
    mockSendNotification.mockRejectedValue(new Error('send failed'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notify('T', 'B')).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('does NOT cache a transient isPermissionGranted failure (retries next call)', async () => {
    // First call: isPermissionGranted throws (e.g. plugin not ready during
    // early startup). The failure must not be cached as a permanent denial.
    mockIsPermissionGranted.mockRejectedValueOnce(new Error('fail'));
    await notify('First', 'Call');
    expect(mockSendNotification).not.toHaveBeenCalled();

    // Second call: the plugin has recovered — permission is re-checked and
    // the notification is sent.
    mockIsPermissionGranted.mockResolvedValue(true);
    await notify('Second', 'Call');
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Second',
      body: 'Call',
    });
  });

  it('does NOT cache a transient requestPermission failure (retries next call)', async () => {
    mockIsPermissionGranted.mockResolvedValueOnce(false);
    mockRequestPermission.mockRejectedValueOnce(new Error('fail'));
    await notify('First', 'Call');
    expect(mockSendNotification).not.toHaveBeenCalled();

    // Plugin recovered — subsequent call grants and sends.
    mockIsPermissionGranted.mockResolvedValueOnce(false);
    mockRequestPermission.mockResolvedValue('granted');
    await notify('Second', 'Call');
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Second',
      body: 'Call',
    });
  });
});

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

// We must isolate the module-level `permissionCached` variable.
// The only clean way in vitest is to reset modules and re-import on every test.
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

describe('notify', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await reloadNotify();
  });

  it('sends notification when permission is already granted', async () => {
    mockIsPermissionGranted.mockResolvedValue(true);

    await notify('Test Title', 'Test Body');

    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Test Title',
      body: 'Test Body',
    });
  });

  it('requests permission when not yet granted, then sends if granted', async () => {
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue('granted');

    await notify('Title', 'Body');

    expect(mockRequestPermission).toHaveBeenCalled();
    expect(mockSendNotification).toHaveBeenCalledWith({
      title: 'Title',
      body: 'Body',
    });
  });

  it('does NOT send when permission is denied', async () => {
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue('denied');

    await notify('Title', 'Body');

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('caches permission result (calls isPermissionGranted only once)', async () => {
    mockIsPermissionGranted.mockResolvedValue(true);

    await notify('First', 'Call');
    await notify('Second', 'Call');

    expect(mockIsPermissionGranted).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });

  it('handles isPermissionGranted throwing gracefully', async () => {
    mockIsPermissionGranted.mockRejectedValue(new Error('IPC error'));

    await expect(notify('Title', 'Body')).resolves.toBeUndefined();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('handles sendNotification throwing gracefully', async () => {
    mockIsPermissionGranted.mockResolvedValue(true);
    mockSendNotification.mockRejectedValue(new Error('Send failed'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(notify('Title', 'Body')).resolves.toBeUndefined();
    // The shared `logger.ts` formatter concatenates arguments into a single
    // line (with timestamp + context prefixes) before calling
    // `console.error`, so the spy sees a single string argument rather
    // than the two-arg call site form. Asserting on substring + Error
    // reference via the call's safeStringify output keeps the contract
    // ("a failure was logged with the original Error captured") without
    // coupling to the internal formatting style.
    const calls = consoleSpy.mock.calls.flat().join('\n');
    expect(calls).toContain('Notification failed');
    expect(calls.toLowerCase()).toContain('send failed');

    consoleSpy.mockRestore();
  });

  it('handles requestPermission throwing gracefully', async () => {
    mockIsPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockRejectedValue(new Error('IPC error'));

    await expect(notify('Title', 'Body')).resolves.toBeUndefined();
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

import { describe, it, expect } from 'vitest';

describe('components/index barrel export', () => {
  it('exports all expected components', async () => {
    const barrel = await import('./index');

    expect(barrel.OverallProgress).toBeDefined();
    expect(barrel.HardwareInfo).toBeDefined();
    expect(barrel.ConfirmDialog).toBeDefined();
    expect(barrel.AppHeader).toBeDefined();
    expect(barrel.Titlebar).toBeDefined();
    expect(barrel.SettingsCard).toBeDefined();
    expect(barrel.StatsStrip).toBeDefined();
    expect(barrel.JobTable).toBeDefined();
    expect(barrel.LogViewer).toBeDefined();
  });

  it('does NOT export deleted SettingsSection', async () => {
    const barrel = await import('./index');
    expect((barrel as Record<string, unknown>).SettingsSection).toBeUndefined();
  });
});

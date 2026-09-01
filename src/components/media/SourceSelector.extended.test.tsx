import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@solidjs/testing-library';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));
vi.mock('@tauri-apps/api/path', () => ({
  dirname: vi.fn((path: string) =>
    Promise.resolve(path.split('/').slice(0, -1).join('/') || '/'),
  ),
}));

import { SourceSelector } from './SourceSelector';
import { open } from '@tauri-apps/plugin-dialog';

const defaultProps = {
  label: 'Master video',
  allowedExtensions: ['.mp4', '.mkv', '.mov'],
  value: [] as string[],
  onChange: vi.fn(),
  icon: 'lucide:video',
  themeColor: 'primary' as const,
};

describe('SourceSelector — extended coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls open dialog when browse button clicked', () => {
    render(() => <SourceSelector {...defaultProps} />);
    // Click the browse area (the dashed border button)
    const browseBtn = screen.getByText('Master video').closest('button')!;
    browseBtn.click();
    expect(open).toHaveBeenCalled();
  });

  it('calls onChange with selected files after browsing', async () => {
    const onChange = vi.fn();
    const mockOpen = open as ReturnType<typeof vi.fn>;
    mockOpen.mockResolvedValue(['/videos/test.mp4', '/videos/other.mkv']);

    render(() => <SourceSelector {...defaultProps} onChange={onChange} />);

    const browseBtn = screen.getByText('Master video').closest('button')!;
    browseBtn.click();

    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        '/videos/test.mp4',
        '/videos/other.mkv',
      ]);
    });
  });

  it('does NOT call onChange when dialog is cancelled', async () => {
    const onChange = vi.fn();
    const mockOpen = open as ReturnType<typeof vi.fn>;
    mockOpen.mockResolvedValue(null);

    render(() => <SourceSelector {...defaultProps} onChange={onChange} />);

    screen.getByText('Master video').closest('button')!.click();

    await vi.waitFor(() => {
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('opens clear confirmation dialog when Clear clicked', () => {
    render(() => <SourceSelector {...defaultProps} value={['/v/test.mp4']} />);

    screen.getByText('Clear').click();
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeTruthy();
  });

  it('closes confirmation when Cancel is clicked', () => {
    render(() => <SourceSelector {...defaultProps} value={['/v/test.mp4']} />);

    screen.getByText('Clear').click();
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeTruthy();
    screen.getByText('Cancel').click();
    // Dialog closes, confirm button is removed
    expect(screen.queryByTestId('confirm-dialog-confirm')).toBeNull();
  });

  it('renders different theme colors', () => {
    const themes = ['primary', 'secondary', 'accent', 'info'] as const;
    for (const theme of themes) {
      const { container } = render(() => (
        <SourceSelector {...defaultProps} themeColor={theme} />
      ));
      // Each theme should render without crashing
      expect(container).toBeTruthy();
    }
  });
});

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

describe('SourceSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the label', () => {
    render(() => <SourceSelector {...defaultProps} />);
    expect(screen.getByText('Master video')).toBeTruthy();
  });

  it('shows "Choose files" when no files selected', () => {
    render(() => <SourceSelector {...defaultProps} />);
    expect(screen.getByText('Choose files')).toBeTruthy();
  });

  it('shows extension list as fallback when no files selected', () => {
    render(() => <SourceSelector {...defaultProps} />);
    expect(screen.getByText('.mp4, .mkv, .mov')).toBeTruthy();
  });

  it('shows file count when files are selected', () => {
    render(() => (
      <SourceSelector
        {...defaultProps}
        value={['/videos/intro.mp4', '/videos/loop.mp4']}
      />
    ));
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('shows file names when files are selected', () => {
    render(() => (
      <SourceSelector {...defaultProps} value={['/videos/intro.mp4']} />
    ));
    expect(screen.getByText('intro.mp4')).toBeTruthy();
  });

  it('shows "Selected files" header when files are selected', () => {
    render(() => <SourceSelector {...defaultProps} value={['/v/intro.mp4']} />);
    expect(screen.getByText('Selected files')).toBeTruthy();
  });

  it('shows clear button when files are selected', () => {
    render(() => <SourceSelector {...defaultProps} value={['/v/intro.mp4']} />);
    expect(screen.getByText('Clear')).toBeTruthy();
  });

  it('calls onChange with null when Clear is confirmed', () => {
    const onChange = vi.fn();

    render(() => (
      <SourceSelector
        {...defaultProps}
        value={['/v/intro.mp4']}
        onChange={onChange}
      />
    ));

    screen.getByText('Clear').click();
    expect(screen.getByText('Clear Master video')).toBeTruthy();
    screen.getByTestId('confirm-dialog-confirm').click();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('does not call onChange when Clear is cancelled', () => {
    const onChange = vi.fn();

    render(() => (
      <SourceSelector
        {...defaultProps}
        value={['/v/intro.mp4']}
        onChange={onChange}
      />
    ));

    screen.getByText('Clear').click();
    screen.getByText('Cancel').click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows "+N more" when more than 8 files', () => {
    const files = Array.from({ length: 10 }, (_, i) => `/v/file${i}.mp4`);
    render(() => <SourceSelector {...defaultProps} value={files} />);
    expect(screen.getByText('+2 more')).toBeTruthy();
  });

  it('limits visible files to 8', () => {
    const files = Array.from({ length: 10 }, (_, i) => `/v/file${i}.mp4`);
    render(() => <SourceSelector {...defaultProps} value={files} />);
    // First 8 should be visible
    for (let i = 0; i < 8; i++) {
      expect(screen.getByText(`file${i}.mp4`)).toBeTruthy();
    }
  });

  it('shows file name from path with backslashes (Windows)', () => {
    render(() => (
      <SourceSelector {...defaultProps} value={['C:\\videos\\intro.mp4']} />
    ));
    expect(screen.getByText('intro.mp4')).toBeTruthy();
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

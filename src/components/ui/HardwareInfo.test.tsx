import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect } from 'vitest';
import { HardwareInfo } from './HardwareInfo';

const mockInfo = {
  cpuModel: 'Intel Core i7-14700K',
  gpuModel: 'NVIDIA GeForce RTX 4090',
  totalRamGB: 64,
  av1Supported: true,
};

describe('HardwareInfo', () => {
  it('shows skeleton shimmer rows when info is null', () => {
    const { container } = render(() => <HardwareInfo info={null} />);
    // skeleton-shimmer elements should be present (3 skeleton rows)
    const skeletons = container.querySelectorAll('.skeleton-shimmer');
    expect(skeletons.length).toBeGreaterThanOrEqual(3);
  });

  it('shows skeleton badge placeholder when info is null', () => {
    const { container } = render(() => <HardwareInfo info={null} />);
    // The AV1 badge area renders a skeleton
    const skeletons = container.querySelectorAll('.skeleton-shimmer');
    expect(skeletons.length).toBeGreaterThanOrEqual(4);
  });

  it('renders CPU model from hardware data', () => {
    render(() => <HardwareInfo info={mockInfo} />);
    expect(screen.getByText('Intel Core i7-14700K')).toBeTruthy();
  });

  it('renders GPU model from hardware data', () => {
    render(() => <HardwareInfo info={mockInfo} />);
    expect(screen.getByText('NVIDIA GeForce RTX 4090')).toBeTruthy();
  });

  it('renders RAM from hardware data', () => {
    render(() => <HardwareInfo info={mockInfo} />);
    expect(screen.getByText('64 GB')).toBeTruthy();
  });

  it('shows AV1 ready badge when supported', () => {
    render(() => <HardwareInfo info={mockInfo} />);
    expect(screen.getByText('AV1 ready')).toBeTruthy();
  });

  it('shows AV1 off badge when not supported', () => {
    render(() => <HardwareInfo info={{ ...mockInfo, av1Supported: false }} />);
    expect(screen.getByText('AV1 off')).toBeTruthy();
  });

  it('renders hardware section heading', () => {
    render(() => <HardwareInfo info={mockInfo} />);
    expect(screen.getByText('Hardware')).toBeTruthy();
  });
});

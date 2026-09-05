// @vitest-environment node
import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRenderLogs } from './useRenderLogs';

function mountLogs() {
  let logs!: ReturnType<typeof useRenderLogs>;
  let dispose!: () => void;

  createRoot((rootDispose) => {
    dispose = rootDispose;
    logs = useRenderLogs();
    return rootDispose;
  });

  return { logs, dispose };
}

describe('useRenderLogs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes the first log immediately', () => {
    const { logs, dispose } = mountLogs();

    logs.appendLog('[INFO] Starting render');

    expect(logs.logs()).toEqual(['[INFO] Starting render']);

    dispose();
  });

  it('flushes fewer than ten buffered logs after 100 ms', () => {
    vi.useFakeTimers();
    const { logs, dispose } = mountLogs();

    logs.appendLog('line 1');
    for (let index = 2; index <= 9; index += 1) {
      logs.appendLog(`line ${index}`);
    }

    expect(logs.logs()).toEqual(['line 1']);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(99);
    expect(logs.logs()).toEqual(['line 1']);

    vi.advanceTimersByTime(1);
    expect(logs.logs()).toHaveLength(9);
    expect(logs.logs()[8]).toBe('line 9');
    expect(vi.getTimerCount()).toBe(0);

    dispose();
  });

  it('flushes immediately when ten buffered logs arrive after the first log', () => {
    vi.useFakeTimers();
    const { logs, dispose } = mountLogs();

    logs.appendLog('line 1');
    for (let index = 2; index <= 11; index += 1) {
      logs.appendLog(`line ${index}`);
    }

    expect(logs.logs()).toHaveLength(11);
    expect(logs.logs()[0]).toBe('line 1');
    expect(logs.logs()[10]).toBe('line 11');
    expect(vi.getTimerCount()).toBe(0);

    dispose();
  });

  it('manual flush publishes buffered logs and cancels the timer', () => {
    vi.useFakeTimers();
    const { logs, dispose } = mountLogs();

    logs.appendLog('line 1');
    logs.appendLog('line 2');
    expect(vi.getTimerCount()).toBe(1);

    logs.flush();

    expect(logs.logs()).toEqual(['line 1', 'line 2']);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(100);
    expect(logs.logs()).toEqual(['line 1', 'line 2']);

    dispose();
  });

  it('reset clears buffered logs and cancels a pending flush', () => {
    vi.useFakeTimers();
    const { logs, dispose } = mountLogs();

    logs.appendLog('line 1');
    logs.appendLog('line 2');
    expect(vi.getTimerCount()).toBe(1);

    logs.reset();
    vi.advanceTimersByTime(100);

    expect(logs.logs()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    dispose();
  });

  it('cleans up a pending timer when its Solid root is disposed', () => {
    vi.useFakeTimers();
    const { logs, dispose } = mountLogs();

    logs.appendLog('line 1');
    logs.appendLog('line 2');
    expect(vi.getTimerCount()).toBe(1);

    dispose();
    vi.advanceTimersByTime(100);

    expect(logs.logs()).toEqual(['line 1']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

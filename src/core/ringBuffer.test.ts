import { describe, it, expect } from 'vitest';
import { RingBuffer } from './ringBuffer';

describe('RingBuffer', () => {
  it('starts empty', () => {
    const rb = new RingBuffer<string>(5);
    expect(rb.length).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });

  it('pushes items up to capacity', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
  });

  it('wraps around when capacity exceeded (head < count)', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([2, 3, 4]);
  });

  it('wraps around when capacity exceeded twice (multiple wraps)', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    rb.push(5);
    rb.push(6);
    rb.push(7);
    expect(rb.length).toBe(3);
    expect(rb.toArray()).toEqual([5, 6, 7]);
  });

  it('handles capacity=1 edge case', () => {
    const rb = new RingBuffer<number>(1);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.length).toBe(1);
    expect(rb.toArray()).toEqual([3]);
  });

  it('capacity=0 is guarded to 1', () => {
    const rb = new RingBuffer<string>(0);
    expect(rb.length).toBe(0);
    rb.push('a');
    expect(rb.length).toBe(1);
    expect(rb.toArray()).toEqual(['a']);
  });

  it('negative capacity is guarded to 1', () => {
    const rb = new RingBuffer<string>(-5);
    rb.push('x');
    expect(rb.length).toBe(1);
  });

  it('reset clears all items', () => {
    const rb = new RingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.reset();
    expect(rb.length).toBe(0);
    expect(rb.toArray()).toEqual([]);
  });

  it('reset allows fresh pushes after wrap', () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.push(2);
    rb.push(3); // wraps
    rb.reset();
    rb.push(4);
    rb.push(5);
    expect(rb.toArray()).toEqual([4, 5]);
  });

  it('toArray returns correct order after partial fill', () => {
    const rb = new RingBuffer<number>(10);
    rb.push(1);
    rb.push(2);
    expect(rb.length).toBe(2);
    expect(rb.toArray()).toEqual([1, 2]);
  });

  it('toArray after wrap returns chronological order (oldest first)', () => {
    const rb = new RingBuffer<string>(4);
    // Fill: [a, b, c, d], head=0
    rb.push('a');
    rb.push('b');
    rb.push('c');
    rb.push('d');
    // Wrap: head advances, buffer[0]='e', [e, b, c, d], head=1
    rb.push('e');
    expect(rb.length).toBe(4);
    // head=1 → oldest is at head (b), then c, d, e
    expect(rb.toArray()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('length reflects actual count, not capacity', () => {
    const rb = new RingBuffer<number>(100);
    rb.push(1);
    expect(rb.length).toBe(1);
    rb.push(2);
    expect(rb.length).toBe(2);
  });

  it('toArray when exactly at capacity and head=0', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(10);
    rb.push(20);
    rb.push(30);
    expect(rb.toArray()).toEqual([10, 20, 30]);
  });
});

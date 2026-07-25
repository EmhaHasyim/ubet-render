export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private readonly capacity: number;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    // Guard against capacity=0 — the modulo in push() would produce NaN.
    if (capacity < 1) capacity = 1;
    this.capacity = capacity;
    this.buffer = Array.from({ length: capacity });
  }

  push(item: T) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  reset() {
    this.head = 0;
    this.count = 0;
    this.buffer = Array.from({ length: this.capacity });
  }

  toArray(): T[] {
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count) as T[];
    }
    const start = this.head;
    return [...this.buffer.slice(start), ...this.buffer.slice(0, start)] as T[];
  }

  get length() {
    return this.count;
  }
}

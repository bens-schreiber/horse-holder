/**
 * A binary min-heap of deadlines, so reclamation costs what it reclaims.
 */
export class ExpiryQueue<T> {
  private entries: { at: number; value: T }[] = [];

  push(at: number, value: T): void {
    const entries = this.entries;
    entries.push({ at, value });
    for (let child = entries.length - 1; child > 0;) {
      const parent = (child - 1) >> 1;
      if (entries[parent]!.at <= entries[child]!.at) {
        break;
      }
      [entries[parent], entries[child]] = [entries[child]!, entries[parent]!];
      child = parent;
    }
  }

  /** Every value due at or before `now`, soonest first, removed as it goes. */
  *drain(now: number): IterableIterator<T> {
    while (this.entries.length > 0 && this.entries[0]!.at <= now) {
      yield this.pop();
    }
  }

  private pop(): T {
    const entries = this.entries;
    const top = entries[0]!;
    const last = entries.pop()!;
    if (entries.length > 0) {
      entries[0] = last;
      this.sift();
    }
    return top.value;
  }

  private sift(): void {
    const entries = this.entries;
    for (let parent = 0; ;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if (left < entries.length && entries[left]!.at < entries[smallest]!.at) {
        smallest = left;
      }
      if (right < entries.length && entries[right]!.at < entries[smallest]!.at) {
        smallest = right;
      }
      if (smallest === parent) {
        return;
      }
      [entries[parent], entries[smallest]] = [entries[smallest]!, entries[parent]!];
      parent = smallest;
    }
  }
}

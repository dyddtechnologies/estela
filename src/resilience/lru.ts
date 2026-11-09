/** Insertion-ordered map bounded by the caller; `touch` moves a key to the most recent end. */
export class LruMap<V> {
  private readonly entries = new Map<string, V>();

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  peek(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }

  /** Removes the least recently used entry accepted by `evictable`; false when none qualifies. */
  evictOne(evictable: (value: V) => boolean): boolean {
    for (const [key, value] of this.entries) {
      if (evictable(value)) {
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }
}

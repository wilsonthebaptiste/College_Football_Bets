/**
 * An in-memory Workers KV with the two calls the cache uses, recording every
 * write so tests can assert what reached L3, and at what TTL.
 */
export interface KvWrite {
  key: string;
  expirationTtl: number;
}

export class FakeKv {
  readonly store = new Map<string, string>();
  readonly writes: KvWrite[] = [];

  async get(key: string, type?: 'json' | 'text'): Promise<unknown> {
    const value = this.store.get(key);
    if (value === undefined) return null;
    return type === 'json' ? (JSON.parse(value) as unknown) : value;
  }

  async put(key: string, value: string, options: { expirationTtl?: number } = {}): Promise<void> {
    this.store.set(key, value);
    this.writes.push({ key, expirationTtl: options.expirationTtl ?? 0 });
  }

  /** As the Worker sees it: `env.SPORTS_KV`. */
  asNamespace(): KVNamespace {
    return this as unknown as KVNamespace;
  }
}

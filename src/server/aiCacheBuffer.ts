import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

interface PersistedCacheEntry {
  key: string;
  namespace: string;
  value: unknown;
  expiresAt: number;
  createdAt: number;
}

const CACHE_DIR = path.resolve(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'ai-response-cache.json');
const MAX_ENTRIES = 1000;
const SAVE_DEBOUNCE_MS = 1200;

class PersistentAiCacheBuffer {
  private readonly entries = new Map<string, PersistedCacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private initialized = false;
  private saveTimer: NodeJS.Timeout | null = null;

  // Burst rate pacer state for live Gemini calls
  private activeLiveCalls = 0;
  private readonly maxConcurrentLiveCalls = 2;
  private readonly minIntervalMs = 180;
  private lastLiveCallStartedAt = 0;
  private readonly waitQueue: Array<() => void> = [];

  private stats = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    liveCalls: 0,
    fallbacks: 0,
    diskLoaded: 0,
  };

  private ensureLoaded(): void {
    if (this.initialized) return;
    this.initialized = true;
    try {
      if (!fs.existsSync(CACHE_FILE)) return;
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedCacheEntry[];
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      let loaded = 0;
      for (const item of parsed) {
        if (
          item &&
          typeof item.key === 'string' &&
          typeof item.expiresAt === 'number' &&
          item.expiresAt > now
        ) {
          this.entries.set(item.key, item);
          loaded++;
        }
      }
      this.stats.diskLoaded = loaded;
    } catch {
      // Ignore corrupt or unavailable cache file; in-memory mode remains active
    }
  }

  private schedulePersist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushToDisk();
    }, SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === 'function') {
      this.saveTimer.unref();
    }
  }

  async flushToDisk(): Promise<void> {
    this.ensureLoaded();
    try {
      const now = Date.now();
      const snapshot: PersistedCacheEntry[] = [];
      for (const [k, v] of this.entries) {
        if (v.expiresAt > now) {
          snapshot.push(v);
        } else {
          this.entries.delete(k);
        }
      }
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      const tmpFile = `${CACHE_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmpFile, JSON.stringify(snapshot), 'utf8');
      await fsp.rename(tmpFile, CACHE_FILE);
    } catch {
      // Safe no-op on read-only environments
    }
  }

  makeKey(namespace: string, parts: unknown[]): string {
    const digest = crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    return `${namespace}:${digest}`;
  }

  get<T>(key: string): T | undefined {
    this.ensureLoaded();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      this.schedulePersist();
      return undefined;
    }
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, namespace: string, value: T, ttlMs: number): void {
    this.ensureLoaded();
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, {
      key,
      namespace,
      value,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    });
    this.schedulePersist();
  }

  /**
   * Resolves from cache if present, coalesces identical concurrent requests
   * via an in-flight buffer, and persists the result across server restarts.
   */
  async getOrCompute<T>(params: {
    namespace: string;
    keyParts: unknown[];
    ttlMs: number;
    bypassCache?: boolean;
    shouldCache?: (value: T) => boolean;
    compute: () => Promise<T>;
  }): Promise<{ value: T; cacheHit: boolean }> {
    const key = this.makeKey(params.namespace, params.keyParts);

    if (!params.bypassCache) {
      const cached = this.get<T>(key);
      if (cached !== undefined) {
        this.stats.hits++;
        return { value: cached, cacheHit: true };
      }
    }

    const existingPromise = this.inFlight.get(key) as Promise<T> | undefined;
    if (existingPromise) {
      this.stats.coalesced++;
      const value = await existingPromise;
      return { value, cacheHit: true };
    }

    this.stats.misses++;
    const work = (async () => {
      try {
        const result = await params.compute();
        const allowSave = params.shouldCache ? params.shouldCache(result) : true;
        if (allowSave) {
          this.set(key, params.namespace, result, params.ttlMs);
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, work);
    const value = await work;
    return { value, cacheHit: false };
  }

  /**
   * Serializes & paces live cloud AI requests to prevent burst 429 spikes.
   */
  async scheduleLiveCall<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeLiveCalls >= this.maxConcurrentLiveCalls) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    this.activeLiveCalls++;
    try {
      const elapsed = Date.now() - this.lastLiveCallStartedAt;
      if (elapsed < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
      }
      this.lastLiveCallStartedAt = Date.now();
      this.stats.liveCalls++;
      return await fn();
    } finally {
      this.activeLiveCalls--;
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  recordFallback(): void {
    this.stats.fallbacks++;
  }

  recordHit(): void {
    this.stats.hits++;
  }

  getStats() {
    this.ensureLoaded();
    const now = Date.now();
    let activeEntries = 0;
    const byNamespace: Record<string, number> = {};
    for (const [k, v] of this.entries) {
      if (v.expiresAt > now) {
        activeEntries++;
        byNamespace[v.namespace] = (byNamespace[v.namespace] ?? 0) + 1;
      } else {
        this.entries.delete(k);
      }
    }
    return {
      ...this.stats,
      activeEntries,
      inFlightCount: this.inFlight.size,
      byNamespace,
    };
  }

  clearAll(): void {
    this.entries.clear();
    this.inFlight.clear();
    void this.flushToDisk();
  }
}

export const aiCacheBuffer = new PersistentAiCacheBuffer();

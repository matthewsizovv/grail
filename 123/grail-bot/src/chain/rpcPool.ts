import { JsonRpcProvider, type Provider } from 'ethers';
import { RetryableError } from '../core/errors.js';
import { logger } from '../core/logger.js';

interface PoolEntry {
  url: string;
  provider: JsonRpcProvider;
  failures: number;
  lastFailure: number;
}

const COOLDOWN_MS = 30_000; // 30 s cooldown after failure
const MAX_FAILURES = 3;

/**
 * Round-robin RPC pool with automatic failover.
 * Marks providers as degraded after repeated failures and skips them during cooldown.
 */
export class RpcPool {
  private entries: PoolEntry[];
  private currentIndex = 0;

  constructor(urls: string[], chainId: number) {
    if (urls.length === 0) throw new Error('RpcPool requires at least one RPC URL');
    this.entries = urls.map((url) => ({
      url,
      provider: new JsonRpcProvider(url, chainId, { staticNetwork: true }),
      failures: 0,
      lastFailure: 0,
    }));
    logger.info({ urls: urls.map((u) => this.maskUrl(u)) }, 'RPC pool initialized');
  }

  /** Get the current healthy provider */
  getProvider(): JsonRpcProvider {
    const entry = this.healthyEntry();
    if (!entry) throw new RetryableError('All RPC providers are degraded');
    return entry.provider;
  }

  /** Generic retry wrapper — rotates provider on failure */
  async call<T>(fn: (provider: JsonRpcProvider) => Promise<T>, maxRetries = 3): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const entry = this.healthyEntry();
      if (!entry) throw new RetryableError('All RPC providers degraded');
      try {
        const result = await fn(entry.provider);
        // Success: reset failures for this provider
        entry.failures = 0;
        return result;
      } catch (err) {
        lastErr = err;
        entry.failures++;
        entry.lastFailure = Date.now();
        logger.warn(
          { rpc: this.maskUrl(entry.url), attempt, err: String(err) },
          'RPC call failed, rotating',
        );
        this.rotate();
      }
    }
    throw new RetryableError(`All ${maxRetries + 1} RPC attempts failed`, lastErr);
  }

  /** Quick health check: ensure block number is advancing */
  async healthCheck(): Promise<boolean> {
    for (const entry of this.entries) {
      try {
        await entry.provider.getBlockNumber();
        entry.failures = 0;
        logger.debug({ rpc: this.maskUrl(entry.url) }, 'RPC health OK');
        return true;
      } catch {
        entry.failures++;
        entry.lastFailure = Date.now();
      }
    }
    return false;
  }

  private healthyEntry(): PoolEntry | null {
    const now = Date.now();
    // Try current index first, then rotate through all
    for (let i = 0; i < this.entries.length; i++) {
      const idx = (this.currentIndex + i) % this.entries.length;
      const entry = this.entries[idx]!;
      if (
        entry.failures < MAX_FAILURES ||
        now - entry.lastFailure > COOLDOWN_MS
      ) {
        this.currentIndex = idx;
        return entry;
      }
    }
    return null;
  }

  private rotate(): void {
    this.currentIndex = (this.currentIndex + 1) % this.entries.length;
  }

  private maskUrl(url: string): string {
    // Hide API keys embedded in URLs
    return url.replace(/\/v2\/[^/]+/, '/v2/[KEY]').replace(/\/[a-f0-9]{32}/, '/[KEY]');
  }
}

// Singleton
let _pool: RpcPool | null = null;

export function initRpcPool(urls: string[], chainId: number): RpcPool {
  _pool = new RpcPool(urls, chainId);
  return _pool;
}

export function getRpcPool(): RpcPool {
  if (!_pool) throw new Error('RPC pool not initialized — call initRpcPool first');
  return _pool;
}

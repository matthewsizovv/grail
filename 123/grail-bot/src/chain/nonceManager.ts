import type { JsonRpcProvider } from 'ethers';
import { RetryableError } from '../core/errors.js';
import { getRpcPool } from './rpcPool.js';
import { logger } from '../core/logger.js';
import { maskAddress } from '../core/logger.js';

/**
 * Local nonce cache with RPC sync.
 *
 * - Keeps a per-wallet nonce in memory.
 * - Before each tx: confirms local nonce == on-chain pending nonce.
 * - After tx broadcast: increments local nonce immediately (don't wait for confirm).
 * - On nonce-too-low error: re-syncs from chain.
 */
export class NonceManager {
  private nonces = new Map<string, number>();

  /**
   * Get the next nonce to use for `address`.
   * Syncs from RPC if not cached.
   */
  async getNonce(address: string): Promise<number> {
    if (this.nonces.has(address)) {
      return this.nonces.get(address)!;
    }
    return this.syncFromChain(address);
  }

  /**
   * Call after a tx is successfully broadcast.
   * Advances the local counter immediately.
   */
  advance(address: string): void {
    const current = this.nonces.get(address) ?? 0;
    this.nonces.set(address, current + 1);
    logger.debug({ wallet: maskAddress(address), nonce: current + 1 }, 'Nonce advanced');
  }

  /**
   * Re-sync from chain — called on nonce-too-low errors.
   */
  async syncFromChain(address: string): Promise<number> {
    const pool = getRpcPool();
    const nonce = await pool.call<number>(
      (p: JsonRpcProvider) => p.getTransactionCount(address, 'pending'),
    );
    this.nonces.set(address, nonce);
    logger.debug({ wallet: maskAddress(address), nonce }, 'Nonce synced from chain');
    return nonce;
  }

  /**
   * Verify local nonce matches on-chain pending nonce.
   * Throws RetryableError with a resync if drift detected.
   */
  async assertSync(address: string): Promise<void> {
    const local = this.nonces.get(address);
    if (local === undefined) {
      await this.syncFromChain(address);
      return;
    }

    const pool = getRpcPool();
    const onChain = await pool.call<number>(
      (p: JsonRpcProvider) => p.getTransactionCount(address, 'pending'),
    );

    if (local !== onChain) {
      logger.warn(
        { wallet: maskAddress(address), local, onChain },
        'Nonce drift detected — resyncing',
      );
      this.nonces.set(address, onChain);
      throw new RetryableError(
        `Nonce drift for ${maskAddress(address)}: local=${local} chain=${onChain}`,
      );
    }
  }
}

// Singleton
let _nonceManager: NonceManager | null = null;

export function getNonceManager(): NonceManager {
  if (!_nonceManager) _nonceManager = new NonceManager();
  return _nonceManager;
}

export function resetNonceManager(): void {
  _nonceManager = null;
}

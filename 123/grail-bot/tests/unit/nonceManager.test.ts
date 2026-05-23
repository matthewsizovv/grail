import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NonceManager } from '../../src/chain/nonceManager.js';
import { RetryableError } from '../../src/core/errors.js';

// Mock the RPC pool
vi.mock('../../src/chain/rpcPool.js', () => ({
  getRpcPool: () => ({
    call: vi.fn().mockResolvedValue(5),
  }),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  maskAddress: (addr: string) => addr.slice(0, 6) + '…' + addr.slice(-4),
}));

const WALLET = '0x1234567890123456789012345678901234567890';

describe('NonceManager', () => {
  let nm: NonceManager;

  beforeEach(() => {
    nm = new NonceManager();
    vi.clearAllMocks();
  });

  it('fetches nonce from chain when not cached', async () => {
    const nonce = await nm.getNonce(WALLET);
    expect(nonce).toBe(5);
  });

  it('returns cached nonce on second call', async () => {
    await nm.getNonce(WALLET);
    const { getRpcPool } = await import('../../src/chain/rpcPool.js');
    const callSpy = vi.spyOn(getRpcPool(), 'call');

    const nonce = await nm.getNonce(WALLET);
    expect(nonce).toBe(5);
    // Should not call RPC again
    expect(callSpy).not.toHaveBeenCalled();
  });

  it('advances nonce after tx broadcast', async () => {
    await nm.getNonce(WALLET);
    nm.advance(WALLET);
    const nonce = await nm.getNonce(WALLET);
    expect(nonce).toBe(6);
  });

  it('syncs from chain and resets cache', async () => {
    await nm.getNonce(WALLET); // cache = 5
    nm.advance(WALLET); // cache = 6
    const synced = await nm.syncFromChain(WALLET); // RPC returns 5
    expect(synced).toBe(5);
    const nonce = await nm.getNonce(WALLET);
    expect(nonce).toBe(5);
  });
});

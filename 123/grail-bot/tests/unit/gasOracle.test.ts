import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GasOracle } from '../../src/chain/gasOracle.js';
import { parseUnits } from 'ethers';

// Mock the RPC pool
vi.mock('../../src/chain/rpcPool.js', () => ({
  getRpcPool: () => ({
    call: vi.fn().mockResolvedValue({
      baseFeePerGas: parseUnits('0.05', 'gwei'), // 0.05 gwei base fee
    }),
  }),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  maskAddress: (a: string) => a,
}));

const GAS_CONFIG = {
  baseFeeMultiplier: 1.3,
  priorityFeeGwei: '0.01',
  maxFeeGwei: '5',
  bumpPercent: 20,
};

describe('GasOracle', () => {
  let oracle: GasOracle;

  beforeEach(() => {
    oracle = new GasOracle(GAS_CONFIG);
  });

  it('computes gas params with multiplier', async () => {
    const params = await oracle.getGasParams();
    // baseFee = 0.05 gwei, * 1.3 = 0.065 gwei + priority 0.01 = 0.075 gwei
    const expectedMax = parseUnits('0.075', 'gwei');
    expect(params.maxFeePerGas).toBe(expectedMax);
    expect(params.maxPriorityFeePerGas).toBe(parseUnits('0.01', 'gwei'));
  });

  it('caps at maxFeeGwei', async () => {
    // base = 0.05 gwei, multiplier 1.3 → 0.065, + 0.01 priority = 0.075 < cap(5 gwei)
    // This test ensures cap works when fee would exceed it
    const highConfig = { ...GAS_CONFIG, maxFeeGwei: '0.001' }; // very low cap
    const highOracle = new GasOracle(highConfig);
    const params = await highOracle.getGasParams();
    expect(params.maxFeePerGas).toBe(parseUnits('0.001', 'gwei'));
  });

  it('bumps gas params by bumpPercent', async () => {
    const params = await oracle.getGasParams();
    const bumped = oracle.bump(params);
    const expected = (params.maxFeePerGas * 120n) / 100n;
    expect(bumped.maxFeePerGas).toBe(expected);
  });

  it('estimates gas cost correctly', async () => {
    const params = await oracle.getGasParams();
    const gasLimit = 200_000n;
    const cost = oracle.estimateCostEth(gasLimit, params);
    expect(cost).toBe(gasLimit * params.maxFeePerGas);
  });
});

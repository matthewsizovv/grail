import { parseUnits, formatUnits, type JsonRpcProvider } from 'ethers';
import type { Config } from '../core/config.js';
import { getRpcPool } from './rpcPool.js';
import { logger } from '../core/logger.js';

export interface GasParams {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** For logging only */
  baseFeeGwei: string;
}

/**
 * EIP-1559 gas oracle.
 * Samples baseFee from the latest block, applies multiplier, adds tip.
 */
export class GasOracle {
  private config: Config['gas'];

  constructor(gasConfig: Config['gas']) {
    this.config = gasConfig;
  }

  async getGasParams(): Promise<GasParams> {
    const pool = getRpcPool();

    const block = await pool.call<{ baseFeePerGas: bigint | null } | null>(
      (p: JsonRpcProvider) => p.getBlock('latest'),
    );

    if (!block || block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
      // Fallback: use maxFeeGwei as both max and priority
      const fee = parseUnits(this.config.maxFeeGwei, 'gwei');
      const priority = parseUnits(this.config.priorityFeeGwei, 'gwei');
      logger.warn('Could not read baseFee from block — using maxFeeGwei fallback');
      return {
        maxFeePerGas: fee,
        maxPriorityFeePerGas: priority,
        baseFeeGwei: this.config.maxFeeGwei,
      };
    }

    const baseFee = block.baseFeePerGas;
    const multiplier = BigInt(Math.round(this.config.baseFeeMultiplier * 1000));
    const adjustedBase = (baseFee * multiplier) / 1000n;

    const priorityFee = parseUnits(this.config.priorityFeeGwei, 'gwei');
    const maxFee = adjustedBase + priorityFee;
    const cap = parseUnits(this.config.maxFeeGwei, 'gwei');

    const finalMaxFee = maxFee > cap ? cap : maxFee;

    const params: GasParams = {
      maxFeePerGas: finalMaxFee,
      maxPriorityFeePerGas: priorityFee,
      baseFeeGwei: formatUnits(baseFee, 'gwei'),
    };

    logger.debug(
      {
        baseFeeGwei: params.baseFeeGwei,
        maxFeeGwei: formatUnits(params.maxFeePerGas, 'gwei'),
        priorityFeeGwei: formatUnits(params.maxPriorityFeePerGas, 'gwei'),
      },
      'Gas params computed',
    );

    return params;
  }

  /**
   * Bump gas params by `bumpPercent` for replacement transactions.
   */
  bump(params: GasParams): GasParams {
    const pct = BigInt(this.config.bumpPercent);
    const bumpFactor = 100n + pct;
    const newMaxFee = (params.maxFeePerGas * bumpFactor) / 100n;
    const newPriority = (params.maxPriorityFeePerGas * bumpFactor) / 100n;

    // Ensure priority doesn't exceed maxFee
    const finalPriority = newPriority > newMaxFee ? newMaxFee : newPriority;

    return {
      maxFeePerGas: newMaxFee,
      maxPriorityFeePerGas: finalPriority,
      baseFeeGwei: params.baseFeeGwei,
    };
  }

  /**
   * Estimate total gas cost in ETH for a given gas limit.
   */
  estimateCostEth(gasLimit: bigint, params: GasParams): bigint {
    return gasLimit * params.maxFeePerGas;
  }
}

let _oracle: GasOracle | null = null;

export function initGasOracle(gasConfig: Config['gas']): GasOracle {
  _oracle = new GasOracle(gasConfig);
  return _oracle;
}

export function getGasOracle(): GasOracle {
  if (!_oracle) throw new Error('GasOracle not initialized');
  return _oracle;
}

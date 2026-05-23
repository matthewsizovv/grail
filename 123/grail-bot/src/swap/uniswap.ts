import { Contract, Interface, type JsonRpcProvider } from 'ethers';
import { getRpcPool } from '../chain/rpcPool.js';
import { SkipTokenError } from '../core/errors.js';
import type { SwapQuote } from './router.js';

// Uniswap V3 SwapRouter02 on Base
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

const QUOTER_V2 = '0x3d4e44Eb1374240CE5F1B136588eDYe9E6aec5d'; // Base QuoterV2 — verify address

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160, uint32, uint256)',
];

const ROUTER_IFACE = new Interface(ROUTER_ABI);

// Pool fee tiers to try in order (most liquid first)
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

/**
 * Uniswap V3 on-chain fallback adapter.
 * Tries fee tiers 500 → 3000 → 10000 and uses the best quote.
 */
export async function getUniswapV3Quote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  walletAddress: string,
  slippageBps: number,
): Promise<SwapQuote> {
  let bestAmountOut = 0n;
  let bestFee = 0;

  // Quote each fee tier
  for (const fee of FEE_TIERS) {
    try {
      const quoted = await quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee);
      if (quoted > bestAmountOut) {
        bestAmountOut = quoted;
        bestFee = fee;
      }
    } catch {
      // This fee tier has no pool
    }
  }

  if (bestAmountOut === 0n) {
    throw new SkipTokenError(
      `Uniswap V3: no pool found for ${tokenIn} → ${tokenOut}`,
      tokenIn,
      'no_liquidity',
    );
  }

  const amountOutMinimum = (bestAmountOut * BigInt(10000 - slippageBps)) / 10000n;

  const data = ROUTER_IFACE.encodeFunctionData('exactInputSingle', [
    {
      tokenIn,
      tokenOut,
      fee: bestFee,
      recipient: walletAddress,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0,
    },
  ]);

  return {
    aggregator: 'uniswap_v3',
    to: UNISWAP_ROUTER,
    data,
    value: 0n,
    amountOut: bestAmountOut,
    gasEstimate: 200_000n,
  };
}

async function quoteExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  return getRpcPool().call<bigint>((p: JsonRpcProvider) => {
    const quoter = new Contract(QUOTER_V2, QUOTER_ABI, p);
    const fn = quoter['quoteExactInputSingle'] as
      | { staticCall: (args: unknown) => Promise<bigint> }
      | undefined;
    if (!fn) throw new Error('quoteExactInputSingle not found on quoter contract');
    return fn.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0,
    });
  });
}

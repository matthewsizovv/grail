import { request } from 'undici';
import { RetryableError, SkipTokenError } from '../core/errors.js';
import type { SwapQuote } from './router.js';

const BASE_URL = 'https://api.odos.xyz';

/**
 * Odos DEX aggregator adapter.
 * Docs: https://docs.odos.xyz/api/sor
 * Auth: none required for basic quotes.
 */
export async function getOdosQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  walletAddress: string,
  slippageBps: number,
  chainId: number,
): Promise<SwapQuote> {
  // Step 1: Get quote
  const quoteBody = {
    chainId,
    inputTokens: [{ tokenAddress: tokenIn, amount: amountIn.toString() }],
    outputTokens: [{ tokenAddress: tokenOut, proportion: 1 }],
    slippageLimitPercent: slippageBps / 100,
    userAddr: walletAddress,
    referralCode: 0,
    disableRFQs: false,
    compact: true,
  };

  let quoteRes: Record<string, unknown>;
  try {
    const res = await request(`${BASE_URL}/sor/quote/v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quoteBody),
    });

    if (res.statusCode === 400) {
      throw new SkipTokenError(`Odos: no route for ${tokenIn}`, tokenIn, 'no_liquidity');
    }
    if (res.statusCode === 429) {
      throw new RetryableError('Odos rate limited');
    }
    if (res.statusCode >= 500) {
      throw new RetryableError(`Odos server error: ${res.statusCode}`);
    }
    quoteRes = (await res.body.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SkipTokenError || err instanceof RetryableError) throw err;
    throw new RetryableError('Odos quote request failed', err);
  }

  const pathId = quoteRes['pathId'] as string | undefined;
  if (!pathId) {
    throw new SkipTokenError('Odos: no pathId in quote', tokenIn, 'no_liquidity');
  }

  const outAmounts = quoteRes['outAmounts'] as string[] | undefined;
  const amountOut = outAmounts?.[0] ? BigInt(outAmounts[0]) : 0n;

  // Step 2: Assemble tx
  const assembleBody = {
    userAddr: walletAddress,
    pathId,
    simulate: false,
  };

  let assembleRes: Record<string, unknown>;
  try {
    const res = await request(`${BASE_URL}/sor/assemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assembleBody),
    });

    if (res.statusCode >= 400) {
      throw new SkipTokenError('Odos: assemble failed', tokenIn, 'no_liquidity');
    }
    assembleRes = (await res.body.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SkipTokenError || err instanceof RetryableError) throw err;
    throw new RetryableError('Odos assemble request failed', err);
  }

  const tx = assembleRes['transaction'] as Record<string, unknown> | undefined;
  if (!tx) {
    throw new SkipTokenError('Odos: no transaction in assemble response', tokenIn, 'no_liquidity');
  }

  return {
    aggregator: 'odos',
    to: tx['to'] as string,
    data: tx['data'] as string,
    value: BigInt((tx['value'] as string | number) ?? 0),
    amountOut,
    gasEstimate: BigInt((tx['gas'] as string | number) ?? 500_000),
  };
}

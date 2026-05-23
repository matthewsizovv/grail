import { request } from 'undici';
import { RetryableError, SkipTokenError } from '../core/errors.js';
import type { SwapQuote } from './router.js';

const BASE_URL = 'https://api.1inch.dev/swap/v6.0';
const API_KEY = process.env['ONEINCH_KEY'] ?? '';

/**
 * 1inch DEX aggregator adapter.
 * Docs: https://portal.1inch.dev/documentation/swap/swagger
 * Auth: API key required.
 */
export async function getOneinchQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  walletAddress: string,
  slippageBps: number,
  chainId: number,
): Promise<SwapQuote> {
  if (!API_KEY) {
    throw new SkipTokenError('1inch: no API key configured', tokenIn, 'no_liquidity');
  }

  const params = new URLSearchParams({
    src: tokenIn,
    dst: tokenOut,
    amount: amountIn.toString(),
    from: walletAddress,
    slippage: String(slippageBps / 100), // percent
    disableEstimate: 'false',
    allowPartialFill: 'false',
  });

  const url = `${BASE_URL}/${chainId}/swap?${params}`;

  let statusCode: number;
  let body: unknown;

  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json',
      },
    });
    statusCode = res.statusCode;
    body = await res.body.json();
  } catch (err) {
    throw new RetryableError('1inch API request failed', err);
  }

  if (statusCode === 429) {
    throw new RetryableError('1inch rate limited');
  }

  if (statusCode === 400) {
    const msg = ((body as Record<string, unknown>)['description'] as string) ?? 'bad request';
    if (msg.includes('cannot estimate') || msg.includes('no route')) {
      throw new SkipTokenError(`1inch: no route for ${tokenIn}: ${msg}`, tokenIn, 'no_liquidity');
    }
    throw new RetryableError(`1inch 400: ${msg}`);
  }

  if (statusCode >= 500) {
    throw new RetryableError(`1inch server error: ${statusCode}`);
  }

  const data = body as Record<string, unknown>;
  const tx = data['tx'] as Record<string, unknown> | undefined;
  const dstAmount = data['dstAmount'] as string | undefined;

  if (!tx || !dstAmount) {
    throw new SkipTokenError('1inch: unexpected response shape', tokenIn, 'no_liquidity');
  }

  return {
    aggregator: '1inch',
    to: tx['to'] as string,
    data: tx['data'] as string,
    value: BigInt((tx['value'] as string | number) ?? 0),
    amountOut: BigInt(dstAmount),
    gasEstimate: BigInt((tx['gas'] as string | number) ?? 500_000),
  };
}

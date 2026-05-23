import { request } from 'undici';
import { RetryableError, SkipTokenError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { SwapQuote } from './router.js';

const BASE_URL = 'https://api.zerion.io/v1';
const API_KEY = process.env['ZERION_API_KEY'] ?? '';

/**
 * Zerion DEX aggregator adapter.
 *
 * Zerion provides a swap API that returns calldata for on-chain swaps.
 * Docs: https://developers.zerion.io/reference/getswap
 *
 * TODO: Confirm auth method (API key vs bearer token vs wallet-signed).
 */
export async function getZerionQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  walletAddress: string,
  slippageBps: number,
  chainId: number,
): Promise<SwapQuote> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };

  if (API_KEY) {
    headers['Authorization'] = `Basic ${Buffer.from(API_KEY + ':').toString('base64')}`;
  }

  const params = new URLSearchParams({
    chain_id: String(chainId),
    sell_token_address: tokenIn,
    buy_token_address: tokenOut,
    sell_amount: amountIn.toString(),
    wallet_address: walletAddress,
    slippage_tolerance: String(slippageBps / 10000), // decimal
  });

  const url = `${BASE_URL}/swap/quote?${params}`;

  let statusCode: number;
  let body: unknown;

  try {
    const res = await request(url, { method: 'GET', headers });
    statusCode = res.statusCode;
    body = await res.body.json();
  } catch (err) {
    throw new RetryableError('Zerion API request failed', err);
  }

  if (statusCode === 429) {
    throw new RetryableError('Zerion rate limited');
  }

  if (statusCode === 404 || statusCode === 400) {
    throw new SkipTokenError(
      `Zerion: no route for token ${tokenIn}`,
      tokenIn,
      'no_liquidity',
    );
  }

  if (statusCode >= 500) {
    throw new RetryableError(`Zerion server error: ${statusCode}`);
  }

  if (statusCode !== 200) {
    throw new RetryableError(`Zerion unexpected status: ${statusCode}`);
  }

  // TODO: parse actual Zerion API response shape
  const data = body as Record<string, unknown>;
  const txData = (data['data'] as Record<string, unknown> | undefined)?.['transaction'] as
    | Record<string, unknown>
    | undefined;

  if (!txData) {
    logger.warn({ body: JSON.stringify(body).slice(0, 200) }, 'Zerion: unexpected response shape');
    throw new SkipTokenError('Zerion: unexpected response', tokenIn, 'no_liquidity');
  }

  return {
    aggregator: 'zerion',
    to: txData['to'] as string,
    data: txData['data'] as string,
    value: BigInt((txData['value'] as string | number) ?? 0),
    amountOut: BigInt((txData['buy_amount'] as string | number) ?? 0),
    gasEstimate: BigInt((txData['gas_limit'] as string | number) ?? 500_000),
  };
}

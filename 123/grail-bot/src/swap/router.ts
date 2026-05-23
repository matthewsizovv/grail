import type { Wallet } from 'ethers';
import { parseUnits, formatUnits } from 'ethers';
import { getRpcPool } from '../chain/rpcPool.js';
import { getTxBuilder } from '../chain/txBuilder.js';
import { balanceOf, getDecimals } from '../chain/erc20.js';
import { getZerionQuote } from './zerion.js';
import { getOdosQuote } from './odos.js';
import { getOneinchQuote } from './oneinch.js';
import { getUniswapV3Quote } from './uniswap.js';
import { ADDRESSES } from '../grail/contracts.js';
import { walletLogger } from '../core/logger.js';
import { SkipTokenError, RetryableError } from '../core/errors.js';
import type { Config } from '../core/config.js';

export type Aggregator = 'zerion' | 'odos' | '1inch' | 'uniswap_v3';

export interface SwapQuote {
  aggregator: Aggregator;
  to: string;
  data: string;
  value: bigint;
  amountOut: bigint;
  gasEstimate: bigint;
}

export interface SellResult {
  skipped: boolean;
  skipReason?: SkipTokenError['reason'] | undefined;
  txHash?: string | undefined;
  usdcReceived?: bigint | undefined;
  aggregator?: Aggregator | undefined;
}

/**
 * Anti-honeypot sell engine.
 *
 * For each token:
 *   1. Simulate the swap via eth_call — revert → honeypot
 *   2. Check quote value vs gas cost threshold
 *   3. Try each aggregator in order (zerion → odos → 1inch → uniswap_v3)
 *   4. Send tx if simulation passes
 */
export class SwapRouter {
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async sellToken(
    wallet: Wallet,
    tokenAddress: string,
    dryRun = false,
  ): Promise<SellResult> {
    const log = walletLogger(wallet.address);
    const chainId = this.cfg.network.chainId;

    // ── Idempotency: check balance ───────────────────────────────────────
    const balance = await balanceOf(tokenAddress, wallet.address);
    if (balance === 0n) {
      log.info({ token: tokenAddress }, 'Token balance is 0, skipping sell');
      return { skipped: true, skipReason: undefined };
    }

    log.info({ token: tokenAddress, balance: balance.toString() }, 'Attempting to sell token');

    // ── Get token metadata ───────────────────────────────────────────────
    let decimals = 18;
    try {
      decimals = await getDecimals(tokenAddress);
    } catch {
      log.warn({ token: tokenAddress }, 'Could not get token decimals, defaulting to 18');
    }

    // ── Try aggregators in order ─────────────────────────────────────────
    const aggregators = this.cfg.swap.aggregators as Aggregator[];
    let quote: SwapQuote | null = null;
    let lastErr: unknown;

    let slippageBps = this.cfg.swap.slippageBps;

    for (const agg of aggregators) {
      try {
        quote = await this.getQuote(agg, tokenAddress, balance, wallet.address, slippageBps, chainId);

        // ── Anti-honeypot: threshold check ────────────────────────────
        const minValueRaw = parseUnits(this.cfg.thresholds.minTokenValueUsd, 6); // USDC 6 dec
        if (quote.amountOut < minValueRaw) {
          log.info(
            { token: tokenAddress, amountOut: quote.amountOut.toString(), minValueRaw: minValueRaw.toString(), agg },
            'Token value below threshold, trying next aggregator',
          );
          throw new SkipTokenError(
            `Below threshold: ${formatUnits(quote.amountOut, 6)} USDC`,
            tokenAddress,
            'below_threshold',
          );
        }

        // ── Anti-honeypot: eth_call simulation ────────────────────────
        log.debug({ agg, token: tokenAddress }, 'Simulating swap via eth_call');
        await this.simulateSwap(wallet.address, quote);

        // ── Honeypot detection: simulate 1% round-trip ─────────────────
        const isHoneypot = await this.detectHoneypot(
          wallet.address,
          tokenAddress,
          balance,
          slippageBps,
          chainId,
        );
        if (isHoneypot) {
          return { skipped: true, skipReason: 'honeypot' };
        }

        break; // Got a good quote
      } catch (err) {
        if (err instanceof SkipTokenError) {
          // Try increasing slippage once before giving up on this aggregator
          if (slippageBps < this.cfg.swap.maxSlippageBps && err.reason !== 'honeypot') {
            slippageBps = this.cfg.swap.maxSlippageBps;
            log.debug({ token: tokenAddress, agg }, 'Bumping slippage and retrying');
            try {
              quote = await this.getQuote(agg, tokenAddress, balance, wallet.address, slippageBps, chainId);
              await this.simulateSwap(wallet.address, quote);
              break;
            } catch (innerErr) {
              lastErr = innerErr;
              quote = null;
              continue;
            }
          }
          lastErr = err;
          quote = null;
          continue; // try next aggregator
        }
        lastErr = err;
        quote = null;
        continue; // try next aggregator
      }
    }

    if (!quote) {
      const reason = lastErr instanceof SkipTokenError ? lastErr.reason : 'no_liquidity';
      log.warn({ token: tokenAddress, reason }, 'All aggregators failed, skipping token');
      return { skipped: true, skipReason: reason };
    }

    // ── Send swap tx ──────────────────────────────────────────────────────
    const [balEth, balUsdc, blockNumber] = await Promise.all([
      getRpcPool().call((p) => p.getBalance(wallet.address)),
      balanceOf(ADDRESSES.USDC, wallet.address),
      getRpcPool().call((p) => p.getBlockNumber()),
    ]);

    const receipt = await getTxBuilder().send(
      wallet,
      {
        to: quote.to,
        data: quote.data,
        value: quote.value,
        stage: 'sell',
        dryRun,
      },
      { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNumber },
    );

    // Calculate USDC received from balance diff
    const balUsdcAfter = await balanceOf(ADDRESSES.USDC, wallet.address);
    const usdcReceived = balUsdcAfter - balUsdc;

    log.info(
      {
        token: tokenAddress,
        aggregator: quote.aggregator,
        usdcReceived: formatUnits(usdcReceived, 6),
        txHash: receipt.hash,
      },
      'Token sold successfully',
    );

    return {
      skipped: false,
      txHash: receipt.hash,
      usdcReceived,
      aggregator: quote.aggregator,
    };
  }

  private async getQuote(
    agg: Aggregator,
    tokenIn: string,
    amountIn: bigint,
    walletAddress: string,
    slippageBps: number,
    chainId: number,
  ): Promise<SwapQuote> {
    switch (agg) {
      case 'zerion':
        return getZerionQuote(tokenIn, ADDRESSES.USDC, amountIn, walletAddress, slippageBps, chainId);
      case 'odos':
        return getOdosQuote(tokenIn, ADDRESSES.USDC, amountIn, walletAddress, slippageBps, chainId);
      case '1inch':
        return getOneinchQuote(tokenIn, ADDRESSES.USDC, amountIn, walletAddress, slippageBps, chainId);
      case 'uniswap_v3':
        return getUniswapV3Quote(tokenIn, ADDRESSES.USDC, amountIn, walletAddress, slippageBps);
    }
  }

  /** eth_call simulation — reverts here instead of on mainnet */
  private async simulateSwap(walletAddress: string, quote: SwapQuote): Promise<void> {
    await getRpcPool().call((p) =>
      p.call({
        to: quote.to,
        data: quote.data,
        from: walletAddress,
        value: quote.value,
      }),
    );
  }

  /**
   * Honeypot detection: simulate selling 1% of balance.
   * If we get back < 50% of the proportional quote → honeypot.
   */
  private async detectHoneypot(
    walletAddress: string,
    tokenAddress: string,
    balance: bigint,
    slippageBps: number,
    chainId: number,
  ): Promise<boolean> {
    const log = walletLogger(walletAddress);
    const testAmount = balance / 100n; // 1%
    if (testAmount === 0n) return false;

    try {
      const testQuote = await this.getQuote(
        'uniswap_v3', // use on-chain for honeypot check (most reliable)
        tokenAddress,
        testAmount,
        walletAddress,
        slippageBps,
        chainId,
      );

      // Full quote for 1% would be quote.amountOut / 100
      // If test quote is less than 50% of that → suspicious
      const fullQuote = await this.getQuote('uniswap_v3', tokenAddress, balance, walletAddress, slippageBps, chainId);
      const expectedFor1Pct = fullQuote.amountOut / 100n;
      const threshold = expectedFor1Pct / 2n; // 50%

      if (testQuote.amountOut < threshold) {
        log.warn(
          {
            token: tokenAddress,
            testAmountOut: testQuote.amountOut.toString(),
            threshold: threshold.toString(),
          },
          'Honeypot detected: 1% sell returns less than 50% of expected',
        );
        return true;
      }
    } catch {
      // If we can't quote 1%, it may still be tradeable — don't block
    }

    return false;
  }
}

let _router: SwapRouter | null = null;

export function initSwapRouter(cfg: Config): SwapRouter {
  _router = new SwapRouter(cfg);
  return _router;
}

export function getSwapRouter(): SwapRouter {
  if (!_router) throw new Error('SwapRouter not initialized');
  return _router;
}

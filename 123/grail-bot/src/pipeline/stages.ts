/**
 * Pipeline stage definitions.
 *
 * Each stage is idempotent: it checks on-chain reality before acting,
 * never relying solely on the DB state.
 */

import { Wallet } from 'ethers';
import { parseEther, parseUnits, formatUnits, formatEther } from 'ethers';
import { buyPacks } from '../grail/buyPacks.js';
import { openPacks } from '../grail/openPacks.js';
import { claimRewards } from '../grail/claim.js';
import { getSwapRouter } from '../swap/router.js';
import { getDB, type WalletRow, type WalletState } from '../core/db.js';
import { getRpcPool } from '../chain/rpcPool.js';
import { balanceOf, buildTransferData, getSymbol, getDecimals } from '../chain/erc20.js';
import { getTxBuilder } from '../chain/txBuilder.js';
import { ADDRESSES } from '../grail/contracts.js';
import { walletLogger } from '../core/logger.js';
import {
  WalletBlockedError,
  SkipTokenError,
} from '../core/errors.js';
import type { Config } from '../core/config.js';

export interface StageContext {
  wallet: Wallet;
  row: WalletRow;
  config: Config;
  dryRun: boolean;
}

/** Number of packs to buy per wallet (configurable) */
const PACKS_PER_WALLET = parseInt(process.env['PACKS_PER_WALLET'] ?? '1', 10);

// ── Stage: PREFLIGHT_OK ────────────────────────────────────────────────────

export async function stagePreflight(ctx: StageContext): Promise<void> {
  const { wallet, config } = ctx;
  const log = walletLogger(wallet.address);
  const db = getDB();

  log.info('Running preflight checks');

  const [balEth, balUsdc] = await Promise.all([
    getRpcPool().call((p) => p.getBalance(wallet.address)),
    balanceOf(ADDRESSES.USDC, wallet.address),
  ]);

  const minEth = parseEther(config.thresholds.minEth);
  const minUsdc = parseUnits(config.thresholds.minUsdc, 6);

  if (balEth < minEth) {
    throw new WalletBlockedError(
      `Insufficient ETH: ${formatEther(balEth)} < ${config.thresholds.minEth}`,
      wallet.address,
    );
  }

  if (balUsdc < minUsdc) {
    throw new WalletBlockedError(
      `Insufficient USDC: ${formatUnits(balUsdc, 6)} < ${config.thresholds.minUsdc}`,
      wallet.address,
    );
  }

  log.info(
    { balEth: formatEther(balEth), balUsdc: formatUnits(balUsdc, 6) },
    'Preflight passed',
  );

  db.updateWalletState(wallet.address, 'PREFLIGHT_OK');
}

// ── Stage: PACKS_BOUGHT ────────────────────────────────────────────────────

export async function stageBuyPacks(ctx: StageContext): Promise<void> {
  const { wallet, dryRun } = ctx;
  const db = getDB();

  await buyPacks(wallet, PACKS_PER_WALLET, dryRun);
  db.updateWalletState(wallet.address, 'PACKS_BOUGHT');
}

// ── Stage: PACKS_OPENED ────────────────────────────────────────────────────

export async function stageOpenPacks(ctx: StageContext): Promise<void> {
  const { wallet, dryRun } = ctx;
  const db = getDB();

  const result = await openPacks(wallet, dryRun);

  // Record discovered tokens
  for (const { address, amount } of result.tokensReceived) {
    let symbol: string | null = null;
    let decimals: number | null = null;
    try {
      [symbol, decimals] = await Promise.all([getSymbol(address), getDecimals(address)]);
    } catch {
      // best-effort
    }

    db.upsertToken({
      wallet: wallet.address,
      token_address: address,
      symbol,
      raw_amount: amount.toString(),
      decimals,
    });
  }

  db.updateWalletState(wallet.address, 'PACKS_OPENED');
}

// ── Stage: TOKENS_DISCOVERED ───────────────────────────────────────────────

export async function stageDiscoverTokens(ctx: StageContext): Promise<void> {
  const { wallet } = ctx;
  const db = getDB();
  const log = walletLogger(wallet.address);

  // Check for any claim stage before discovery
  await claimRewards(wallet, ctx.dryRun);

  // The tokens should already be in DB from openPacks events.
  // But also do a fresh on-chain check for any tokens that may have been missed.
  // In production, scan Transfer events TO this wallet from the open tx block.
  const existing = db.getTokensByWallet(wallet.address);
  log.info({ tokenCount: existing.length }, 'Tokens in DB post-open');

  db.updateWalletState(wallet.address, 'TOKENS_DISCOVERED');
}

// ── Stage: TOKENS_SOLD ────────────────────────────────────────────────────

export async function stageSellTokens(ctx: StageContext): Promise<void> {
  const { wallet, dryRun } = ctx;
  const db = getDB();
  const log = walletLogger(wallet.address);
  const router = getSwapRouter();

  const tokens = db.getTokensByWallet(wallet.address).filter(
    (t) => t.sold === 0 && t.skip_reason === null,
  );

  log.info({ count: tokens.length }, 'Selling tokens');

  for (const token of tokens) {
    try {
      const result = await router.sellToken(wallet, token.token_address, dryRun);

      if (result.skipped) {
        db.markTokenSkipped(wallet.address, token.token_address, result.skipReason ?? 'no_liquidity');
        log.info({ token: token.token_address, reason: result.skipReason }, 'Token skipped');
      } else {
        db.markTokenSold(
          wallet.address,
          token.token_address,
          result.txHash!,
          result.usdcReceived!.toString(),
        );
        log.info(
          {
            token: token.token_address,
            usdc: formatUnits(result.usdcReceived!, 6),
            aggregator: result.aggregator,
          },
          'Token sold',
        );
      }
    } catch (err) {
      if (err instanceof SkipTokenError) {
        db.markTokenSkipped(wallet.address, token.token_address, err.reason);
        log.warn({ token: token.token_address, reason: err.reason }, 'Token skipped (error)');
      } else {
        // Non-skip errors: log and continue to next token
        log.error({ token: token.token_address, err: String(err) }, 'Sell failed, continuing');
      }
    }
  }

  db.updateWalletState(wallet.address, 'TOKENS_SOLD');
}

// ── Stage: CONSOLIDATED ───────────────────────────────────────────────────

export async function stageConsolidate(ctx: StageContext): Promise<void> {
  const { wallet, row, config, dryRun } = ctx;
  const db = getDB();
  const log = walletLogger(wallet.address);

  // Determine destination
  let destination: string | null = null;
  if (config.consolidation.mode === 'fixed') {
    destination = config.consolidation.fixedAddress;
  } else if (config.consolidation.mode === 'next_wallet') {
    destination = row.next_wallet;
  }

  if (!destination) {
    log.info('No consolidation destination configured, skipping');
    db.updateWalletState(wallet.address, 'CONSOLIDATED');
    return;
  }

  const reserveUsdc = parseUnits(config.thresholds.reserveUsdc, 6);
  const minConsolidate = parseUnits(config.thresholds.minConsolidate, 6);

  const balUsdc = await balanceOf(ADDRESSES.USDC, wallet.address);
  const sendAmount = balUsdc - reserveUsdc;

  if (sendAmount <= 0n || sendAmount < minConsolidate) {
    log.info(
      { balUsdc: formatUnits(balUsdc, 6), sendAmount: formatUnits(sendAmount > 0n ? sendAmount : 0n, 6) },
      'USDC below min consolidate threshold, skipping transfer',
    );
    db.updateWalletState(wallet.address, 'CONSOLIDATED');
    return;
  }

  log.info(
    { destination, amount: formatUnits(sendAmount, 6) },
    'Consolidating USDC',
  );

  const [balEth, blockNumber] = await Promise.all([
    getRpcPool().call((p) => p.getBalance(wallet.address)),
    getRpcPool().call((p) => p.getBlockNumber()),
  ]);

  await getTxBuilder().send(
    wallet,
    {
      to: ADDRESSES.USDC,
      data: buildTransferData(destination, sendAmount),
      stage: 'consolidate',
      dryRun,
    },
    { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNumber },
  );

  log.info({ destination, amount: formatUnits(sendAmount, 6) }, 'USDC consolidated');
  db.updateWalletState(wallet.address, 'CONSOLIDATED');
}

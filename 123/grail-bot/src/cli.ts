#!/usr/bin/env node
/**
 * Grail Bot CLI
 *
 * Commands:
 *   init    — import wallets from CSV, encrypt PKs, write to DB
 *   start   — run the full pipeline
 *   resume  — run only wallets in FAILED_RETRY or unfinished states
 *   status  — print wallet state summary
 *   export  — export results to CSV
 */

import { Command } from 'commander';
import { createReadStream, createWriteStream } from 'fs';
import { createInterface } from 'readline';
import { formatEther, formatUnits } from 'ethers';
import { loadConfig } from './core/config.js';
import { getDB, resetDB } from './core/db.js';
import { logger } from './core/logger.js';
import { encryptPrivateKey } from './core/crypto.js';
import { initRpcPool, getRpcPool } from './chain/rpcPool.js';
import { initGasOracle } from './chain/gasOracle.js';
import { initTxBuilder } from './chain/txBuilder.js';
import { initSwapRouter } from './swap/router.js';
import { runOrchestrator, printStats } from './pipeline/orchestrator.js';
import { assertContractsConfigured } from './grail/contracts.js';
import { balanceOf } from './chain/erc20.js';
import { ADDRESSES } from './grail/contracts.js';
import { maskAddress } from './core/logger.js';

const program = new Command();

program
  .name('grail-bot')
  .description('Grail.xyz Base Executor Bot')
  .version('1.0.0');

// ── init ──────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Import wallets from CSV, encrypt private keys, initialize DB')
  .requiredOption('--wallets <path>', 'Path to wallets CSV (columns: address,privateKey[,nextWallet])')
  .option('--db <path>', 'Path to SQLite DB', 'data/state.db')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .action(async (opts: { wallets: string; db: string; config: string }) => {
    try {
      const config = loadConfig(opts.config);
      initRpcPool(config.network.rpcs, config.network.chainId);

      const db = getDB(opts.db);
      const rows = await parseCsv(opts.wallets);

      logger.info({ count: rows.length }, 'Importing wallets');

      let imported = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const nextWallet = rows[i + 1]?.address ?? null;

        try {
          const pkEncrypted = encryptPrivateKey(row.privateKey);
          db.upsertWallet(row.address, pkEncrypted, i, nextWallet);
          imported++;
          logger.debug({ index: i, wallet: maskAddress(row.address) }, 'Wallet imported');
        } catch (err) {
          logger.error({ index: i, wallet: maskAddress(row.address), err: String(err) }, 'Failed to import wallet');
        }
      }

      logger.info({ imported, total: rows.length }, 'Import complete');
      printStats();
      db.close();
    } catch (err) {
      logger.fatal({ err: String(err) }, 'Init failed');
      process.exit(1);
    }
  });

// ── start ─────────────────────────────────────────────────────────────────

program
  .command('start')
  .description('Run the full pipeline')
  .option('--dry-run', 'Simulate without sending transactions')
  .option('--only-index <n>', 'Process only wallet at this CSV index (canary mode)', parseInt)
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--db <path>', 'Path to SQLite DB', 'data/state.db')
  .action(async (opts: { dryRun: boolean; onlyIndex?: number; config: string; db: string }) => {
    try {
      const config = loadConfig(opts.config);
      if (opts.dryRun) config.execution.dryRun = true;

      initRpcPool(config.network.rpcs, config.network.chainId);
      initGasOracle(config.gas);
      initTxBuilder(config);
      initSwapRouter(config);
      assertContractsConfigured(config.execution.dryRun);

      const db = getDB(opts.db);

      // Pre-run confirmation
      await showPreRunSummary(config, opts.dryRun);
      const confirmed = await waitForConfirmation(config.execution.dryRun);
      if (!confirmed) {
        logger.info('Cancelled by user');
        process.exit(0);
      }

      const orchOpts: import('./pipeline/orchestrator.js').OrchestratorOptions = {};
      if (opts.onlyIndex !== undefined) orchOpts.onlyIndex = opts.onlyIndex;
      await runOrchestrator(config, orchOpts);
      printStats();

      db.close();
    } catch (err) {
      logger.fatal({ err: String(err) }, 'Start failed');
      process.exit(1);
    }
  });

// ── resume ────────────────────────────────────────────────────────────────

program
  .command('resume')
  .description('Continue unfinished wallets (FAILED_RETRY and in-progress states)')
  .option('--config <path>', 'Path to config.json', 'config.json')
  .option('--db <path>', 'Path to SQLite DB', 'data/state.db')
  .action(async (opts: { config: string; db: string }) => {
    try {
      const config = loadConfig(opts.config);

      initRpcPool(config.network.rpcs, config.network.chainId);
      initGasOracle(config.gas);
      initTxBuilder(config);
      initSwapRouter(config);
      assertContractsConfigured(config.execution.dryRun);

      const db = getDB(opts.db);

      logger.info('Resuming from last checkpoint');
      await runOrchestrator(config, { resumeOnly: true });
      printStats();

      db.close();
    } catch (err) {
      logger.fatal({ err: String(err) }, 'Resume failed');
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Print wallet state summary')
  .option('--db <path>', 'Path to SQLite DB', 'data/state.db')
  .action((opts: { db: string }) => {
    const db = getDB(opts.db);
    printStats();

    // Show BLOCKED wallets with errors
    const blocked = db.getWalletsByState('BLOCKED');
    if (blocked.length > 0) {
      console.log('\nBlocked wallets:');
      for (const w of blocked) {
        console.log(`  ${maskAddress(w.address)} [${w.index_in_csv}]: ${w.last_error ?? 'unknown'}`);
      }
    }

    db.close();
  });

// ── export ────────────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export results to CSV')
  .option('--out <path>', 'Output CSV path', 'report.csv')
  .option('--db <path>', 'Path to SQLite DB', 'data/state.db')
  .action(async (opts: { out: string; db: string }) => {
    const db = getDB(opts.db);
    const wallets = db.getAllWallets();
    const out = createWriteStream(opts.out);

    out.write('address,index,state,last_error,tokens_sold,usdc_received\n');

    for (const w of wallets) {
      const tokens = db.getTokensByWallet(w.address);
      const sold = tokens.filter((t) => t.sold === 1);
      const usdcTotal = sold.reduce((acc, t) => {
        const v = BigInt(t.usdc_received ?? '0');
        return acc + v;
      }, 0n);

      out.write(
        [
          maskAddress(w.address),
          w.index_in_csv,
          w.state,
          (w.last_error ?? '').replace(/,/g, ';'),
          sold.length,
          formatUnits(usdcTotal, 6),
        ].join(',') + '\n',
      );
    }

    out.end();
    logger.info({ path: opts.out, count: wallets.length }, 'Export complete');
    db.close();
  });

// ── Helpers ────────────────────────────────────────────────────────────────

interface CsvRow {
  address: string;
  privateKey: string;
}

async function parseCsv(path: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const rl = createInterface({ input: createReadStream(path) });
  let isHeader = true;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    const [address, privateKey] = line.trim().split(',');
    if (!address || !privateKey) continue;
    rows.push({ address: address.trim(), privateKey: privateKey.trim() });
  }

  return rows;
}

async function showPreRunSummary(config: ReturnType<typeof loadConfig>, dryRun: boolean): Promise<void> {
  const db = getDB();
  const wallets = db.getWalletsByState('NEW', 'PREFLIGHT_OK', 'APPROVED', 'PACKS_BOUGHT', 'PACKS_OPENED', 'TOKENS_DISCOVERED', 'TOKENS_SOLD', 'FAILED_RETRY');

  console.log('\n══════════════════════════════════════');
  console.log(`  Grail Bot — ${dryRun ? 'DRY-RUN' : 'MAINNET'} Run`);
  console.log('══════════════════════════════════════');
  console.log(`  Chain ID  : ${config.network.chainId}`);
  console.log(`  Wallets   : ${wallets.length} to process`);
  console.log(`  Concurrency: ${config.execution.concurrency}`);
  console.log('');

  // Sample first 3 wallets' balances
  if (!dryRun && wallets.length > 0) {
    try {
      const pool = getRpcPool();
      const sample = wallets.slice(0, 3);
      console.log('  Sample balances:');
      for (const w of sample) {
        const [eth, usdc] = await Promise.all([
          pool.call((p) => p.getBalance(w.address)),
          balanceOf(ADDRESSES.USDC, w.address),
        ]);
        console.log(`    ${maskAddress(w.address)}: ${formatEther(eth)} ETH, ${formatUnits(usdc, 6)} USDC`);
      }
    } catch {
      console.log('  (Could not fetch balances)');
    }
  }

  console.log('══════════════════════════════════════\n');
}

async function waitForConfirmation(dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    console.log('DRY-RUN mode: auto-confirming\n');
    return true;
  }

  process.stdout.write('⚠️  This will send REAL transactions on mainnet. Type "yes" to continue: ');

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    rl.question('', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

program.parse();

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { FatalError } from './errors.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type WalletState =
  | 'NEW'
  | 'PREFLIGHT_OK'
  | 'APPROVED'
  | 'PACKS_BOUGHT'
  | 'PACKS_OPENED'
  | 'TOKENS_DISCOVERED'
  | 'TOKENS_SOLD'
  | 'CONSOLIDATED'
  | 'DONE'
  | 'BLOCKED'
  | 'FAILED_RETRY';

export type TxStatus = 'pending' | 'confirmed' | 'reverted' | 'replaced';

export type TxStage =
  | 'approve'
  | 'buy'
  | 'open'
  | 'sell'
  | 'consolidate';

export type SkipReason = 'no_liquidity' | 'honeypot' | 'below_threshold' | 'simulation_revert';

export interface WalletRow {
  address: string;
  pk_encrypted: string;
  index_in_csv: number;
  next_wallet: string | null;
  state: WalletState;
  state_updated: number; // unix ms
  last_error: string | null;
}

export interface TransactionRow {
  hash: string;
  wallet: string;
  stage: TxStage;
  nonce: number;
  status: TxStatus;
  gas_used: number | null;
  block_number: number | null;
  created_at: number; // unix ms
}

export interface TokenReceivedRow {
  wallet: string;
  token_address: string;
  symbol: string | null;
  raw_amount: string; // BigInt as string
  decimals: number | null;
  sold: number; // 0 | 1
  sell_tx: string | null;
  usdc_received: string | null;
  skip_reason: SkipReason | null;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  pk_encrypted  TEXT NOT NULL,
  index_in_csv  INTEGER NOT NULL,
  next_wallet   TEXT,
  state         TEXT NOT NULL DEFAULT 'NEW',
  state_updated INTEGER NOT NULL,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  hash          TEXT PRIMARY KEY,
  wallet        TEXT NOT NULL,
  stage         TEXT NOT NULL,
  nonce         INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  gas_used      INTEGER,
  block_number  INTEGER,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (wallet) REFERENCES wallets(address)
);

CREATE TABLE IF NOT EXISTS tokens_received (
  wallet        TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol        TEXT,
  raw_amount    TEXT NOT NULL,
  decimals      INTEGER,
  sold          INTEGER DEFAULT 0,
  sell_tx       TEXT,
  usdc_received TEXT,
  skip_reason   TEXT,
  PRIMARY KEY (wallet, token_address)
);

CREATE INDEX IF NOT EXISTS idx_wallets_state  ON wallets(state);
CREATE INDEX IF NOT EXISTS idx_tx_wallet      ON transactions(wallet, stage);
CREATE INDEX IF NOT EXISTS idx_tokens_wallet  ON tokens_received(wallet);
`;

// ── DB wrapper ────────────────────────────────────────────────────────────────

export class DB {
  private db: Database.Database;

  constructor(dbPath: string) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.exec(SCHEMA);
      logger.debug({ dbPath }, 'Database initialized');
    } catch (err) {
      throw new FatalError(`Failed to initialize database at '${dbPath}'`, err);
    }
  }

  // ── Wallets ───────────────────────────────────────────────────────────────

  upsertWallet(
    address: string,
    pkEncrypted: string,
    indexInCsv: number,
    nextWallet: string | null,
  ): void {
    const stmt = this.db.prepare<[string, string, number, string | null, number]>(`
      INSERT INTO wallets (address, pk_encrypted, index_in_csv, next_wallet, state, state_updated)
      VALUES (?, ?, ?, ?, 'NEW', ?)
      ON CONFLICT(address) DO NOTHING
    `);
    stmt.run(address, pkEncrypted, indexInCsv, nextWallet, Date.now());
  }

  getWallet(address: string): WalletRow | undefined {
    return this.db
      .prepare<[string], WalletRow>('SELECT * FROM wallets WHERE address = ?')
      .get(address);
  }

  updateWalletState(address: string, state: WalletState, lastError?: string): void {
    this.db
      .prepare<[WalletState, string | null, number, string]>(`
        UPDATE wallets SET state = ?, last_error = ?, state_updated = ? WHERE address = ?
      `)
      .run(state, lastError ?? null, Date.now(), address);
  }

  getWalletsByState(...states: WalletState[]): WalletRow[] {
    const placeholders = states.map(() => '?').join(', ');
    return this.db
      .prepare<WalletState[], WalletRow>(`SELECT * FROM wallets WHERE state IN (${placeholders}) ORDER BY index_in_csv`)
      .all(...states);
  }

  getAllWallets(): WalletRow[] {
    return this.db
      .prepare<[], WalletRow>('SELECT * FROM wallets ORDER BY index_in_csv')
      .all();
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  insertTx(row: Omit<TransactionRow, 'gas_used' | 'block_number'>): void {
    this.db
      .prepare<[string, string, TxStage, number, TxStatus, number]>(`
        INSERT OR IGNORE INTO transactions (hash, wallet, stage, nonce, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(row.hash, row.wallet, row.stage, row.nonce, row.status, row.created_at);
  }

  updateTxStatus(
    hash: string,
    status: TxStatus,
    gasUsed?: number,
    blockNumber?: number,
  ): void {
    this.db
      .prepare<[TxStatus, number | null, number | null, string]>(`
        UPDATE transactions SET status = ?, gas_used = ?, block_number = ? WHERE hash = ?
      `)
      .run(status, gasUsed ?? null, blockNumber ?? null, hash);
  }

  getTxByWalletAndStage(wallet: string, stage: TxStage): TransactionRow[] {
    return this.db
      .prepare<[string, TxStage], TransactionRow>(
        'SELECT * FROM transactions WHERE wallet = ? AND stage = ? ORDER BY created_at DESC',
      )
      .all(wallet, stage);
  }

  // ── Tokens ────────────────────────────────────────────────────────────────

  upsertToken(row: Omit<TokenReceivedRow, 'sold' | 'sell_tx' | 'usdc_received' | 'skip_reason'>): void {
    this.db
      .prepare<[string, string, string | null, string, number | null]>(`
        INSERT INTO tokens_received (wallet, token_address, symbol, raw_amount, decimals)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(wallet, token_address) DO UPDATE SET
          raw_amount = excluded.raw_amount,
          symbol     = excluded.symbol,
          decimals   = excluded.decimals
      `)
      .run(row.wallet, row.token_address, row.symbol ?? null, row.raw_amount, row.decimals ?? null);
  }

  markTokenSold(wallet: string, tokenAddress: string, sellTx: string, usdcReceived: string): void {
    this.db
      .prepare<[string, string, string, string]>(`
        UPDATE tokens_received SET sold = 1, sell_tx = ?, usdc_received = ?
        WHERE wallet = ? AND token_address = ?
      `)
      .run(sellTx, usdcReceived, wallet, tokenAddress);
  }

  markTokenSkipped(wallet: string, tokenAddress: string, reason: SkipReason): void {
    this.db
      .prepare<[SkipReason, string, string]>(`
        UPDATE tokens_received SET skip_reason = ? WHERE wallet = ? AND token_address = ?
      `)
      .run(reason, wallet, tokenAddress);
  }

  getTokensByWallet(wallet: string): TokenReceivedRow[] {
    return this.db
      .prepare<[string], TokenReceivedRow>('SELECT * FROM tokens_received WHERE wallet = ?')
      .all(wallet);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats(): Record<WalletState, number> {
    const rows = this.db
      .prepare<[], { state: WalletState; count: number }>(
        'SELECT state, COUNT(*) as count FROM wallets GROUP BY state',
      )
      .all();

    const result = {} as Record<WalletState, number>;
    for (const row of rows) {
      result[row.state] = row.count;
    }
    return result;
  }

  // ── Transactions ──────────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _db: DB | null = null;

export function getDB(dbPath?: string): DB {
  if (!_db) {
    const path = dbPath ?? join(process.cwd(), 'data', 'state.db');
    _db = new DB(path);
  }
  return _db;
}

export function resetDB(): void {
  _db?.close();
  _db = null;
}

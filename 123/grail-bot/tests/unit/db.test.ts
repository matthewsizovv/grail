import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DB } from '../../src/core/db.js';
import { unlinkSync, existsSync } from 'fs';

const TMP_DB = '/tmp/grail-test.db';

describe('DB', () => {
  let db: DB;

  beforeEach(() => {
    db = new DB(TMP_DB);
  });

  afterEach(() => {
    db.close();
    if (existsSync(TMP_DB)) unlinkSync(TMP_DB);
    if (existsSync(TMP_DB + '-shm')) unlinkSync(TMP_DB + '-shm');
    if (existsSync(TMP_DB + '-wal')) unlinkSync(TMP_DB + '-wal');
  });

  describe('wallets', () => {
    const ADDR = '0x1234567890123456789012345678901234567890';
    const PK_ENC = 'encryptedBase64==';

    it('upserts a new wallet', () => {
      db.upsertWallet(ADDR, PK_ENC, 0, null);
      const wallet = db.getWallet(ADDR);
      expect(wallet).toBeDefined();
      expect(wallet!.address).toBe(ADDR);
      expect(wallet!.state).toBe('NEW');
      expect(wallet!.index_in_csv).toBe(0);
    });

    it('does not overwrite existing wallet on re-import', () => {
      db.upsertWallet(ADDR, PK_ENC, 0, null);
      db.updateWalletState(ADDR, 'PACKS_BOUGHT');
      db.upsertWallet(ADDR, 'different-encrypted-pk', 0, null);
      const wallet = db.getWallet(ADDR);
      expect(wallet!.state).toBe('PACKS_BOUGHT'); // state preserved
    });

    it('updates wallet state', () => {
      db.upsertWallet(ADDR, PK_ENC, 0, null);
      db.updateWalletState(ADDR, 'DONE');
      const wallet = db.getWallet(ADDR);
      expect(wallet!.state).toBe('DONE');
    });

    it('stores last_error', () => {
      db.upsertWallet(ADDR, PK_ENC, 0, null);
      db.updateWalletState(ADDR, 'BLOCKED', 'insufficient funds');
      const wallet = db.getWallet(ADDR);
      expect(wallet!.last_error).toBe('insufficient funds');
    });

    it('filters wallets by state', () => {
      const ADDR2 = '0xabcdef1234567890abcdef1234567890abcdef12';
      db.upsertWallet(ADDR, PK_ENC, 0, null);
      db.upsertWallet(ADDR2, PK_ENC, 1, null);
      db.updateWalletState(ADDR, 'DONE');

      const newWallets = db.getWalletsByState('NEW');
      expect(newWallets).toHaveLength(1);
      expect(newWallets[0]!.address).toBe(ADDR2);
    });
  });

  describe('transactions', () => {
    const WALLET = '0x1234567890123456789012345678901234567890';
    const HASH = '0x' + 'ab'.repeat(32);

    beforeEach(() => {
      db.upsertWallet(WALLET, 'enc', 0, null);
    });

    it('inserts and retrieves a transaction', () => {
      db.insertTx({ hash: HASH, wallet: WALLET, stage: 'buy', nonce: 5, status: 'pending', created_at: Date.now() });
      const txs = db.getTxByWalletAndStage(WALLET, 'buy');
      expect(txs).toHaveLength(1);
      expect(txs[0]!.hash).toBe(HASH);
      expect(txs[0]!.status).toBe('pending');
    });

    it('updates tx status to confirmed', () => {
      db.insertTx({ hash: HASH, wallet: WALLET, stage: 'buy', nonce: 5, status: 'pending', created_at: Date.now() });
      db.updateTxStatus(HASH, 'confirmed', 123456, 15000000);
      const txs = db.getTxByWalletAndStage(WALLET, 'buy');
      expect(txs[0]!.status).toBe('confirmed');
      expect(txs[0]!.gas_used).toBe(123456);
    });

    it('is idempotent on duplicate insert', () => {
      db.insertTx({ hash: HASH, wallet: WALLET, stage: 'buy', nonce: 5, status: 'pending', created_at: Date.now() });
      db.insertTx({ hash: HASH, wallet: WALLET, stage: 'buy', nonce: 5, status: 'pending', created_at: Date.now() });
      const txs = db.getTxByWalletAndStage(WALLET, 'buy');
      expect(txs).toHaveLength(1);
    });
  });

  describe('tokens', () => {
    const WALLET = '0x1234567890123456789012345678901234567890';
    const TOKEN = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    beforeEach(() => {
      db.upsertWallet(WALLET, 'enc', 0, null);
    });

    it('inserts a token', () => {
      db.upsertToken({ wallet: WALLET, token_address: TOKEN, symbol: 'GRL', raw_amount: '1000000000000000000', decimals: 18 });
      const tokens = db.getTokensByWallet(WALLET);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.symbol).toBe('GRL');
      expect(tokens[0]!.sold).toBe(0);
    });

    it('marks token as sold', () => {
      db.upsertToken({ wallet: WALLET, token_address: TOKEN, symbol: 'GRL', raw_amount: '1000', decimals: 18 });
      db.markTokenSold(WALLET, TOKEN, '0x' + 'cc'.repeat(32), '5000000');
      const tokens = db.getTokensByWallet(WALLET);
      expect(tokens[0]!.sold).toBe(1);
      expect(tokens[0]!.usdc_received).toBe('5000000');
    });

    it('marks token as skipped', () => {
      db.upsertToken({ wallet: WALLET, token_address: TOKEN, symbol: 'GRL', raw_amount: '1000', decimals: 18 });
      db.markTokenSkipped(WALLET, TOKEN, 'honeypot');
      const tokens = db.getTokensByWallet(WALLET);
      expect(tokens[0]!.skip_reason).toBe('honeypot');
    });
  });

  describe('stats', () => {
    it('returns correct counts per state', () => {
      const ADDR1 = '0x1111111111111111111111111111111111111111';
      const ADDR2 = '0x2222222222222222222222222222222222222222';
      const ADDR3 = '0x3333333333333333333333333333333333333333';
      db.upsertWallet(ADDR1, 'enc', 0, null);
      db.upsertWallet(ADDR2, 'enc', 1, null);
      db.upsertWallet(ADDR3, 'enc', 2, null);
      db.updateWalletState(ADDR1, 'DONE');
      db.updateWalletState(ADDR2, 'BLOCKED');

      const stats = db.getStats();
      expect(stats['DONE']).toBe(1);
      expect(stats['BLOCKED']).toBe(1);
      expect(stats['NEW']).toBe(1);
    });
  });
});

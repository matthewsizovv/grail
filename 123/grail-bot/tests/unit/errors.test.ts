import { describe, it, expect } from 'vitest';
import { classifyError, FatalError, WalletBlockedError, RetryableError } from '../../src/core/errors.js';

const WALLET = '0x1234567890123456789012345678901234567890';

describe('classifyError', () => {
  it('classifies insufficient funds as WalletBlockedError', () => {
    const err = new Error('insufficient funds for gas');
    expect(classifyError(err, WALLET)).toBeInstanceOf(WalletBlockedError);
  });

  it('classifies nonce too low as RetryableError', () => {
    const err = new Error('nonce too low');
    expect(classifyError(err, WALLET)).toBeInstanceOf(RetryableError);
  });

  it('classifies replacement underpriced as RetryableError', () => {
    const err = new Error('replacement underpriced');
    expect(classifyError(err, WALLET)).toBeInstanceOf(RetryableError);
  });

  it('classifies timeout as RetryableError', () => {
    const err = new Error('request timeout');
    expect(classifyError(err, WALLET)).toBeInstanceOf(RetryableError);
  });

  it('classifies revert as WalletBlockedError', () => {
    const err = new Error('execution reverted: Ownable: caller is not the owner');
    expect(classifyError(err, WALLET)).toBeInstanceOf(WalletBlockedError);
  });

  it('classifies schema error as FatalError', () => {
    const err = new Error('schema conflict detected');
    expect(classifyError(err, WALLET)).toBeInstanceOf(FatalError);
  });

  it('classifies unknown errors as RetryableError by default', () => {
    const err = new Error('some unknown weird error xyz');
    expect(classifyError(err, WALLET)).toBeInstanceOf(RetryableError);
  });
});

describe('Error hierarchy', () => {
  it('FatalError has correct name', () => {
    const e = new FatalError('test');
    expect(e.name).toBe('FatalError');
    expect(e).toBeInstanceOf(Error);
  });

  it('WalletBlockedError carries wallet address', () => {
    const e = new WalletBlockedError('blocked', WALLET);
    expect(e.wallet).toBe(WALLET);
  });

  it('RetryableError is instanceof Error', () => {
    const e = new RetryableError('retry me');
    expect(e).toBeInstanceOf(Error);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, resetConfig } from '../../src/core/config.js';
import { writeFileSync, unlinkSync } from 'fs';
import { FatalError } from '../../src/core/errors.js';

const VALID_CONFIG = {
  network: {
    chainId: 8453,
    rpcs: ['https://mainnet.base.org'],
  },
};

describe('loadConfig', () => {
  const TMP = '/tmp/grail-test-config.json';

  afterEach(() => {
    resetConfig();
    try { unlinkSync(TMP); } catch { /* ignore */ }
  });

  it('loads valid config and applies defaults', () => {
    writeFileSync(TMP, JSON.stringify(VALID_CONFIG));
    const cfg = loadConfig(TMP);
    expect(cfg.network.chainId).toBe(8453);
    expect(cfg.execution.dryRun).toBe(false);
    expect(cfg.execution.concurrency).toBe(1);
    expect(cfg.retry.maxAttempts).toBe(5);
    expect(cfg.gas.bumpPercent).toBe(20);
  });

  it('throws FatalError if file does not exist', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow(FatalError);
  });

  it('throws FatalError if chainId is missing', () => {
    writeFileSync(TMP, JSON.stringify({ network: { rpcs: ['https://base.org'] } }));
    expect(() => loadConfig(TMP)).toThrow(FatalError);
  });

  it('throws FatalError if rpcs is empty', () => {
    writeFileSync(TMP, JSON.stringify({ network: { chainId: 8453, rpcs: [] } }));
    expect(() => loadConfig(TMP)).toThrow(FatalError);
  });

  it('throws FatalError for invalid rpc URL', () => {
    writeFileSync(TMP, JSON.stringify({ network: { chainId: 8453, rpcs: ['not-a-url'] } }));
    expect(() => loadConfig(TMP)).toThrow(FatalError);
  });

  it('returns cached config on second call', () => {
    writeFileSync(TMP, JSON.stringify(VALID_CONFIG));
    const cfg1 = loadConfig(TMP);
    const cfg2 = loadConfig(TMP);
    expect(cfg1).toBe(cfg2);
  });
});

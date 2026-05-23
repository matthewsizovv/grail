import { describe, it, expect, beforeEach } from 'vitest';

// Set MASTER_KEY before importing crypto module
process.env['MASTER_KEY'] = 'a'.repeat(64); // 32-byte key as hex

import { encryptPrivateKey, decryptPrivateKey } from '../../src/core/crypto.js';

const SAMPLE_PK = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('crypto', () => {
  it('encrypts and decrypts a private key correctly', () => {
    const encrypted = encryptPrivateKey(SAMPLE_PK);
    const decrypted = decryptPrivateKey(encrypted);
    expect(decrypted).toBe(SAMPLE_PK);
  });

  it('handles 0x-prefixed private keys', () => {
    const withPrefix = '0x' + SAMPLE_PK;
    const encrypted = encryptPrivateKey(withPrefix);
    const decrypted = decryptPrivateKey(encrypted);
    expect(decrypted).toBe(SAMPLE_PK); // returns without 0x
  });

  it('produces different ciphertext each time (random IV)', () => {
    const enc1 = encryptPrivateKey(SAMPLE_PK);
    const enc2 = encryptPrivateKey(SAMPLE_PK);
    expect(enc1).not.toBe(enc2);
  });

  it('throws on wrong master key', () => {
    const encrypted = encryptPrivateKey(SAMPLE_PK);

    process.env['MASTER_KEY'] = 'b'.repeat(64); // wrong key
    expect(() => decryptPrivateKey(encrypted)).toThrow();
    process.env['MASTER_KEY'] = 'a'.repeat(64); // restore
  });

  it('throws on corrupted ciphertext', () => {
    const encrypted = encryptPrivateKey(SAMPLE_PK);
    const corrupted = encrypted.slice(0, -4) + 'XXXX';
    expect(() => decryptPrivateKey(corrupted)).toThrow();
  });
});

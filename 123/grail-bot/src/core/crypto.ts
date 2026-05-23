import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { FatalError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

function getMasterKey(): Buffer {
  const hex = process.env['MASTER_KEY'];
  if (!hex) {
    throw new FatalError('MASTER_KEY env var is not set. Run: export MASTER_KEY=$(openssl rand -hex 32)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new FatalError('MASTER_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a private key using AES-256-GCM.
 * Returns base64-encoded: iv(12) + ciphertext + authTag(16)
 */
export function encryptPrivateKey(pk: string): string {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const plaintext = Buffer.from(pk.startsWith('0x') ? pk.slice(2) : pk, 'hex');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString('base64');
}

/**
 * Decrypt a private key encrypted by encryptPrivateKey().
 * Returns the hex private key (without 0x prefix).
 */
export function decryptPrivateKey(encryptedBase64: string): string {
  const key = getMasterKey();
  const combined = Buffer.from(encryptedBase64, 'base64');

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new FatalError('Invalid encrypted private key format');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('hex');
  } catch {
    throw new FatalError('Private key decryption failed — wrong MASTER_KEY or corrupted data');
  }
}

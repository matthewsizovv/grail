import pino from 'pino';
import { mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = new URL('../../data/logs', import.meta.url).pathname;

// Ensure logs directory exists
try {
  mkdirSync(DATA_DIR, { recursive: true });
} catch {
  // directory may already exist
}

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const logFile = join(DATA_DIR, `${today}.jsonl`);

/**
 * Mask a wallet address: 0xabcd…1234
 */
export function maskAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Mask a private key entirely — never show it
 */
export function maskPrivateKey(_pk: string): string {
  return '[REDACTED]';
}

// Redactor: strip private keys and full addresses from log objects
const redactPaths = ['pk', 'privateKey', 'private_key', 'mnemonic', 'seed'];

function redactSerializer(value: unknown): unknown {
  if (typeof value === 'string') {
    // Detect 32-byte hex strings (private keys) — never log
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
      return '[REDACTED_HEX64]';
    }
    // Partial-mask ethereum addresses in warn/error: keep first 6 + last 4
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
      return maskAddress(value);
    }
  }
  return value;
}

const transport = pino.transport({
  targets: [
    // Human-readable console output
    {
      target: 'pino-pretty',
      level: process.env['LOG_LEVEL'] ?? 'info',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageFormat: '{wallet} [{stage}] {msg}',
      },
    },
    // JSON Lines file output
    {
      target: 'pino/file',
      level: 'trace',
      options: { destination: logFile, append: true },
    },
  ],
});

const baseLogger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
    serializers: {
      wallet: redactSerializer,
      address: redactSerializer,
    },
    base: null, // no pid/hostname
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);

export const logger = baseLogger;

/**
 * Create a child logger bound to a specific wallet (address masked).
 */
export function walletLogger(address: string) {
  return logger.child({ wallet: maskAddress(address) });
}

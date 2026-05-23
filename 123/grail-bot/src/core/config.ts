import { z } from 'zod';
import { readFileSync } from 'fs';
import { FatalError } from './errors.js';

// ── Zod schema ──────────────────────────────────────────────────────────────

const NetworkSchema = z.object({
  chainId: z.number().int().positive(),
  rpcs: z.array(z.string().url()).min(1),
});

const ExecutionSchema = z.object({
  dryRun: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(10).default(1),
  /** [min, max] seconds to wait between wallets */
  delayBetweenWallets: z.tuple([z.number().nonnegative(), z.number().positive()]).default([30, 120]),
});

const ThresholdsSchema = z.object({
  /** Minimum ETH a wallet must have before starting */
  minEth: z.string().default('0.003'),
  /** Minimum USDC a wallet must have before buying packs */
  minUsdc: z.string().default('15'),
  /** ETH to keep for gas after consolidation */
  reserveEth: z.string().default('0.0005'),
  /** USDC to keep after consolidation */
  reserveUsdc: z.string().default('0'),
  /** Do not consolidate if amount is below this */
  minConsolidate: z.string().default('1'),
  /** Skip selling tokens whose quote is below this USD value */
  minTokenValueUsd: z.string().default('0.10'),
});

const GasSchema = z.object({
  /** Multiplier on top of baseFee */
  baseFeeMultiplier: z.number().positive().default(1.3),
  /** Priority fee (tip) in Gwei */
  priorityFeeGwei: z.string().default('0.01'),
  /** Hard cap maxFee in Gwei */
  maxFeeGwei: z.string().default('5'),
  /** Percent to bump gas on replacement tx */
  bumpPercent: z.number().int().positive().default(20),
});

const SwapSchema = z.object({
  /** Default slippage in bps (1 bps = 0.01%) */
  slippageBps: z.number().int().min(1).max(10000).default(200),
  /** Maximum allowed slippage */
  maxSlippageBps: z.number().int().min(1).max(10000).default(500),
  /** Ordered list of aggregators to try */
  aggregators: z
    .array(z.enum(['zerion', 'odos', '1inch', 'uniswap_v3']))
    .default(['zerion', 'odos', '1inch', 'uniswap_v3']),
});

const RetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(5),
  /** Backoff delays in ms, length must equal maxAttempts */
  backoffMs: z.array(z.number().int().positive()).default([1000, 2000, 4000, 8000, 16000]),
});

const ConsolidationSchema = z.object({
  /** 'next_wallet' → send to next wallet in CSV, 'fixed' → send to fixedAddress */
  mode: z.enum(['next_wallet', 'fixed']).default('next_wallet'),
  fixedAddress: z.string().nullable().default(null),
});

export const ConfigSchema = z.object({
  network: NetworkSchema,
  execution: ExecutionSchema.default({}),
  thresholds: ThresholdsSchema.default({}),
  gas: GasSchema.default({}),
  swap: SwapSchema.default({}),
  retry: RetrySchema.default({}),
  consolidation: ConsolidationSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Loader ──────────────────────────────────────────────────────────────────

let _config: Config | null = null;

export function loadConfig(path = 'config.json'): Config {
  if (_config) return _config;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FatalError(`Cannot read config file at '${path}'`, err);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new FatalError(`Config validation failed:\n${issues}`);
  }

  _config = result.data;
  return _config;
}

/** Reset cached config (useful in tests) */
export function resetConfig(): void {
  _config = null;
}

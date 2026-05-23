/**
 * Адреса контрактов и ABI интерфейсы для Grail.xyz на Base.
 *
 * ── Phase 0 данные (заполнено) ─────────────────────────────────────────────
 *
 * PACK_SALE  = 0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da  (из ТЗ + DevTools)
 * PACK_NFT   = 0xc7bd7aa20841e43838648131768735f32d15aafa  (из trace)
 * USDC       = 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913  (нативный Base USDC)
 * Цена пака  = 15 USDC = 15_000_000 raw (6 decimals)
 * Подпись    = нужна (REQUIRES_BACKEND_SIGNATURE = true)
 *
 * ── Что ещё нужно выяснить (TODO Phase 0) ──────────────────────────────────
 *
 *   [ ] Точная сигнатура функции buy: run `cast 4byte-decode <input_8chars>`
 *   [ ] Параметры подписи: (quantity, sig, deadline) или (quantity, nonce, sig)?
 *   [ ] URL бэкенд API для получения подписи
 *   [ ] Формат события PackOpened — какие поля, indexed или нет
 *   [ ] open() вызывается на PACK_NFT или на PACK_SALE?
 *   [ ] ERC721 или ERC1155 — проверить через: cast call 0xc7bd... "supportsInterface(bytes4)" 0x80ac58cd
 *
 * ── Как обновить ABI ────────────────────────────────────────────────────────
 *
 *   1. BaseScan: https://basescan.org/address/0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da#code
 *   2. Foundry:
 *      cast abi-decode "buy(uint256,bytes,uint256)" <calldata>
 *      cast 4byte-decode <первые 8 символов calldata>
 *   3. Заменить содержимое src/grail/abi/PackSale.json и PackNFT.json
 */

import { Interface } from 'ethers';
import type { ContractRunner } from 'ethers';
import { Contract } from 'ethers';
import { FatalError } from '../core/errors.js';
import { getRpcPool } from '../chain/rpcPool.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// ABI загружаются из JSON — обновить после получения реального ABI с BaseScan
const PackSaleABI: unknown[] = require('./abi/PackSale.json') as unknown[];
const PackNFTABI: unknown[] = require('./abi/PackNFT.json') as unknown[];

// ── АДРЕСА КОНТРАКТОВ ──────────────────────────────────────────────────────

/**
 * Реальные адреса Grail.xyz на Base (заполнены по Phase 0 данным).
 * Переопределяются через ENV — полезно для тестнетов или обновлений.
 */
export const ADDRESSES = {
  /**
   * Контракт продажи паков Grail.
   * Реальный адрес: 0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da
   * Переопределить: export GRAIL_PACK_SALE=0x...
   */
  PACK_SALE: process.env['GRAIL_PACK_SALE'] ?? '0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da',

  /**
   * Контракт NFT паков (ERC721, предположительно).
   * Реальный адрес: 0xc7bd7aa20841e43838648131768735f32d15aafa
   * Переопределить: export GRAIL_PACK_NFT=0x...
   * TODO Phase 0: проверить ERC721 vs ERC1155:
   *   cast call 0xc7bd7aa20841e43838648131768735f32d15aafa \
   *     "supportsInterface(bytes4)(bool)" 0x80ac58cd \
   *     --rpc-url https://mainnet.base.org
   *   (0x80ac58cd = ERC721, 0xd9b67a26 = ERC1155)
   */
  PACK_NFT: process.env['GRAIL_PACK_NFT'] ?? '0xc7bd7aa20841e43838648131768735f32d15aafa',

  /** USDC на Base (нативный, не bridged USDbC) */
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',

  /** WETH на Base (нужен для DEX агрегаторов) */
  WETH: '0x4200000000000000000000000000000000000006',

  /**
   * Контракт клейма наград (отдельный).
   * GRAIL_CLAIM_NEEDED=false → не используется.
   * Если включить: export GRAIL_REWARD_CLAIM=0x...
   */
  REWARD_CLAIM: process.env['GRAIL_REWARD_CLAIM'] ?? null,
} as const;

// ── ВАЛИДАЦИЯ АДРЕСОВ ──────────────────────────────────────────────────────

/**
 * Проверяем что адреса выглядят как настоящие 20-байтовые адреса.
 * В dry-run пропускаем — там транзакции не идут.
 */
export function assertContractsConfigured(dryRun: boolean): void {
  if (dryRun) return;

  // Нулевой адрес — явный признак незаполненной конфигурации
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

  if (ADDRESSES.PACK_SALE === ZERO_ADDR || ADDRESSES.PACK_NFT === ZERO_ADDR) {
    throw new FatalError(
      'Адреса контрактов не настроены!\n' +
      'Задай переменные окружения:\n' +
      '  export GRAIL_PACK_SALE=0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da\n' +
      '  export GRAIL_PACK_NFT=0xc7bd7aa20841e43838648131768735f32d15aafa\n',
    );
  }
}

// ── ABI ИНТЕРФЕЙСЫ ─────────────────────────────────────────────────────────

/** Интерфейс контракта продажи паков */
export const PACK_SALE_IFACE = new Interface(PackSaleABI as never[]);

/** Интерфейс контракта NFT паков */
export const PACK_NFT_IFACE = new Interface(PackNFTABI as never[]);

// ── ПАРАМЕТРЫ ПАКОВ ────────────────────────────────────────────────────────

/**
 * Токен оплаты — USDC (подтверждено Phase 0: GRAIL_PAYMENT_TOKEN = USDC).
 * ETH value = 0 в транзакции покупки → оплата через USDC transferFrom.
 */
export const PACK_PAYMENT: 'ETH' | 'USDC' = 'USDC';

/**
 * Количество паков на кошелёк.
 * Устанавливается через: export PACKS_PER_WALLET=3
 */
export const PACKS_PER_WALLET = parseInt(process.env['PACKS_PER_WALLET'] ?? '1', 10);

/**
 * Нужна ли подпись от бэкенда Grail при покупке?
 * Phase 0 подтверждено: GRAIL_BACKEND_SIG=true (в calldata видна bytes подпись).
 * Переопределить: export GRAIL_BACKEND_SIG=false (если появится новый тип без подписи).
 */
export const REQUIRES_BACKEND_SIGNATURE = (process.env['GRAIL_BACKEND_SIG'] ?? 'true') === 'true';

/**
 * Цена одного пака в raw USDC единицах (6 decimals).
 * Phase 0 подтверждено: 15 USDC = 15_000_000.
 *
 * Если контракт имеет динамическую цену — раскомментировать fetch ниже.
 */
export async function getPackPrice(): Promise<bigint> {
  // Приоритет: ENV переменная → фиксированная Phase 0 цена → on-chain view
  const envPrice = process.env['GRAIL_PACK_PRICE_RAW'];
  if (envPrice) return BigInt(envPrice);

  // Phase 0 данные: 15 USDC (фиксированная цена на момент RE)
  const PHASE0_PRICE = 15_000_000n;

  // TODO Phase 0: если цена динамическая — раскомментировать и найти имя view-функции:
  //   cast call 0x4491... "price()(uint256)" --rpc-url https://mainnet.base.org
  //   cast call 0x4491... "packPrice()(uint256)" --rpc-url https://mainnet.base.org
  //   cast call 0x4491... "mintPrice()(uint256)" --rpc-url https://mainnet.base.org
  //
  // const contract = new Contract(ADDRESSES.PACK_SALE, PACK_SALE_IFACE, getRpcPool().getProvider());
  // try {
  //   return await (contract['price'] as () => Promise<bigint>)();
  // } catch {
  //   return PHASE0_PRICE; // fallback на Phase 0 цену если view-функции нет
  // }

  return PHASE0_PRICE;
}

/**
 * Максимум паков на кошелёк (null = без лимита).
 *
 * TODO Phase 0: проверить:
 *   cast call 0x4491... "maxPerWallet()(uint256)" --rpc-url https://mainnet.base.org
 *   cast call 0x4491... "maxMintsPerUser()(uint256)" --rpc-url https://mainnet.base.org
 */
export async function getMaxPacksPerWallet(): Promise<number | null> {
  // TODO Phase 0: раскомментировать если контракт имеет такую view-функцию
  // try {
  //   const contract = new Contract(ADDRESSES.PACK_SALE, PACK_SALE_IFACE, getRpcPool().getProvider());
  //   const max = await (contract['maxPerWallet'] as () => Promise<bigint>)();
  //   const n = Number(max);
  //   return n > 0 ? n : null; // 0 может означать "без лимита"
  // } catch {
  //   return null;
  // }
  return null; // предполагаем нет лимита пока не проверено
}

/**
 * Тип NFT контракта: ERC721 (по умолчанию) или ERC1155.
 *
 * Проверить через:
 *   cast call 0xc7bd7aa20841e43838648131768735f32d15aafa \
 *     "supportsInterface(bytes4)(bool)" 0x80ac58cd \
 *     --rpc-url https://mainnet.base.org
 *
 * 0x80ac58cd = ERC721, 0xd9b67a26 = ERC1155
 */
export const PACK_NFT_IS_ERC1155 = (process.env['GRAIL_NFT_ERC1155'] === 'true');

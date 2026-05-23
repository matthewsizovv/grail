/**
 * Модуль покупки паков на Grail.xyz.
 *
 * Phase 0 данные:
 *   - Контракт: 0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da (Base)
 *   - Оплата: USDC (не ETH) через transferFrom (апрув нужен)
 *   - Цена: 15 USDC / пак = 15_000_000 raw
 *   - Подпись бэкенда: требуется (REQUIRES_BACKEND_SIGNATURE=true)
 *
 * Идемпотентность:
 *   Перед покупкой проверяем on-chain баланс NFT-паков. Если уже есть паки
 *   (куплено в прошлый раз) — пропускаем, не тратим газ.
 *
 * Порядок действий:
 *   1. Идемпотентная проверка через on-chain events / DB
 *   2. Approve USDC для контракта (если не сделано)
 *   3. Получить подпись от бэкенда Grail
 *   4. Построить calldata: buy(quantity, signature, deadline)
 *   5. Preflight → send → ждём 2 подтверждения → проверяем событие PackBought
 *
 * TODO Phase 0 — нужно подтвердить:
 *   [ ] Точная сигнатура buy(): запустить `npm run phase0:decode` на реальном tx
 *   [ ] URL бэкенд API — перехватить через DevTools/mitmproxy
 *   [ ] Порядок параметров: (qty, sig, deadline) или (qty, deadline, sig)?
 *   [ ] Нужен ли approve для open() тоже (setApprovalForAll)?
 */

import { MaxUint256, type Wallet, type TransactionReceipt } from 'ethers';
import { getTxBuilder } from '../chain/txBuilder.js';
import { getRpcPool } from '../chain/rpcPool.js';
import { ensureApproval, buildApproveData, balanceOf } from '../chain/erc20.js';
import {
  ADDRESSES,
  PACK_SALE_IFACE,
  PACK_NFT_IFACE,
  PACK_PAYMENT,
  PACKS_PER_WALLET,
  REQUIRES_BACKEND_SIGNATURE,
  getPackPrice,
  getMaxPacksPerWallet,
} from './contracts.js';
import { getPackBuySignature } from './api.js';
import { walletLogger } from '../core/logger.js';
import { WalletBlockedError } from '../core/errors.js';
import { getDB } from '../core/db.js';

// ── Имя функции и варианты calldata ──────────────────────────────────────────
//
// После Phase 0 RE — раскомментировать правильный вариант или задать через ENV.
//
//   GRAIL_BUY_FUNCTION=buy          (по умолчанию)
//   GRAIL_BUY_FUNCTION=purchasePacks (если контракт использует другое имя)
//   GRAIL_BUY_FUNCTION=mint

const BUY_FUNCTION_NAME = process.env['GRAIL_BUY_FUNCTION'] ?? 'buy';

export interface BuyPacksResult {
  /** true если покупка пропущена (уже куплено) */
  skipped: boolean;
  receipt?: TransactionReceipt;
  /** Сколько паков куплено в этот раз */
  packsBought: number;
}

/**
 * Идемпотентная покупка паков.
 *
 * @param wallet   Кошелёк покупателя
 * @param count    Сколько паков хотим купить
 * @param dryRun   Если true — только логируем, транзакцию не отправляем
 */
export async function buyPacks(
  wallet: Wallet,
  count: number = PACKS_PER_WALLET,
  dryRun = false,
): Promise<BuyPacksResult> {
  const log = walletLogger(wallet.address);
  const db = getDB();

  // ── 1. Идемпотентность: проверяем сколько паков уже куплено ──────────────
  const alreadyBought = await countConfirmedPacksBought(wallet.address);

  if (alreadyBought >= count) {
    log.info({ alreadyBought, target: count }, 'Паки уже куплены on-chain, пропускаем');
    return { skipped: true, packsBought: 0 };
  }

  const remaining = count - alreadyBought;
  log.info({ alreadyBought, remaining, target: count }, 'Покупаем паки');

  // ── 2. Проверка лимита паков на кошелёк ──────────────────────────────────
  const maxPerWallet = await getMaxPacksPerWallet();
  if (maxPerWallet !== null && remaining > maxPerWallet) {
    throw new WalletBlockedError(
      `Превышен лимит паков: пытаемся купить ${remaining}, максимум ${maxPerWallet}`,
      wallet.address,
    );
  }

  // ── 3. Получаем цену и проверяем USDC баланс ─────────────────────────────
  const pricePerPack = await getPackPrice();
  const totalCost = pricePerPack * BigInt(remaining);

  log.debug(
    {
      pricePerPack: pricePerPack.toString(),
      totalCost: totalCost.toString(),
      token: PACK_PAYMENT,
      remaining,
    },
    'Стоимость паков',
  );

  // ── 4. Апруваем USDC если нужно (оплата всегда в USDC для Grail) ─────────
  if (PACK_PAYMENT === 'USDC') {
    const { needed } = await ensureApproval(wallet, ADDRESSES.USDC, ADDRESSES.PACK_SALE, totalCost);

    if (needed) {
      log.info(
        { spender: ADDRESSES.PACK_SALE, totalCost: totalCost.toString() },
        'Апруваем USDC для контракта продажи паков',
      );

      const [balEth, balUsdc, blockNum] = await fetchBalances(wallet.address);

      // MaxUint256 апрув — чтобы не делать approve перед каждой покупкой в будущем
      await getTxBuilder().send(
        wallet,
        {
          to: ADDRESSES.USDC,
          data: buildApproveData(ADDRESSES.PACK_SALE, MaxUint256),
          stage: 'approve',
          dryRun,
        },
        { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNum },
      );

      db.updateWalletState(wallet.address, 'APPROVED');
      log.info('✅ USDC апрув выполнен');
    } else {
      log.debug('USDC апрув уже есть, пропускаем');
    }
  }

  // ── 5. Получаем подпись от бэкенда Grail ─────────────────────────────────
  let sigBytes: string = '0x';
  let sigDeadline: number = 0;

  if (REQUIRES_BACKEND_SIGNATURE) {
    log.debug({ wallet: wallet.address, count: remaining }, 'Запрашиваем подпись у бэкенда Grail');

    const quote = await getPackBuySignature(wallet.address, remaining);
    sigBytes = quote.signature;
    sigDeadline = quote.deadline;

    log.debug(
      { deadline: new Date(sigDeadline * 1000).toISOString() },
      'Подпись бэкенда получена',
    );

    // Проверяем что подпись не просрочена (с запасом 30 секунд)
    const nowSec = Math.floor(Date.now() / 1000);
    if (sigDeadline < nowSec + 30) {
      throw new WalletBlockedError(
        `Подпись бэкенда уже просрочена или просрочится через 30с: deadline=${sigDeadline}, now=${nowSec}`,
        wallet.address,
      );
    }
  }

  // ── 6. Строим calldata ────────────────────────────────────────────────────
  //
  // Phase 0 TODO: после декодирования реального tx — выбрать правильный вариант.
  //
  // Вариант A (PRIMARY): buy(uint256 quantity, bytes signature, uint256 deadline)
  //   Наиболее распространённый паттерн с бэкенд-подписью.
  //
  // Вариант B: buy(uint256 quantity, uint256 deadline, bytes signature)
  //   Другой порядок параметров — проверить через cast 4byte-decode.
  //
  // Вариант C: mint(uint256 quantity, uint256 nonce, uint256 expiry, bytes signature)
  //   С nonce вместо deadline — если бэкенд возвращает nonce.
  //
  // Переключение через ENV: GRAIL_BUY_VARIANT=A (по умолчанию A)

  const data = buildBuyCalldata(remaining, sigBytes, sigDeadline);

  // ETH value = 0, потому что оплата через USDC (transferFrom)
  const value = 0n;

  // ── 7. Preflight + отправка транзакции ───────────────────────────────────
  const [balEth, balUsdc, blockNum] = await fetchBalances(wallet.address);

  log.info(
    {
      to: ADDRESSES.PACK_SALE,
      function: BUY_FUNCTION_NAME,
      packCount: remaining,
      totalUsdcCost: totalCost.toString(),
    },
    'Отправляем транзакцию покупки паков',
  );

  const receipt = await getTxBuilder().send(
    wallet,
    {
      to: ADDRESSES.PACK_SALE,
      data,
      value,
      stage: 'buy',
      // Убеждаемся что USDC достаточно для покупки
      requiredUsdc: PACK_PAYMENT === 'USDC' ? totalCost : undefined,
      dryRun,
    },
    { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNum },
    // Верифицируем событие PackBought (или PacksPurchased)
    // TODO Phase 0: поменять eventName на реальное имя события
    { iface: PACK_SALE_IFACE, eventName: 'PackBought' },
  );

  log.info(
    {
      packsBought: remaining,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    },
    '✅ Паки куплены',
  );

  return { skipped: false, receipt, packsBought: remaining };
}

// ── Построение calldata ───────────────────────────────────────────────────────

/**
 * Строит calldata для buy() с учётом наличия/отсутствия подписи бэкенда.
 *
 * Вариант задаётся через ENV: GRAIL_BUY_VARIANT=A|B|C
 * По умолчанию — Вариант A: buy(quantity, signature, deadline)
 *
 * TODO Phase 0: после декодирования реальной tx — жёстко указать нужный вариант.
 */
function buildBuyCalldata(quantity: number, signature: string, deadline: number): string {
  const variant = process.env['GRAIL_BUY_VARIANT'] ?? 'A';

  if (!REQUIRES_BACKEND_SIGNATURE) {
    // Без подписи: самый простой вариант — buy(uint256 quantity)
    return PACK_SALE_IFACE.encodeFunctionData(BUY_FUNCTION_NAME, [BigInt(quantity)]);
  }

  switch (variant) {
    case 'A':
      // buy(uint256 quantity, bytes signature, uint256 deadline)
      return PACK_SALE_IFACE.encodeFunctionData(BUY_FUNCTION_NAME, [
        BigInt(quantity),
        signature,
        BigInt(deadline),
      ]);

    case 'B':
      // buy(uint256 quantity, uint256 deadline, bytes signature) — другой порядок
      return PACK_SALE_IFACE.encodeFunctionData(BUY_FUNCTION_NAME, [
        BigInt(quantity),
        BigInt(deadline),
        signature,
      ]);

    case 'C': {
      // mint(uint256 quantity, uint256 nonce, uint256 expiry, bytes signature)
      // Используется когда бэкенд даёт nonce вместо deadline
      // signature играет роль proof
      const nonce = BigInt(process.env['GRAIL_SIG_NONCE'] ?? deadline.toString());
      return PACK_SALE_IFACE.encodeFunctionData(BUY_FUNCTION_NAME, [
        BigInt(quantity),
        nonce,
        BigInt(deadline),
        signature,
      ]);
    }

    default:
      // Fallback на вариант A
      return PACK_SALE_IFACE.encodeFunctionData(BUY_FUNCTION_NAME, [
        BigInt(quantity),
        signature,
        BigInt(deadline),
      ]);
  }
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

/**
 * Считает количество подтверждённых покупок паков этим кошельком.
 *
 * Сначала проверяем БД (быстро), потом on-chain баланс NFT (точно).
 *
 * Логика идемпотентности:
 *   - Если в БД есть confirmed buy tx → уже куплено
 *   - Если on-chain NFT баланс > 0 → уже куплено (на случай крэша между tx и записью в БД)
 *
 * TODO Phase 0: улучшить через eth_getLogs с фильтром по PackBought событию
 *   и адресу кошелька — тогда можно точно считать количество паков.
 */
async function countConfirmedPacksBought(walletAddress: string): Promise<number> {
  const db = getDB();
  const txs = db.getTxByWalletAndStage(walletAddress, 'buy');

  // Быстрая проверка через БД
  const confirmedCount = txs.filter((t) => t.status === 'confirmed').length;
  if (confirmedCount > 0) return confirmedCount;

  // Медленная но надёжная: проверяем on-chain NFT баланс
  // Если есть паки on-chain — значит покупка прошла (БД отстала из-за краша)
  try {
    const pool = getRpcPool();
    const { Contract } = await import('ethers');

    const balance = await pool.call<bigint>((p) => {
      const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
      return (c['balanceOf'] as (a: string) => Promise<bigint>)(walletAddress);
    });

    if (balance > 0n) {
      // У нас есть паки on-chain, считаем это как 1 закупку
      return 1;
    }
  } catch {
    // Если проверка on-chain не удалась — не блокируем, идём дальше
    // DB статус = 0 confirmed → попробуем купить
  }

  return confirmedCount; // 0 если ничего нет
}

/** Получить балансы ETH, USDC и номер блока для preflight */
async function fetchBalances(address: string): Promise<[bigint, bigint, number]> {
  const pool = getRpcPool();
  return Promise.all([
    pool.call((p) => p.getBalance(address)),
    balanceOf(ADDRESSES.USDC, address),
    pool.call((p) => p.getBlockNumber()),
  ]);
}

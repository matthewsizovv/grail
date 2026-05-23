/**
 * Конечный автомат одного кошелька.
 *
 * Диаграмма переходов:
 *
 *   NEW ──► PREFLIGHT_OK ──► APPROVED ──► PACKS_BOUGHT ──► PACKS_OPENED
 *            ─────────────────────────────────────────────────────────────
 *           ──► TOKENS_DISCOVERED ──► TOKENS_SOLD ──► CONSOLIDATED ──► DONE
 *
 * Аварийные состояния:
 *   BLOCKED      — пропускаем кошелёк (ручное вмешательство)
 *   FAILED_RETRY — вернёмся при следующем запуске
 *
 * КЛЮЧЕВОЕ ПРАВИЛО ИДЕМПОТЕНТНОСТИ:
 *   При запуске с любого состояния — сначала проверяем on-chain реальность,
 *   а не слепо доверяем флагу в БД. БД может отстать от цепи если бот упал
 *   между sendTransaction и записью в SQLite.
 */

import { Wallet } from 'ethers';
import { decryptPrivateKey } from '../core/crypto.js';
import { getDB, type WalletRow, type WalletState } from '../core/db.js';
import { walletLogger } from '../core/logger.js';
import { WalletBlockedError, FatalError, classifyError } from '../core/errors.js';
import {
  stagePreflight,
  stageBuyPacks,
  stageOpenPacks,
  stageDiscoverTokens,
  stageSellTokens,
  stageConsolidate,
  type StageContext,
} from './stages.js';
import { getRpcPool } from '../chain/rpcPool.js';
import type { Config } from '../core/config.js';

// ── Таблица переходов конечного автомата ──────────────────────────────────

type StageHandler = (ctx: StageContext) => Promise<void>;

interface Transition {
  handler: StageHandler;
  /** В какое состояние переходим после успеха */
  next: WalletState;
  /** Человекочитаемое описание шага для логов */
  description: string;
}

/**
 * Карта переходов: текущее состояние → что делаем.
 * APPROVED — это подсостояние PREFLIGHT_OK (апрув выполнен, покупка ещё нет).
 */
const TRANSITIONS: Partial<Record<WalletState, Transition>> = {
  NEW: {
    handler: stagePreflight,
    next: 'PREFLIGHT_OK',
    description: 'Проверка балансов (preflight)',
  },
  PREFLIGHT_OK: {
    handler: stageBuyPacks,
    next: 'PACKS_BOUGHT',
    description: 'Покупка паков',
  },
  // APPROVED = апрув сделан но покупка ещё не выполнена
  APPROVED: {
    handler: stageBuyPacks,
    next: 'PACKS_BOUGHT',
    description: 'Покупка паков (после апрува)',
  },
  PACKS_BOUGHT: {
    handler: stageOpenPacks,
    next: 'PACKS_OPENED',
    description: 'Открытие паков',
  },
  PACKS_OPENED: {
    handler: stageDiscoverTokens,
    next: 'TOKENS_DISCOVERED',
    description: 'Обнаружение полученных токенов',
  },
  TOKENS_DISCOVERED: {
    handler: stageSellTokens,
    next: 'TOKENS_SOLD',
    description: 'Продажа токенов',
  },
  TOKENS_SOLD: {
    handler: stageConsolidate,
    next: 'CONSOLIDATED',
    description: 'Консолидация USDC',
  },
  CONSOLIDATED: {
    handler: markDone,
    next: 'DONE',
    description: 'Завершение',
  },
};

/** Финальный шаг — просто пометить DONE */
async function markDone(ctx: StageContext): Promise<void> {
  getDB().updateWalletState(ctx.wallet.address, 'DONE');
}

// ── Основная функция ──────────────────────────────────────────────────────

/**
 * Запускает полный пайплайн для одного кошелька.
 * Продолжает с того состояния которое записано в БД.
 *
 * @throws FatalError — пробрасывается вверх, останавливает весь бот
 */
export async function runWallet(row: WalletRow, config: Config, dryRun: boolean): Promise<void> {
  const log = walletLogger(row.address);
  const db = getDB();

  log.info({ state: row.state }, 'Начинаем обработку кошелька');

  // ── Расшифровываем приватный ключ ─────────────────────────────────────────
  let pk: string;
  try {
    pk = decryptPrivateKey(row.pk_encrypted);
  } catch (err) {
    // Проблема с расшифровкой — фатальная, нужна рука человека
    throw new FatalError(
      'Не удалось расшифровать приватный ключ. Проверь MASTER_KEY.',
      err,
    );
  }

  // Подключаем кошелёк к провайдеру RPC
  const provider = getRpcPool().getProvider();
  const wallet = new Wallet(pk, provider);

  // ── Цикл конечного автомата ───────────────────────────────────────────────
  let currentState = row.state;

  while (
    currentState !== 'DONE' &&
    currentState !== 'BLOCKED' &&
    currentState !== 'FAILED_RETRY'
  ) {
    const transition = TRANSITIONS[currentState];

    if (!transition) {
      // Нет обработчика для текущего состояния — это баг или ручное вмешательство
      const msg = `Нет обработчика для состояния '${currentState}'`;
      log.error({ state: currentState }, msg);
      db.updateWalletState(row.address, 'BLOCKED', msg);
      return;
    }

    log.info(
      { state: currentState, step: transition.description },
      `Выполняем шаг: ${transition.description}`,
    );

    // Читаем свежую строку из БД перед каждым шагом (могла измениться)
    const freshRow = db.getWallet(row.address) ?? row;

    const ctx: StageContext = {
      wallet,
      row: freshRow,
      config,
      dryRun,
    };

    try {
      await transition.handler(ctx);
      currentState = transition.next;

      log.info(
        { prevState: String(currentState), newState: transition.next },
        `Шаг выполнен → ${transition.next}`,
      );
    } catch (err) {
      // ── Обработка ошибок ────────────────────────────────────────────────
      if (err instanceof FatalError) {
        // Фатальные ошибки идут вверх — останавливают весь бот
        throw err;
      }

      if (err instanceof WalletBlockedError) {
        log.error(
          { state: currentState, step: transition.description, error: err.message },
          'Кошелёк заблокирован',
        );
        db.updateWalletState(row.address, 'BLOCKED', err.message);
        return;
      }

      // Классифицируем неизвестные ошибки
      const classified = classifyError(err, row.address);

      if (classified instanceof WalletBlockedError) {
        log.error(
          { state: currentState, error: classified.message },
          'Кошелёк заблокирован (после классификации)',
        );
        db.updateWalletState(row.address, 'BLOCKED', classified.message);
        return;
      }

      // RetryableError — сохраняем состояние, попробуем при следующем запуске
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { state: currentState, step: transition.description, error: errorMsg },
        'Ошибка на шаге — сохраняем FAILED_RETRY, продолжим при следующем запуске',
      );
      db.updateWalletState(row.address, 'FAILED_RETRY', errorMsg);
      return;
    }
  }

  if (currentState === 'DONE') {
    log.info('✅ Кошелёк полностью обработан');
  }
}

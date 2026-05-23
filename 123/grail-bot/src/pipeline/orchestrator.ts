/**
 * Оркестратор: последовательный запуск кошельков.
 *
 * Возможности:
 *   - Resume с любого состояния после краша
 *   - Graceful shutdown по SIGINT/SIGTERM (заканчивает текущий кошелёк)
 *   - Случайная задержка между кошельками (human-like поведение)
 *   - Пропускает DONE и BLOCKED кошельки
 *   - FAILED_RETRY кошельки ретраит в этом же запуске
 *   - Canary mode: --only-index 0 (только один кошелёк)
 *
 * ПРАВИЛО CONCURRENCY:
 *   По умолчанию concurrency=1 (один кошелёк за раз).
 *   Не увеличивай если не уверен — параллельные wallets могут
 *   конфликтовать по nonce и создавать двойные траты.
 */

import { getDB, type WalletRow } from '../core/db.js';
import { logger, maskAddress } from '../core/logger.js';
import { runWallet } from './walletRunner.js';
import { FatalError } from '../core/errors.js';
import type { Config } from '../core/config.js';

// ── Graceful shutdown ─────────────────────────────────────────────────────

let _shutdown = false;

export function setupShutdownHandlers(): void {
  const handler = (signal: string) => {
    // Устанавливаем флаг — бот завершит текущий кошелёк и выйдет
    logger.warn({ signal }, '🛑 Сигнал остановки получен. Завершаем текущий кошелёк...');
    _shutdown = true;
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

// ── Опции оркестратора ────────────────────────────────────────────────────

export interface OrchestratorOptions {
  /** Запустить только кошелёк с этим индексом в CSV (canary mode) */
  onlyIndex?: number;
  /** true = пропустить NEW кошельки, только resume незавершённые */
  resumeOnly?: boolean;
}

// ── Основной цикл ─────────────────────────────────────────────────────────

/**
 * Запускает оркестратор.
 * Итерирует кошельки последовательно с задержкой между ними.
 *
 * @throws FatalError если что-то пошло совсем не так
 */
export async function runOrchestrator(
  config: Config,
  opts: OrchestratorOptions = {},
): Promise<void> {
  const db = getDB();
  setupShutdownHandlers();

  const allWallets = db.getAllWallets();
  logger.info({ total: allWallets.length }, '📋 Всего кошельков в БД');

  // ── Фильтрация кошельков ──────────────────────────────────────────────────
  let wallets: WalletRow[];

  if (opts.onlyIndex !== undefined) {
    // Canary mode: только один кошелёк
    wallets = allWallets.filter((w) => w.index_in_csv === opts.onlyIndex);
    if (wallets.length === 0) {
      logger.warn({ index: opts.onlyIndex }, 'Кошелёк с таким индексом не найден');
      return;
    }
    logger.info({ index: opts.onlyIndex }, '🕯️  Canary режим: один кошелёк');
  } else {
    // Обычный режим: все незавершённые
    wallets = allWallets.filter(
      (w) => w.state !== 'DONE' && w.state !== 'BLOCKED',
    );

    if (opts.resumeOnly) {
      // Resume: только кошельки которые уже начали (не NEW)
      wallets = wallets.filter((w) => w.state !== 'NEW');
      logger.info('🔄 Resume режим: только незавершённые кошельки');
    }
  }

  logger.info({ eligible: wallets.length }, `🚀 Запускаем обработку ${wallets.length} кошельков`);

  if (wallets.length === 0) {
    logger.info('Нечего делать — все кошельки в DONE или BLOCKED');
    return;
  }

  // ── Счётчики результатов ──────────────────────────────────────────────────
  let processed = 0;
  let succeeded = 0;
  let blocked = 0;
  let pendingRetry = 0;

  // ── Основной цикл ─────────────────────────────────────────────────────────
  for (const row of wallets) {
    if (_shutdown) {
      logger.info('🛑 Получен сигнал остановки, прерываем цикл');
      break;
    }

    const walletNum = `${processed + 1}/${wallets.length}`;

    logger.info(
      {
        index: row.index_in_csv,
        wallet: maskAddress(row.address),
        state: row.state,
      },
      `[${walletNum}] Обрабатываем кошелёк`,
    );

    const startMs = Date.now();

    try {
      await runWallet(row, config, config.execution.dryRun);

      // Читаем финальное состояние из БД
      const finalRow = db.getWallet(row.address);
      const finalState = finalRow?.state ?? 'UNKNOWN';
      const durationMs = Date.now() - startMs;

      if (finalState === 'DONE') {
        succeeded++;
        logger.info(
          { wallet: maskAddress(row.address), durationMs },
          `[${walletNum}] ✅ DONE`,
        );
      } else if (finalState === 'BLOCKED') {
        blocked++;
        logger.warn(
          { wallet: maskAddress(row.address), error: finalRow?.last_error },
          `[${walletNum}] 🚫 BLOCKED: ${finalRow?.last_error ?? 'неизвестная причина'}`,
        );
      } else if (finalState === 'FAILED_RETRY') {
        pendingRetry++;
        logger.warn(
          { wallet: maskAddress(row.address) },
          `[${walletNum}] ⏳ FAILED_RETRY: повторим при следующем запуске`,
        );
      }
    } catch (err) {
      if (err instanceof FatalError) {
        // FatalError — поднимаем вверх, останавливаем всё
        logger.fatal(
          { error: err.message },
          '💀 Фатальная ошибка — останавливаем бот',
        );
        throw err;
      }

      // Неожиданная ошибка в runWallet (не должна попасть сюда)
      logger.error(
        { wallet: maskAddress(row.address), err: String(err) },
        `[${walletNum}] Неожиданная ошибка`,
      );
      blocked++;
    }

    processed++;

    // ── Задержка между кошельками ─────────────────────────────────────────
    if (processed < wallets.length && !_shutdown) {
      const [minSec, maxSec] = config.execution.delayBetweenWallets;
      const delaySec = randomBetween(minSec, maxSec);
      logger.debug({ delaySec }, `Ждём ${delaySec}с перед следующим кошельком`);
      await sleep(delaySec * 1000);
    }
  }

  // ── Итоговая статистика ───────────────────────────────────────────────────
  logger.info(
    { processed, succeeded, blocked, pendingRetry, total: wallets.length },
    '📊 Оркестратор завершён',
  );

  // Предупреждение если много BLOCKED
  const blockedPct = processed > 0 ? (blocked / processed) * 100 : 0;
  if (blockedPct > 10) {
    logger.warn(
      { blockedPct: blockedPct.toFixed(1) },
      `⚠️  ${blockedPct.toFixed(1)}% кошельков заблокировано — проверь причины через 'npm run status'`,
    );
  }
}

// ── Статистика ────────────────────────────────────────────────────────────

/**
 * Выводит таблицу состояний кошельков.
 * Вызывается после каждого запуска оркестратора.
 */
export function printStats(): void {
  const db = getDB();
  const stats = db.getStats();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);

  // Иконки для каждого состояния
  const icons: Record<string, string> = {
    NEW: '🆕',
    PREFLIGHT_OK: '✔️ ',
    APPROVED: '🔓',
    PACKS_BOUGHT: '🛒',
    PACKS_OPENED: '📦',
    TOKENS_DISCOVERED: '🔍',
    TOKENS_SOLD: '💱',
    CONSOLIDATED: '💰',
    DONE: '✅',
    BLOCKED: '🚫',
    FAILED_RETRY: '⏳',
  };

  console.log('\n┌──────────────────────────────────────────┐');
  console.log('│       Grail Bot — Состояния кошельков    │');
  console.log('├────────────────────┬───────┬─────────────┤');
  console.log('│ Состояние          │ Кол-во│ Процент     │');
  console.log('├────────────────────┼───────┼─────────────┤');

  for (const [state, count] of Object.entries(stats).sort()) {
    const icon = icons[state] ?? '  ';
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    const bar = '█'.repeat(Math.floor(Number(pct) / 10));
    console.log(
      `│ ${icon} ${state.padEnd(15)} │ ${String(count).padStart(5)} │ ${pct.padStart(5)}% ${bar.padEnd(5)} │`,
    );
  }

  console.log('├────────────────────┼───────┼─────────────┤');
  console.log(`│ ИТОГО              │ ${String(total).padStart(5)} │             │`);
  console.log('└────────────────────┴───────┴─────────────┘\n');

  // Выводим заблокированные кошельки с причинами
  const blocked = db.getWalletsByState('BLOCKED');
  if (blocked.length > 0) {
    console.log('🚫 Заблокированные кошельки:');
    for (const w of blocked) {
      console.log(`   [${w.index_in_csv}] ${maskAddress(w.address)}: ${w.last_error ?? 'причина неизвестна'}`);
    }
    console.log('');
  }
}

// ── Вспомогательные функции ───────────────────────────────────────────────

/** Случайное число от min до max включительно */
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

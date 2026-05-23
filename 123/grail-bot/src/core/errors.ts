/**
 * Иерархия ошибок бота.
 *
 * ┌─────────────────┬──────────────────────────────────────────────────┐
 * │ Тип ошибки      │ Действие                                         │
 * ├─────────────────┼──────────────────────────────────────────────────┤
 * │ FatalError      │ Стоп всего бота, нужен человек                   │
 * │ WalletBlocked   │ Пропустить этот кошелёк, идти дальше             │
 * │ RetryableError  │ Повтор с exponential backoff (до 5 раз)          │
 * │ SkipTokenError  │ Пропустить этот конкретный токен при продаже     │
 * └─────────────────┴──────────────────────────────────────────────────┘
 *
 * Правило: при любом сомнении → WalletBlockedError. Лучше пропустить
 * кошелёк, чем угадывать и потерять средства.
 */

export class FatalError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FatalError';
    // Прикрепляем стектрейс причины для удобства отладки
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nПричина: ${cause.stack}`;
    }
  }
}

export class WalletBlockedError extends Error {
  constructor(
    message: string,
    /** Адрес кошелька который блокируется */
    public readonly wallet: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WalletBlockedError';
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nПричина: ${cause.stack}`;
    }
  }
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RetryableError';
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nПричина: ${cause.stack}`;
    }
  }
}

export class SkipTokenError extends Error {
  constructor(
    message: string,
    /** Адрес токена который пропускается */
    public readonly token: string,
    /** Причина пропуска для записи в БД */
    public readonly reason: 'no_liquidity' | 'honeypot' | 'below_threshold' | 'simulation_revert',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkipTokenError';
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nПричина: ${cause.stack}`;
    }
  }
}

/**
 * Классифицирует произвольную ошибку RPC/контракта в нашу иерархию.
 *
 * Эта функция — "воронка": любая неизвестная ошибка попадает сюда
 * и получает правильный тип. Это гарантирует что ничего не "потеряется"
 * тихо и не вызовет undefined behaviour в оркестраторе.
 */
export function classifyError(
  err: unknown,
  wallet: string,
): FatalError | WalletBlockedError | RetryableError {
  const msg = err instanceof Error
    ? err.message.toLowerCase()
    : String(err).toLowerCase();

  // ── Fatal: проблемы конфигурации, требуют вмешательства человека ─────────
  if (msg.includes('encryption key') || msg.includes('master_key') || msg.includes('schema')) {
    return new FatalError(`Фатальная ошибка: ${msg}`, err);
  }

  // ── WalletBlocked: недостаточно ETH/USDC ─────────────────────────────────
  if (
    msg.includes('insufficient funds for gas') ||
    msg.includes('insufficient funds for transfer') ||
    msg.includes('insufficient eth') ||
    msg.includes('insufficient balance')
  ) {
    return new WalletBlockedError(`Недостаточно средств: ${msg}`, wallet, err);
  }

  // ── WalletBlocked: контракт реvertнулся и мы не знаем почему ─────────────
  // Исключаем ошибки nonce/replacement которые лечатся ретраем
  if (
    (msg.includes('execution reverted') || msg.includes('revert')) &&
    !msg.includes('nonce') &&
    !msg.includes('replacement')
  ) {
    return new WalletBlockedError(`Контракт реvertнулся: ${msg}`, wallet, err);
  }

  // ── Retryable: проблемы nonce ─────────────────────────────────────────────
  if (msg.includes('nonce too low') || msg.includes('nonce too high') || msg.includes('nonce')) {
    return new RetryableError(`Проблема nonce (решается ресинхронизацией): ${msg}`, err);
  }

  // ── Retryable: газ и replacement ─────────────────────────────────────────
  if (msg.includes('replacement underpriced') || msg.includes('transaction underpriced')) {
    return new RetryableError(`Газ слишком низкий (поднимем на ${err instanceof Error ? '' : '20%'}): ${msg}`, err);
  }

  // ── Retryable: сеть и RPC таймауты ───────────────────────────────────────
  if (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('network error') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('request failed') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('server error') ||
    msg.includes('bad gateway') ||
    msg.includes('service unavailable')
  ) {
    return new RetryableError(`Ошибка RPC/сети (переключаемся на следующий RPC): ${msg}`, err);
  }

  // ── Default: неизвестные ошибки — RetryableError с предупреждением ────────
  // Лучше попробовать ещё раз чем заблокировать кошелёк из-за временного сбоя
  return new RetryableError(`Неизвестная ошибка (treated as retryable): ${msg}`, err);
}

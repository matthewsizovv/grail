/**
 * Счётчики текущей сессии (сбрасываются при каждом новом запуске бота).
 * Используется для нумерации паков в Telegram-уведомлениях.
 */

let _sessionPacksOpened = 0;

/** Увеличить счётчик открытых паков за сессию */
export function incrementSessionPacks(count = 1): void {
  _sessionPacksOpened += count;
}

/** Получить текущий счётчик открытых паков за сессию */
export function getSessionPacksOpened(): number {
  return _sessionPacksOpened;
}

/** Сбросить счётчик (например, при тестировании) */
export function resetSessionState(): void {
  _sessionPacksOpened = 0;
}

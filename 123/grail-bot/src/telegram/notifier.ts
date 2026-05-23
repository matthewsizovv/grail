/**
 * Telegram-уведомления для Grail Bot.
 *
 * Переменные окружения:
 *   TELEGRAM_BOT_TOKEN  — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID    — ID чата/канала куда слать (можно узнать через @userinfobot)
 *
 * Формат сообщения:
 *   🎰 <b>БОНУСКА WIN WIN WIN</b>  ← только если суммарно токенов > 100
 *
 *   👛 Кошелёк #1
 *   📦 Открыт пак по счёту за сессию: 3
 *   🎁 Получены токены: WEMBA 15 YAMAL 30
 */

import { fetch } from 'undici';
import { logger } from '../core/logger.js';

const TELEGRAM_API = 'https://api.telegram.org';

// Читаем конфиг из env один раз при загрузке модуля
const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const CHAT_ID = process.env['TELEGRAM_CHAT_ID'];

export interface TokenInfo {
  symbol: string;
  /** Человекочитаемое количество (уже с учётом decimals) */
  amount: number;
}

export interface PackOpenedNotification {
  /** Порядковый номер кошелька в CSV (0-based → выводим +1) */
  walletIndex: number;
  /** Сколько паков открыто за всю сессию (нарастающий итог) */
  sessionPackCount: number;
  /** Список полученных токенов */
  tokens: TokenInfo[];
}

/**
 * Отправляет уведомление об открытии пака.
 * Ошибки не пробрасываются — бот не должен падать из-за уведомлений.
 */
export async function sendPackOpenedNotification(n: PackOpenedNotification): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    logger.debug('Telegram не настроен (нет TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID), пропускаем');
    return;
  }

  const text = buildMessage(n);

  try {
    const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, 'Telegram: ошибка отправки');
    } else {
      logger.debug({ walletIndex: n.walletIndex, sessionPackCount: n.sessionPackCount }, 'Telegram: уведомление отправлено');
    }
  } catch (err) {
    // Не ронять бот из-за сети
    logger.warn({ err: String(err) }, 'Telegram: не удалось отправить уведомление');
  }
}

/**
 * Генерирует текст сообщения в HTML-разметке Telegram.
 */
function buildMessage(n: PackOpenedNotification): string {
  const { walletIndex, sessionPackCount, tokens } = n;

  // Суммируем количество токенов
  const totalAmount = tokens.reduce((sum, t) => sum + t.amount, 0);

  // Строка токенов: "WEMBA 15 YAMAL 30"
  const tokenStr =
    tokens.length > 0
      ? tokens.map((t) => `${t.symbol.toUpperCase()} ${formatAmount(t.amount)}`).join('  ')
      : 'нет токенов';

  const lines: string[] = [];

  // Бонуска — если суммарно > 100 единиц токенов
  if (totalAmount > 100) {
    lines.push('<b>🎰 БОНУСКА WIN WIN WIN</b>');
    lines.push('');
  }

  lines.push(`👛 Кошелёк #${walletIndex + 1}`);
  lines.push(`📦 Открыт пак по счёту за сессию: ${sessionPackCount}`);
  lines.push(`🎁 Получены токены: ${tokenStr}`);

  return lines.join('\n');
}

/**
 * Форматирует число для отображения:
 * - Целые числа — без дробной части
 * - Дробные — до 2 знаков
 */
function formatAmount(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

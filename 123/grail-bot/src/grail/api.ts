/**
 * Grail.xyz Backend API Client.
 *
 * Phase 0 подтверждено: GRAIL_BACKEND_SIG=true — бэкенд подписывает покупку.
 *
 * ── Как реализовать (TODO Phase 0) ─────────────────────────────────────────
 *
 * 1. Открой https://grail.xyz в Chrome DevTools → Network → XHR/Fetch
 * 2. Купи 1 пак вручную через UI
 * 3. Найди API запрос с "signature" или "sign" в ответе
 * 4. Скопируй:
 *    a) URL: BASE_URL + путь (например: /api/v1/packs/sign или /mint/authorize)
 *    b) Headers: Authorization, x-api-key, или cookie
 *    c) Request body: { wallet, quantity, collectionId, ... }
 *    d) Response body: { signature, deadline, ... }
 * 5. Заполни GRAIL_API_URL и GRAIL_API_KEY в .env
 * 6. Реализуй getPackBuySignature() ниже, убрав заглушку
 *
 * ── Известные варианты аутентификации в NFT launchpad'ах ───────────────────
 *
 *   A) API Key в заголовке: Authorization: Bearer <JWT>
 *   B) Кошелёк + подпись nonce: wallet-connect-style challenge
 *   C) Cookie session: после login через MetaMask
 *   D) No auth: только rate-limit по IP (маловероятно с подписью)
 *
 * ── ENV переменные ─────────────────────────────────────────────────────────
 *
 *   GRAIL_API_URL      URL бэкенда (обязательно если GRAIL_BACKEND_SIG=true)
 *   GRAIL_API_KEY      Bearer token или API key
 *   GRAIL_COLLECTION_ID  ID коллекции паков (если нужен в запросе)
 *   GRAIL_API_STUB     "true" = вернуть заглушку без реального API (только dry-run!)
 */

import { request } from 'undici';
import { logger } from '../core/logger.js';
import { RetryableError, FatalError, WalletBlockedError } from '../core/errors.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Базовый URL API Grail.xyz.
 * TODO Phase 0: заполнить после перехвата через DevTools.
 * Скорее всего: https://api.grail.xyz или https://grail.xyz/api
 */
const BASE_URL = process.env['GRAIL_API_URL'] ?? 'https://api.grail.xyz';

/** Bearer token или API key для авторизации */
const API_KEY = process.env['GRAIL_API_KEY'] ?? '';

/** ID коллекции паков (если нужен в запросе к API) */
const COLLECTION_ID = process.env['GRAIL_COLLECTION_ID'] ?? '';

// ── Типы ответов API ──────────────────────────────────────────────────────────

export interface PackSignatureResponse {
  /** EIP-712 или просто eth_sign подпись от бэкенда */
  signature: string;
  /** Unix timestamp истечения подписи */
  deadline: number;
  /** Nonce (если используется вместо deadline или вместе с ним) */
  nonce?: string;
  /** Цена в raw USDC (для проверки что не изменилась) */
  price?: string;
}

// ── Основная функция ──────────────────────────────────────────────────────────

/**
 * Запрашивает подпись у бэкенда Grail для покупки паков.
 *
 * Бэкенд подписывает: keccak256(abi.encode(buyer, quantity, price, deadline))
 * и возвращает bytes signature которая проверяется в контракте через ecrecover.
 *
 * TODO Phase 0: реализовать после перехвата реального API запроса.
 */
export async function getPackBuySignature(
  walletAddress: string,
  packCount: number,
): Promise<PackSignatureResponse> {
  // Режим заглушки: только для dry-run тестирования
  if (process.env['GRAIL_API_STUB'] === 'true') {
    logger.warn(
      { walletAddress, packCount },
      '[API STUB] Возвращаем фейковую подпись. ТОЛЬКО ДЛЯ DRY-RUN!',
    );
    return {
      signature: '0x' + '00'.repeat(65), // 65 нулевых байт (невалидная подпись)
      deadline: Math.floor(Date.now() / 1000) + 3600, // +1 час
      nonce: '0',
      price: '15000000',
    };
  }

  if (!process.env['GRAIL_API_URL']) {
    throw new FatalError(
      'GRAIL_API_URL не задан!\n' +
      'Выполни Phase 0 RE: перехвати API запрос через Chrome DevTools.\n' +
      'Для dry-run тестирования: export GRAIL_API_STUB=true',
    );
  }

  // ── Вариант A: простой POST запрос с wallet + quantity ───────────────────
  // TODO Phase 0: заменить путь и формат тела запроса после перехвата

  const body: Record<string, unknown> = {
    wallet: walletAddress,
    quantity: packCount,
  };

  // Добавляем collectionId если задан
  if (COLLECTION_ID) {
    body['collectionId'] = COLLECTION_ID;
  }

  logger.debug({ url: `${BASE_URL}/sign`, walletAddress, packCount }, 'Запрашиваем подпись API');

  try {
    const response = await apiRequest<PackSignatureResponse>(
      'POST',
      // TODO Phase 0: заменить '/sign' на реальный путь
      '/sign',
      body,
    );

    // Валидируем ответ
    if (!response.signature || !response.signature.startsWith('0x')) {
      throw new FatalError(`Некорректная подпись от API: ${JSON.stringify(response)}`);
    }

    if (!response.deadline || response.deadline < Math.floor(Date.now() / 1000)) {
      throw new WalletBlockedError(
        `API вернул просроченный deadline: ${response.deadline}`,
        walletAddress,
      );
    }

    return response;

  } catch (err) {
    // Пробрасываем наши ошибки без изменений
    if (err instanceof FatalError || err instanceof WalletBlockedError) throw err;
    if (err instanceof RetryableError) throw err;

    // Оборачиваем неизвестные ошибки
    throw new RetryableError(`Ошибка API при получении подписи: ${String(err)}`, err);
  }
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

/**
 * Выполняет HTTP запрос к Grail API с обработкой ошибок.
 *
 * Поведение:
 *   - 200: парсим JSON и возвращаем
 *   - 401/403: FatalError (проверь GRAIL_API_KEY)
 *   - 429: RetryableError (rate limit)
 *   - 5xx: RetryableError (сервер временно недоступен)
 *   - 4xx: FatalError (некорректный запрос)
 */
async function apiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // User-Agent чтобы выглядеть как браузер
    // TODO Phase 0: скопировать точный User-Agent из DevTools
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };

  // Авторизация через Bearer token
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  // TODO Phase 0: если авторизация через cookie или другой заголовок — добавить здесь
  // headers['x-api-key'] = API_KEY;
  // headers['Cookie'] = `session=${API_KEY}`;

  const reqOptions: Parameters<typeof request>[1] = {
    method,
    headers,
  };

  if (body !== undefined) {
    reqOptions.body = JSON.stringify(body);
  }

  const resp = await request(url, reqOptions);

  // ── Обработка HTTP статусов ───────────────────────────────────────────────

  if (resp.statusCode === 429) {
    const retryAfter = resp.headers['retry-after'] ?? '10';
    throw new RetryableError(
      `Grail API rate limit, retry-after: ${retryAfter}s`,
    );
  }

  if (resp.statusCode === 401 || resp.statusCode === 403) {
    const text = await resp.body.text();
    throw new FatalError(
      `Grail API авторизация не прошла (${resp.statusCode}): ${text}\n` +
      'Проверь GRAIL_API_KEY и GRAIL_API_URL.',
    );
  }

  if (resp.statusCode >= 500) {
    const text = await resp.body.text();
    throw new RetryableError(
      `Grail API ошибка сервера ${resp.statusCode}: ${text.slice(0, 200)}`,
    );
  }

  if (resp.statusCode >= 400) {
    const text = await resp.body.text();
    throw new FatalError(
      `Grail API клиентская ошибка ${resp.statusCode}: ${text.slice(0, 500)}`,
    );
  }

  return resp.body.json() as Promise<T>;
}

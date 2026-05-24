/**
 * Grail.xyz Backend API Client — Phase 0 ЗАВЕРШЁН.
 *
 * Перехваченный API (Chrome DevTools):
 *   POST https://grail.xyz/api/packs/redeem/prepare
 *   Auth: Privy.io JWT (Bearer + Cookie: privy-token)
 *
 * Поток покупки (commit-reveal + USDC permit):
 *   1. POST /api/packs/redeem/prepare → получаем challenge + 2 EIP-712 объекта
 *   2. Кошелёк подписывает usdc_permit_typed_data (EIP-2612 permit, без approve-транзакции)
 *   3. Кошелёк подписывает user_attestation_typed_data (коммит к challenge)
 *   4. Обе подписи идут в контракт redeemPacks()
 *
 * ENV переменные:
 *   GRAIL_PRIVY_TOKEN   — JWT токен от Privy.io (получить через DevTools → копировать из Authorization header)
 *   GRAIL_PACK_ID       — ID пака (например: GRAILGENESISPACKS6)
 *   GRAIL_API_URL       — Базовый URL (по умолчанию: https://grail.xyz)
 *
 * ВАЖНО: JWT токен истекает через 1 час!
 *   Если бот вернул 401 — нужно обновить GRAIL_PRIVY_TOKEN:
 *   1. Открой grail.xyz в Chrome DevTools → Network
 *   2. Купи пак вручную
 *   3. Найди запрос /api/packs/redeem/prepare
 *   4. Скопируй значение заголовка Authorization (без "Bearer ")
 *   5. export GRAIL_PRIVY_TOKEN=<новый_токен>
 */

import { request } from 'undici';
import { logger } from '../core/logger.js';
import { RetryableError, FatalError, WalletBlockedError } from '../core/errors.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

const BASE_URL = process.env['GRAIL_API_URL'] ?? 'https://grail.xyz';

/** Privy.io JWT токен. Устаревший GRAIL_API_KEY тоже поддерживается */
const PRIVY_TOKEN = process.env['GRAIL_PRIVY_TOKEN'] ?? process.env['GRAIL_API_KEY'] ?? '';

/** ID пака — строковый идентификатор (например GRAILGENESISPACKS6) */
const PACK_ID = process.env['GRAIL_PACK_ID'] ?? 'GRAILGENESISPACKS6';

// ── Типы ──────────────────────────────────────────────────────────────────────

export interface Eip712Domain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
}

export interface Eip712TypeField {
  name: string;
  type: string;
}

/** EIP-712 typed data — возвращается API и используется для подписи кошельком */
export interface Eip712TypedData {
  domain: Eip712Domain;
  /** Типы: { EIP712Domain: [...], PrimaryType: [...] } */
  types: Record<string, Eip712TypeField[]>;
  message: Record<string, unknown>;
  primaryType: string;
}

/** Ответ от POST /api/packs/redeem/prepare */
export interface PrepareRedeemResponse {
  /** UUID challenge (hex bytes32 в attestation) */
  pack_challenge_id: string;
  /** ID пака: "GRAILGENESISPACKS6" */
  pack_id: string;
  /** Количество призов за 1 пак */
  draws_per_pack: number;
  /** ISO timestamp до которого challenge действителен */
  expires_at: string;
  /** Запрошенное количество паков */
  pack_count: number;
  /** Сколько паков ещё можно купить в этой сессии */
  packs_left_to_redeem: number;
  /** Хэш серверного секрета (commit-reveal) */
  server_secret_hash: string;
  /** Всего призов = draws_per_pack * pack_count */
  total_draws: number;
  /** EIP-712 typed data для подписи USDC permit */
  usdc_permit_typed_data: Eip712TypedData;
  /** EIP-712 typed data для подписи пользователя (GrailPackUserAttestation) */
  user_attestation_typed_data: Eip712TypedData;
  /** Цена в USDC — строка "15" */
  usdc_price: string;

  /**
   * Подпись сервера Grail — авторизует покупку на контракте.
   *
   * Подтверждено из реального tx: поле "permit_signature" содержит
   * предвычисленную подпись (v, r, s) плюс deadline и wallet_address.
   * Эта подпись идёт в calldata как slots 15-17 (serverV, serverR, serverS).
   *
   * Несмотря на название "permit" — это НЕ USDC permit, а авторизация покупки.
   */
  permit_signature?: {
    v: number;
    r: string;
    s: string;
    deadline: string;
    wallet_address: string;
  };

  /**
   * Альтернативные имена на случай изменения API (вряд ли, но на всякий случай).
   */
  backend_sig?: string;
  server_sig?: string;

  /** Catch-all: любые дополнительные поля API (не теряем при парсинге) */
  [key: string]: unknown;
}

// ── Основная функция ──────────────────────────────────────────────────────────

/**
 * Готовит покупку пака: получает challenge + EIP-712 данные для подписи.
 *
 * Кошелёк должен подписать:
 *   1. usdc_permit_typed_data (USDC permit — без approve транзакции)
 *   2. user_attestation_typed_data (GrailPackUserAttestation)
 *
 * Затем обе подписи + данные challenge передаются в контракт redeemPacks().
 */
export async function preparePackRedeem(
  walletAddress: string,
  packCount: number,
): Promise<PrepareRedeemResponse> {
  if (!PRIVY_TOKEN) {
    throw new FatalError(
      'GRAIL_PRIVY_TOKEN не задан!\n\n' +
      'Как получить:\n' +
      '  1. Открой https://grail.xyz в Chrome → DevTools (F12) → Network\n' +
      '  2. Купи пак вручную\n' +
      '  3. Найди запрос /api/packs/redeem/prepare\n' +
      '  4. Скопируй значение заголовка Authorization (без "Bearer ")\n' +
      '  5. В .env: GRAIL_PRIVY_TOKEN=<токен>\n\n' +
      'ВНИМАНИЕ: токен действует 1 час!\n',
    );
  }

  logger.debug(
    { walletAddress, packCount, packId: PACK_ID },
    'Запрашиваем prepare у Grail API',
  );

  const response = await grailApiRequest<PrepareRedeemResponse>(
    'POST',
    '/api/packs/redeem/prepare',
    {
      pack_count: packCount,
      pack_id: PACK_ID,
      wallet_address: walletAddress,
    },
  );

  // Проверяем что challenge ещё не истёк
  const expiresAt = new Date(response.expires_at).getTime();
  const nowMs = Date.now();
  if (expiresAt < nowMs + 30_000) {
    throw new WalletBlockedError(
      `Challenge уже истёк или истечёт через 30с: expires_at=${response.expires_at}`,
      walletAddress,
    );
  }

  logger.debug(
    {
      pack_challenge_id: response.pack_challenge_id,
      expires_at: response.expires_at,
      draws_per_pack: response.draws_per_pack,
    },
    'Challenge получен',
  );

  return response;
}

// ── HTTP клиент ───────────────────────────────────────────────────────────────

async function grailApiRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'Origin': 'https://grail.xyz',
    'Referer': 'https://grail.xyz/',
  };

  if (PRIVY_TOKEN) {
    headers['Authorization'] = `Bearer ${PRIVY_TOKEN}`;
    // Grail проверяет оба: заголовок и cookie
    headers['Cookie'] = `privy-session=t; privy-token=${PRIVY_TOKEN}`;
  }

  const resp = await request(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (resp.statusCode === 401 || resp.statusCode === 403) {
    throw new FatalError(
      `Grail API: токен истёк или недействителен (HTTP ${resp.statusCode}).\n\n` +
      'Обнови GRAIL_PRIVY_TOKEN:\n' +
      '  1. Открой grail.xyz → DevTools → Network\n' +
      '  2. Купи пак вручную\n' +
      '  3. Скопируй Authorization заголовок из /api/packs/redeem/prepare\n' +
      '  4. В .env: GRAIL_PRIVY_TOKEN=<новый_токен>\n',
    );
  }

  if (resp.statusCode === 429) {
    throw new RetryableError('Grail API: rate limit (429), подождём и повторим');
  }

  if (resp.statusCode >= 500) {
    const text = await resp.body.text();
    throw new RetryableError(`Grail API ошибка сервера ${resp.statusCode}: ${text.slice(0, 200)}`);
  }

  if (resp.statusCode >= 400) {
    const text = await resp.body.text();
    throw new FatalError(`Grail API клиентская ошибка ${resp.statusCode}: ${text.slice(0, 500)}`);
  }

  return resp.body.json() as Promise<T>;
}

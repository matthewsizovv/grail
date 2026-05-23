/**
 * Модуль покупки паков Grail.xyz.
 *
 * Поток (commit-reveal + USDC permit):
 *   1. POST /api/packs/redeem/prepare → challenge + typed data
 *   2. wallet.signTypedData(usdc_permit_typed_data)     → permitSig  (без approve!)
 *   3. wallet.signTypedData(user_attestation_typed_data) → userSig
 *   4. buildRedeemCalldata() → 21-slot calldata (сектор подтверждён: 0x2bb1bc60)
 *   5. отправляем транзакцию в PACK_SALE
 *
 * Структура calldata (21 слот × 32 байта, декодировано из реального tx):
 *   [0-6]   USDC permit: owner, spender, value, deadline, permitV, permitR, permitS
 *   [7-14]  Attestation: все поля GrailPackUserAttestation в порядке из types[]
 *           (динамически читаются из API — включая скрытые hubAddress, drawSalt и т.д.)
 *   [15-17] userSig:    v, r, s  (подпись user_attestation_typed_data)
 *   [18-20] backendSig: v, r, s  (подпись бэкенда Grail, приходит из API)
 *
 * Ссылка на реальный tx (Base): 0x0b63506498222a6e68c7a7b900802e6f8fcd0f651d307843006eb376aec5eff0
 */

import { Contract, AbiCoder, Signature, type Wallet, type TypedDataDomain } from 'ethers';
import { getTxBuilder } from '../chain/txBuilder.js';
import { getRpcPool } from '../chain/rpcPool.js';
import { balanceOf } from '../chain/erc20.js';
import {
  ADDRESSES,
  PACK_SALE_IFACE,
  PACK_NFT_IFACE,
  PACKS_PER_WALLET,
} from './contracts.js';
import {
  preparePackRedeem,
  type Eip712TypedData,
  type Eip712TypeField,
  type PrepareRedeemResponse,
} from './api.js';
import { walletLogger } from '../core/logger.js';
import { WalletBlockedError, FatalError } from '../core/errors.js';
import { getDB } from '../core/db.js';

export interface BuyPacksResult {
  skipped: boolean;
  packsBought: number;
}

/**
 * Идемпотентная покупка паков с USDC permit.
 *
 * @param wallet   Кошелёк покупателя
 * @param count    Количество паков (по умолчанию PACKS_PER_WALLET)
 * @param dryRun   Симуляция без реальных транзакций
 */
export async function buyPacks(
  wallet: Wallet,
  count: number = PACKS_PER_WALLET,
  dryRun = false,
): Promise<BuyPacksResult> {
  const log = walletLogger(wallet.address);

  // ── Идемпотентность: уже куплено? ─────────────────────────────────────────
  const alreadyBought = await countConfirmedPacksBought(wallet.address);
  if (alreadyBought >= count) {
    log.info({ alreadyBought, target: count }, 'Паки уже куплены on-chain, пропускаем');
    return { skipped: true, packsBought: 0 };
  }

  const remaining = count - alreadyBought;
  log.info({ alreadyBought, remaining }, 'Начинаем покупку паков');

  // ── Шаг 1: получаем challenge от API ──────────────────────────────────────
  const prepare = await preparePackRedeem(wallet.address, remaining);

  // Логируем все поля ответа API — поможет найти имя backend_sig поля
  log.debug(
    {
      challenge: prepare.pack_challenge_id,
      draws_per_pack: prepare.draws_per_pack,
      expires_at: prepare.expires_at,
      // Все ключи верхнего уровня (включая неизвестные поля бэкенда)
      apiKeys: Object.keys(prepare),
      attestationFields: (
        prepare.user_attestation_typed_data.types[
          prepare.user_attestation_typed_data.primaryType
        ] ?? []
      ).map((f: Eip712TypeField) => `${f.name}:${f.type}`),
    },
    'Challenge получен от API',
  );

  if (dryRun) {
    log.info('[DRY-RUN] Пропускаем подписание и отправку транзакции');
    return { skipped: false, packsBought: remaining };
  }

  // ── Шаг 2: подписываем USDC permit (без approve-транзакции!) ──────────────
  log.debug('Подписываем USDC permit (EIP-2612)...');
  const permitSig = await signEip712(wallet, prepare.usdc_permit_typed_data);
  log.debug({ sigLen: permitSig.length }, 'USDC permit подписан');

  // ── Шаг 3: подписываем GrailPackUserAttestation ───────────────────────────
  log.debug('Подписываем GrailPackUserAttestation...');
  const userSig = await signEip712(wallet, prepare.user_attestation_typed_data);
  log.debug({ sigLen: userSig.length }, 'Attestation подписан');

  // ── Шаг 4: строим calldata для redeemPacks() ──────────────────────────────
  const calldata = buildRedeemCalldata(prepare, userSig, permitSig);

  // ── Шаг 5: отправляем транзакцию ──────────────────────────────────────────
  const [balEth, balUsdc, blockNum] = await Promise.all([
    getRpcPool().call((p) => p.getBalance(wallet.address)),
    balanceOf(ADDRESSES.USDC, wallet.address),
    getRpcPool().call((p) => p.getBlockNumber()),
  ]);

  log.info(
    {
      to: ADDRESSES.PACK_SALE,
      packCount: remaining,
      challenge: prepare.pack_challenge_id,
    },
    'Отправляем redeemPacks() транзакцию',
  );

  const receipt = await getTxBuilder().send(
    wallet,
    {
      to: ADDRESSES.PACK_SALE,
      data: calldata,
      value: 0n,           // оплата через USDC permit, не ETH
      stage: 'buy',
      dryRun,
    },
    { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNum },
    // Слушаем события PackRedeemed или PackBought
    { iface: PACK_SALE_IFACE, eventName: 'PackRedeemed' },
  );

  log.info(
    { packsBought: remaining, txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() },
    '✅ Паки куплены',
  );

  return { skipped: false, packsBought: remaining };
}

// ── Подписание EIP-712 ────────────────────────────────────────────────────────

/**
 * Подписывает EIP-712 typed data ТОЧНО как вернул API.
 *
 * Использует types и message напрямую из API-ответа — не hardcoded.
 * Убирает EIP712Domain из types (ethers обрабатывает его отдельно через domain).
 *
 * Числа (uint256) автоматически конвертируются из строк в BigInt.
 */
async function signEip712(wallet: Wallet, typedData: Eip712TypedData): Promise<string> {
  const { EIP712Domain: _ignored, ...signingTypes } = typedData.types;

  // Конвертируем uint256 строки в BigInt (ethers v6 требует BigInt)
  const message = coerceMessageValues(
    typedData.message,
    typedData.types[typedData.primaryType] ?? [],
  );

  return wallet.signTypedData(
    typedData.domain as TypedDataDomain,
    signingTypes,
    message,
  );
}

/**
 * Конвертирует строковые числа в BigInt для корректной подписи.
 * uint256, int256 и их варианты → BigInt.
 * address, bytes32 и остальные → оставляем как есть.
 */
function coerceMessageValues(
  message: Record<string, unknown>,
  fields: Eip712TypeField[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = message[field.name];
    if (raw === undefined) continue;

    if (/^u?int\d*$/.test(field.type) && typeof raw === 'string') {
      result[field.name] = BigInt(raw);
    } else if (/^u?int\d*$/.test(field.type) && typeof raw === 'number') {
      result[field.name] = BigInt(raw);
    } else {
      result[field.name] = raw;
    }
  }

  return result;
}

// ── Построение calldata для redeemPacks() ────────────────────────────────────

/**
 * Строит calldata для вызова redeemPacks() на контракте GrailPackHub.
 *
 * Использует ПОДТВЕРЖДЁННЫЙ селектор 0x2bb1bc60 (декодирован из реального tx
 * 0x0b63506498222a6e68c7a7b900802e6f8fcd0f651d307843006eb376aec5eff0).
 *
 * 21-slot layout (каждый слот 32 байта):
 *   [0-6]   USDC permit: owner, spender, value, deadline, v, r, s
 *   [7-14]  Attestation: все поля GrailPackUserAttestation по порядку из types[]
 *           Читаются ДИНАМИЧЕСКИ из API — включая скрытые hubAddress, drawSalt и т.д.
 *   [15-17] userSig разбитый на v, r, s
 *   [18-20] backendSig разбитый на v, r, s (подпись сервера Grail)
 *
 * Если контракт ревертится:
 *   1. Проверь что backendSig правильно получен из API
 *   2. Попробуй поменять порядок userSig/backendSig (15-17 ↔ 18-20)
 *   3. Скинь хэш упавшей tx — посмотрим revert reason через cast run
 */
function buildRedeemCalldata(
  prepare: PrepareRedeemResponse,
  userSig: string,
  permitSig: string,
): string {
  // Подтверждённый селектор из реального tx
  const SELECTOR = '0x2bb1bc60';
  const coder = AbiCoder.defaultAbiCoder();

  // ── USDC Permit ─────────────────────────────────────────────────────────────
  const permit = prepare.usdc_permit_typed_data.message;
  const pSig = Signature.from(permitSig);

  // ── User Attestation — читаем ВСЕ поля динамически ────────────────────────
  // API возвращает полный types[] со всеми скрытыми полями (hubAddress, drawSalt…)
  // Порядок полей в типе = порядок слотов в calldata
  const attestation = prepare.user_attestation_typed_data.message;
  const attestationTypeDef =
    prepare.user_attestation_typed_data.types[
      prepare.user_attestation_typed_data.primaryType
    ] ?? [];

  if (attestationTypeDef.length === 0) {
    throw new FatalError(
      `types["${prepare.user_attestation_typed_data.primaryType}"] пуст или не найден. ` +
      `Доступные типы: ${JSON.stringify(Object.keys(prepare.user_attestation_typed_data.types))}`,
    );
  }

  const attestationTypes: string[] = [];
  const attestationValues: unknown[] = [];

  for (const field of attestationTypeDef) {
    const raw = attestation[field.name];
    if (raw === undefined) {
      throw new FatalError(
        `Поле "${field.name}" отсутствует в attestation.message.\n` +
        `Имеющиеся поля: ${JSON.stringify(Object.keys(attestation))}\n` +
        `Полный message: ${JSON.stringify(attestation)}`,
      );
    }
    attestationTypes.push(field.type);
    if (/^u?int\d*$/.test(field.type)) {
      attestationValues.push(BigInt(raw as string | number));
    } else {
      attestationValues.push(raw as string);
    }
  }

  // Ожидаем ровно 8 полей (slots 7-14). Если не 8 — предупреждаем, но не падаем.
  if (attestationTypes.length !== 8) {
    // This is just a warning — if tx reverts we'll need to debug
    process.stderr.write(
      `[WARN] Attestation fields: ${attestationTypes.length} (expected 8). ` +
      `Fields: ${attestationTypeDef.map((f) => f.name).join(', ')}\n`,
    );
  }

  // ── User Signature ───────────────────────────────────────────────────────────
  const uSig = Signature.from(userSig);

  // ── Backend Signature ─────────────────────────────────────────────────────────
  // Grail бэкенд подписывает attestation — авторизует покупку.
  // Ищем в ответе API по нескольким возможным именам поля.
  const backendSigRaw =
    prepare.backend_sig ??
    prepare.server_sig ??
    prepare.hub_sig ??
    prepare.attestation_sig ??
    // Иногда вложено в user_attestation_typed_data (нестандартное поле)
    ((prepare.user_attestation_typed_data as unknown) as Record<string, unknown>)['server_sig'] as string | undefined ??
    ((prepare.user_attestation_typed_data as unknown) as Record<string, unknown>)['backend_sig'] as string | undefined;

  if (!backendSigRaw) {
    // Выводим все поля API чтобы пользователь нашёл правильное имя
    const topLevelKeys = Object.keys(prepare).filter(
      (k) => !['pack_challenge_id', 'pack_id', 'draws_per_pack', 'expires_at',
        'pack_count', 'packs_left_to_redeem', 'server_secret_hash', 'total_draws',
        'usdc_permit_typed_data', 'user_attestation_typed_data', 'usdc_price'].includes(k),
    );

    throw new FatalError(
      '❌ Подпись бэкенда не найдена в ответе API.\n\n' +
      'Известные поля API: ' + JSON.stringify(Object.keys(prepare)) + '\n' +
      'Неизвестные поля: ' + JSON.stringify(topLevelKeys) + '\n\n' +
      'Что делать:\n' +
      '  1. Открой DevTools → Network → /api/packs/redeem/prepare → Response\n' +
      '  2. Найди поле со значением "0x..." длиной 130 символов (65 байт = подпись)\n' +
      '  3. Сообщи имя этого поля — добавим в код\n\n' +
      'Поля в user_attestation_typed_data: ' +
      JSON.stringify(Object.keys(prepare.user_attestation_typed_data)),
    );
  }

  const bSig = Signature.from(backendSigRaw as string);

  // ── Кодирование 21 слота ─────────────────────────────────────────────────────
  const allTypes = [
    // Permit [0-6]
    'address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'bytes32',
    // Attestation [7 .. 7+N-1]
    ...attestationTypes,
    // userSig [N+7 .. N+9]
    'uint256', 'bytes32', 'bytes32',
    // backendSig [N+10 .. N+12]
    'uint256', 'bytes32', 'bytes32',
  ];

  const allValues = [
    // Permit
    permit['owner'] as string,
    permit['spender'] as string,
    BigInt(permit['value'] as string | number),
    BigInt(permit['deadline'] as string | number),
    BigInt(pSig.v),
    pSig.r,
    pSig.s,
    // Attestation (все поля по порядку из types[])
    ...attestationValues,
    // userSig
    BigInt(uSig.v),
    uSig.r,
    uSig.s,
    // backendSig
    BigInt(bSig.v),
    bSig.r,
    bSig.s,
  ];

  try {
    const encoded = coder.encode(allTypes, allValues);
    return SELECTOR + encoded.slice(2); // убираем 0x перед склейкой
  } catch (err) {
    throw new FatalError(
      'AbiCoder.encode() упал — несовместимые типы.\n' +
      `Types: ${JSON.stringify(allTypes)}\n` +
      `Attestation fields: ${JSON.stringify(attestationTypeDef.map((f) => `${f.name}:${f.type}`))}`,
      err,
    );
  }
}

// ── Идемпотентность ───────────────────────────────────────────────────────────

async function countConfirmedPacksBought(walletAddress: string): Promise<number> {
  const db = getDB();
  const txs = db.getTxByWalletAndStage(walletAddress, 'buy');
  const confirmed = txs.filter((t) => t.status === 'confirmed').length;
  if (confirmed > 0) return confirmed;

  // Fallback: проверяем on-chain баланс NFT
  try {
    const balance = await getRpcPool().call<bigint>((p) => {
      const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
      return (c['balanceOf'] as (a: string) => Promise<bigint>)(walletAddress);
    });
    return balance > 0n ? 1 : 0;
  } catch {
    return 0;
  }
}

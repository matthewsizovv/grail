/**
 * Модуль покупки паков Grail.xyz.
 *
 * Поток (commit-reveal + USDC permit):
 *   1. POST /api/packs/redeem/prepare → challenge + typed data
 *   2. wallet.signTypedData(usdc_permit_typed_data)      → permitSig  (без approve!)
 *   3. wallet.signTypedData(user_attestation_typed_data) → userSig
 *   4. buildRedeemCalldata() → calldata (селектор 0x2bb1bc60)
 *   5. отправляем транзакцию в PACK_SALE
 *
 * Структура calldata (21 слот × 32 байта, декодировано из реального tx):
 *   [0-6]   USDC permit: owner, spender, value, deadline, permitV, permitR, permitS
 *   [7-14]  Attestation: все N полей GrailPackUserAttestation из API types[] (N=8 → 21 слот)
 *           Реальный tx: packChallengeId, packId, redeemer, hubAddress,
 *                        packCount, expiry, <drawSalt/serverNonce>, serverSecretHash
 *           NB: DevTools иногда показывает только 6 из 8 полей (обрезает длинные arrays)
 *   [7+N .. 7+N+2]  serverSig: v, r, s  (подпись бэкенда из permit_signature)
 *   [7+N+3 .. 7+N+5] userSig:  v, r, s  (подпись user_attestation_typed_data)
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
import { walletLogger, logger } from '../core/logger.js';
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
 * ▶ Селектор 0x2bb1bc60 подтверждён из реального tx:
 *   0x0b63506498222a6e68c7a7b900802e6f8fcd0f651d307843006eb376aec5eff0
 *
 * ▶ 21-slot layout (каждый слот 32 байта), восстановлен из реального calldata:
 *
 *   [0]  owner    = permit.owner      (wallet address)
 *   [1]  spender  = permit.spender    (PackSale address)
 *   [2]  value    = permit.value      (15 USDC в raw, = 15 000 000)
 *   [3]  deadline = permit.deadline   (= attestation.expiry — одно значение!)
 *   [4]  permitV  \
 *   [5]  permitR  ─ подпись wallet.signTypedData(usdc_permit_typed_data)
 *   [6]  permitS  /
 *   [7..7+N-1] — все поля GrailPackUserAttestation в порядке из API types[]
 *              Реальный tx показал 8 полей (slots 7-14):
 *              packChallengeId, packId, redeemer, hubAddress,
 *              packCount, expiry, <drawSalt/serverNonce>, serverSecretHash
 *              NB: 6 полей из types[] + 2 скрытых (hubAddress + drawSalt)
 *                  которые API возвращает в message но не всегда видны в DevTools
 *   [7+N]   serverV  \
 *   [7+N+1] serverR  ─ API permit_signature (сервер авторизует покупку)
 *   [7+N+2] serverS  /
 *   [7+N+3] userV    \
 *   [7+N+4] userR    ─ подпись wallet.signTypedData(user_attestation_typed_data)
 *   [7+N+5] userS    /
 *
 * ▶ Attestation поля читаются ДИНАМИЧЕСКИ из API — не hardcoded.
 *   Если API вернул 8 полей → 7+8+3+3=21 слот (правильно).
 *   Если API вернул 6 полей → 7+6+3+3=19 слот (будет предупреждение).
 */
function buildRedeemCalldata(
  prepare: PrepareRedeemResponse,
  userSig: string,    // user signs user_attestation_typed_data  → userSig slots
  permitSig: string,  // user signs usdc_permit_typed_data       → permitSig slots
): string {
  const SELECTOR = '0x2bb1bc60';
  const coder = AbiCoder.defaultAbiCoder();

  // ── 1. Permit fields ─────────────────────────────────────────────────────────
  const permit = prepare.usdc_permit_typed_data.message;
  const pSig = Signature.from(permitSig);

  // ── 2. Attestation fields — ПОЛНОСТЬЮ ДИНАМИЧЕСКИ из API ─────────────────────
  //
  // ПОЧЕМУ ДИНАМИЧЕСКИ:
  //   Реальный calldata содержит 8 слотов attestation (slots 7-14).
  //   Но пользователь подтвердил только 6 полей из DevTools paste.
  //   Скорее всего DevTools показал неполный список — реальных полей 8:
  //     hubAddress (slot 10 = PackSale) и drawSalt/serverNonce (slot 13 = 0xa7e9f9c4...)
  //   Читая ВСЕ поля из API мы автоматически включаем скрытые поля.
  //
  const attTypedData = prepare.user_attestation_typed_data;
  const attPrimaryType = attTypedData.primaryType; // "GrailPackUserAttestation"
  const attFieldDefs: Eip712TypeField[] = attTypedData.types[attPrimaryType] ?? [];
  const attMsg = attTypedData.message;

  if (attFieldDefs.length === 0) {
    throw new FatalError(
      `❌ Нет полей в user_attestation_typed_data.types.${attPrimaryType}.\n` +
      `Доступные типы: ${JSON.stringify(Object.keys(attTypedData.types))}`,
    );
  }

  const attTypes: string[] = [];
  const attValues: unknown[] = [];

  for (const field of attFieldDefs) {
    // AbiCoder корректно обрабатывает uint32, uint256, address, bytes32 и т.д.
    attTypes.push(field.type);

    const raw = attMsg[field.name];
    if (raw === undefined) {
      throw new FatalError(
        `❌ Поле attestation "${field.name}" (${field.type}) отсутствует в message.\n` +
        `Доступные поля message: ${JSON.stringify(Object.keys(attMsg))}\n` +
        `Полный message: ${JSON.stringify(attMsg)}`,
      );
    }

    // Конвертируем числа в BigInt (ethers v6 требует BigInt для uint*)
    if (/^u?int\d*$/.test(field.type)) {
      attValues.push(BigInt(raw as string | number));
    } else {
      attValues.push(raw);
    }
  }

  // ── 3. Server Authorization Signature = API's permit_signature ───────────────
  // Называется "permit_signature" в API но это подпись СЕРВЕРА (авторизация покупки)
  const serverSig = prepare['permit_signature'] as
    | { v: number; r: string; s: string; deadline: string; wallet_address: string }
    | undefined;

  if (!serverSig) {
    throw new FatalError(
      '❌ permit_signature не найден в ответе API.\n' +
      `Поля API: ${JSON.stringify(Object.keys(prepare))}\n\n` +
      'Открой DevTools → ответ /api/packs/redeem/prepare → найди поле permit_signature',
    );
  }

  // ── 4. User attestation signature ────────────────────────────────────────────
  const uSig = Signature.from(userSig);

  // ── 5. Собираем полный массив типов/значений ──────────────────────────────────
  const types = [
    // Permit [0-6]
    'address',  // 0  owner = wallet
    'address',  // 1  spender = PackSale
    'uint256',  // 2  value = 15M USDC
    'uint256',  // 3  deadline (= attestation.expiry)
    'uint256',  // 4  permitV
    'bytes32',  // 5  permitR
    'bytes32',  // 6  permitS
    // Attestation [7 .. 7+N-1] — N полей из API (динамически)
    ...attTypes,
    // Server sig (permit_signature from API)
    'uint256',  // serverV
    'bytes32',  // serverR
    'bytes32',  // serverS
    // User attestation sig
    'uint256',  // userV
    'bytes32',  // userR
    'bytes32',  // userS
  ];

  const values: unknown[] = [
    // Permit
    permit['owner'] as string,
    permit['spender'] as string,
    BigInt(permit['value'] as string | number),
    BigInt(permit['deadline'] as string | number),
    BigInt(pSig.v),
    pSig.r,
    pSig.s,
    // Attestation (динамически)
    ...attValues,
    // Server sig
    BigInt(serverSig.v),
    serverSig.r,
    serverSig.s,
    // User attestation sig
    BigInt(uSig.v),
    uSig.r,
    uSig.s,
  ];

  // ── 6. Debug лог: показываем layout для диагностики ──────────────────────────
  logger.debug(
    {
      totalSlots: types.length,
      attFieldCount: attFieldDefs.length,
      attFields: attFieldDefs.map((f) => `${f.name}:${f.type}`),
      attMessage: attMsg,
    },
    'buildRedeemCalldata: раскладка слотов',
  );

  // ── 7. Предупреждение если не 21 слот ────────────────────────────────────────
  // Реальный tx имеет 21 слот (676 байт). Если attestation вернул не 8 полей,
  // количество слотов будет другим — это сигнал проверить API response.
  const expectedSlots = 21;
  if (types.length !== expectedSlots) {
    logger.warn(
      {
        actualSlots: types.length,
        expectedSlots,
        attFieldCount: attFieldDefs.length,
        attFields: attFieldDefs.map((f) => `${f.name}:${f.type}`),
      },
      `⚠️  Количество слотов ${types.length} ≠ ${expectedSlots} (нужно 21 как в реальном tx). ` +
      `API вернул ${attFieldDefs.length} полей attestation (нужно 8). ` +
      `Проверь полный ответ /api/packs/redeem/prepare → поле user_attestation_typed_data.types`,
    );
  }

  // ── 8. ABI-encode ─────────────────────────────────────────────────────────────
  try {
    const encoded = coder.encode(types, values);
    const calldata = SELECTOR + encoded.slice(2); // убираем 0x перед склейкой
    const byteLen = (calldata.length - 2) / 2;
    logger.debug({ byteLen, slots: types.length }, 'buildRedeemCalldata: calldata готов');
    return calldata;
  } catch (err) {
    throw new FatalError(
      '❌ AbiCoder.encode() упал при построении calldata.\n' +
      `Типы: ${JSON.stringify(types)}\n` +
      `Permit message fields: ${JSON.stringify(Object.keys(permit))}\n` +
      `Attestation fields: ${JSON.stringify(attFieldDefs.map((f) => f.name))}`,
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

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
 *   [7]  packChallengeId  \
 *   [8]  packId           |
 *   [9]  redeemer         | поля user_attestation_typed_data.message
 *   [10] hub = PackSale   | (= slot [1], контракт передаёт сам себя явно!)
 *   [11] packCount        |
 *   [12] expiry           | (= slot [3], то же значение что и deadline)
 *   [13] nonce            | ← bytes32 из usdc_permit_typed_data.message.nonce!
 *   [14] serverSecretHash /
 *   [15] serverV  \
 *   [16] serverR  ─ API permit_signature (сервер авторизует покупку)
 *   [17] serverS  /
 *   [18] userV    \
 *   [19] userR    ─ подпись wallet.signTypedData(user_attestation_typed_data)
 *   [20] userS    /
 *
 * ▶ Если tx ревертится — скинь хэш, посмотрим revert reason.
 */
function buildRedeemCalldata(
  prepare: PrepareRedeemResponse,
  userSig: string,    // user signs user_attestation_typed_data  → slots 18-20
  permitSig: string,  // user signs usdc_permit_typed_data       → slots 4-6
): string {
  const SELECTOR = '0x2bb1bc60';
  const coder = AbiCoder.defaultAbiCoder();

  // ── Permit fields ─────────────────────────────────────────────────────────────
  const permit = prepare.usdc_permit_typed_data.message;
  const pSig = Signature.from(permitSig);

  // Permit nonce — bytes32 random (EIP-3009 style)
  // Восстановлен как slot 13 реального tx (0xa7e9f9c4...) — именно nonce из permit.message
  const permitNonce = permit['nonce'] as string | bigint | number | undefined;
  if (permitNonce === undefined) {
    throw new FatalError(
      '❌ Нет поля "nonce" в usdc_permit_typed_data.message.\n' +
      `Поля permit.message: ${JSON.stringify(Object.keys(permit))}\n` +
      `Полное permit.message: ${JSON.stringify(permit)}`,
    );
  }
  // Нормализуем: если число — конвертируем в hex bytes32
  const nonceBytes32 =
    typeof permitNonce === 'string'
      ? permitNonce // already hex string
      : ('0x' + BigInt(permitNonce).toString(16).padStart(64, '0'));

  // ── Attestation fields ────────────────────────────────────────────────────────
  const att = prepare.user_attestation_typed_data.message;
  const uSig = Signature.from(userSig);

  // ── Server Authorization Signature = API's permit_signature ───────────────────
  // Называется "permit_signature" в API но это подпись СЕРВЕРА (авторизация покупки)
  // Содержит: {v, r, s, deadline, wallet_address}
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

  // ── 21-slot ABI encoding ──────────────────────────────────────────────────────
  // NOTE: используем 'uint256' для всех числовых типов — ABI encoding одинаков
  //       для uint8/uint32/uint256 (все паддятся до 32 байт). Функциональный
  //       selector всё равно задаётся через SELECTOR константу напрямую.
  const types = [
    // Permit [0-6]
    'address',   // 0  owner = wallet
    'address',   // 1  spender = PackSale
    'uint256',   // 2  value = 15M USDC
    'uint256',   // 3  deadline (= attestation.expiry, одно значение!)
    'uint256',   // 4  permitV
    'bytes32',   // 5  permitR
    'bytes32',   // 6  permitS
    // Attestation [7-14]
    'bytes32',   // 7  packChallengeId
    'bytes32',   // 8  packId
    'address',   // 9  redeemer = wallet (= slot 0)
    'address',   // 10 hub = PackSale (= slot 1, передаётся снова явно!)
    'uint256',   // 11 packCount
    'uint256',   // 12 expiry (= slot 3, то же значение что и deadline)
    'bytes32',   // 13 nonce (random bytes32 из usdc_permit_typed_data.message.nonce)
    'bytes32',   // 14 serverSecretHash
    // Server signature [15-17] = permit_signature from API
    'uint256',   // 15 serverV
    'bytes32',   // 16 serverR
    'bytes32',   // 17 serverS
    // User attestation signature [18-20]
    'uint256',   // 18 userV
    'bytes32',   // 19 userR
    'bytes32',   // 20 userS
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
    // Attestation
    att['packChallengeId'] as string,
    att['packId'] as string,
    att['redeemer'] as string,
    ADDRESSES.PACK_SALE,                              // hub = PackSale (hardcoded, same as spender)
    BigInt(att['packCount'] as string | number),
    BigInt(att['expiry'] as string | number),
    nonceBytes32,                                     // random nonce from permit.message.nonce
    att['serverSecretHash'] as string,
    // Server sig (permit_signature from API)
    BigInt(serverSig.v),
    serverSig.r,
    serverSig.s,
    // User attestation sig
    BigInt(uSig.v),
    uSig.r,
    uSig.s,
  ];

  try {
    const encoded = coder.encode(types, values);
    const calldata = SELECTOR + encoded.slice(2); // убираем 0x перед склейкой
    // Проверяем длину: должно быть ровно 676 байт (4 + 21*32)
    const byteLen = (calldata.length - 2) / 2;
    if (byteLen !== 676) {
      throw new Error(`Неверная длина calldata: ${byteLen} байт (ожидается 676)`);
    }
    return calldata;
  } catch (err) {
    throw new FatalError(
      'AbiCoder.encode() упал при построении calldata.\n' +
      `Permit fields: ${JSON.stringify(Object.keys(permit))}\n` +
      `Attestation fields: ${JSON.stringify(Object.keys(att))}`,
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

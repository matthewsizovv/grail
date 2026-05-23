/**
 * Модуль покупки паков Grail.xyz — Phase 0 ЗАВЕРШЁН.
 *
 * Поток (commit-reveal + USDC permit):
 *   1. POST /api/packs/redeem/prepare → challenge + typed data
 *   2. wallet.signTypedData(usdc_permit_typed_data) → permitSig  (без транзакции!)
 *   3. wallet.signTypedData(user_attestation_typed_data) → userSig
 *   4. redeemPacks(challengeParams, userSig, permitParams, permitSig) → tx
 *
 * Ключевое: USDC permit заменяет approve-транзакцию (газ экономится).
 *
 * TODO: подтвердить точную сигнатуру redeemPacks() через BaseScan.
 *   Найди хэш своей покупки → basescan.org/tx/<hash> → Input Data → Decode
 *   Или скинь хэш транзакции и я декодирую.
 */

import { Contract, type Wallet, type TypedDataDomain } from 'ethers';
import { getTxBuilder } from '../chain/txBuilder.js';
import { getRpcPool } from '../chain/rpcPool.js';
import { balanceOf } from '../chain/erc20.js';
import {
  ADDRESSES,
  PACK_SALE_IFACE,
  PACK_NFT_IFACE,
  PACKS_PER_WALLET,
} from './contracts.js';
import { preparePackRedeem, type Eip712TypedData, type Eip712TypeField } from './api.js';
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

  log.debug(
    {
      challenge: prepare.pack_challenge_id,
      draws_per_pack: prepare.draws_per_pack,
      expires_at: prepare.expires_at,
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
  const attestation = prepare.user_attestation_typed_data.message;
  const permit = prepare.usdc_permit_typed_data.message;

  const calldata = buildRedeemCalldata(
    attestation,
    userSig,
    permit,
    permitSig,
  );

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
 * Строит calldata для вызова redeemPacks().
 *
 * BEST-GUESS параметры — нужно подтвердить через BaseScan!
 *
 * Если транзакция ревертится — скинь хэш своей покупки,
 * декодируем точную сигнатуру из реального tx.
 *
 * Текущая гипотеза:
 *   redeemPacks(
 *     bytes32 packChallengeId,
 *     bytes32 packId,
 *     uint256 packCount,
 *     bytes32 serverSecretHash,
 *     uint256 expiry,
 *     bytes   userSig,
 *     uint256 permitValue,
 *     uint256 permitNonce,
 *     uint256 permitDeadline,
 *     bytes   permitSig
 *   )
 */
function buildRedeemCalldata(
  attestation: Record<string, unknown>,
  userSig: string,
  permit: Record<string, unknown>,
  permitSig: string,
): string {
  const packChallengeId = attestation['packChallengeId'] as string;
  const packId = attestation['packId'] as string;
  const packCount = BigInt(attestation['packCount'] as string | number);
  const serverSecretHash = attestation['serverSecretHash'] as string;
  const expiry = BigInt(attestation['expiry'] as string | number);

  const permitValue = BigInt(permit['value'] as string | number);
  const permitNonce = BigInt(permit['nonce'] as string | number);
  const permitDeadline = BigInt(permit['deadline'] as string | number);

  try {
    return PACK_SALE_IFACE.encodeFunctionData('redeemPacks', [
      packChallengeId,
      packId,
      packCount,
      serverSecretHash,
      expiry,
      userSig,
      permitValue,
      permitNonce,
      permitDeadline,
      permitSig,
    ]);
  } catch (err) {
    throw new FatalError(
      'Не удалось закодировать redeemPacks() — возможно неверная сигнатура функции.\n' +
      'Нужно подтвердить ABI через BaseScan:\n' +
      '  basescan.org/address/0x4491Ac59d1e6A5D2E15a8048c2de34199e8De8dA#code\n' +
      'Или скинь хэш реальной покупки — декодируем вместе.',
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

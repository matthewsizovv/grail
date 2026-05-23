/**
 * Построитель транзакций с retry, gas bump и preflight проверками.
 *
 * ПРИНЦИП: перед каждой реальной транзакцией обязательно:
 *   1. Проверяем баланс ETH (хватит ли на газ)
 *   2. Проверяем баланс USDC (если нужен)
 *   3. Проверяем nonce (нет ли дрейфа)
 *   4. Симулируем через eth_call (поймаем revert до mainnet)
 *
 * RETRY СТРАТЕГИЯ:
 *   - До 5 попыток с exponential backoff
 *   - При "replacement underpriced" — поднимаем газ на bumpPercent%
 *   - При nonce drift — ресинхронизируем с цепью
 *   - Записываем tx в БД при первом broadcast и обновляем при confirm
 */

import {
  type JsonRpcProvider,
  type Wallet,
  type TransactionRequest,
  type TransactionReceipt,
  type TransactionResponse,
  type Log,
  type Interface,
  parseEther,
  formatEther,
  formatUnits,
} from 'ethers';
import { getRpcPool } from './rpcPool.js';
import { getNonceManager } from './nonceManager.js';
import { getGasOracle, type GasParams } from './gasOracle.js';
import { getDB, type TxStage } from '../core/db.js';
import { RetryableError, WalletBlockedError, classifyError } from '../core/errors.js';
import { walletLogger } from '../core/logger.js';
import type { Config } from '../core/config.js';

// ── Типы ──────────────────────────────────────────────────────────────────

export interface TxRequest {
  /** Контракт назначения */
  to: string;
  /** Закодированный calldata */
  data: string;
  /** ETH value (только для ETH-пейментов) */
  value?: bigint;
  /** Лимит газа (если не задан — оценивается через estimateGas) */
  gasLimit?: bigint;
  /** Метка в БД для трекинга */
  stage: TxStage;
  /** Минимум USDC который должен быть на кошельке */
  requiredUsdc?: bigint;
  /** Не отправлять — только залогировать */
  dryRun?: boolean;
}

export interface PrefightContext {
  balanceEth: bigint;
  balanceUsdc: bigint;
  /** Последний блок который мы видели (для проверки свежести RPC) */
  lastSeenBlock: number;
}

const CONFIRMATIONS = 2;      // Ждём 2 подтверждения перед следующим шагом
const GAS_BUFFER_NUM = 120n;  // Буфер газа: 120/100 = +20%
const GAS_BUFFER_DEN = 100n;

// ── Построитель транзакций ─────────────────────────────────────────────────

export class TxBuilder {
  private cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Preflight проверки перед транзакцией.
   * Бросает WalletBlockedError или RetryableError — никогда не угадывает.
   */
  async preflight(
    wallet: Wallet,
    tx: TxRequest,
    ctx: PrefightContext,
    gasParams: GasParams,
  ): Promise<bigint> {
    const log = walletLogger(wallet.address);
    const pool = getRpcPool();

    // ── 1. Проверка свежести RPC ─────────────────────────────────────────
    const currentBlock = await pool.call<number>((p: JsonRpcProvider) => p.getBlockNumber());
    if (currentBlock <= ctx.lastSeenBlock) {
      throw new RetryableError(
        `RPC возможно застрял: текущий блок ${currentBlock} ≤ последнего виденного ${ctx.lastSeenBlock}`,
      );
    }

    // ── 2. Оцениваем газ ─────────────────────────────────────────────────
    let gasLimit = tx.gasLimit;
    if (!gasLimit) {
      const estimated = await pool.call<bigint>((p: JsonRpcProvider) =>
        p.estimateGas({ ...tx, from: wallet.address }),
      );
      // Добавляем 20% буфер чтобы не падать на на-граничных ситуациях
      gasLimit = (estimated * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
      log.debug(
        { estimated: estimated.toString(), withBuffer: gasLimit.toString() },
        'Оценка газа с буфером',
      );
    }

    // ── 3. Проверяем ETH на газ ──────────────────────────────────────────
    const gasCost = getGasOracle().estimateCostEth(gasLimit, gasParams);
    const ethReserve = parseEther('0.0001'); // небольшой резерв поверх газа
    const ethNeeded = gasCost + ethReserve + (tx.value ?? 0n);

    if (ctx.balanceEth < ethNeeded) {
      throw new WalletBlockedError(
        `Недостаточно ETH: есть ${formatEther(ctx.balanceEth)}, нужно ${formatEther(ethNeeded)} ` +
        `(газ ~${formatEther(gasCost)})`,
        wallet.address,
      );
    }

    // ── 4. Проверяем USDC (если нужен) ───────────────────────────────────
    if (tx.requiredUsdc !== undefined && ctx.balanceUsdc < tx.requiredUsdc) {
      throw new WalletBlockedError(
        `Недостаточно USDC: есть ${formatUnits(ctx.balanceUsdc, 6)}, ` +
        `нужно ${formatUnits(tx.requiredUsdc, 6)}`,
        wallet.address,
      );
    }

    // ── 5. Проверяем nonce ───────────────────────────────────────────────
    await getNonceManager().assertSync(wallet.address);

    // ── 6. Симуляция через eth_call — ловим revert до mainnet ───────────
    log.debug({ stage: tx.stage, to: tx.to }, 'Симулируем tx через eth_call');
    try {
      await pool.call<string>((p: JsonRpcProvider) =>
        p.call({
          to: tx.to,
          data: tx.data,
          from: wallet.address,
          value: tx.value ?? 0n,
        }),
      );
    } catch (err) {
      // eth_call упал → контракт реvertнется на mainnet → блокируем кошелёк
      throw new WalletBlockedError(
        `eth_call симуляция упала — контракт реvertнется: ${String(err)}`,
        wallet.address,
        err,
      );
    }

    log.debug({ stage: tx.stage, gasLimit: gasLimit.toString() }, 'Preflight пройден ✓');
    return gasLimit;
  }

  /**
   * Строит, подписывает и отправляет транзакцию.
   * Ждёт CONFIRMATIONS подтверждений.
   * При необходимости верифицирует событие.
   *
   * @param wallet        Кошелёк отправителя
   * @param tx            Запрос транзакции
   * @param ctx           Балансы и блок для preflight
   * @param verifyEvent   Если задано — проверяем что событие было эмитировано
   */
  async send(
    wallet: Wallet,
    tx: TxRequest,
    ctx: PrefightContext,
    verifyEvent?: { iface: Interface; eventName: string },
  ): Promise<TransactionReceipt> {
    const log = walletLogger(wallet.address);

    // ── Dry-run: не отправляем, возвращаем заглушку ───────────────────────
    if (tx.dryRun ?? this.cfg.execution.dryRun) {
      log.info(
        { stage: tx.stage, to: tx.to, value: tx.value?.toString() ?? '0' },
        '[DRY-RUN] Транзакция пропущена',
      );
      // Возвращаем фейковый receipt для dry-run
      return {
        status: 1,
        hash: '0x' + 'dry'.repeat(21) + '1',
        gasUsed: 200_000n,
        blockNumber: ctx.lastSeenBlock + 1,
        logs: [],
      } as unknown as TransactionReceipt;
    }

    const { retry } = this.cfg;
    let gasParams = await getGasOracle().getGasParams();
    let lastErr: unknown;

    // ── Retry цикл ────────────────────────────────────────────────────────
    for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
      // Задержка перед ретраем
      if (attempt > 0) {
        const delayMs = retry.backoffMs[attempt - 1] ?? 16_000;
        log.info(
          { attempt, delayMs, stage: tx.stage },
          `Повтор через ${delayMs}мс...`,
        );
        await sleep(delayMs);

        // Поднимаем газ при retry чтобы не получить "replacement underpriced"
        if (attempt >= 2) {
          gasParams = getGasOracle().bump(gasParams);
          log.debug(
            { maxFeePerGas: gasParams.maxFeePerGas.toString() },
            'Газ поднят для retry',
          );
        }
      }

      try {
        // Preflight перед каждой попыткой (балансы могли измениться)
        const gasLimit = await this.preflight(wallet, tx, ctx, gasParams);

        const nonce = await getNonceManager().getNonce(wallet.address);

        const txReq: TransactionRequest = {
          to: tx.to,
          data: tx.data,
          value: tx.value ?? 0n,
          nonce,
          gasLimit,
          maxFeePerGas: gasParams.maxFeePerGas,
          maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
          chainId: BigInt(this.cfg.network.chainId),
          type: 2, // EIP-1559
        };

        log.info(
          {
            stage: tx.stage,
            to: tx.to,
            nonce,
            gasLimit: gasLimit.toString(),
            value: (tx.value ?? 0n).toString(),
          },
          `Отправляем tx (попытка ${attempt + 1}/${retry.maxAttempts})`,
        );

        // ── Отправка ─────────────────────────────────────────────────────
        const response: TransactionResponse = await wallet.sendTransaction(txReq);

        // Сразу инкрементируем локальный nonce — не ждём confirm
        getNonceManager().advance(wallet.address);

        // Записываем в БД как pending
        getDB().insertTx({
          hash: response.hash,
          wallet: wallet.address,
          stage: tx.stage,
          nonce,
          status: 'pending',
          created_at: Date.now(),
        });

        log.info(
          { stage: tx.stage, txHash: response.hash },
          `Tx отправлена, ждём ${CONFIRMATIONS} подтверждений`,
        );

        // ── Ожидание подтверждений ────────────────────────────────────────
        const receipt = await response.wait(CONFIRMATIONS);

        if (!receipt) {
          // Null receipt = возможный реорг
          throw new RetryableError('Receipt = null (возможный реорг блокчейна)');
        }

        if (receipt.status === 0) {
          // Транзакция прошла но реvertнулась on-chain
          getDB().updateTxStatus(response.hash, 'reverted');
          throw new WalletBlockedError(
            `Tx ${response.hash} реvertнулась on-chain. ` +
            'Используй Tenderly для анализа причины.',
            wallet.address,
          );
        }

        // Обновляем статус в БД
        getDB().updateTxStatus(
          response.hash,
          'confirmed',
          Number(receipt.gasUsed),
          receipt.blockNumber,
        );

        // Обновляем lastSeenBlock для следующих preflight проверок
        ctx.lastSeenBlock = receipt.blockNumber;

        // ── Верификация события ───────────────────────────────────────────
        if (verifyEvent) {
          const found = receipt.logs.some((rawLog: Log) => {
            try {
              const parsed = verifyEvent.iface.parseLog({
                topics: [...rawLog.topics],
                data: rawLog.data,
              });
              return parsed?.name === verifyEvent.eventName;
            } catch {
              return false;
            }
          });

          if (!found) {
            // Tx прошла но ожидаемое событие не эмитировалось
            // Это критичная ошибка — что-то пошло не так с контрактом
            throw new WalletBlockedError(
              `Событие '${verifyEvent.eventName}' не найдено в receipt ${response.hash}. ` +
              'Контракт мог вернуть иное поведение.',
              wallet.address,
            );
          }
        }

        log.info(
          {
            stage: tx.stage,
            txHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
            blockNumber: receipt.blockNumber,
          },
          '✅ Транзакция подтверждена',
        );

        return receipt;
      } catch (err) {
        lastErr = err;

        // WalletBlockedError не ретраим — сразу поднимаем
        if (err instanceof WalletBlockedError) throw err;

        // FatalError тоже
        if (err instanceof RetryableError && String(err.message).includes('Fatal')) throw err;

        // Классифицируем ошибку
        const classified = classifyError(err, wallet.address);
        if (classified instanceof WalletBlockedError) throw classified;

        // Обработка нonce drift
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.toLowerCase().includes('nonce')) {
          log.warn('Nonce drift — ресинхронизируем с цепью');
          await getNonceManager().syncFromChain(wallet.address);
        }

        log.warn(
          { stage: tx.stage, attempt: attempt + 1, err: errMsg.slice(0, 200) },
          'Попытка неудачна, будем ретраить',
        );
      }
    }

    throw new RetryableError(
      `Tx не прошла за ${retry.maxAttempts} попыток`,
      lastErr,
    );
  }
}

// ── Синглтон ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _builder: TxBuilder | null = null;

export function initTxBuilder(cfg: Config): TxBuilder {
  _builder = new TxBuilder(cfg);
  return _builder;
}

export function getTxBuilder(): TxBuilder {
  if (!_builder) throw new Error('TxBuilder не инициализирован. Вызови initTxBuilder() сначала.');
  return _builder;
}

/**
 * Модуль клейма наград Grail.xyz.
 *
 * TODO Phase 0 — КРИТИЧНО — определить механику наград:
 *
 * Вариант A: Токены минтятся АВТОМАТИЧЕСКИ в момент open() → этот модуль не нужен.
 *   Признаки: в receipt от open() есть Transfer события от нулевого адреса (mint).
 *   Действие: вернуть { needed: false, skipped: true }.
 *
 * Вариант B: Токены накапливаются в маппинге pendingRewards[address] → нужен claim().
 *   Признаки: в receipt от open() нет Transfer событий, но есть событие типа
 *             RewardsAdded(address, uint256) или Credited(address, tokens, amounts).
 *   Действие: реализовать отдельную транзакцию claim()/claimRewards()/redeem().
 *
 * Вариант C: Награды — это отдельные NFT → нужен redeemNFT() с burn паков.
 *   Действие: реализовать через PACK_SALE_IFACE.encodeFunctionData('redeem', [...]).
 *
 * КАК ПРОВЕРИТЬ:
 *   1. Открой Tenderly, найди tx открытия пака.
 *   2. В трейсе ищи Transfer(from=0x0000, to=твойАдрес) — это mint.
 *   3. Если Transfer есть → Вариант A.
 *   4. Если Transfer нет, но есть mapping pendingRewards → Вариант B.
 *   5. cast call <packNft> "pendingRewards(address)(uint256)" <твойАдрес>
 *      Если возвращает > 0 после open → Вариант B.
 */

import { Contract, Interface, type Wallet, type TransactionReceipt } from 'ethers';
import { getTxBuilder } from '../chain/txBuilder.js';
import { getRpcPool } from '../chain/rpcPool.js';
import { balanceOf } from '../chain/erc20.js';
import { ADDRESSES, PACK_NFT_IFACE, PACK_SALE_IFACE } from './contracts.js';
import { walletLogger } from '../core/logger.js';

// Переключатель: нужен ли отдельный claim? (задаётся после Phase 0)
const CLAIM_NEEDED = process.env['GRAIL_CLAIM_NEEDED'] === 'true';

// ABI для функции claim (заполнить после Phase 0)
// TODO Phase 0: добавить реальную сигнатуру функции клейма
const CLAIM_ABI = [
  'function claimRewards() external',
  'function claim() external',
  'function redeem(uint256[] tokenIds) external',
  'event RewardsClaimed(address indexed account, address[] tokens, uint256[] amounts)',
];
const CLAIM_IFACE = new Interface(CLAIM_ABI);

export interface ClaimResult {
  /** true если клейм нужен был */
  needed: boolean;
  /** true если пропущен (уже claim или не нужен) */
  skipped: boolean;
  receipt?: TransactionReceipt;
  /** Токены полученные при клейме */
  claimedTokens: { address: string; amount: bigint }[];
}

/**
 * Идемпотентный клейм наград.
 * Проверяет pendingRewards перед отправкой транзакции.
 *
 * @param wallet  Кошелёк
 * @param dryRun  Если true — только логируем
 */
export async function claimRewards(wallet: Wallet, dryRun = false): Promise<ClaimResult> {
  const log = walletLogger(wallet.address);

  // Если по результатам Phase 0 выяснили что клейм не нужен — сразу выходим
  if (!CLAIM_NEEDED) {
    log.debug('Клейм отключён (GRAIL_CLAIM_NEEDED != true) — токены минтятся при открытии паков');
    return { needed: false, skipped: true, claimedTokens: [] };
  }

  // ── Идемпотентность: проверяем pending rewards ─────────────────────────
  const pendingAmount = await checkPendingRewards(wallet.address);

  if (pendingAmount === 0n) {
    log.info('Нет pending rewards на клейм, пропускаем');
    return { needed: true, skipped: true, claimedTokens: [] };
  }

  log.info({ pendingAmount: pendingAmount.toString() }, 'Клеймим награды');

  // ── Строим calldata ────────────────────────────────────────────────────
  // TODO Phase 0: выбрать правильную функцию из CLAIM_ABI
  // Вариант без аргументов:
  const data = CLAIM_IFACE.encodeFunctionData('claimRewards');

  // Вариант с tokenIds (если Вариант C из комментария выше):
  // const data = CLAIM_IFACE.encodeFunctionData('redeem', [tokenIds]);

  const pool = getRpcPool();
  const [balEth, balUsdc, blockNum] = await Promise.all([
    pool.call((p) => p.getBalance(wallet.address)),
    balanceOf(ADDRESSES.USDC, wallet.address),
    pool.call((p) => p.getBlockNumber()),
  ]);

  // TODO Phase 0: заменить ADDRESSES.PACK_NFT на правильный адрес если клейм
  // делается через другой контракт
  const receipt = await getTxBuilder().send(
    wallet,
    {
      to: ADDRESSES.PACK_NFT,
      data,
      stage: 'open', // используем 'open' как ближайший по смыслу
      dryRun,
    },
    { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNum },
  );

  // Парсим что получили при клейме
  const claimedTokens: { address: string; amount: bigint }[] = [];
  if (!dryRun) {
    for (const rawLog of receipt.logs) {
      try {
        const parsed = CLAIM_IFACE.parseLog({ topics: [...rawLog.topics], data: rawLog.data });
        if (parsed?.name === 'RewardsClaimed') {
          const addrs = parsed.args['tokens'] as string[];
          const amounts = parsed.args['amounts'] as bigint[];
          for (let i = 0; i < addrs.length; i++) {
            const addr = addrs[i]; const amt = amounts[i];
            if (addr && amt) claimedTokens.push({ address: addr, amount: amt });
          }
        }
      } catch { /* не наш ABI */ }
    }
  }

  log.info({ tokensReceived: claimedTokens.length, txHash: receipt.hash }, 'Клейм выполнен');
  return { needed: true, skipped: false, receipt, claimedTokens };
}

/**
 * Проверяет наличие pending rewards.
 * TODO Phase 0: реализовать через cast call <addr> "pendingRewards(address)(uint256)" <wallet>
 *
 * Если функция называется по-другому — поправить здесь.
 */
async function checkPendingRewards(address: string): Promise<bigint> {
  if (!CLAIM_NEEDED) return 0n;

  try {
    const pool = getRpcPool();
    return await pool.call<bigint>((p) => {
      const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
      // TODO Phase 0: поменять 'pendingRewards' на реальное имя view-функции
      const fn = c['pendingRewards'] as ((a: string) => Promise<bigint>) | undefined;
      if (!fn) return Promise.resolve(0n);
      return fn(address);
    });
  } catch {
    // Если функция не существует → возвращаем 0 (нет pending rewards)
    return 0n;
  }
}

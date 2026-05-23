/**
 * Модуль открытия паков Grail.xyz.
 *
 * Идемпотентность:
 *   Проверяем on-chain баланс NFT-паков. Если = 0 → уже открыты / не куплены.
 *
 * Порядок действий:
 *   1. Проверить баланс pack NFT (ERC721 или ERC1155)
 *   2. Получить список token ID в нашем кошельке
 *   3. Вызвать open(uint256[] packIds) или открыть по одному (зависит от контракта)
 *   4. Распарсить события PackOpened → получить список ERC20 токенов-наград
 *   5. Вернуть список полученных токенов для записи в БД
 *
 * TODO Phase 0 — нужно выяснить:
 *   - Это ERC721 (tokensOfOwner) или ERC1155 (balanceOf(addr, tokenId))?
 *   - Один open() на все паки или по одному?
 *   - Есть ли cooldown между открытиями?
 *   - Нужно ли setApprovalForAll(packSale, true) перед open()?
 *   - Как именно эмитируется событие PackOpened — список токенов или по одному?
 */

import { Contract, type Wallet, type TransactionReceipt } from 'ethers';
import { getTxBuilder } from '../chain/txBuilder.js';
import { getRpcPool } from '../chain/rpcPool.js';
import { balanceOf } from '../chain/erc20.js';
import {
  ADDRESSES,
  PACK_NFT_IFACE,
  PACK_NFT_IS_ERC1155,
  PACK_SALE_IFACE,
} from './contracts.js';
import { walletLogger } from '../core/logger.js';

export interface ReceivedToken {
  address: string;
  amount: bigint;
}

export interface OpenPacksResult {
  /** true если пропущено (паков нет) */
  skipped: boolean;
  receipt?: TransactionReceipt;
  packsOpened: number;
  /** ERC20 токены полученные из паков */
  tokensReceived: ReceivedToken[];
}

/**
 * Идемпотентное открытие всех паков.
 *
 * @param wallet  Кошелёк с паками
 * @param dryRun  Если true — только логируем, не отправляем tx
 */
export async function openPacks(wallet: Wallet, dryRun = false): Promise<OpenPacksResult> {
  const log = walletLogger(wallet.address);
  const pool = getRpcPool();

  // ── 1. Проверяем баланс NFT-паков (идемпотентность) ──────────────────────
  const packBalance = await getPackNftBalance(wallet.address);

  if (packBalance === 0n) {
    log.info('NFT-паков нет на балансе, пропускаем открытие');
    return { skipped: true, packsOpened: 0, tokensReceived: [] };
  }

  log.info({ packBalance: packBalance.toString() }, 'Открываем паки');

  // ── 2. Получаем ID всех паков кошелька ───────────────────────────────────
  const packIds = await getOwnedPackIds(wallet.address, packBalance);

  if (packIds.length === 0) {
    log.warn('balanceOf > 0, но tokensOfOwner вернул пустой список. Возможно, несовместимый ABI.');
    return { skipped: true, packsOpened: 0, tokensReceived: [] };
  }

  log.debug({ packIds: packIds.map(String) }, 'Найдены ID паков');

  // ── 3. Строим calldata для открытия ──────────────────────────────────────
  // TODO Phase 0: выбрать правильный вариант на основе RE_REPORT.md
  //
  // Вариант A: открыть все сразу (batch)
  //   const data = PACK_NFT_IFACE.encodeFunctionData('open', [packIds]);
  //
  // Вариант B: открыть по одному (если нет batch-функции)
  //   for (const id of packIds) {
  //     await openSinglePack(wallet, id, dryRun);
  //   }
  //
  // Вариант C: open() вызывается на PackSale, а не на PackNFT
  //   const data = PACK_SALE_IFACE.encodeFunctionData('open', [packIds]);
  //   to = ADDRESSES.PACK_SALE

  // По умолчанию: batch через PackNFT контракт
  const data = PACK_NFT_IFACE.encodeFunctionData('open', [packIds]);

  // ── 4. Отправляем транзакцию ──────────────────────────────────────────────
  const [balEth, balUsdc, blockNum] = await Promise.all([
    pool.call((p) => p.getBalance(wallet.address)),
    balanceOf(ADDRESSES.USDC, wallet.address),
    pool.call((p) => p.getBlockNumber()),
  ]);

  const receipt = await getTxBuilder().send(
    wallet,
    {
      to: ADDRESSES.PACK_NFT,
      data,
      stage: 'open',
      dryRun,
    },
    { balanceEth: balEth, balanceUsdc: balUsdc, lastSeenBlock: blockNum },
    { iface: PACK_NFT_IFACE, eventName: 'PackOpened' },
  );

  // ── 5. Парсим события PackOpened → список полученных токенов ─────────────
  const tokensReceived = dryRun ? [] : parsePackOpenedEvents(receipt);

  log.info(
    {
      packsOpened: packIds.length,
      tokensReceived: tokensReceived.length,
      txHash: receipt.hash,
    },
    'Паки открыты',
  );

  return {
    skipped: false,
    receipt,
    packsOpened: packIds.length,
    tokensReceived,
  };
}

// ── Вспомогательные функции ───────────────────────────────────────────────

/**
 * Баланс pack NFT для адреса.
 * Поддерживает ERC721 (balanceOf(addr)) и ERC1155 (balanceOf(addr, tokenId=0)).
 *
 * TODO Phase 0: для ERC1155 нужно знать конкретный tokenId типа пака.
 * Если у Grail несколько видов паков — нужно проитерировать по типам.
 */
async function getPackNftBalance(address: string): Promise<bigint> {
  const pool = getRpcPool();

  if (PACK_NFT_IS_ERC1155) {
    // ERC1155: balanceOf(address account, uint256 id)
    // TODO Phase 0: заменить 0n на реальный tokenId типа пака
    const erc1155TokenId = BigInt(process.env['GRAIL_PACK_TOKEN_ID'] ?? '1');
    return pool.call<bigint>((p) => {
      const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
      return (c['balanceOf'] as (a: string, id: bigint) => Promise<bigint>)(address, erc1155TokenId);
    });
  } else {
    // ERC721: balanceOf(address owner)
    return pool.call<bigint>((p) => {
      const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
      return (c['balanceOf'] as (a: string) => Promise<bigint>)(address);
    });
  }
}

/**
 * Получает список ID паков кошелька.
 *
 * Для ERC721 с ERC721Enumerable: токены через tokensOfOwner(addr).
 * Для ERC1155: возвращаем [tokenId] с балансом.
 *
 * TODO Phase 0: проверить, поддерживает ли контракт tokensOfOwner.
 * Если нет — нужно парсить Transfer события или использовать Alchemy API.
 */
async function getOwnedPackIds(address: string, balance: bigint): Promise<bigint[]> {
  const pool = getRpcPool();

  if (PACK_NFT_IS_ERC1155) {
    // ERC1155: просто возвращаем [tokenId] с нужным balance
    const erc1155TokenId = BigInt(process.env['GRAIL_PACK_TOKEN_ID'] ?? '1');
    // Возвращаем массив из balance штук одного tokenId (для batch open)
    return Array.from({ length: Number(balance) }, () => erc1155TokenId);
  }

  // ERC721: используем tokensOfOwner если контракт наследует ERC721Enumerable
  try {
    return await pool.call<bigint[]>((p) => {
      const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
      return (c['tokensOfOwner'] as (a: string) => Promise<bigint[]>)(address);
    });
  } catch {
    // Если tokensOfOwner недоступен — используем tokenOfOwnerByIndex (ERC721Enumerable)
    return await getTokensByEnumeration(address, balance, pool);
  }
}

/**
 * ERC721Enumerable fallback: перебираем токены через tokenOfOwnerByIndex.
 * Медленнее, но универсально.
 */
async function getTokensByEnumeration(
  address: string,
  balance: bigint,
  pool: ReturnType<typeof getRpcPool>,
): Promise<bigint[]> {
  const ids: bigint[] = [];
  for (let i = 0n; i < balance; i++) {
    try {
      const id = await pool.call<bigint>((p) => {
        const c = new Contract(ADDRESSES.PACK_NFT, PACK_NFT_IFACE, p);
        return (c['tokenOfOwnerByIndex'] as (a: string, idx: bigint) => Promise<bigint>)(address, i);
      });
      ids.push(id);
    } catch {
      break; // конец списка
    }
  }
  return ids;
}

/**
 * Парсит события PackOpened из receipt и возвращает список полученных токенов.
 *
 * TODO Phase 0: обновить согласно реальному формату события.
 * Возможные форматы:
 *
 *   event PackOpened(address indexed opener, uint256 packId, address[] tokens, uint256[] amounts)
 *   event PackOpened(address indexed opener, uint256[] packIds, address[] tokens, uint256[] amounts)
 *   event TokensMinted(address indexed to, address[] tokens, uint256[] amounts)
 */
function parsePackOpenedEvents(receipt: TransactionReceipt): ReceivedToken[] {
  const tokens: ReceivedToken[] = [];

  for (const rawLog of receipt.logs) {
    // Пробуем оба ABI — PackNFT и PackSale (событие может быть в разных местах)
    for (const iface of [PACK_NFT_IFACE, PACK_SALE_IFACE]) {
      try {
        const parsed = iface.parseLog({ topics: [...rawLog.topics], data: rawLog.data });
        if (!parsed) continue;

        if (parsed.name === 'PackOpened' || parsed.name === 'TokensMinted') {
          // Формат: tokens (address[]) и amounts (uint256[])
          const addrs = parsed.args['tokens'] as string[] | undefined;
          const amounts = parsed.args['amounts'] as bigint[] | undefined;

          if (addrs && amounts) {
            for (let i = 0; i < addrs.length; i++) {
              const addr = addrs[i];
              const amt = amounts[i];
              if (addr && amt && amt > 0n) {
                tokens.push({ address: addr, amount: amt });
              }
            }
          }
          break; // нашли событие, идём к следующему лог-записи
        }
      } catch {
        // Не наш ABI — продолжаем
      }
    }
  }

  return tokens;
}

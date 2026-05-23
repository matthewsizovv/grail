#!/usr/bin/env tsx
/**
 * tools/decode-tx.ts — Инструмент Phase 0
 *
 * Декодирует транзакцию Grail.xyz и выводит:
 *   - Адрес контракта (to)
 *   - Функциональный селектор (первые 4 байта calldata)
 *   - Декодированные параметры (если ABI известен)
 *   - Список эмитированных событий
 *   - ETH value транзакции
 *
 * Использование:
 *   npx tsx tools/decode-tx.ts <TX_HASH>
 *   npx tsx tools/decode-tx.ts <TX_HASH> --rpc https://mainnet.base.org
 *
 * Примеры:
 *   npx tsx tools/decode-tx.ts 0xabc123...  # Декодировать buy tx
 *   npx tsx tools/decode-tx.ts 0xdef456...  # Декодировать open tx
 *
 * Результат сохраняется в: RE_REPORT_auto.md
 */

import { JsonRpcProvider, Interface, formatEther, hexlify } from 'ethers';
import { writeFileSync } from 'fs';

// ── Аргументы командной строки ─────────────────────────────────────────────
const args = process.argv.slice(2);
const txHash = args.find((a) => a.startsWith('0x') && a.length === 66);
const rpcArg = args.findIndex((a) => a === '--rpc');
const rpcUrl = rpcArg >= 0 ? args[rpcArg + 1] : process.env['RPC_URL'];

if (!txHash) {
  console.error('Использование: npx tsx tools/decode-tx.ts <TX_HASH> [--rpc <RPC_URL>]');
  console.error('Пример: npx tsx tools/decode-tx.ts 0xabcd...');
  process.exit(1);
}

const RPC_URLS = [
  rpcUrl,
  'https://mainnet.base.org',
  'https://base.drpc.org',
  'https://base.llamarpc.com',
].filter(Boolean) as string[];

// ── Известные адреса Grail.xyz на Base (Phase 0 данные) ────────────────────
const GRAIL_ADDRESSES = {
  PACK_SALE: '0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da',
  PACK_NFT:  '0xc7bd7aa20841e43838648131768735f32d15aafa',
  USDC:      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
} as const;

// ── Известные ABI для попытки декодирования ────────────────────────────────
// Добавляй сюда сигнатуры по мере их нахождения в Phase 0
const KNOWN_FUNCTIONS = [
  // Покупка паков — все возможные варианты с подписью бэкенда
  // Вариант A: buy(quantity, signature, deadline) — PRIMARY
  'function buy(uint256 quantity, bytes signature, uint256 deadline)',
  // Вариант B: buy(quantity, deadline, signature)
  'function buy(uint256 quantity, uint256 deadline, bytes signature)',
  // Без подписи
  'function buy(uint256 packCount)',
  // С collectionId
  'function buy(uint256 collectionId, uint256 packCount)',
  'function buy(uint256 collectionId, uint256 quantity, bytes signature, uint256 deadline)',
  // Альтернативные имена
  'function purchasePacks(uint256 count, bytes signature, uint256 deadline)',
  'function purchasePacks(uint256 count)',
  'function mintPacks(uint256 amount)',
  'function buyPacks(uint256 count)',
  // С nonce
  'function mint(uint256 quantity, uint256 nonce, uint256 expiry, bytes signature)',
  // Открытие паков
  'function open(uint256[] packIds)',
  'function openPacks(uint256[] tokenIds)',
  'function reveal(uint256[] tokenIds)',
  'function unpack(uint256[] tokenIds)',
  'function openPack(uint256 packId)',
  // Клейм
  'function claim()',
  'function claimRewards()',
  'function redeem()',
  // ERC20 стандарт
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  // ERC721 стандарт
  'function setApprovalForAll(address operator, bool approved)',
];

const KNOWN_EVENTS = [
  'event PackBought(address indexed buyer, uint256 packCount, uint256[] packIds)',
  'event PackBought(address indexed buyer, uint256 packId)',
  'event PacksPurchased(address indexed buyer, uint256 count)',
  'event PackOpened(address indexed opener, uint256 packId, address[] tokens, uint256[] amounts)',
  'event PackOpened(address indexed opener, uint256[] packIds, address[] tokens, uint256[] amounts)',
  'event TokensMinted(address indexed to, address[] tokens, uint256[] amounts)',
  'event RewardsClaimed(address indexed account, address[] tokens, uint256[] amounts)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

// Строим интерфейс из всех известных функций и событий
const iface = new Interface([...KNOWN_FUNCTIONS, ...KNOWN_EVENTS]);

// ── Основная логика ────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Декодирование транзакции: ${txHash}\n`);

  // Пробуем подключиться к RPC
  let provider: JsonRpcProvider | null = null;
  for (const url of RPC_URLS) {
    try {
      const p = new JsonRpcProvider(url, 8453, { staticNetwork: true });
      await p.getBlockNumber();
      provider = p;
      console.log(`✅ RPC подключён: ${url}`);
      break;
    } catch {
      console.log(`❌ RPC недоступен: ${url}`);
    }
  }

  if (!provider) {
    console.error('\n⛔ Не удалось подключиться ни к одному RPC.');
    console.error('Запусти вручную: cast tx <hash> --rpc-url https://mainnet.base.org');
    process.exit(1);
  }

  // Получаем транзакцию
  const tx = await provider.getTransaction(txHash!);
  if (!tx) {
    console.error(`Транзакция ${txHash} не найдена`);
    process.exit(1);
  }

  const receipt = await provider.getTransactionReceipt(txHash!);

  // ── Базовая информация ───────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('ТРАНЗАКЦИЯ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Hash:           ${tx.hash}`);
  console.log(`From:           ${tx.from}`);
  console.log(`To:             ${tx.to}`);
  console.log(`Value:          ${formatEther(tx.value)} ETH`);
  console.log(`Nonce:          ${tx.nonce}`);
  console.log(`Block:          ${tx.blockNumber}`);
  console.log(`Status:         ${receipt?.status === 1 ? '✅ Success' : '❌ Failed/Reverted'}`);
  console.log(`Gas used:       ${receipt?.gasUsed?.toString() ?? 'unknown'}`);

  // ── Декодирование calldata ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('CALLDATA');
  console.log('═══════════════════════════════════════════════════════════════');

  const calldata = tx.data;
  const selector = calldata.slice(0, 10); // первые 4 байта + 0x

  console.log(`Selector (4 bytes): ${selector}`);
  console.log(`Calldata raw:       ${calldata.slice(0, 100)}...`);

  // Пробуем декодировать через известные функции
  let decoded = false;
  for (const funcSig of KNOWN_FUNCTIONS) {
    try {
      const funcName = funcSig.split('(')[0]!.replace('function ', '');
      const fragment = iface.getFunction(funcName);
      if (!fragment) continue;

      const result = iface.decodeFunctionData(fragment, calldata);
      console.log(`\n✅ Декодировано как: ${funcSig}`);
      console.log('Параметры:');
      fragment.inputs.forEach((input, i) => {
        const val = result[i];
        const valStr = Array.isArray(val) ? `[${val.map(String).join(', ')}]` : String(val);
        console.log(`  ${input.name} (${input.type}): ${valStr}`);
      });
      decoded = true;
      break;
    } catch {
      // Не совпало — пробуем следующую
    }
  }

  if (!decoded) {
    console.log(`\n⚠️  Функция не опознана. Selector: ${selector}`);
    console.log('Добавь сигнатуру в KNOWN_FUNCTIONS или используй:');
    console.log(`  cast 4byte ${selector}`);
    console.log(`  cast 4byte-decode ${calldata.slice(0, 10)}`);
  }

  // ── Декодирование событий ────────────────────────────────────────────────
  if (receipt && receipt.logs.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`СОБЫТИЯ (${receipt.logs.length} штук)`);
    console.log('═══════════════════════════════════════════════════════════════');

    for (const log of receipt.logs) {
      console.log(`\nКонтракт: ${log.address}`);

      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) {
          console.log(`  Событие: ${parsed.name}`);
          parsed.fragment.inputs.forEach((input, i) => {
            const val = parsed.args[i];
            const valStr = Array.isArray(val) ? `[${val.map(String).join(', ')}]` : String(val);
            console.log(`  ${input.name} (${input.type}): ${valStr}`);
          });
        } else {
          console.log(`  Topics: ${log.topics.join(', ')}`);
        }
      } catch {
        // Неизвестное событие
        console.log(`  ⚠️ Неизвестное событие. Topic[0]: ${log.topics[0]}`);
        console.log(`     Data: ${log.data.slice(0, 66)}...`);
      }
    }
  }

  // ── Генерируем частичный RE_REPORT ──────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('РЕЗУЛЬТАТ ДЛЯ RE_REPORT.md');
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Подсказки по адресам ─────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ИДЕНТИФИКАЦИЯ КОНТРАКТА');
  console.log('═══════════════════════════════════════════════════════════════');

  const toAddr = tx.to?.toLowerCase();
  if (toAddr === GRAIL_ADDRESSES.PACK_SALE) {
    console.log(`✅ To = PACK_SALE (0x4491...)  — это транзакция покупки пака`);
  } else if (toAddr === GRAIL_ADDRESSES.PACK_NFT) {
    console.log(`✅ To = PACK_NFT (0xc7bd...)   — это транзакция открытия пака`);
  } else if (toAddr === GRAIL_ADDRESSES.USDC) {
    console.log(`✅ To = USDC (0x8335...)        — это USDC approve или transfer`);
  } else {
    console.log(`⚠️  Неизвестный контракт: ${tx.to}`);
    console.log(`   Ожидаемые контракты:`);
    console.log(`   PACK_SALE: ${GRAIL_ADDRESSES.PACK_SALE}`);
    console.log(`   PACK_NFT:  ${GRAIL_ADDRESSES.PACK_NFT}`);
  }

  const report = generateReport(tx, receipt, selector, calldata, decoded);
  console.log('\n');
  console.log(report);

  // Сохраняем в файл
  const outFile = 'RE_REPORT_auto.md';
  writeFileSync(outFile, report, 'utf8');
  console.log(`\n✅ Результат сохранён в ${outFile}`);
}

function generateReport(tx: Awaited<ReturnType<typeof JsonRpcProvider.prototype.getTransaction>>, receipt: Awaited<ReturnType<typeof JsonRpcProvider.prototype.getTransactionReceipt>>, selector: string, calldata: string, decoded: boolean): string {
  const paymentIsEth = tx && tx.value > 0n;
  const lines: string[] = [
    '# Phase 0 — Автоматически извлечённый отчёт',
    '',
    '> Сгенерировано: ' + new Date().toISOString(),
    '> TX hash: ' + (tx?.hash ?? 'n/a'),
    '',
    '## Транзакция',
    '',
    '```yaml',
    `tx_hash: "${tx?.hash}"`,
    `from: "${tx?.from}"`,
    `to: "${tx?.to}"`,
    `value: "${tx ? formatEther(tx.value) : '0'} ETH"`,
    `payment: "${paymentIsEth ? 'ETH (msg.value > 0)' : 'USDC или другой ERC20 (value = 0)'}"`,
    `selector: "${selector}"`,
    `status: "${receipt?.status === 1 ? 'success' : 'failed'}"`,
    `gas_used: ${receipt?.gasUsed?.toString() ?? 'unknown'}`,
    '```',
    '',
    '## Phase 0 конфиг (обновить после анализа)',
    '',
    '```bash',
    `# Контракты (уже вшиты в код как default)`,
    `export GRAIL_PACK_SALE="${tx?.to ?? '0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da'}"`,
    `export GRAIL_PACK_NFT="0xc7bd7aa20841e43838648131768735f32d15aafa"`,
    `export GRAIL_PAYMENT_TOKEN="${paymentIsEth ? 'ETH' : 'USDC'}"`,
    `export GRAIL_PACK_PRICE_RAW="15000000"  # 15 USDC`,
    `export GRAIL_BACKEND_SIG="true"          # подпись нужна`,
    `export GRAIL_CLAIM_NEEDED="false"        # клейм не нужен`,
    '',
    `# После декодирования функции (selector: ${selector}):`,
    `# export GRAIL_BUY_FUNCTION=buy`,
    `# export GRAIL_BUY_VARIANT=A    # A|B|C — зависит от порядка параметров`,
    '```',
    '',
    '## Следующие шаги',
    '',
    '1. Определить точную сигнатуру buy():',
    `   cast 4byte ${selector}`,
    '',
    '2. Декодировать параметры:',
    `   cast abi-decode "buy(uint256,bytes,uint256)" ${tx?.data.slice(0, 10)}...`,
    '',
    '3. Определить тип пак NFT (ERC721 vs ERC1155):',
    '   cast call 0xc7bd7aa20841e43838648131768735f32d15aafa \\',
    '     "supportsInterface(bytes4)(bool)" 0x80ac58cd \\',
    '     --rpc-url https://mainnet.base.org',
    '',
    '4. Задать API URL и запустить dry-run:',
    '   export GRAIL_API_STUB=true  # для сухого тестирования без реального API',
    '   npm start -- --dry-run --only-index 0',
  ];

  return lines.join('\n');
}

main().catch((err) => {
  console.error('Ошибка:', err);
  process.exit(1);
});

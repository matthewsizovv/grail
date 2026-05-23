#!/usr/bin/env tsx
/**
 * tools/check-env.ts — Проверка конфигурации перед запуском
 *
 * Выводит таблицу всех ENV переменных бота и их статус.
 * Запускать после Phase 0 чтобы убедиться что всё настроено.
 *
 * Использование: npx tsx tools/check-env.ts
 */

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

interface EnvCheck {
  name: string;
  required: boolean;
  description: string;
  validator?: (val: string) => boolean;
  example: string;
}

const CHECKS: EnvCheck[] = [
  // Безопасность
  {
    name: 'MASTER_KEY',
    required: true,
    description: 'AES-256 ключ шифрования приватных ключей (64 hex символа)',
    validator: (v) => /^[0-9a-fA-F]{64}$/.test(v),
    example: '$(openssl rand -hex 32)',
  },
  // Контракты Grail (Phase 0 — адреса уже вшиты в код, ENV переопределяют)
  {
    name: 'GRAIL_PACK_SALE',
    required: false,
    description: 'Адрес контракта продажи паков. Дефолт: 0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da',
    validator: (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
    example: '0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da',
  },
  {
    name: 'GRAIL_PACK_NFT',
    required: false,
    description: 'Адрес контракта NFT паков. Дефолт: 0xc7bd7aa20841e43838648131768735f32d15aafa',
    validator: (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
    example: '0xc7bd7aa20841e43838648131768735f32d15aafa',
  },
  {
    name: 'GRAIL_PACK_PRICE_RAW',
    required: false,
    description: 'Цена пака в raw USDC единицах (6 dec). Дефолт: 15000000 (= 15 USDC)',
    validator: (v) => /^\d+$/.test(v),
    example: '15000000',
  },
  {
    name: 'PACKS_PER_WALLET',
    required: false,
    description: 'Сколько паков покупать на один кошелёк. Дефолт: 1',
    validator: (v) => /^\d+$/.test(v) && parseInt(v) > 0,
    example: '1',
  },
  {
    name: 'GRAIL_BACKEND_SIG',
    required: false,
    description: 'true если buy() требует подпись бэкенда. Дефолт: true (Phase 0 подтверждено)',
    validator: (v) => v === 'true' || v === 'false',
    example: 'true',
  },
  {
    name: 'GRAIL_BUY_FUNCTION',
    required: false,
    description: 'Имя функции покупки: buy|purchasePacks|mint. Дефолт: buy',
    validator: (v) => ['buy', 'purchasePacks', 'mint', 'buyPacks', 'mintPacks'].includes(v),
    example: 'buy',
  },
  {
    name: 'GRAIL_BUY_VARIANT',
    required: false,
    description: 'Порядок параметров buy(): A=(qty,sig,deadline) B=(qty,deadline,sig) C=(qty,nonce,exp,sig)',
    validator: (v) => ['A', 'B', 'C'].includes(v),
    example: 'A  (PRIMARY — decode real tx to confirm)',
  },
  // Бэкенд API (нужен если GRAIL_BACKEND_SIG=true)
  {
    name: 'GRAIL_API_URL',
    required: false,
    description: 'URL бэкенда Grail для получения подписи (обязателен если GRAIL_BACKEND_SIG=true!)',
    validator: (v) => v.startsWith('http'),
    example: 'https://api.grail.xyz  (перехватить через DevTools)',
  },
  {
    name: 'GRAIL_API_KEY',
    required: false,
    description: 'Bearer token / API key для авторизации в бэкенде Grail',
    example: 'eyJhbGc...  (из DevTools Authorization header)',
  },
  {
    name: 'GRAIL_API_STUB',
    required: false,
    description: 'true = вернуть фейковую подпись (только для dry-run!)',
    validator: (v) => v === 'true' || v === 'false',
    example: 'true  (только для тестирования)',
  },
  {
    name: 'GRAIL_COLLECTION_ID',
    required: false,
    description: 'ID коллекции паков (если нужен в API запросе)',
    example: '1',
  },
  {
    name: 'GRAIL_CLAIM_NEEDED',
    required: false,
    description: 'true если нужен отдельный claim() после open(). Дефолт: false (Phase 0 подтверждено)',
    validator: (v) => v === 'true' || v === 'false',
    example: 'false',
  },
  {
    name: 'GRAIL_NFT_ERC1155',
    required: false,
    description: 'true если пак NFT — ERC1155 (false = ERC721). Проверить: cast call supportsInterface',
    validator: (v) => v === 'true' || v === 'false',
    example: 'false',
  },
  // API ключи (опционально)
  {
    name: 'ALCHEMY_KEY',
    required: false,
    description: 'Alchemy API ключ (для надёжного RPC)',
    example: 'alchemy_abc123...',
  },
  {
    name: 'TENDERLY_KEY',
    required: false,
    description: 'Tenderly API ключ (для надёжного RPC + симуляций)',
    example: 'tenderly_abc...',
  },
  {
    name: 'ONEINCH_KEY',
    required: false,
    description: '1inch API ключ (для DEX агрегатора)',
    example: 'abc123...',
  },
  {
    name: 'ZERION_API_KEY',
    required: false,
    description: 'Zerion API ключ (для DEX агрегатора)',
    example: 'abc123...',
  },
  {
    name: 'LOG_LEVEL',
    required: false,
    description: 'Уровень логирования: trace|debug|info|warn|error',
    validator: (v) => ['trace', 'debug', 'info', 'warn', 'error'].includes(v),
    example: 'info',
  },
];

function check(): void {
  console.log(`\n${BOLD}══════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Grail Bot — Проверка конфигурации${RESET}`);
  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}\n`);

  let allGood = true;
  let criticalMissing = false;
  const phase0Missing: string[] = [];

  for (const check of CHECKS) {
    const val = process.env[check.name];
    const isSet = val !== undefined && val !== '';
    const isValid = isSet && (check.validator ? check.validator(val) : true);

    let status: string;
    let detail: string;

    if (isValid) {
      status = `${GREEN}✅${RESET}`;
      // Маскируем значения — не выводим секреты
      const masked = check.name === 'MASTER_KEY'
        ? '[установлен — ' + val.length + ' символов]'
        : val!.length > 20
        ? val!.slice(0, 10) + '...' + val!.slice(-4)
        : val!;
      detail = `${GREEN}${masked}${RESET}`;
    } else if (isSet && !isValid) {
      status = `${YELLOW}⚠️ ${RESET}`;
      detail = `${YELLOW}Установлен но невалидный: ${val!.slice(0, 20)}...${RESET}`;
      allGood = false;
    } else if (check.required) {
      status = `${RED}❌${RESET}`;
      detail = `${RED}ОБЯЗАТЕЛЬНО: export ${check.name}=${check.example}${RESET}`;
      allGood = false;
      criticalMissing = true;
    } else if (check.name.startsWith('GRAIL_')) {
      status = `${YELLOW}○ ${RESET}`;
      detail = `${YELLOW}Не задан (Phase 0 не выполнен)${RESET}`;
      phase0Missing.push(check.name);
    } else {
      status = `  `;
      detail = `Не задан — будет использован дефолт`;
    }

    const nameStr = check.name.padEnd(22);
    console.log(`${status} ${BOLD}${nameStr}${RESET}  ${detail}`);
    console.log(`       ${check.description}`);
    console.log('');
  }

  // ── Итог ─────────────────────────────────────────────────────────────────
  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}`);

  if (criticalMissing) {
    console.log(`${RED}${BOLD}⛔ Критические переменные не установлены. Бот не запустится.${RESET}`);
  } else if (phase0Missing.length > 0) {
    console.log(`${YELLOW}${BOLD}⚠️  Phase 0 не выполнен. Необходимые переменные:${RESET}`);
    for (const name of phase0Missing) {
      console.log(`   export ${name}=???`);
    }
    console.log('\nЗапуск в dry-run режиме возможен:');
    console.log('  npm start -- --dry-run');
  } else {
    console.log(`${GREEN}${BOLD}✅ Все переменные настроены. Можно запускать.${RESET}`);
  }

  console.log(`${BOLD}══════════════════════════════════════════════════════${RESET}\n`);
}

check();

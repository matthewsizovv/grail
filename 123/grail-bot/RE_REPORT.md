# Phase 0 Reverse Engineering Report — Grail.xyz on Base

> **Status: PARTIALLY COMPLETE — Core addresses known, function signatures need confirmation.**
>
> Confirmed data (from DevTools + input data analysis):
>   - PACK_SALE address ✅
>   - PACK_NFT address ✅
>   - Payment token: USDC ✅
>   - Pack price: 15 USDC ✅
>   - Backend signature: required ✅
>   - Claim needed: false ✅
>
> Still TODO: exact function signatures, API endpoint, event format.

---

## Known Addresses (Phase 0 confirmed)

```bash
# Контракты Grail.xyz на Base (chainId 8453)
export GRAIL_PACK_SALE=0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da
export GRAIL_PACK_NFT=0xc7bd7aa20841e43838648131768735f32d15aafa
export GRAIL_PAYMENT_TOKEN=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913  # USDC

# Параметры покупки
export GRAIL_PACK_PRICE_RAW=15000000   # 15 USDC (6 decimals)
export GRAIL_BACKEND_SIG=true          # подпись бэкенда нужна

# Опционально (не нужен для стандартного потока)
export GRAIL_CLAIM_NEEDED=false        # клейм не нужен (токены auto-mint в open())
```

---

## Tools Used

- [x] Chrome DevTools — перехват адресов контрактов и input data
- [ ] Tenderly — детальный анализ trace транзакции
- [ ] BaseScan — проверенный ABI контракта
- [ ] Foundry `cast 4byte-decode`, `cast call`, `cast abi-decode`

---

## buy_pack

```yaml
contract: "0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da"    # ✅ подтверждено
function: "buy(???)"                                          # ⚠️ TODO: decode calldata
selector: "0x???"                                            # ⚠️ TODO: первые 4 байта calldata

payment_token: "USDC"                                        # ✅ подтверждено (GRAIL_PAYMENT_TOKEN)
payment_token_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"

price_per_pack: "fixed"                                      # ✅ предположительно фиксированная
price_value: "15000000"                                      # ✅ 15 USDC = 15_000_000 raw

requires_signature: true                                     # ✅ подтверждено (из input data)
signature_type: "backend_ecdsa"                              # ⚠️ предположительно — TODO проверить EIP-712
signature_deadline: true                                     # ⚠️ TODO: есть ли deadline параметр?

requires_approval:
  - token: "USDC"
    spender: "0x4491ac59d1e6a5d2e15a8048c2de34199e8de8da"   # ✅ approve нужен

events_emitted:
  - "PackBought(address indexed buyer, ...)"                 # ⚠️ TODO: verify exact signature

example_tx: "TODO: добавить хэш реальной buy tx"
```

### Декодирование calldata — TODO

```bash
# Шаг 1: декодировать selector
TX_HASH="<вставь реальный хэш buy транзакции>"
cast tx $TX_HASH --rpc-url https://mainnet.base.org | grep input

# Шаг 2: определить функцию
SELECTOR="<первые 10 символов input>"  # например 0xa1b2c3d4
cast 4byte $SELECTOR

# Шаг 3: декодировать параметры (попробовать варианты)
# Вариант A: buy(uint256 quantity, bytes signature, uint256 deadline)
cast abi-decode "buy(uint256,bytes,uint256)" <calldata>

# Вариант B: buy(uint256 quantity, uint256 deadline, bytes signature)
cast abi-decode "buy(uint256,uint256,bytes)" <calldata>

# Вариант C: с nonce
cast abi-decode "buy(uint256,uint256,uint256,bytes)" <calldata>
```

### Известные кандидаты сигнатуры buy()

| Вариант | Сигнатура | ENV | Статус |
|---------|-----------|-----|--------|
| A | `buy(uint256,bytes,uint256)` | `GRAIL_BUY_VARIANT=A` | PRIMARY — используется по умолчанию |
| B | `buy(uint256,uint256,bytes)` | `GRAIL_BUY_VARIANT=B` | Другой порядок |
| C | `mint(uint256,uint256,uint256,bytes)` | `GRAIL_BUY_VARIANT=C` + `GRAIL_BUY_FUNCTION=mint` | С nonce |

---

## open_pack

```yaml
contract: "0xc7bd7aa20841e43838648131768735f32d15aafa"    # ✅ подтверждено
function: "open(uint256[])"                                # ⚠️ предположительно — TODO: verify
selector: "0x???"                                          # ⚠️ TODO

nft_standard: "ERC721"                                     # ⚠️ TODO: проверить supportsInterface
open_mode: "batch"                                         # ⚠️ предположительно batch
cooldown_seconds: null                                     # ⚠️ TODO

tokens_of_owner_function: "tokensOfOwner"                  # ⚠️ предположительно — TODO verify

requires_setApprovalForAll: false                          # ⚠️ TODO: нужен ли approve для burn?

events_emitted:
  - "PackOpened(address indexed opener, ...)"              # ⚠️ TODO: verify format

example_tx: "TODO: хэш реальной open tx"
```

### Как проверить NFT стандарт

```bash
PACK_NFT="0xc7bd7aa20841e43838648131768735f32d15aafa"
RPC="https://mainnet.base.org"

# ERC721 (0x80ac58cd)?
cast call $PACK_NFT "supportsInterface(bytes4)(bool)" 0x80ac58cd --rpc-url $RPC

# ERC1155 (0xd9b67a26)?
cast call $PACK_NFT "supportsInterface(bytes4)(bool)" 0xd9b67a26 --rpc-url $RPC

# ERC721Enumerable (0x780e9d63)?
cast call $PACK_NFT "supportsInterface(bytes4)(bool)" 0x780e9d63 --rpc-url $RPC

# tokensOfOwner существует?
cast call $PACK_NFT "tokensOfOwner(address)(uint256[])" <твой_адрес> --rpc-url $RPC
```

---

## claim_rewards

```yaml
needed: false    # ✅ GRAIL_CLAIM_NEEDED=false — токены auto-mint в open()
```

---

## backend_api

```yaml
needed: true     # ✅ GRAIL_BACKEND_SIG=true
endpoint: "???"  # ⚠️ TODO: перехватить через DevTools

# Как найти:
# 1. Открой https://grail.xyz в Chrome DevTools → Network → XHR
# 2. Купи 1 пак вручную
# 3. Найди запрос с "/sign", "/authorize", "/quote", "/mint" в URL
# 4. Запиши URL, headers, request body, response body
```

### Ожидаемый формат ответа (предположительно)

```json
{
  "signature": "0x...",    // 65-байтная ECDSA подпись
  "deadline": 1234567890,  // Unix timestamp
  "nonce": "optional",     // если используется
  "price": "15000000"      // цена для проверки
}
```

---

## sell_route

```yaml
aggregator_order: "zerion → odos → 1inch → uniswap_v3"
usdc_output: true           # продаём всегда в USDC
slippage_tested: "1%"       # по умолчанию
anti_honeypot: true         # eth_call + 1% round-trip check
```

---

## antibot_checks

```yaml
tx_origin_check: "???"     # TODO: проверить bytecode на tx.origin
rate_limit_backend: "???"  # TODO: нужна ли задержка между запросами API?
merkle_whitelist: false     # маловероятно для публичной продажи
captcha_required: "???"    # TODO: есть ли hCaptcha при покупке в UI?
notes: |
  Если бэкенд ограничивает по IP — нужен прокси для каждого кошелька.
  Задать: export GRAIL_API_PROXY_URL=http://proxy:port
```

---

## open_questions

| Вопрос | Статус | Ответ |
|--------|--------|-------|
| Точная сигнатура buy() | ⚠️ TODO | Нужно декодировать реальный tx |
| Порядок параметров (qty, sig, deadline) vs (qty, deadline, sig) | ⚠️ TODO | cast 4byte-decode |
| URL бэкенд API для подписи | ⚠️ TODO | DevTools перехват |
| Формат запроса к API (body поля) | ⚠️ TODO | DevTools перехват |
| ERC721 или ERC1155? | ⚠️ TODO | cast call supportsInterface |
| tokensOfOwner или tokenOfOwnerByIndex? | ⚠️ TODO | cast call |
| Точная сигнатура open() | ⚠️ TODO | cast 4byte-decode реального open tx |
| Событие PackOpened — формат полей | ⚠️ TODO | BaseScan verified ABI или Tenderly |
| setApprovalForAll нужен для open()? | ⚠️ TODO | Tenderly trace |
| Динамическая или фиксированная цена? | ⚠️ TODO | cast call price() |
| Лимит паков на кошелёк? | ⚠️ TODO | cast call maxPerWallet() |

---

## Regression Test Transactions

После нахождения реальных tx — добавить для регрессионного тестирования:

```bash
# Покупка пака
TX_BUY="https://basescan.org/tx/0x..."
EXPECTED_CALLDATA="0x..."

# Открытие пака
TX_OPEN="https://basescan.org/tx/0x..."
EXPECTED_CALLDATA="0x..."
```

---

## Быстрый старт (после заполнения ENV)

```bash
# 1. Настроить окружение
cp .env.example .env
# Заполнить все GRAIL_* переменные

# 2. Проверить ENV
npm run check:env

# 3. Dry-run на 1 кошельке
npm run dev:dry -- --only-index 0

# 4. Если calldata совпадает с реальными tx — запускать боевой
npm start -- --only-index 0   # canary: 1 кошелёк
npm start                      # все кошельки
```

---

## Completion Criteria

Phase 0 завершена когда:
1. [ ] Все TODO поля выше заполнены
2. [ ] `npm run dev:dry -- --only-index 0` печатает calldata совпадающий с реальными tx
3. [ ] `cast 4byte-decode` подтверждает все selectors
4. [ ] Anti-bot вопросы отвечены (нет сюрпризов на mainnet)
5. [ ] Backend API реализован в `src/grail/api.ts`

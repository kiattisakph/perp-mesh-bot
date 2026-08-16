# PerpMesh Bot

Automated perpetual trading bot for **Binance USDT-M Futures** only.

v1: Bun + TypeScript strict, One-way Position Mode, Isolated Margin, testnet-first, **one strategy per account/symbol**.

## Supported strategies

Guardian, Trend, Swing, Maker, Offset Maker, Liquidity Maker.

Not in v1: Grid, Maker Points, Basis Arbitrage, Binance Spot, multi-exchange, Hedge Mode, origin-repo exchange adapters or native signers.

## Safety invariants

- Every **exit** order is `reduceOnly=true`.
- Strategy **policy** returns `OrderIntent[]`. It never calls an exchange client.
- Cancel **bot-owned** orders only (clientOrderId prefix + instance). Never `cancelAllOrders` for the symbol.
- Stop **entry** when market or account feeds are stale. Keep **risk management** running in degraded mode.
- Precision and filters come from exchange `exchangeInfo`, not `.env`, after metadata is loaded.
- Keep TLS verification on. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Never display, log, or commit secrets (API key, secret, signature, auth headers). Load credentials from the environment for signing only.
- Production live trading requires an explicit confirmation flag. Defaults are dry-run / testnet.

## Package manager

Use **Bun**. Do not add npm/pnpm/yarn lockfiles.

Do **not** add GitHub Actions workflows (`.github/workflows/`). Lint and tests are local: `bun test` and `bun run lint`.

```bash
bun install
bun test
bun run lint
```

Runtime start is not implemented yet:

```bash
bun run start --strategy guardian --symbol BTCUSDT --dry-run --testnet
```

## Coding conventions

- TypeScript strict mode. Fail-fast config validation.
- Domain types stay exchange-agnostic (no CCXT types in `domain/`).
- Execution service is the only module that places or cancels orders.
- Adapter maps Binance payloads into the canonical domain model.
- Structured logs only. Reuse existing names; do not invent requirements.

Implementation must be written from this repo's spec and [official Binance USDT-M docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info). Do not copy origin-repo source, adapters, or native binaries. Do not add a `LICENSE` file ([docs/decisions/002-no-license.md](docs/decisions/002-no-license.md)).

## What to read

| Work | Read |
|---|---|
| Scope, goals, non-goals, definition of done | [docs/product-requirements.md](docs/product-requirements.md) |
| Layers, lifecycles, ownership, directories | [docs/architecture.md](docs/architecture.md) |
| Types, units, transitions, invariants | [docs/domain-model.md](docs/domain-model.md) |
| REST/WS, precision, modes, testnet | [docs/binance-usdtm.md](docs/binance-usdtm.md) |
| Limits, stale feeds, 429, kill switch | [docs/risk-policy.md](docs/risk-policy.md) |
| Tests and production gates | [docs/testing.md](docs/testing.md) |
| Phased delivery | [docs/implementation-roadmap.md](docs/implementation-roadmap.md) |
| Guardian / Trend / Swing / Maker family | [docs/strategies/](docs/strategies/) |
| Config names and units | [.env.example](.env.example) |
| v1 venue decision | [docs/decisions/001-binance-usdtm-first.md](docs/decisions/001-binance-usdtm-first.md) |
| No license file | [docs/decisions/002-no-license.md](docs/decisions/002-no-license.md) |
| Index of authoritative files | [docs/README.md](docs/README.md) |
| Behavioral specification (Thai, do not edit) | [docs/reference/binance-usdtm-strategy-reimplementation.md](docs/reference/binance-usdtm-strategy-reimplementation.md) |

If a split doc and the reference spec disagree, treat the gap as **TBD** and ask the owner. Do not invent requirements.

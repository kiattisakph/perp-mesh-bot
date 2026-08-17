# PerpMesh Bot

PerpMesh Bot is an automated perpetual trading bot for **Binance USDⓈ-M (USDT-M) Futures**.

It reimplements a fixed set of strategies as a new codebase: strategy policy stays pure, and only the execution layer talks to Binance.

This repository is **not** ready to trade live capital until every item in the [definition of done](docs/product-requirements.md#definition-of-done) is true, including testnet soak and explicit production confirmation.

## Supported strategies

| Strategy | Role |
|---|---|
| Guardian | Protect an existing position. Does not open. |
| Trend | SMA cross + Bollinger bandwidth filter, then protect. |
| Swing | RSI arm/cross entries and exits, plus a percent stop. |
| Maker | Two-sided post-only quotes; reduce-only exit when filled. |
| Offset Maker | Maker plus depth-imbalance skip and forced imbalance exit. |
| Liquidity Maker | Maker plus fill-aware breakeven-style exit. No imbalance flatten. |

v1 does **not** include Grid, Maker Points, Basis Arbitrage, Binance Spot, multi-exchange routing, or Hedge Mode.

## Current status

Production hardening gates are in place: defaults stay testnet and dry-run; `--read-only` places no orders; production hosts require CLI `--confirm-production`. Operator procedures: [docs/runbooks/production.md](docs/runbooks/production.md).

Constraints already decided for v1:

- Bun + TypeScript strict mode
- Binance USDT-M Futures only
- One-way Position Mode
- Isolated Margin
- Testnet-first
- One strategy per account/symbol

See [docs/implementation-roadmap.md](docs/implementation-roadmap.md) for the build order.

## Architecture summary

Strategy policy emits `OrderIntent[]`. A risk service may block or reshape those intents. An execution service is the only place that places or cancels orders. A Binance adapter maps REST/WebSocket payloads into the canonical domain model. Reconciliation compares expected bot-owned orders with the exchange.

Details: [docs/architecture.md](docs/architecture.md).

## Safety warning

This software, once implemented, will be able to place real futures orders. It can lose money, including more than the isolated margin on a position.

Until implementation, testnet soak, and production gates in [docs/testing.md](docs/testing.md) are complete:

- Do not point API keys with live funds at this bot.
- Do not treat example config values as sized for your account.
- Production trading will require an explicit confirmation flag. Dry-run and testnet are the intended defaults.

Every exit order must be reduce-only. The bot may cancel only orders it owns.

## Quick start

1. Read [AGENTS.md](AGENTS.md) if you are an AI coding agent, or this README if you are a human developer.
2. Open the documentation index: [docs/README.md](docs/README.md).
3. Copy [.env.example](.env.example). Leave secrets empty. Never commit `.env`.
4. Install and verify tooling:

```bash
bun install
bun run lint
bun test
```

`bun run start` applies production gates. Defaults stay dry-run and testnet:

```bash
bun run start --strategy guardian --symbol BTCUSDT --dry-run --testnet
```

Production hosts require `BINANCE_TESTNET=false` and `--confirm-production`. Do not treat example config values as sized for a live account.

## Documentation

All split docs, the reading order, and the authoritative-source map: **[docs/README.md](docs/README.md)**.

The original behavioral specification (do not edit): [docs/reference/binance-usdtm-strategy-reimplementation.md](docs/reference/binance-usdtm-strategy-reimplementation.md).

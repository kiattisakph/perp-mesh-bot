# Product requirements

Authoritative for: problem, goals, non-goals, users, requirements, constraints, and definition of done.

Behavioral origin: [reference/binance-usdtm-strategy-reimplementation.md](reference/binance-usdtm-strategy-reimplementation.md) (do not edit).

Venue decision: [decisions/001-binance-usdtm-first.md](decisions/001-binance-usdtm-first.md).

## Problem statement

The origin bot mixes strategy logic with exchange and execution details, and it spans markets and strategies this product does not want. PerpMesh Bot is a **new** repository that keeps only six Binance USDT-M strategies, with strategy policy separated from execution.

The origin repository has **no root `LICENSE`** and no `license` field in `package.json`. This product uses the origin only as a **behavioral specification**. It must not copy origin source, exchange adapters, or native binaries. Future implementation is written from this spec and [official Binance USDT-M documentation](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info). This repository also has **no license file**. See [decisions/002-no-license.md](decisions/002-no-license.md). This is not legal advice.

## Goals

1. Trade Binance USDT-M Futures only, with REST for bootstrap/control and WebSocket for market and user data.
2. Support exactly six strategies: Guardian, Trend, Swing, Maker, Offset Maker, Liquidity Maker.
3. Keep strategy policy pure: policies emit [order intents](domain-model.md#order-intent), never call Binance.
4. Enforce [risk policy](risk-policy.md), reconnect, reconciliation, and graceful shutdown.
5. Prove behavior on dry-run and Binance testnet before any live-capital run.
6. Run **one strategy per account/symbol** in v1.

## Non-goals

- Grid
- Maker Points
- Basis arbitrage
- Binance Spot (including automatic Spot RSI/kline for Swing)
- Multi-exchange router
- Origin native signers and non-Binance venues (Lighter, Python bridge, StandX, Nado, GRVT, Aster, Backpack, Paradex, OndoPerps)
- Referral, copyright guard, encrypted banner
- Large UI in v1
- Hedge Mode or simultaneous LONG/SHORT positions
- Copying origin implementation source into this repo

## Target users

The spec does not name a commercial persona. v1 users are:

- The project owner operating **one** Binance USDT-M account and symbol per process
- Developers and AI agents implementing from these docs

**TBD:** whether a broader operator persona, hosted product, or multi-user deployment is in scope after v1.

## Functional requirements

1. Connect only to Binance USDT-M Futures. See [binance-usdtm.md](binance-usdtm.md).
2. REST: load market metadata and precision; read account and position; read open orders; place and cancel orders; cancel bot-owned orders; set Isolated margin and leverage; verify One-way mode.
3. WebSocket: order book depth, ticker, mark price, kline, account updates, order/trade updates.
4. Implement the six strategies in [strategies/](strategies/). Rollout order: Guardian → Trend → Swing → Maker → Offset Maker → Liquidity Maker.
5. Maker family ships only after a testnet soak. See [testing.md](testing.md).
6. Dry-run and testnet before live capital.
7. Risk, reconnect, reconciliation, and graceful shutdown as in [architecture.md](architecture.md) and [risk-policy.md](risk-policy.md).

## Operational requirements

- Defaults: testnet and dry-run. Production live trading needs **explicit confirmation**.
- Intended CLI (not implemented yet):

  ```bash
  bun run start --strategy guardian --symbol BTCUSDT
  bun run start --strategy trend --symbol BTCUSDT
  bun run start --strategy swing --symbol BTCUSDT
  bun run start --strategy maker --symbol BTCUSDT
  bun run start --strategy offset-maker --symbol BTCUSDT
  bun run start --strategy liquidity-maker --symbol BTCUSDT
  ```

  Safety flags specified: `--dry-run`, `--testnet`, `--read-only`, `--cancel-only`, `--flatten-on-exit`.
- Structured logs and the metrics listed below. Log schema: [domain-model.md](domain-model.md#observability).
- Testnet soak 24–72 hours before production. Gates: [testing.md](testing.md).
- Fail-fast config validation. Variable names and units: [../.env.example](../.env.example).

### Metrics to emit

WS connection state; last feed update age; REST latency; REST/WS error count; order create/cancel count; 429 count; open-order count; position quantity/notional; realized/unrealized PnL; strategy state; protective coverage; reconciliation mismatch; kill-switch count.

## Security requirements

- Never disable TLS verification. Never honor `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Never log, print, or commit API key, secret, signature, authorization headers, or full raw private responses that may contain secrets.
- `.env` must be gitignored. `.env.example` contains names only.
- API keys: Futures trading on, **withdrawal off**, IP allowlist on. Separate keys for testnet and production.
- Production REST/WS hosts are allowlisted. Custom URLs are testnet-only and must be HTTPS/WSS with hostname validation. See [binance-usdtm.md](binance-usdtm.md#endpoint-allowlist).
- Production startup requires an explicit confirmation flag. **TBD:** exact flag name.

## Product constraints

| Constraint | v1 value |
|---|---|
| Runtime | Bun + TypeScript strict mode |
| Venue | Binance USDT-M Futures |
| Position mode | One-way (`positionSide=BOTH`) |
| Margin | Isolated |
| Multi-strategy | Not on the same account/symbol. A future portfolio coordinator is out of v1. |
| Licensing | No `LICENSE` file ([002-no-license](decisions/002-no-license.md)). New implementation from spec + official Binance docs. Origin source is not copied. |
| Suggested libraries | `ccxt`, `ws`, `trading-signals`; lock versions at implementation. Choose **one** HTTP stack. Bun loads `.env`; do not add `dotenv` by default. |

Intended directory layout: [architecture.md](architecture.md#suggested-directory-structure).

## Definition of done

The product is ready for live capital only when **all** of the following are true:

- No origin source or binaries were copied
- No `LICENSE` file was added (owner decision)
- TypeScript strict, lint, and tests pass
- Binance adapter contract tests pass
- Every exit is reduce-only
- Startup and restart reconciliation pass
- Owned-order cancellation passes
- Feed-stale and WS reconnect pass
- 429 handling does not cause an order storm
- Guardian protects an existing position after restart
- Trend and Swing pass a full lifecycle test
- Maker family passes partial-fill and reprice tests
- Kill switch passes both `CANCEL_ONLY` and `CANCEL_AND_FLATTEN`
- Testnet soak 24–72 hours with no orphan orders
- API key has no withdrawal permission and has an IP allowlist
- Production startup requires explicit confirmation

Until then, the bot is **not** production-ready.

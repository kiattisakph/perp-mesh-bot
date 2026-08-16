# Implementation roadmap

Authoritative for: phase order, deliverables, dependencies, tests, completion criteria, and phase risks.

Do not start a later strategy before its dependencies are complete. Do **not** start Maker family before execution, ownership, and rate-limit handling are proven.

Licensing: implement from these docs and [official Binance USDT-M documentation](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info). Do not copy origin-repo source, adapters, or native binaries. This repo has **no `LICENSE` file** ([002-no-license](decisions/002-no-license.md)). This is not legal advice.

## Phase 1 — Repository setup

**Deliverables**

- Repository tooling: Bun, TypeScript strict, Vitest, oxlint, CI
- Secret scanning and branch protection
- `.gitignore` including `.env`
- Lockfile via Bun; inspect current versions of `ccxt`, `ws`, `trading-signals` before pinning
- No `src/` trading logic yet beyond empty scaffolding if needed for CI

**Dependencies:** none (current documentation phase is the input).

**Tests:** CI pipeline exists and a placeholder test job runs.

**Completion criteria:** clean checkout; `bun test` and lint are wired; secrets cannot be committed accidentally; no `LICENSE` file.

**Risks:** adding origin files by mistake; adding a `LICENSE` against [002-no-license](decisions/002-no-license.md).

## Phase 2 — Domain model

**Deliverables**

- Domain types from [domain-model.md](domain-model.md) as real TypeScript (no CCXT types)
- Config schema/fail-fast validation from [../.env.example](../.env.example)
- Canonical rounding helpers that consume `SymbolPrecision` (implementation, not `.env` ticks)

**Dependencies:** Phase 1.

**Tests:** unit tests for rounding, min notional, signed position helpers.

**Completion criteria:** domain package compiles under strict mode; no exchange DTOs leak into `domain/`.

**Risks:** unresolved TBDs (order-status mapping, `CANCEL.orderIds`). Do not invent; ask the owner.

## Phase 3 — Binance adapter

**Deliverables**

- Futures-only REST client, public streams, user stream, listenKey lifecycle
- Precision from `exchangeInfo`
- One-way / isolated / leverage bootstrap
- Mappers to canonical domain
- Testnet URL taken from **current** official docs, not hardcoded folklore

**Dependencies:** Phase 2. Spec: [binance-usdtm.md](binance-usdtm.md).

**Tests:** adapter [contract tests](testing.md#contract-tests); testnet create/cancel round-trip.

**Completion criteria:** account, order, depth, mark, and kline streams map correctly; testnet create/cancel round-trip passes; CCXT objects never reach strategy.

**Risks:** stale testnet hosts; clock skew; listenKey expiry; local book gaps on diff depth.

## Phase 4 — Execution / risk / reconciliation

**Deliverables**

- Order intents → execution service
- clientOrderId / ownership
- Order planner
- Reconciliation and restart behavior
- Rate-limit state machine
- Kill switch (`CANCEL_ONLY`, `CANCEL_AND_FLATTEN`)
- Shutdown cancels owned orders only

**Dependencies:** Phase 3. Spec: [architecture.md](architecture.md), [risk-policy.md](risk-policy.md).

**Tests:** ownership, reduce-only close, duplicate intents, 429 degrade/pause, kill switch, restart without duplicate, unknown cancel → query.

**Completion criteria:** restart does not duplicate; cancels are owned-only; closes are always reduce-only.

**Risks:** symbol-wide cancel; flatten vs cancel-only confusion; 503 unknown execution status causing double orders.

## Phase 5 — Guardian

**Deliverables**

- Guardian policy, stop replacement rollback, trailing, profit lock
- Reuse this protection policy later in Trend

**Dependencies:** Phase 4. Spec: [strategies/guardian.md](strategies/guardian.md).

**Tests:** unit protection tests; testnet existing-position stop; restart recovery.

**Completion criteria:** existing testnet position is protected and recovers after restart. Guardian never opens or increases a position.

**Risks:** cancelling another strategy's stops; failed replacement leaving the position naked; unresolved profit-lock stop-price TBD.

## Phase 6 — Trend

**Deliverables**

- SMA / Bollinger bandwidth
- Entry policy and cooldowns
- Protection reuse from Guardian

**Dependencies:** Phase 5. Spec: [strategies/trend.md](strategies/trend.md).

**Tests:** cross/filter unit tests; testnet single open + protect + close cycle; cooldown; restart with position does not double-enter.

**Completion criteria:** full open/protect/close cycle on testnet.

**Risks:** using ticker VWAP as mark; bandwidth false entries; UTC-minute duplicate entries.

## Phase 7 — Swing

**Deliverables**

- RSI policy on **USDT-M klines** (not automatic Spot)
- Armed-state persistence (`data/swing-state-<instance>.json`, atomic write + schema/version)
- Percent stop plus client-side breach

**Dependencies:** Phase 4 (can proceed after 4; recommended after Trend only if sharing runtime). Spec: [strategies/swing.md](strategies/swing.md).

**Tests:** arm/cross unit tests; persistence round-trip; testnet cycle; restart restores armed state; stop does not wait for RSI.

**Completion criteria:** arm/open/exit and stop cycle pass.

**Risks:** following legacy Spot `ETHBTC` notes; losing armed state on crash; profit-for-exit definition TBD.

## Phase 8 — Maker family

**Deliverables**

- Shared maker runtime
- Classic, Offset, and Liquidity policies
- Fill tracker from execution reports
- Cancel/replace budget, reprice dwell, post-only clamp

**Dependencies:** Phases 4 and soak-ready risk controls. Spec: [strategies/maker-family.md](strategies/maker-family.md).

**Tests:** desired quotes, imbalance skip/exit, liquidity exit pricing, partial fill → exit-only, reprice budget, 429 no storm.

**Completion criteria:** unit/integration tests pass. **Do not call this phase production-ready** until Phase 9 soak passes.

**Risks:** cancel/replace storms; crossing the spread; inferring fills only from open orders; Offset forced flatten vs Liquidity (must not flatten on imbalance).

## Phase 9 — Testnet soak

**Deliverables**

- 24–72 hour testnet run of each strategy intended for production, with Maker family included
- Injected WS disconnects, kill-switch drills, orphan/position audits, leak and order-rate checks

**Dependencies:** Phases 5–8 for the strategies under soak. Spec: [testing.md](testing.md#soak-test-24-72-hours).

**Tests:** soak checklist.

**Completion criteria:** soak window completed with no orphan orders, no position mismatch, no order storm.

**Risks:** testnet divergence from production; insufficient chaos during the window.

## Phase 10 — Production hardening

**Deliverables**

- Read-only startup mode
- Explicit production confirmation (flag name **TBD**)
- IP allowlist verification checklist
- Alerts on the [metrics list](product-requirements.md#metrics-to-emit)
- Backup kill switch
- Runbooks
- Confirm API key: Futures on, withdrawal off, IP allowlist, prod key ≠ testnet key

**Dependencies:** Phase 9 and [definition of done](product-requirements.md#definition-of-done).

**Tests:** production-confirmation cannot be satisfied by default env; read-only mode places no orders.

**Completion criteria:** every item in definition of done is true.

**Risks:** shipping live defaults; TLS bypass; logging secrets; running two strategies on one account/symbol.

## Suggested library set (pin at implementation)

The spec suggests:

```json
{
  "dependencies": {
    "ccxt": "latest",
    "ws": "latest",
    "trading-signals": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/ws": "latest",
    "oxlint": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

Replace `"latest"` with locked versions after checking current releases. One HTTP stack only.

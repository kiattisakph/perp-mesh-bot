# Testing

Authoritative for: test kinds, fixtures, soak, and production readiness **test** gates.

Per-strategy behavioral acceptance detail: [strategies/](strategies/). Product-wide done list: [product-requirements.md](product-requirements.md#definition-of-done).

There is no production runtime yet. Add tests in the same phase as the code they cover ([implementation-roadmap.md](implementation-roadmap.md)).

## Unit tests

### Indicators

- SMA
- Bollinger bandwidth (population standard deviation, per Trend spec)
- RSI candle replacement
- RSI new-candle update

### Risk

- USD stop
- Percentage stop
- Mark slippage
- Precision rounding
- Min notional
- Max position / notional

### Order planner

- Exact match
- Price drift
- Quantity drift
- Reduce-only mismatch
- Ownership mismatch
- Duplicate intent

### Policies

- Guardian protection
- Trend cross and filters
- Swing arm/cross
- Maker desired quotes
- Offset imbalance
- Liquidity exit pricing

## Contract tests

The Binance adapter must:

- Emit canonical account state
- Emit canonical order updates
- Emit sorted depth
- Create each supported order type
- Cancel owned orders
- Return precision
- Reconnect and reconcile
- Never expose a CCXT object to strategy

## Integration tests

Use a fake Binance server or recorded fixtures:

- User-stream disconnect
- Out-of-order WS events
- Duplicate execution report
- Partial fill
- Filled order missing from open orders
- REST/WS disagreement
- 429 rate limit
- Timestamp drift
- Unknown order on cancel
- Stop placement failure

## Recorded WebSocket fixtures

Store under `tests/fixtures/`. Fixtures must be **sanitized**: no keys, secrets, signatures, or full private payloads that contain account identifiers beyond what a test needs.

Cover at least: depth diffs, ticker, mark price, kline, `ORDER_TRADE_UPDATE` (including `TRADE` and partial fills), `ACCOUNT_UPDATE`, `listenKeyExpired`.

**TBD:** fixture format (JSONL vs captured frames) and whether recordings come from testnet only.

## Failure / chaos tests

Drive the failure table in [risk-policy.md](risk-policy.md#failure-behavior): stale depth, stale user stream, REST down, 429, unknown precision, account mismatch, stop place fail, market close fail, unknown cancel, clock skew.

Maker family: 429 must not produce an order storm; reprice must respect dwell and tick tolerance.

## Testnet acceptance

Shared:

- Startup checks one-way / isolated / leverage
- Quotes and orders pass precision
- Shutdown cancels only owned orders
- Kill switch can flatten
- Restart does not duplicate position or orders

Per strategy (detail in strategy docs; this is the testnet bar):

| Strategy | Testnet acceptance |
|---|---|
| Guardian | Existing position gets a stop; profit lock moves the stop |
| Trend | Controlled signal opens **one** position; protective orders exist; cooldown works |
| Swing | RSI arm/open/exit completes a cycle; restart restores state |
| Maker family | Post-only quotes do not cross; partial fill becomes exit-only; reprice stays in budget; rate limit does not storm |

## Soak test (24-72 hours)

Required before production, especially before Maker family is considered done:

- Testnet for at least 24–72 hours
- Multiple WS disconnects
- No orphan orders
- No position mismatch
- No memory/timer leaks
- Order rate per minute stays bounded (**TBD:** numeric budget)
- Kill switch exercised in both modes

## Per-strategy acceptance criteria

Authoritative lists:

- [Guardian](strategies/guardian.md#acceptance-tests)
- [Trend](strategies/trend.md#acceptance-tests)
- [Swing](strategies/swing.md#acceptance-tests)
- [Maker family](strategies/maker-family.md#acceptance-tests)

Do not mark a strategy phase complete until both the unit/policy criteria and the testnet row above pass.

## Production readiness gates

Testing subset of definition of done:

1. TypeScript strict, lint, unit, contract, and integration tests pass
2. Adapter contract tests pass
3. Every exit in tests is reduce-only
4. Startup/restart reconciliation tests pass
5. Owned-order cancel tests pass
6. Feed-stale and WS reconnect tests pass
7. 429 tests show no order storm
8. Guardian restart protection test passes
9. Trend and Swing full lifecycle tests pass
10. Maker family partial-fill and reprice tests pass
11. Kill switch tests pass for `CANCEL_ONLY` and `CANCEL_AND_FLATTEN`
12. Testnet soak 24–72 hours with no orphan orders

Live-capital gates that are **not** purely tests (key permissions, explicit production confirmation) remain in [product-requirements.md](product-requirements.md#definition-of-done).

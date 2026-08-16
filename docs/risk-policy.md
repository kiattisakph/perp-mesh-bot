# Risk policy

Authoritative for: shared trading limits, stops, slippage, freshness, 429, duplicates, partial fills, protective coverage, kill switch, failure behavior, and safety invariants.

Strategy-specific entry/exit rules live under [strategies/](strategies/). Config names and units: [../.env.example](../.env.example).

## Position / notional limits

Mandatory controls:

| Control | Config | Unit |
|---|---|---|
| Trade size | `TRADE_QUANTITY` | Base-asset quantity |
| Max position | `MAX_POSITION_QUANTITY` | Base-asset quantity |
| Max notional | `MAX_NOTIONAL_USDT` | USDT |
| Session loss | `SESSION_LOSS_LIMIT_USDT` | USDT |

Reject entry intents that would make `abs(position.quantity)` exceed `MAX_POSITION_QUANTITY` or notional exceed `MAX_NOTIONAL_USDT`.

The spec also lists a **daily/session** loss limit and a **per-trade** loss limit. Config currently has `SESSION_LOSS_LIMIT_USDT` plus `LOSS_LIMIT_USDT` (USDT stop used by Guardian/Trend/Maker). **TBD:** whether daily loss is a separate clock from session, and whether `LOSS_LIMIT_USDT` is the per-trade limit for every strategy.

Example placeholders in `.env.example` are not sized for a live account.

## USD stop

Used by Guardian, Trend protection, and Maker-family loss control.

```text
longStop  = entryPrice - lossUsd / quantity
shortStop = entryPrice + lossUsd / abs(quantity)
```

- `entryPrice`: USDT
- `lossUsd`: USDT (`LOSS_LIMIT_USDT`)
- `quantity`: base-asset position quantity

Stops may only move in the **risk-reducing** direction.

Maker-family also computes exit PnL from the book: long vs best bid, short vs best ask. If that PnL is below `-lossLimitUsd`, cancel owned limits then reduce-only market close (after mark slippage check).

## Percentage stop

Used by Swing:

```text
longStop  = entry × (1 - stopLossFraction)
shortStop = entry × (1 + stopLossFraction)
```

`SWING_STOP_LOSS_FRACTION` is a fraction (`0.05` = 5%). Apply both:

- Exchange `STOP_MARKET`
- Client-side kill when price breaches the stop (do not wait for RSI)

## Mark-price slippage

```text
distance = abs(candidatePrice - markPrice) / markPrice
allowed  = distance <= maxSlippageFraction
```

`MAX_CLOSE_SLIPPAGE_FRACTION` is a fraction (`0.005` = 0.5%). Mark price comes from the mark-price stream. Block market closes that fail this guard.

## Feed freshness

`FEED_STALE_MS` is milliseconds (example `10000` = 10 seconds).

| Failure | Required behavior |
|---|---|
| Public depth stale | Stop entry and quote updates |
| User stream stale | Stop entry, REST reconcile, keep protection |
| Account/order/market feeds stale (Trend entry) | No new entry |

**TBD:** whether ticker, mark, kline, and depth each use `FEED_STALE_MS` or have per-feed timeouts. Spec gives one env var.

While stale: **do not open**. Risk management continues.

## Rate-limit states

```text
NORMAL
  └─ first 429 → DEGRADED
DEGRADED
  ├─ clean window → NORMAL
  └─ repeated 429 → PAUSED
PAUSED
  └─ cooldown + healthy probe → DEGRADED/NORMAL
```

| State | Entry | Quotes / cancel-replace | Protection |
|---|---|---|---|
| `DEGRADED` | Forbidden | Increase poll interval | Priority over quote updates |
| `PAUSED` | Forbidden | Reduce cancel/replace | Still required |

Do not disable risk management because of 429.

**TBD:** length of a "clean window", how many 429s count as "repeated", PAUSED cooldown, and probe definition. No env vars are specified.

## Duplicate-order protection

Mandatory. Do not place a second order that duplicates an in-flight or live bot-owned order for the same purpose.

Maker: no duplicate quotes. Trend: no leftover instance entry orders. Reconciliation matches side, reduce-only, price, quantity, owner, purpose — not price alone.

**TBD:** exact duplicate key (intent hash vs purpose+side) and whether a live `NEW` order blocks a replace until cancel ack.

## Partial-fill handling

- `PARTIALLY_FILLED` is not `FILLED`. Remaining = `quantity - filledQuantity`.
- Exit quantity ≤ absolute position (and filled size where that is smaller).
- Maker: a fill on one side flips the runtime to exit-only; do not add entry quotes.
- Liquidity Maker: detect fills from `ORDER_TRADE_UPDATE` `TRADE` even if the order has already left the open-order array.

## Protective coverage

A non-flat position is **covered** when bot-owned reduce-only protection exists for that instance:

- Guardian / Trend: `STOP_MARKET` (and trailing when enabled), size not exceeding the position
- Swing: percent `STOP_MARKET` plus client-side breach close
- Maker family: reduce-only exit quote and/or market close on loss; Offset Maker also imbalance flatten

If stop **creation** fails: bounded retry and critical alert; keep trying. If market close fails: keep the protective stop and retry per policy.

**TBD:** retry bound, backoff, and whether "covered" requires the stop quantity to equal `abs(position)` after rounding.

Guardian stop replacement must restore the previous stop if the replacement place fails.

## Kill switch

Order of operations:

1. Block entry intents
2. Cancel bot-owned **entry** orders
3. Fetch latest account/position
4. If flatten is enabled, send reduce-only market close
5. Confirm via account stream and REST
6. Keep protective orders until flat is confirmed
7. Exit the process after reconcile

Modes (`KILL_SWITCH_MODE`):

```text
CANCEL_ONLY
CANCEL_AND_FLATTEN
```

CLI relatives: `--cancel-only`, `--flatten-on-exit`. **TBD:** how CLI flags interact with `KILL_SWITCH_MODE` when both are set.

## Cancel-only and cancel-and-flatten

| Mode | Entry | Bot-owned entry orders | Position |
|---|---|---|---|
| `CANCEL_ONLY` | Blocked | Canceled | Left in place; keep protection until operator action or later flatten |
| `CANCEL_AND_FLATTEN` | Blocked | Canceled | Reduce-only market close, slippage-checked, then confirm flat |

Neither mode may cancel orders the bot does not own.

## Failure behavior

| Failure | Required behavior |
|---|---|
| Public depth stale | Stop entry and quote updates |
| User stream stale | Stop entry, REST reconcile, keep protection |
| REST unavailable | Stop entry; do not assume cancel succeeded |
| 429 | Degrade/pause entry; protection has priority |
| Precision unknown | Do not send orders |
| Account mismatch | Pause and reconcile |
| Stop creation fails | Bounded retry and critical alert |
| Market close fails | Keep protective stop and retry per policy |
| Unknown cancel result | Query open orders before deciding status |
| Clock skew | Sync server time and pause signed requests |

## Safety invariants

1. Every exit order is reduce-only.
2. Strategy policy does not call the exchange client.
3. Cancels target bot-owned orders only.
4. Stale market or account feeds block entry; they do not disable risk management.
5. Rate-limit `DEGRADED` / `PAUSED` still run protection.
6. TLS verification stays enabled.
7. Secrets are never logged or committed.
8. Precision comes from exchange metadata.
9. Production live trading needs explicit confirmation.
10. Close quantity never exceeds absolute position.
11. Zero quantity is never sent.
12. Min notional is checked before send.

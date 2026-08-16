# Guardian

Authoritative for: Guardian behavior. Shared USD stop formula also appears in [../risk-policy.md](../risk-policy.md#usd-stop); this file owns trailing, profit lock, and Guardian constraints.

Config names: [../../.env.example](../../.env.example). Runtime shell: [../architecture.md](../architecture.md#runtime-lifecycle).

Trend reuses this protection policy. See [trend.md](trend.md).

## Purpose

Guardian does **not** open a position and does not emit a directional signal. It protects an existing position with:

- Stop loss
- Trailing stop
- Step profit lock
- Cleanup of Guardian-owned protective orders when flat

## Inputs

Required:

- Account / position
- Open orders
- Ticker
- Mark price
- Precision

Not required: depth, klines, RSI.

## Configuration

| Variable | Unit | Role |
|---|---|---|
| `LOSS_LIMIT_USDT` | USDT | Absolute USD stop distance |
| `TRAILING_ACTIVATION_PROFIT_USDT` | USDT | Profit that arms trailing |
| `TRAILING_CALLBACK_RATE` | Binance percent points (`1` = 1%, range 0.1–5) | Trailing callback |
| `PROFIT_LOCK_TRIGGER_USDT` | USDT | Profit that starts lock steps |
| `PROFIT_LOCK_STEP_USDT` | USDT | Step width |
| Shared risk vars | see `.env.example` | Position/notional/session/slippage/kill switch |

**TBD:** whether trailing is always on or gated by a boolean. Spec says Guardian uses trailing; there is no `TRAILING_ENABLED` flag.

## Indicators and formulas

USD stop ([risk-policy.md](../risk-policy.md#usd-stop)):

```text
longStop  = entryPrice - lossUsd / quantity
shortStop = entryPrice + lossUsd / abs(quantity)
```

Trailing activation:

```text
longActivation  = entryPrice + trailingProfitUsd / quantity
shortActivation = entryPrice - trailingProfitUsd / abs(quantity)
```

`entryPrice` and activation are USDT. `quantity` is base-asset position. `trailingProfitUsd` is `TRAILING_ACTIVATION_PROFIT_USDT`.

Profit-lock steps:

```text
steps = 1 + floor((profit - triggerUsd) / offsetUsd)
```

`profit`, `triggerUsd` (`PROFIT_LOCK_TRIGGER_USDT`), and `offsetUsd` (`PROFIT_LOCK_STEP_USDT`) are USDT.

Stops move only in the **risk-reducing** direction.

**TBD:** mapping from `steps` to the new stop price (the spec defines `steps` but not `newStop = f(steps)`). **TBD:** `profit` definition (unrealized PnL in USDT vs mark vs last).

## State machine

```text
IDLE
  └─ position detected → PENDING_PROTECTION
PENDING_PROTECTION
  └─ stop confirmed → PROTECTING
PROTECTING
  ├─ profit increases → MOVE_STOP
  └─ position flat → CLEANUP
CLEANUP
  └─ protective orders removed → IDLE
```

`MOVE_STOP` returns to `PROTECTING` after a successful replace (and rolls back if the new stop fails).

## Entry behavior

None. Guardian must not market-open, must not emit non-reduce orders, and must not increase position.

## Exit behavior

Guardian should **not** market-close from a signal. Flatten is a kill-switch / operator concern, not a Guardian signal.

When flat: cancel only **Guardian-owned** protective orders.

## Protective behavior

On position:

1. Ensure a reduce-only `STOP_MARKET` (`workingType=MARK_PRICE`) sized ≤ `abs(quantity)`
2. Place trailing stop when trailing is in use (`PLACE_TRAILING_STOP`, reduce-only)
3. Move stop according to profit lock; never widen risk
4. If a replacement place fails, restore the previous stop

## Order intents

Allowed:

- `PLACE_STOP` (`reduceOnly: true`)
- `PLACE_TRAILING_STOP` (`reduceOnly: true`)
- `CANCEL` / `CANCEL_OWNED` for Guardian-owned protective orders only

Forbidden: `PLACE_LIMIT` or `PLACE_MARKET` with `reduceOnly: false`. Guardian should not emit signal-driven `PLACE_MARKET` closes.

## Recovery behavior

Restart with a position: enter protection immediately (`PENDING_PROTECTION`). Do not wait for a signal. Do not cancel other strategies' stops (v1 also forbids sharing the account/symbol).

## Failure behavior

Follow [../risk-policy.md](../risk-policy.md#failure-behavior). Specifically:

- Stop creation fails → bounded retry + critical alert
- Replacement fails → restore previous stop
- Stale feeds → do not open (already true); keep trying to maintain protection via REST if the user stream is down

## Risk controls

Shared: [../risk-policy.md](../risk-policy.md). Guardian-specific: no non-reduce orders; owned-order cleanup only; stop rollback.

## Acceptance tests

- A position with no stop receives a stop after `READY`
- A profitable position receives profit-lock stop moves
- Guardian never increases position
- When flat, no orphan Guardian orders remain
- Restart while in position resumes protection

## Non-goals

- Opening or flipping positions
- Grid, Maker Points, Basis
- Cancelling another strategy's or a human's orders
- Market-close from Guardian signal

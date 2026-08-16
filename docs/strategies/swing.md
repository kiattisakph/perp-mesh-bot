# Swing

Authoritative for: Swing RSI arm/cross, percent stop, persistence, and Swing non-goals.

Shared risk: [../risk-policy.md](../risk-policy.md). Config: [../../.env.example](../../.env.example). Venue: [../decisions/001-binance-usdtm-first.md](../decisions/001-binance-usdtm-first.md).

Legacy notes in [../swingtrading/](../swingtrading/) describe Spot `ETHBTC`. **v1 does not follow that automatically.**

## Purpose

Use RSI exhaustion and a cross back through a threshold to open and close positions, with a percent stop that always works.

## Inputs

- Account / position / open orders
- Depth (subscribed; **TBD:** required for entry vs freshness only)
- Ticker / mark price
- USDT-M klines for `SWING_SIGNAL_SYMBOL` at `SWING_SIGNAL_INTERVAL`
- Precision
- Persisted armed state

Default signal source:

```text
REST: /fapi/v1/klines
WS:   <symbol>@kline_<interval>
```

`SWING_SIGNAL_MARKET=usdm`. A future `spot|usdm` switch needs explicit config and a new decision. Do not auto-use Spot.

## Configuration

| Variable | Unit | Role |
|---|---|---|
| `SWING_DIRECTION` | `long` \| `short` \| `both` | Allowed trade direction |
| `SWING_RSI_PERIOD` | Closed-candle count | RSI length |
| `SWING_RSI_HIGH` | RSI 0–100 | High threshold; must be > low |
| `SWING_RSI_LOW` | RSI 0–100 | Low threshold |
| `SWING_SIGNAL_SYMBOL` | USDT-M symbol | Kline symbol |
| `SWING_SIGNAL_INTERVAL` | Binance interval string | e.g. `4h` |
| `SWING_SIGNAL_MARKET` | `usdm` in v1 | Signal venue |
| `SWING_STOP_LOSS_FRACTION` | Fraction (`0.05` = 5%) | Stop distance |
| `SWING_REQUIRE_PROFIT_FOR_EXIT` | `true` \| `false` | Signal exit waits for profit |
| `TRADE_QUANTITY` | Base-asset quantity | Entry size |

## Indicators and formulas

RSI over `SWING_RSI_PERIOD` closed candles. Spec depends on `trading-signals` for indicator implementation (including replace vs add on the live candle). Do not invent a second RSI formula.

Percent stop ([../risk-policy.md](../risk-policy.md#percentage-stop)):

```text
longStop  = entry × (1 - stopLossFraction)
shortStop = entry × (1 + stopLossFraction)
```

## State machine

```ts
interface SwingState {
  previousRsi: number | null;
  armedShortEntry: boolean;
  armedShortExit: boolean;
  armedLongEntry: boolean;
  armedLongExit: boolean;
}
```

```text
FLAT
  ├─ RSI crosses up through rsiHigh → armedShortEntry
  │    └─ RSI crosses down through rsiHigh → OPEN_SHORT (if direction allows)
  └─ RSI crosses down through rsiLow → armedLongEntry
       └─ RSI crosses up through rsiLow → OPEN_LONG (if direction allows)
SHORT
  ├─ RSI crosses down through rsiLow → armedShortExit
  │    └─ RSI crosses up through rsiLow → CLOSE if profit rule passes
  └─ stop breach → CLOSE (reduce-only), do not wait for RSI
LONG
  ├─ RSI crosses up through rsiHigh → armedLongExit
  │    └─ RSI crosses down through rsiHigh → CLOSE if profit rule passes
  └─ stop breach → CLOSE (reduce-only)
```

Do not pyramid.

## Entry behavior

Short:

1. RSI crosses **up** through `rsiHigh` → arm short
2. RSI crosses **back down** through `rsiHigh` → open short

Long:

1. RSI crosses **down** through `rsiLow` → arm long
2. RSI crosses **back up** through `rsiLow` → open long

Respect `SWING_DIRECTION`. Size = `TRADE_QUANTITY` with precision rules. Feeds must be fresh; rate-limit must allow entry.

**TBD:** LIMIT vs MARKET for Swing entry (not specified).

## Exit behavior

Short position:

1. RSI crosses down through `rsiLow` → arm exit
2. RSI crosses back up through `rsiLow`
3. Close when the profit condition passes (if `SWING_REQUIRE_PROFIT_FOR_EXIT=true`)

Long position: symmetric with `rsiHigh`.

Stop loss **always** runs even when signal exit is waiting on profit.

Signal close and stop close are reduce-only.

**TBD:** profit condition (unrealized PnL > 0 USDT? after fees? vs mark?). Spec only says "profit condition".

## Protective behavior

- Exchange `STOP_MARKET` reduce-only at the percent stop
- Client-side close when price breaches the stop (reduce-only market), without waiting for RSI
- Mark-price slippage applies to market closes

## Order intents

- Entry open (`reduceOnly: false`) — type TBD
- Reduce-only close (`PLACE_MARKET` or reduce limit) on signal exit
- `PLACE_STOP` (`reduceOnly: true`)
- Reduce-only `PLACE_MARKET` on stop breach
- `CANCEL` of Swing-owned orders when replaced or flat

## Recovery behavior

Persist armed state:

```text
data/swing-state-<instance>.json
```

Atomic write; validate schema and version. Restart mid-setup must not drop arms.

## Failure behavior

[../risk-policy.md](../risk-policy.md#failure-behavior). Corrupt or missing state file: **TBD** (fail-fast vs start unarmed). Spec requires validation, not the fallback.

## Risk controls

Direction filter, no pyramid, percent stop + client kill, shared caps, `rsiLow < rsiHigh` at config validation.

## Acceptance tests

- RSI 69→71 arms short; 71→69 opens short
- RSI 31→29 arms long; 29→31 opens long
- Direction filter works
- No pyramiding
- Signal exit respects profit config
- Stop breach closes without waiting for RSI
- Restart restores armed state

## Non-goals

- Automatic Spot klines / `ETHBTC` reference market
- Grid, Maker Points, Basis
- Hedge Mode
- Pyramiding

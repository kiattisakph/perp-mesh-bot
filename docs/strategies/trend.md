# Trend

Authoritative for: Trend entry, indicators, cooldowns, and Trend-specific recovery.

Protection (USD stop, trailing, profit lock) reuses [guardian.md](guardian.md). Shared risk: [../risk-policy.md](../risk-policy.md). Config: [../../.env.example](../../.env.example).

## Purpose

Open a position when price crosses SMA and Bollinger bandwidth is wide enough, then protect with stop, trailing, and profit lock.

## Inputs

- Account / position / open orders
- Depth (subscribed; **TBD:** whether entry uses depth besides freshness)
- Ticker
- Mark price
- Klines at `TREND_KLINE_INTERVAL`
- Precision

## Configuration

| Variable | Unit | Role |
|---|---|---|
| `TRADE_QUANTITY` | Base-asset quantity | Entry size |
| `TREND_SMA_PERIOD` | Closed-candle count | SMA lookback (do not hardcode 30) |
| `TREND_KLINE_INTERVAL` | Binance interval string | e.g. `1m` |
| `TREND_BOLLINGER_LENGTH` | Closed-candle count | Bandwidth lookback |
| `TREND_BOLLINGER_MULTIPLIER` | Dimensionless | Std multiplier |
| `TREND_MIN_BANDWIDTH` | Dimensionless | Minimum bandwidth |
| `TREND_ENTRY_COOLDOWN_MS` | Milliseconds | After stop loss |
| Protection vars | USDT / callbackRate | Same as Guardian |
| Shared risk vars | see `.env.example` | Caps, slippage, kill switch |

## Indicators and formulas

SMA:

```text
SMA(n) = sum(last n closes) / n
```

`n = TREND_SMA_PERIOD`. Use **closed** candles.

Bollinger bandwidth:

```text
mean = average(closes)
std  = populationStandardDeviation(closes)
bandwidth = (2 × std × multiplier) / mean
```

Lookback length = `TREND_BOLLINGER_LENGTH`. `multiplier` = `TREND_BOLLINGER_MULTIPLIER`.

USD stop / trailing / profit lock: [guardian.md](guardian.md#indicators-and-formulas).

## State machine

Trend uses the shared runtime lifecycle ([../architecture.md](../architecture.md#startup-lifecycle)). Signal-level:

```text
FLAT
  ├─ long cross + filters → OPENING_LONG → IN_POSITION (protect)
  └─ short cross + filters → OPENING_SHORT → IN_POSITION (protect)
IN_POSITION
  ├─ stop / trailing / profit lock / soft loss → FLAT
  └─ restart → PROTECTING first, no entry until reconciled
```

The spec does **not** define a reverse-SMA-cross exit. Do not add one unless the owner decides. **TBD:** whether opposite cross should flatten.

## Entry behavior

When flat:

```text
previousPrice < SMA && currentPrice > SMA → OPEN_LONG
previousPrice > SMA && currentPrice < SMA → OPEN_SHORT
```

All of the following must hold:

- At least `max(smaPeriod, bollingerLength)` klines ready
- `bandwidth >= TREND_MIN_BANDWIDTH`
- No entry in the same **UTC minute**
- Cooldown after stop loss has elapsed (`TREND_ENTRY_COOLDOWN_MS`)
- Account, order, and market feeds are fresh
- No leftover entry orders for this instance
- Rate-limit state allows entry

Entry is a market or otherwise opening order of `TRADE_QUANTITY`, rounded down to step, never zero, min-notional checked. **TBD:** spec table says Trend "opens"; it does not say LIMIT vs MARKET for entry. Do not assume without a decision.

Do not pyramid.

## Exit behavior

- Exchange `STOP_MARKET` (reduce-only)
- Trailing stop when enabled
- Move stop via profit lock
- Soft loss check as backup of the exchange stop; if exceeded, **reduce-only** market close
- Soft loss uses `LOSS_LIMIT_USDT` (USDT)

No signal-based market close is specified beyond protection and soft loss.

## Protective behavior

Same as Guardian after a position exists. Market close must be reduce-only.

## Order intents

- Entry: `PLACE_MARKET` or `PLACE_LIMIT` with `reduceOnly: false` (**TBD:** which)
- `PLACE_STOP` / `PLACE_TRAILING_STOP` with `reduceOnly: true`
- Reduce-only `PLACE_MARKET` for soft-loss close
- `CANCEL` of Trend-owned orders

## Recovery behavior

On restart:

- If a position exists, enter protection immediately
- Do not process entry signals until reconciliation is done
- Persist `lastEntryAt` and `lastStopAt` if cooldown must survive restart (spec: should)
- `previousPrice` may be seeded from the latest **closed** candle

**TBD:** persistence path/schema for Trend (only Swing's file path is specified).

## Failure behavior

[../risk-policy.md](../risk-policy.md#failure-behavior). Stale feeds or 429: no entry; keep protection.

## Risk controls

Shared caps plus Guardian protection plus UTC-minute uniqueness plus post-stop cooldown.

## Acceptance tests

- Cross up opens long when bandwidth passes
- Cross down opens short when bandwidth passes
- Low bandwidth does not open
- No second entry in the same UTC minute
- Position receives stop and trailing
- Soft loss beyond limit causes reduce-only close
- Restart with a position does not open a second position

## Non-goals

- Grid / Maker Points / Basis
- Hedge Mode / pyramiding
- Using ticker weighted average as mark price
- Reverse-cross exit unless explicitly added later

# Maker family

Authoritative for: shared Maker runtime and the three quoting policies — Classic Maker, Offset Maker, Liquidity Maker.

Shared risk: [../risk-policy.md](../risk-policy.md). Config: [../../.env.example](../../.env.example). Ownership and planner: [../architecture.md](../architecture.md).

Do not enable Maker family in production before the [testnet soak](../testing.md#soak-test-24-72-hours). Order churn and rate-limit risk are higher than directional strategies.

```text
MakerRuntime
  ├── ClassicMakerPolicy
  ├── OffsetMakerPolicy
  └── LiquidityMakerPolicy
```

## Shared purpose

When flat, quote post-only bid and ask. When in position, stop entry quotes and work a **reduce-only** exit. Policies differ in imbalance handling and exit pricing.

## Shared inputs

- Account / position
- Open orders
- Depth
- Ticker
- Mark price
- Precision
- Execution reports (`ORDER_TRADE_UPDATE`)

## Shared configuration

| Variable | Unit | Role |
|---|---|---|
| `TRADE_QUANTITY` | Base-asset quantity | Quote size |
| `LOSS_LIMIT_USDT` | USDT | Loss kill-switch |
| `MAKER_REFRESH_MS` | Milliseconds | Quote loop |
| `MAKER_ENTRY_DEPTH_LEVEL` | 1-based book level | Entry price level |
| `MAKER_BID_OFFSET` | Quote-asset price (USDT) | `bid[level] - offset` |
| `MAKER_ASK_OFFSET` | Quote-asset price (USDT) | `ask[level] + offset` |
| `MAKER_REPRICE_TICKS` | Tick count | Min price delta to replace |
| `MAKER_MIN_DWELL_MS` | Milliseconds | Min age before replace |
| `MAKER_DEPTH_LEVELS` | Level count | Imbalance window |
| `OFFSET_SKIP_RATIO` | Dimensionless | Offset skip |
| `OFFSET_FORCED_EXIT_RATIO` | Dimensionless | Offset flatten |
| `LIQUIDITY_SKIP_RATIO` | Dimensionless | Liquidity skip |
| `LIQUIDITY_CLOSE_TICK_OFFSET` | Tick count | Liquidity exit offset |
| `LIQUIDITY_RECENT_FILL_MS` | Milliseconds | Fill-price freshness |

Offset vs Liquidity extra vars apply only to that policy.

## Shared indicators / formulas

Depth sums over top N (`MAKER_DEPTH_LEVELS`) quantities:

```text
bidDepth = sum(top N bid quantities)
askDepth = sum(top N ask quantities)
```

Quantities are base asset.

Maker clamp (Offset; Liquidity also applies after exit pricing):

```text
BUY price  <= bestAsk - tick
SELL price >= bestBid + tick
```

`tick` is `PRICE_FILTER.tickSize` (USDT).

Loss PnL from executable book: long vs best bid, short vs best ask. If PnL `< -LOSS_LIMIT_USDT`, cancel owned limits, check mark slippage, reduce-only market close.

Reprice dwell: do not cancel/replace if the new price differs by fewer than `MAKER_REPRICE_TICKS` ticks **or** the order is younger than `MAKER_MIN_DWELL_MS`.

## Shared state machine

```text
STARTING
  → RECONCILING
  → FLAT_QUOTING
  → POSITION_EXIT_ONLY
  → FLAT_QUOTING
```

Any state may go to `DEGRADED`, `PAUSED`, or `KILL_SWITCH`.

## Shared entry / exit / protective behavior

- Flat: post-only bid and ask (`LIMIT` + `GTX`, `reduceOnly=false`)
- In position: no new entry quotes; one reduce-only exit; exit quantity ≤ `abs(position)`
- Loss kill-switch as above (reduce-only market)
- Stale depth: stop entry and quote updates
- 429: [../risk-policy.md](../risk-policy.md#rate-limit-states); protection outranks quote updates

## Shared desired quotes and intents

Policy returns desired quotes; the planner diffs them:

```ts
interface DesiredQuote {
  purpose: "ENTRY_BID" | "ENTRY_ASK" | "EXIT";
  side: OrderSide;
  price: number;
  quantity: number;
  reduceOnly: boolean;
  postOnly: boolean;
}
```

Match on purpose, side, price, quantity, reduceOnly, ownership. Quantity drift beyond tolerance → replace. **TBD:** numeric quantity tolerance.

Intents: `PLACE_LIMIT` (post-only entries; reduce-only exit limits), reduce-only `PLACE_MARKET` on kill/imbalance flatten, `CANCEL` of owned quotes. Never `reduceOnly=false` on Offset/Liquidity **exits**.

## Shared recovery / failure / risk

Restart: reconcile owned quotes vs desired; do not duplicate; if in position, `POSITION_EXIT_ONLY`.

Failure table: [../risk-policy.md](../risk-policy.md#failure-behavior). REST down: do not assume cancel succeeded.

Shared risk: max position, max notional, USD stop, mark slippage, post-only, stale depth, rate-limit, reprice dwell, cancel/replace budget.

**TBD:** numeric cancel/replace budget (orders per minute). Spec requires a budget and soak checks order rate; no number is given.

## How the three policies differ

| Feature | Classic Maker | Offset Maker | Liquidity Maker |
|---|---|---|---|
| Two-sided post-only when flat | Yes | Yes, with skip | Yes, with skip |
| Depth side skip | No | Yes (`OFFSET_SKIP_RATIO`) | Yes (`LIQUIDITY_SKIP_RATIO`) |
| Forced imbalance market exit | No | Yes (`OFFSET_FORCED_EXIT_RATIO`) | **No** |
| Exit at L1 | Typical reduce-only exit | Yes | Not required |
| Fill-aware exit | No | No | Yes |
| Breakeven clamp | No | No | Yes |

## Acceptance tests

Unit and testnet criteria for each policy are under Classic Maker, Offset Maker, and Liquidity Maker below. Shared soak and testnet bars: [../testing.md](../testing.md).

---

# Classic Maker

## Purpose

When flat, quote post-only bid and ask. When filled, stop opening and place a single reduce-only exit.

## Inputs

Shared inputs. Classic does not use imbalance ratios.

## Configuration

Shared maker vars plus `LOSS_LIMIT_USDT`. Ignore Offset/Liquidity-only vars.

## Indicators and formulas

Flat quotes:

```text
BUY  @ bid[level] - bidOffset
SELL @ ask[level] + askOffset
```

`level` = `MAKER_ENTRY_DEPTH_LEVEL`. Offsets are USDT prices. Both orders: `LIMIT` + `GTX` + `reduceOnly=false`.

## State machine

Shared maker lifecycle.

## Entry behavior

Only in `FLAT_QUOTING`. Both sides. Post-only. Do not add size while a position exists.

## Exit behavior

- Long → `SELL` reduce-only exit
- Short → `BUY` reduce-only exit
- Exit quantity ≤ absolute position
- Exit must be reduce-only

**TBD:** Classic exit price (spec does not give a formula; Offset uses L1; do not copy Liquidity breakeven here).

## Protective behavior

If book PnL `< -LOSS_LIMIT_USDT`: cancel bot-owned limits, slippage check, reduce-only market close.

## Order intents

Shared. Classic: `ENTRY_BID`, `ENTRY_ASK`, `EXIT`.

## Recovery / failure / risk

Shared.

## Acceptance tests

- Flat has post-only bid/ask
- Fill on one side leaves only a reduce-only exit
- Does not increase position while in position
- Stop loss cancels quotes before close
- No duplicate quotes

## Non-goals

- Imbalance skip/flatten
- Fill-aware breakeven exit
- Grid / Maker Points / Basis
- `cancelAllOrders` for the symbol

---

# Offset Maker

## Purpose

Classic Maker plus order-book imbalance:

- Do not quote the thin side
- Reduce adverse selection
- Flatten when imbalance is strongly against the position

## Inputs

Shared, including top-N depth.

## Configuration

Shared plus `OFFSET_SKIP_RATIO` (dimensionless, reference ≈ 3) and `OFFSET_FORCED_EXIT_RATIO` (dimensionless, reference ≈ 6).

## Indicators and formulas

Skip (reference policy; both values are config):

```text
askDepth × skipRatio < bidDepth → skip SELL entry
bidDepth × skipRatio < askDepth → skip BUY entry
```

Forced imbalance exit (reduce-only market close):

```text
long:  bidDepth × forcedExitRatio < askDepth → flatten
short: askDepth × forcedExitRatio < bidDepth → flatten
```

Maker clamp as in shared formulas. Reprice dwell as shared.

## State machine

Shared. Forced flatten is an exit transition to flat, then `FLAT_QUOTING` after reconcile.

## Entry behavior

Same as Classic, minus skipped thin side.

## Exit behavior

- Reduce-only exit (L1)
- Forced imbalance flatten is reduce-only **market**, never `reduceOnly=false`

## Protective behavior

Shared USD loss kill-switch **and** forced imbalance flatten.

## Order intents

Shared. Flatten uses reduce-only `PLACE_MARKET`.

## Recovery / failure / risk

Shared. Extra: do not spam reprice.

## Acceptance tests

- Balanced book quotes both sides
- Thin ask → no SELL entry
- Thin bid → no BUY entry
- Extreme imbalance against the position flattens
- Quotes do not cross the spread
- Reprice does not spam Binance

## Non-goals

- Liquidity Maker breakeven exit
- Forced flatten **off** (that is Liquidity)
- Grid / Maker Points / Basis

---

# Liquidity Maker

## Purpose

Maker that places exits near breakeven or a minimum profit using fill/entry price. Uses depth skip for **entry** only. Does **not** forced-exit on imbalance.

## Inputs

Shared plus fill tracking from execution reports.

## Configuration

Shared plus `LIQUIDITY_SKIP_RATIO` (dimensionless, example 2), `LIQUIDITY_CLOSE_TICK_OFFSET` (ticks), `LIQUIDITY_RECENT_FILL_MS` (milliseconds).

## Indicators and formulas

Entry skip: same shape as Offset, with `LIQUIDITY_SKIP_RATIO`. No forced imbalance market exit.

Exit price source order:

1. Latest fill price still fresh (`LIQUIDITY_RECENT_FILL_MS`)
2. Position entry price
3. Best bid/ask fallback

Then:

```text
long  = max(fillOrEntry + closeTickOffset × tick, entry + tick)
short = min(fillOrEntry - closeTickOffset × tick, entry - tick)
```

Then apply maker clamp. `closeTickOffset` is ticks; `tick` is USDT tick size.

## State machine

Shared. No imbalance-flatten transition.

## Entry behavior

Two-sided post-only with skip. No add-on while in position.

## Exit behavior

Fill-aware reduce-only limit near breakeven. Not required to sit on L1.

Fill tracking must **not** infer fills from the open-order array alone. Use:

- `ORDER_TRADE_UPDATE`
- Execution type `TRADE`
- Accumulated filled quantity
- Average fill price
- Position delta as reconciliation backup

## Protective behavior

USD loss kill-switch only (no imbalance flatten). Reduce-only market after canceling owned limits.

## Order intents

Shared. Exit `PLACE_LIMIT` with `reduceOnly=true` (GTC reduce limit is allowed; post-only on exit **TBD** — spec wants maker clamp, not necessarily `GTX` on the exit).

## Recovery / failure / risk

Shared. Fills that disappear from open orders must still be detected.

## Acceptance tests

- Exit prefers a recent fill over entry price
- Long exit is not below the breakeven target when the book allows
- Short exit is not above the breakeven target when the book allows
- No forced market exit from depth imbalance
- Fill events are detected after the order leaves open orders

## Non-goals

- Offset Maker forced imbalance flatten
- Grid / Maker Points / Basis
- Inferring fills only from open orders

# Domain model

Authoritative for: ubiquitous language, TypeScript design examples, canonical units, transitions, and domain invariants.

These interfaces are **design examples**, not production source. They are not copied from the origin repository.

Exchange field mapping: [binance-usdtm.md](binance-usdtm.md). Process states: [architecture.md](architecture.md).

## Ubiquitous language

| Term | Meaning |
|---|---|
| Strategy policy | Pure logic. Inputs a snapshot, outputs `OrderIntent[]`. |
| Order intent | Desired place/cancel action. Contains no adapter or client. |
| Strategy snapshot | Immutable view of account, orders, market, precision, and clocks for one tick. |
| Bot-owned order | Exchange order whose `clientOrderId` matches this app/strategy/instance prefix. |
| Reduce-only | Exit that can only decrease absolute position. Required for every exit. |
| Protective order | Reduce-only stop and/or trailing stop covering an open position. |
| One-way mode | Single net position per symbol; Binance `positionSide=BOTH`. |
| Isolated margin | Margin isolated to the symbol. v1 default. |
| Mark price | Price from the mark-price stream. Not a ticker weighted average. |
| Degraded / Paused | Rate-limit runtime states. Entry is blocked; protection still runs. |
| Kill switch | Controlled stop: `CANCEL_ONLY` or `CANCEL_AND_FLATTEN`. |

## Canonical units

| Quantity | Unit | Notes |
|---|---|---|
| Price | Quote asset (USDT for USDT-M) | Rounded to `PRICE_FILTER.tickSize` |
| Quantity | Base asset | Signed position: positive = long, negative = short. Rounded to `LOT_SIZE.stepSize` |
| Notional | USDT | `abs(quantity) * price` (mark or order price as specified by the caller) |
| PnL, USD stops, session loss | USDT | Absolute money, not a fraction |
| Fraction | Dimensionless | `0.005` = 0.5%. Names must include `FRACTION` |
| Trailing callback rate | Binance percent points | `1` = 1%. Allowed range 0.1–5 |
| Time | Milliseconds | Event times, polls, cooldowns, dwell |
| Depth level | 1-based index into the book | Spec example `MAKER_ENTRY_DEPTH_LEVEL=1` is best bid/ask |
| Bandwidth | Dimensionless | `(2 × std × multiplier) / mean` |

After `exchangeInfo` is loaded, `.env` is **not** the source of truth for tick size, step size, or min notional.

## Market data

```ts
export interface PriceLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  eventTime: number;
  sequence: number;
}

export interface MarketTicker {
  symbol: string;
  lastPrice: number;
  markPrice: number;
  eventTime: number;
}

export interface Candle {
  symbol: string;
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}
```

`MarketTicker.markPrice` must be filled from the mark-price stream (or REST mark price), never from a weighted-average ticker field.

`eventTime` / `openTime` / `closeTime` are milliseconds. `sequence` is the book update id used to detect gaps.

**TBD:** sorted depth convention (bid descending / ask ascending is implied by Maker math but not stated). Contract tests require sorted depth; treat bid[0]/ask[0] as best.

## Account

```ts
export interface AccountState {
  walletBalance: number;
  availableBalance: number;
  positions: FuturesPosition[];
  updateTime: number;
}
```

Balances are USDT (single-asset USDT-M). `updateTime` is milliseconds.

## Position

```ts
export interface FuturesPosition {
  symbol: string;
  quantity: number;        // positive=long, negative=short
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice?: number;
  leverage: number;
  marginMode: "isolated" | "cross";
  updateTime: number;
}
```

v1 requires `marginMode === "isolated"` at runtime. `leverage` is a dimensionless integer ratio (for example `3` = 3x).

Flat means `quantity === 0` (or no position for the symbol).

## Order

```ts
export type OrderSide = "BUY" | "SELL";
export type OrderType =
  | "LIMIT"
  | "MARKET"
  | "STOP_MARKET"
  | "TRAILING_STOP_MARKET";

export interface TradingOrder {
  exchangeOrderId: string;
  clientOrderId: string;
  strategyId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  price?: number;
  stopPrice?: number;
  activationPrice?: number;
  quantity: number;
  filledQuantity: number;
  reduceOnly: boolean;
  updateTime: number;
}
```

`quantity` and `filledQuantity` are base-asset amounts (unsigned on the order; side plus reduce-only encode direction). `callbackRate` for trailing lives on the place intent, not on this snapshot type.

Binance also has `STOP`, `TAKE_PROFIT`, and `TAKE_PROFIT_MARKET`. v1 policies do not emit those types.

## Order status

```ts
export type OrderStatus =
  | "NEW"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";
```

Binance also reports `EXPIRED_IN_MATCH`. **TBD:** map it to `EXPIRED` or extend this union.

REST rejections may never become an exchange order. **TBD:** whether `REJECTED` is a persisted order status or only an execution error.

## Order intent

```ts
export type OrderIntent =
  | {
      type: "PLACE_LIMIT";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      price: number;
      quantity: number;
      postOnly: boolean;
      reduceOnly: boolean;
    }
  | {
      type: "PLACE_MARKET";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      quantity: number;
      reduceOnly: boolean;
      reason: string;
    }
  | {
      type: "PLACE_STOP";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      stopPrice: number;
      quantity: number;
      reduceOnly: true;
    }
  | {
      type: "PLACE_TRAILING_STOP";
      strategyId: string;
      symbol: string;
      side: OrderSide;
      activationPrice: number;
      callbackRate: number;
      quantity: number;
      reduceOnly: true;
    }
  | {
      type: "CANCEL";
      strategyId: string;
      orderIds: string[];
    }
  | {
      type: "CANCEL_OWNED";
      strategyId: string;
      symbol: string;
    };
```

`OrderIntent` must not hold an adapter or Binance client.

`PLACE_STOP` and `PLACE_TRAILING_STOP` are typed `reduceOnly: true`. Market and limit **exits** must set `reduceOnly: true` even though the type allows `false` for entries.

`CANCEL.orderIds` **TBD:** exchange order ids, client order ids, or either. `CANCEL_OWNED` cancels bot-owned orders for that strategy and symbol only.

## Strategy state

Shared runtime lifecycle (not strategy-specific signal state):

```ts
export type StrategyLifecycle =
  | "CREATED"
  | "STARTING"
  | "RECONCILING"
  | "READY"
  | "RUNNING"
  | "DEGRADED"
  | "PAUSED"
  | "STOPPING"
  | "STOPPED";

export type RateLimitState = "NORMAL" | "DEGRADED" | "PAUSED";
```

Maker quoting states: [strategies/maker-family.md](strategies/maker-family.md). Guardian: [strategies/guardian.md](strategies/guardian.md). Swing armed flags: [strategies/swing.md](strategies/swing.md).

## Strategy snapshot

The spec requires an immutable snapshot each tick. Fields below are the union of strategy inputs, not an extra product requirement.

```ts
export interface SymbolPrecision {
  tickSize: number;
  stepSize: number;
  marketStepSize?: number;
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

export interface StrategySnapshot {
  strategyId: string;
  instanceId: string;
  symbol: string;
  lifecycle: StrategyLifecycle;
  rateLimitState: RateLimitState;
  account: AccountState;
  position: FuturesPosition | null;
  openOrders: TradingOrder[];
  orderBook?: OrderBook;
  ticker?: MarketTicker;
  markPrice?: number;
  candles?: Candle[];
  precision: SymbolPrecision;
  now: number;
}
```

`now` is milliseconds. A strategy must not go `READY` if required feeds for that strategy are missing. Per-strategy required inputs live in [strategies/](strategies/).

## Observability

```ts
export interface StrategyLog {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  strategyId: string;
  instanceId: string;
  symbol: string;
  event: string;
  details?: Record<string, unknown>;
}
```

Forbidden in logs: API key, secret, signature, authorization header, full raw private responses. Metrics list: [product-requirements.md](product-requirements.md#metrics-to-emit).

## State transitions

### Position (one-way)

```text
FLAT  -- entry fill --> LONG   (quantity > 0)
FLAT  -- entry fill --> SHORT  (quantity < 0)
LONG  -- reduce-only fill / flatten --> FLAT or smaller LONG
SHORT -- reduce-only fill / flatten --> FLAT or smaller SHORT
```

v1 must not open the opposite side while a position exists (no hedge, no flip-through-hedge). **TBD:** whether a flatten plus reverse entry in one tick is allowed for Trend/Swing, or flatten must be confirmed first. Spec: do not pyramid; Maker forbids adding while in position.

### Order

```text
PLACE ack --> NEW
NEW --> PARTIALLY_FILLED --> FILLED
NEW | PARTIALLY_FILLED --> CANCELED | EXPIRED
place rejected --> REJECTED  (mapping TBD)
```

Partial fills remain live until filled, canceled, or expired. Remaining quantity is `quantity - filledQuantity`.

### Runtime

See [architecture.md](architecture.md#startup-lifecycle). Rate-limit: [risk-policy.md](risk-policy.md#rate-limit-states).

## Invariants

1. Exit intents (`PLACE_STOP`, `PLACE_TRAILING_STOP`, and any close/exit limit or market) have `reduceOnly === true`.
2. Close quantity ≤ `abs(position.quantity)` after step-size rounding.
3. Entry quantity is rounded **down** to step size and is never zero.
4. Orders the bot cancels are bot-owned.
5. Domain objects do not reference CCXT or Binance client instances.
6. Mark price used for slippage and protection comes from the mark-price feed.
7. Precision used for round/validate comes from `exchangeInfo` filters, not `.env`.
8. `PLACE_STOP` / `PLACE_TRAILING_STOP` cannot be expressed with `reduceOnly: false`.

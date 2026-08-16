# Binance USDT-M adapter

Authoritative for: how PerpMesh talks to Binance USDⓈ-M Futures.

Product scope: [product-requirements.md](product-requirements.md). Domain types: [domain-model.md](domain-model.md). App startup sequence: [architecture.md](architecture.md#startup-lifecycle).

**Source of truth for API behavior** is official Binance documentation. Local snapshots under [binance/](binance/) were fetched 2026-01-27 and may be stale. Re-check the live docs before implementation.

## REST / WebSocket responsibilities

| Channel | Responsibility |
|---|---|
| REST | `exchangeInfo` and filters; server time; position mode; margin type; leverage; account; open orders; place/cancel; listenKey create/keepalive/close; polling backup |
| Public WebSocket | Depth, ticker, mark price, kline |
| User data WebSocket | `ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`, `listenKeyExpired` |

Prefer user-stream account/order state over REST during volatile markets ([market streams connect](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams)). REST remains the backup and the bootstrap source.

Signed REST uses HMAC SHA256, `timestamp` in milliseconds, and `recvWindow` (default 5000 ms if omitted). [General info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info).

## Public streams

Production public base: `wss://fstream.binance.com` ([market streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams)). Symbols in stream names are **lowercase**. Connections last at most 24 hours. Server ping every 3 minutes; respond with pong.

| Stream | Used by | Official doc |
|---|---|---|
| `<symbol>@depth@100ms` | Maker family, Trend, Swing | [Diff book depth](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Diff-Book-Depth-Streams) |
| `<symbol>@ticker` | Trend, Guardian, Maker family | [Individual symbol ticker](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Individual-Symbol-Ticker-Streams) |
| `<symbol>@markPrice@1s` | Every strategy and slippage guard | [Mark price stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Mark-Price-Stream) |
| `<symbol>@kline_<interval>` | Trend and Swing | [Kline stream](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Kline-Candlestick-Streams) |

Use the **mark-price stream** for mark price. Do not map a weighted-average ticker field to mark price.

`<symbol>@depth@100ms` is the **diff** book. Maintaining a local book requires a REST snapshot plus gap detection ([how to manage a local order book](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)). **TBD:** snapshot depth limit and what to do on a sequence gap besides rebuild (spec only requires freshness + sorted depth).

Guardian does not require depth or kline.

## User data stream

Events required by this bot:

- [`ORDER_TRADE_UPDATE`](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams/Event-Order-Update)
- [`ACCOUNT_UPDATE`](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams/Event-Balance-and-Position-Update)

Connect at `wss://fstream.binance.com/ws/<listenKey>` ([user data streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams)). Order updates using event time `E`. A connection is valid at most 24 hours.

On `listenKeyExpired`, no further user data arrives until a new listenKey is used ([expired event](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams/Event-User-Data-Stream-Expired)). Recreate the key and reconnect.

Fill tracking for Liquidity Maker must use `ORDER_TRADE_UPDATE` with execution type `TRADE`, accumulated filled quantity, and average fill price. Position delta is a reconciliation backup only. See [strategies/maker-family.md](strategies/maker-family.md).

## Listen-key lifecycle

| Step | API | Notes |
|---|---|---|
| Create | `POST /fapi/v1/listenKey` | Valid 60 minutes. If one exists, Binance returns it and extends 60 minutes. |
| Keepalive | `PUT /fapi/v1/listenKey` | Extends 60 minutes. `-1125` means recreate with POST. |
| Close | `DELETE /fapi/v1/listenKey` | Invalidates the key. |
| Subscribe | `wss://fstream.binance.com/ws/<listenKey>` | User data |

Sources: [connect](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams), [start](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams/Start-User-Data-Stream), [keepalive](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams/Keepalive-User-Data-Stream).

Binance recommends sending keepalive about every 60 minutes; the key expires after 60 minutes. The spec says keepalive **before expiry with margin**. **TBD:** exact keepalive interval in milliseconds (no env var is specified).

## Startup bootstrap

Adapter checklist (app sequence: [architecture.md](architecture.md#startup-lifecycle)):

1. `GET /fapi/v1/time` — clock sync ([check server time](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Check-Server-Time))
2. `GET /fapi/v1/exchangeInfo` — symbol filters ([exchange information](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information))
3. `GET /fapi/v1/positionSide/dual` — require One-way (`dualSidePosition: false`) ([get position mode](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Current-Position-Mode)). If `BINANCE_REQUIRE_ONE_WAY=true` and the account is hedge, **TBD:** refuse to start vs call `POST /fapi/v1/positionSide/dual` with `dualSidePosition=false` ([change position mode](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Change-Position-Mode)). Changing mode affects **every** symbol.
4. `POST /fapi/v1/marginType` — `ISOLATED` ([change margin type](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Change-Margin-Type))
5. `POST /fapi/v1/leverage` — configured leverage, integer 1–125 and within the symbol bracket ([change initial leverage](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Change-Initial-Leverage))
6. Account + position REST snapshot — **TBD:** `GET /fapi/v2/account` vs `GET /fapi/v3/account` vs position-info endpoints
7. `GET /fapi/v1/openOrders` for the symbol ([open orders](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Current-All-Open-Orders))
8. Create listenKey and connect user stream
9. Subscribe public streams the strategy needs
10. Seed klines via `GET /fapi/v1/klines` when Trend/Swing need history ([kline data](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)). **TBD:** history length (legacy Swing notes said 500; the reimplementation spec does not).

## Exchange metadata / precision

Read from `exchangeInfo` for the configured symbol:

- `PRICE_FILTER.tickSize` (do not use `pricePrecision` as tick size)
- `LOT_SIZE.stepSize` (do not use `quantityPrecision` as step size)
- `MARKET_LOT_SIZE`
- `MIN_NOTIONAL` or `NOTIONAL`
- quantity precision, price precision (display/helpers only)

Rules:

- Entry quantity rounds **down** to step
- Close quantity must not exceed absolute position
- Price rounds in the direction that preserves maker semantics
- Never send quantity `0`
- Reject below min notional before send
- After metadata is loaded, `.env` is not the precision source of truth

Unknown precision: **do not place orders**.

## Order mapping

Place: `POST /fapi/v1/order` ([new order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api)). Test-order fields (including `callbackRate` range) are documented on [test new order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order-Test). `GTX` is post-only ([common definitions](https://developers.binance.com/docs/derivatives/usds-margined-futures/common-definition)). Crossed post-only is rejected `-5022`.

| Intent | Binance order |
|---|---|
| Post-only limit | `LIMIT` + `timeInForce=GTX` |
| Normal reduce limit | `LIMIT` + `GTC` + `reduceOnly=true` |
| Market entry | `MARKET` + `reduceOnly=false` |
| Market close | `MARKET` + `reduceOnly=true` |
| Stop loss | `STOP_MARKET` + `reduceOnly=true` + `workingType=MARK_PRICE` |
| Trailing stop | `TRAILING_STOP_MARKET` + activation + callback + reduce-only semantics |

One-way mode: omit hedge-only `positionSide`, or send `BOTH` (default). Do not send `reduceOnly` in Hedge Mode; v1 is One-way only.

`callbackRate`: min 0.1, max 5, where `1` means 1%.

Never send `reduceOnly=false` for Offset Maker or Liquidity Maker **exits**.

Cancel individual or owned orders. Do not use `DELETE /fapi/v1/allOpenOrders` as a blunt symbol cancel ([cancel all open orders](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Cancel-All-Open-Orders)). Use [cancel order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Cancel-Order) / [cancel multiple](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Cancel-Multiple-Orders) on bot-owned ids.

`newClientOrderId` max 36 chars: `^[\.A-Z\:/a-z0-9_-]{1,36}$`. Ownership policy: [architecture.md](architecture.md#order-ownership).

HTTP 503 with "Unknown error, please check your request or try again later." means execution status is **unknown** — query rather than retry a duplicate. Reduce-only / close-position orders are exempt from some overload throttles (`-1008`). [General info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info).

## One-way mode

v1 requires One-way Mode: `dualSidePosition=false`, `positionSide=BOTH`. Hedge Mode is a non-goal. Position mode is account-wide.

## Isolated margin

v1 sets `marginType=ISOLATED` per symbol. Cross is out of v1 runtime even though the domain union includes `"cross"` for mapping honesty.

## Leverage

Set via `POST /fapi/v1/leverage`. Config `BINANCE_LEVERAGE` is a dimensionless integer. Validate against the symbol's allowed range (docs state 1–125; actual cap is per-symbol). **TBD:** whether a failed leverage change is fatal at startup (spec says set it; it does not define the error path).

## Reconnection

Exponential backoff for WebSocket reconnect:

```text
3s → 6s → 12s → ... → max 60s
```

`RECONNECT_MAX_MS=60000` (milliseconds). Public and user streams reconnect independently. User-stream reconnect includes listenKey check/recreate.

WS incoming message limit: 10 messages per second per connection ([market streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams)).

## REST polling backup

| Poll | Suggested interval | Env |
|---|---|---|
| Account | 5000 ms | `ACCOUNT_POLL_MS` |
| Open orders | 3000 ms | `ORDERS_POLL_MS` |

When the user stream is stale:

1. Stop opening new positions
2. Keep protective orders via REST
3. Reconcile account and open orders
4. Return to normal when WS and REST agree

Stale thresholds: [risk-policy.md](risk-policy.md#feed-freshness).

## Endpoint allowlist

Production:

```text
REST: https://fapi.binance.com
WS:   wss://fstream.binance.com
```

[General info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info), [user data](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams).

If a custom endpoint is enabled for **testnet**:

- HTTPS / WSS only
- Validate hostname
- Log the environment clearly
- Never disable TLS verification
- Never support `NODE_TLS_REJECT_UNAUTHORIZED=0`

## Rate limits

Limits come from `exchangeInfo.rateLimits` (`REQUEST_WEIGHT`, `ORDERS`, `RAW_REQUEST`). 429 = back off. Repeated 429 can become HTTP 418 IP ban (2 minutes to 3 days). Limits are per IP for weight, per account for orders. [General info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info).

Bot behavior on 429: [risk-policy.md](risk-policy.md#rate-limit-states).

## Clock synchronization

`GET /fapi/v1/time` compared to local time. Signed request rule ([timing security](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)):

```text
timestamp < serverTime + 1000 && serverTime - timestamp <= recvWindow
```

On skew: sync server time and **pause signed requests**. **TBD:** numeric skew threshold used at READY, and `recvWindow` value (Binance default 5000 ms; no env var specified).

## Testnet requirements

The spec forbids hardcoding stale testnet URLs. Official general-info (snapshot 2026-01-27) listed:

- REST testnet: `https://demo-fapi.binance.com`
- Websocket testnet: `wss://fstream.binancefuture.com`

Other Binance materials still mention `https://testnet.binancefuture.com`. **TBD:** confirm REST and WS testnet bases from the live general-info page at implementation time. Keys are not interchangeable with production.

`BINANCE_TESTNET=true` must be the default path in v1. Production hosts must not be used unless explicit confirmation is set.

Futures Testnet key setup: [Futures testnet](https://testnet.binancefuture.com/en/futures/BTCUSDT) (linked from [quick start](https://developers.binance.com/docs/derivatives/quick-start)). Re-verify that URL when implementing.

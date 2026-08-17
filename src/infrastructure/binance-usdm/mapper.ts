import type { AccountState, FuturesPosition } from "../../domain/account";
import type { Candle, MarketTicker, OrderBook, PriceLevel } from "../../domain/market";
import type { OrderIntent } from "../../domain/intent";
import type {
  OrderSide,
  OrderStatus,
  OrderType,
  TradingOrder,
} from "../../domain/order";
import { MapperError } from "./errors";
import { decimalString } from "./signing";

export type PlaceIntent = Exclude<
  OrderIntent,
  { type: "CANCEL" } | { type: "CANCEL_OWNED" }
>;

export type BinanceOrderParams = Record<string, string | number | boolean>;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MapperError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new MapperError(`${label} must be a string`);
}

function asNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new MapperError(`${label} must be a finite number`);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  try {
    return asNumber(value, "optional");
  } catch {
    return undefined;
  }
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new MapperError(`${label} must be a boolean`);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new MapperError(`${label} must be an array`);
  }
  return value;
}

function mapOrderSide(value: unknown): OrderSide {
  const side = asString(value, "side");
  if (side === "BUY" || side === "SELL") {
    return side;
  }
  throw new MapperError(`unsupported order side ${side}`);
}

function mapOrderType(value: unknown): OrderType | undefined {
  const type = asString(value, "order type");
  if (
    type === "LIMIT" ||
    type === "MARKET" ||
    type === "STOP_MARKET" ||
    type === "TRAILING_STOP_MARKET"
  ) {
    return type;
  }
  return undefined;
}

function mapOrderStatus(value: unknown): OrderStatus {
  const status = asString(value, "order status");
  if (status === "EXPIRED_IN_MATCH") {
    return "EXPIRED";
  }
  if (
    status === "NEW" ||
    status === "PARTIALLY_FILLED" ||
    status === "FILLED" ||
    status === "CANCELED" ||
    status === "REJECTED" ||
    status === "EXPIRED"
  ) {
    return status;
  }
  throw new MapperError(`unsupported order status ${status}`);
}

function mapMarginMode(value: unknown): "isolated" | "cross" {
  if (value === true || value === "isolated") {
    return "isolated";
  }
  if (value === false || value === "cross" || value === "crossed") {
    return "cross";
  }
  throw new MapperError("unsupported margin mode");
}

function mapPriceLevels(levels: unknown, label: string): PriceLevel[] {
  return asArray(levels, label).map((level, index) => {
    const pair = asArray(level, `${label}[${index}]`);
    return {
      price: asNumber(pair[0], `${label}[${index}].price`),
      quantity: asNumber(pair[1], `${label}[${index}].quantity`),
    };
  });
}

export function sortDepth(book: OrderBook): OrderBook {
  return {
    ...book,
    bids: [...book.bids].sort((a, b) => b.price - a.price),
    asks: [...book.asks].sort((a, b) => a.price - b.price),
  };
}

export function mapDepthSnapshot(
  payload: unknown,
  symbol: string,
): OrderBook {
  const row = asRecord(payload, "depth snapshot");
  return sortDepth({
    symbol,
    bids: mapPriceLevels(row.bids, "bids"),
    asks: mapPriceLevels(row.asks, "asks"),
    eventTime: optionalNumber(row.E) ?? 0,
    sequence: asNumber(row.lastUpdateId, "lastUpdateId"),
  });
}

export function mapDepthDiff(payload: unknown): OrderBook {
  const row = asRecord(payload, "depth diff");
  return sortDepth({
    symbol: asString(row.s, "s"),
    bids: mapPriceLevels(row.b, "b"),
    asks: mapPriceLevels(row.a, "a"),
    eventTime: asNumber(row.E, "E"),
    sequence: asNumber(row.u, "u"),
  });
}

export function mapMarkPriceEvent(payload: unknown): {
  symbol: string;
  markPrice: number;
  eventTime: number;
} {
  const row = asRecord(payload, "mark price");
  return {
    symbol: asString(row.s ?? row.symbol, "symbol"),
    markPrice: asNumber(row.p ?? row.markPrice, "markPrice"),
    eventTime: asNumber(row.E ?? row.time, "eventTime"),
  };
}

export function mapTickerEvent(
  payload: unknown,
  markPrice: number,
): MarketTicker {
  const row = asRecord(payload, "ticker");
  return {
    symbol: asString(row.s, "s"),
    lastPrice: asNumber(row.c, "c"),
    markPrice,
    eventTime: asNumber(row.E, "E"),
  };
}

export function mapKlineEvent(payload: unknown): Candle {
  const row = asRecord(payload, "kline");
  const kline = asRecord(row.k, "k");
  return {
    symbol: asString(kline.s ?? row.s, "s"),
    interval: asString(kline.i, "i"),
    openTime: asNumber(kline.t, "t"),
    closeTime: asNumber(kline.T, "T"),
    open: asNumber(kline.o, "o"),
    high: asNumber(kline.h, "h"),
    low: asNumber(kline.l, "l"),
    close: asNumber(kline.c, "c"),
    volume: asNumber(kline.v, "v"),
    closed: asBoolean(kline.x, "x"),
  };
}

export function mapRestKlines(
  payload: unknown,
  symbol: string,
  interval: string,
): Candle[] {
  return asArray(payload, "klines").map((row, index) => {
    const kline = asArray(row, `klines[${index}]`);
    return {
      symbol,
      interval,
      openTime: asNumber(kline[0], "openTime"),
      open: asNumber(kline[1], "open"),
      high: asNumber(kline[2], "high"),
      low: asNumber(kline[3], "low"),
      close: asNumber(kline[4], "close"),
      volume: asNumber(kline[5], "volume"),
      closeTime: asNumber(kline[6], "closeTime"),
      closed: true,
    };
  });
}

function mapRestOrderFields(
  row: Record<string, unknown>,
  strategyId: string,
): TradingOrder | undefined {
  const type = mapOrderType(row.origType ?? row.type);
  if (type === undefined) {
    return undefined;
  }
  const order: TradingOrder = {
    exchangeOrderId: asString(row.orderId, "orderId"),
    clientOrderId: asString(row.clientOrderId, "clientOrderId"),
    strategyId,
    symbol: asString(row.symbol, "symbol"),
    side: mapOrderSide(row.side),
    type,
    status: mapOrderStatus(row.status),
    quantity: asNumber(row.origQty, "origQty"),
    filledQuantity: asNumber(row.executedQty, "executedQty"),
    reduceOnly: asBoolean(row.reduceOnly, "reduceOnly"),
    updateTime: asNumber(row.updateTime, "updateTime"),
  };
  const price = optionalNumber(row.price);
  if (price !== undefined && price > 0) {
    order.price = price;
  }
  const stopPrice = optionalNumber(row.stopPrice);
  if (stopPrice !== undefined && stopPrice > 0 && type !== "TRAILING_STOP_MARKET") {
    order.stopPrice = stopPrice;
  }
  const activation = optionalNumber(row.activatePrice);
  if (activation !== undefined && activation > 0) {
    order.activationPrice = activation;
  }
  return order;
}

export function mapRestOrder(
  payload: unknown,
  strategyId = "",
): TradingOrder {
  const mapped = mapRestOrderFields(asRecord(payload, "order"), strategyId);
  if (mapped === undefined) {
    throw new MapperError("unsupported v1 order type");
  }
  return mapped;
}

export function mapRestOpenOrders(
  payload: unknown,
  strategyId = "",
): TradingOrder[] {
  return asArray(payload, "openOrders").flatMap((row) => {
    const mapped = mapRestOrderFields(asRecord(row, "openOrder"), strategyId);
    return mapped === undefined ? [] : [mapped];
  });
}

export function mapOrderTradeUpdate(
  payload: unknown,
  strategyId = "",
): TradingOrder {
  const row = asRecord(payload, "ORDER_TRADE_UPDATE");
  const order = asRecord(row.o, "o");
  const type = mapOrderType(order.ot ?? order.o);
  if (type === undefined) {
    throw new MapperError("unsupported v1 order type");
  }
  const mapped: TradingOrder = {
    exchangeOrderId: asString(order.i, "i"),
    clientOrderId: asString(order.c, "c"),
    strategyId,
    symbol: asString(order.s, "s"),
    side: mapOrderSide(order.S),
    type,
    status: mapOrderStatus(order.X),
    quantity: asNumber(order.q, "q"),
    filledQuantity: asNumber(order.z, "z"),
    reduceOnly: asBoolean(order.R, "R"),
    updateTime: asNumber(row.E, "E"),
  };
  const price = optionalNumber(order.p);
  if (price !== undefined && price > 0) {
    mapped.price = price;
  }
  const stopPrice = optionalNumber(order.sp);
  if (stopPrice !== undefined && stopPrice > 0 && type !== "TRAILING_STOP_MARKET") {
    mapped.stopPrice = stopPrice;
  }
  const activation = optionalNumber(order.AP);
  if (activation !== undefined && activation > 0) {
    mapped.activationPrice = activation;
  }
  return mapped;
}

function usdtAsset(
  assets: unknown,
): { walletBalance: number; availableBalance: number; updateTime: number } {
  const list = asArray(assets, "assets");
  const usdt = list
    .map((row) => asRecord(row, "asset"))
    .find((row) => row.asset === "USDT");
  if (usdt === undefined) {
    throw new MapperError("USDT asset missing from account");
  }
  return {
    walletBalance: asNumber(usdt.walletBalance, "walletBalance"),
    availableBalance: asNumber(usdt.availableBalance, "availableBalance"),
    updateTime: optionalNumber(usdt.updateTime) ?? 0,
  };
}

export function mapPositionRisk(payload: unknown): FuturesPosition[] {
  return asArray(payload, "positionRisk").flatMap((row) => {
    const position = asRecord(row, "position");
    if (position.positionSide !== undefined && position.positionSide !== "BOTH") {
      return [];
    }
    const quantity = asNumber(position.positionAmt, "positionAmt");
    const mapped: FuturesPosition = {
      symbol: asString(position.symbol, "symbol"),
      quantity,
      entryPrice: asNumber(position.entryPrice, "entryPrice"),
      markPrice: asNumber(position.markPrice, "markPrice"),
      unrealizedPnl: asNumber(
        position.unRealizedProfit ?? position.unrealizedProfit,
        "unRealizedProfit",
      ),
      leverage: asNumber(position.leverage, "leverage"),
      marginMode: mapMarginMode(position.marginType ?? position.isolated),
      updateTime: optionalNumber(position.updateTime) ?? 0,
    };
    const liquidation = optionalNumber(position.liquidationPrice);
    if (liquidation !== undefined && liquidation > 0) {
      mapped.liquidationPrice = liquidation;
    }
    return [mapped];
  });
}

export function mapAccountV2(
  payload: unknown,
  positions: FuturesPosition[],
): AccountState {
  const row = asRecord(payload, "account");
  const usdt = usdtAsset(row.assets);
  return {
    walletBalance: usdt.walletBalance,
    availableBalance:
      optionalNumber(row.availableBalance) ?? usdt.availableBalance,
    positions,
    updateTime: usdt.updateTime,
  };
}

export function applyAccountUpdate(
  previous: AccountState,
  payload: unknown,
): AccountState {
  const row = asRecord(payload, "ACCOUNT_UPDATE");
  const data = asRecord(row.a, "a");
  const eventTime = asNumber(row.E, "E");
  let walletBalance = previous.walletBalance;
  let availableBalance = previous.availableBalance;
  const balances = asArray(data.B, "B");
  for (const item of balances) {
    const balance = asRecord(item, "B[]");
    if (balance.a !== "USDT") {
      continue;
    }
    walletBalance = asNumber(balance.wb, "wb");
  }

  const bySymbol = new Map(
    previous.positions.map((position) => [position.symbol, position]),
  );
  const changed = asArray(data.P ?? [], "P");
  for (const item of changed) {
    const position = asRecord(item, "P[]");
    if (position.ps !== undefined && position.ps !== "BOTH") {
      continue;
    }
    const symbol = asString(position.s, "s");
    const prior = bySymbol.get(symbol);
    const mapped: FuturesPosition = {
      symbol,
      quantity: asNumber(position.pa, "pa"),
      entryPrice: asNumber(position.ep, "ep"),
      markPrice: prior?.markPrice ?? 0,
      unrealizedPnl: asNumber(position.up, "up"),
      leverage: prior?.leverage ?? 0,
      marginMode: mapMarginMode(position.mt ?? "isolated"),
      updateTime: eventTime,
    };
    if (prior?.liquidationPrice !== undefined) {
      mapped.liquidationPrice = prior.liquidationPrice;
    }
    bySymbol.set(symbol, mapped);
  }

  return {
    walletBalance,
    availableBalance,
    positions: [...bySymbol.values()],
    updateTime: eventTime,
  };
}

export function mapOrderTradeFill(
  payload: unknown,
  strategyId = "",
): {
  order: TradingOrder;
  executionType: string;
  lastFilledQuantity: number;
  lastFillPrice: number;
  averageFillPrice: number;
  eventTime: number;
} {
  const row = asRecord(payload, "ORDER_TRADE_UPDATE");
  const order = asRecord(row.o, "o");
  return {
    order: mapOrderTradeUpdate(payload, strategyId),
    executionType: asString(order.x, "x"),
    lastFilledQuantity: asNumber(order.l, "l"),
    lastFillPrice: optionalNumber(order.L) ?? 0,
    averageFillPrice: optionalNumber(order.ap) ?? 0,
    eventTime: asNumber(row.E, "E"),
  };
}

export function mapListenKeyExpired(payload: unknown): boolean {
  const row = asRecord(payload, "listenKeyExpired");
  return row.e === "listenKeyExpired";
}

export function unwrapStreamPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const row = payload as Record<string, unknown>;
  if (typeof row.stream === "string" && "data" in row) {
    return row.data;
  }
  return payload;
}

export function eventTypeOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const eventType = (payload as Record<string, unknown>).e;
  return typeof eventType === "string" ? eventType : undefined;
}

export function intentToOrderParams(
  intent: PlaceIntent,
  newClientOrderId: string,
): BinanceOrderParams {
  const params: BinanceOrderParams = {
    symbol: intent.symbol,
    side: intent.side,
    newClientOrderId,
    newOrderRespType: "RESULT",
  };

  switch (intent.type) {
    case "PLACE_LIMIT":
      params.type = "LIMIT";
      params.timeInForce = intent.postOnly ? "GTX" : "GTC";
      params.price = decimalString(intent.price);
      params.quantity = decimalString(intent.quantity);
      params.reduceOnly = intent.reduceOnly;
      return params;
    case "PLACE_MARKET":
      params.type = "MARKET";
      params.quantity = decimalString(intent.quantity);
      params.reduceOnly = intent.reduceOnly;
      return params;
    case "PLACE_STOP":
      params.type = "STOP_MARKET";
      params.stopPrice = decimalString(intent.stopPrice);
      params.quantity = decimalString(intent.quantity);
      params.reduceOnly = true;
      params.workingType = "MARK_PRICE";
      return params;
    case "PLACE_TRAILING_STOP":
      params.type = "TRAILING_STOP_MARKET";
      params.activationPrice = decimalString(intent.activationPrice);
      params.callbackRate = decimalString(intent.callbackRate);
      params.quantity = decimalString(intent.quantity);
      params.reduceOnly = true;
      return params;
  }
}

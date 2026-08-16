import type { SymbolPrecision } from "../../domain/strategy";
import { UnknownPrecisionError } from "./errors";

type ExchangeFilter = {
  filterType?: string;
  tickSize?: string;
  stepSize?: string;
  notional?: string;
  minNotional?: string;
};

type ExchangeSymbol = {
  symbol?: string;
  status?: string;
  pricePrecision?: number;
  quantityPrecision?: number;
  filters?: ExchangeFilter[];
};

export type ExchangeInfoPayload = {
  symbols?: ExchangeSymbol[];
};

function requireFilter(
  filters: ExchangeFilter[],
  filterType: string,
): ExchangeFilter {
  const found = filters.find((filter) => filter.filterType === filterType);
  if (found === undefined) {
    throw new UnknownPrecisionError(`missing ${filterType} filter`);
  }
  return found;
}

function requirePositiveNumber(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    throw new UnknownPrecisionError(`${name} is missing`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UnknownPrecisionError(`${name} is not a positive number`);
  }
  return value;
}

function minNotionalFromFilters(filters: ExchangeFilter[]): number {
  const minNotional = filters.find(
    (filter) => filter.filterType === "MIN_NOTIONAL",
  );
  if (minNotional !== undefined) {
    return requirePositiveNumber(
      "MIN_NOTIONAL",
      minNotional.notional ?? minNotional.minNotional,
    );
  }
  const notional = filters.find((filter) => filter.filterType === "NOTIONAL");
  if (notional !== undefined) {
    return requirePositiveNumber(
      "NOTIONAL",
      notional.minNotional ?? notional.notional,
    );
  }
  throw new UnknownPrecisionError("missing MIN_NOTIONAL or NOTIONAL filter");
}

export function precisionFromExchangeInfo(
  payload: ExchangeInfoPayload,
  symbol: string,
): SymbolPrecision {
  const symbols = payload.symbols;
  if (!Array.isArray(symbols)) {
    throw new UnknownPrecisionError("exchangeInfo.symbols is missing");
  }
  const row = symbols.find((entry) => entry.symbol === symbol);
  if (row === undefined) {
    throw new UnknownPrecisionError(`symbol ${symbol} not found in exchangeInfo`);
  }
  const filters = row.filters;
  if (!Array.isArray(filters)) {
    throw new UnknownPrecisionError(`symbol ${symbol} has no filters`);
  }

  const priceFilter = requireFilter(filters, "PRICE_FILTER");
  const lotSize = requireFilter(filters, "LOT_SIZE");
  const marketLot = filters.find(
    (filter) => filter.filterType === "MARKET_LOT_SIZE",
  );

  const precision: SymbolPrecision = {
    tickSize: requirePositiveNumber("tickSize", priceFilter.tickSize),
    stepSize: requirePositiveNumber("stepSize", lotSize.stepSize),
    minNotional: minNotionalFromFilters(filters),
    quantityPrecision:
      typeof row.quantityPrecision === "number" ? row.quantityPrecision : 0,
    pricePrecision:
      typeof row.pricePrecision === "number" ? row.pricePrecision : 0,
  };

  if (marketLot?.stepSize !== undefined && marketLot.stepSize !== "") {
    precision.marketStepSize = requirePositiveNumber(
      "MARKET_LOT_SIZE.stepSize",
      marketLot.stepSize,
    );
  }

  return precision;
}

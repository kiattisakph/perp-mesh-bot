export const PRODUCTION_REST_BASE = "https://fapi.binance.com";
export const PRODUCTION_WS_BASE = "wss://fstream.binance.com";

/**
 * Official USDⓈ-M general-info testnet hosts (docs snapshot 2026-01-27;
 * REST host also listed as the testnet server in current OpenAPI).
 * Live HTML general-info is JS-gated; REST liveness is checked in contract tests.
 */
export const TESTNET_REST_BASE = "https://demo-fapi.binance.com";
export const TESTNET_WS_BASE = "wss://fstream.binancefuture.com";

export const DEFAULT_RECV_WINDOW_MS = 5000;
export const RECONNECT_INITIAL_MS = 3000;
export const DEPTH_SNAPSHOT_LIMIT = 1000;
export const LISTEN_KEY_KEEPALIVE_MS = 30 * 60 * 1000;

export type VenueEnvironment = "testnet" | "production";

export type BinanceEndpoints = {
  restBase: string;
  wsBase: string;
  environment: VenueEnvironment;
};

export type EndpointInput = {
  testnet: boolean;
  restUrl?: string;
  wsUrl?: string;
};

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function resolveBinanceEndpoints(input: EndpointInput): BinanceEndpoints {
  if (!input.testnet) {
    return {
      restBase: PRODUCTION_REST_BASE,
      wsBase: PRODUCTION_WS_BASE,
      environment: "production",
    };
  }

  return {
    restBase: stripTrailingSlash(input.restUrl ?? TESTNET_REST_BASE),
    wsBase: stripTrailingSlash(input.wsUrl ?? TESTNET_WS_BASE),
    environment: "testnet",
  };
}

export function publicCombinedStreamUrl(
  wsBase: string,
  streams: readonly string[],
): string {
  return `${stripTrailingSlash(wsBase)}/stream?streams=${streams.join("/")}`;
}

export function userStreamUrl(wsBase: string, listenKey: string): string {
  return `${stripTrailingSlash(wsBase)}/ws/${listenKey}`;
}

export function publicStreamNames(input: {
  symbol: string;
  depth?: boolean;
  ticker?: boolean;
  mark?: boolean;
  klineInterval?: string;
}): string[] {
  const symbol = input.symbol.toLowerCase();
  const streams: string[] = [];
  if (input.depth === true) {
    streams.push(`${symbol}@depth@100ms`);
  }
  if (input.ticker === true) {
    streams.push(`${symbol}@ticker`);
  }
  if (input.mark === true) {
    streams.push(`${symbol}@markPrice@1s`);
  }
  if (input.klineInterval !== undefined) {
    streams.push(`${symbol}@kline_${input.klineInterval}`);
  }
  return streams;
}

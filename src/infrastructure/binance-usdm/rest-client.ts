import {
  DEFAULT_RECV_WINDOW_MS,
  type BinanceEndpoints,
} from "./endpoints";
import {
  BinanceApiError,
  ClockSkewError,
  INVALID_TIMESTAMP,
  RateLimitError,
  UNKNOWN_EXECUTION_MESSAGE,
  UnknownExecutionError,
} from "./errors";
import { buildQuery, signQuery, type QueryValue } from "./signing";

export type HttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
};

export type HttpResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
};

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export type RestClientOptions = {
  endpoints: BinanceEndpoints;
  apiKey: string;
  apiSecret: string;
  recvWindowMs?: number;
  now?: () => number;
  http?: HttpClient;
};

async function defaultHttp(request: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

function parseJson(text: string): unknown {
  if (text.trim() === "") {
    return {};
  }
  return JSON.parse(text) as unknown;
}

function retryAfterMs(headers: HttpResponse["headers"]): number | undefined {
  const raw = headers.get("Retry-After");
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

export class BinanceRestClient {
  private readonly endpoints: BinanceEndpoints;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindowMs: number;
  private readonly now: () => number;
  private readonly http: HttpClient;
  private timeOffsetMs = 0;
  private synced = false;

  constructor(options: RestClientOptions) {
    this.endpoints = options.endpoints;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.recvWindowMs = options.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.http = options.http ?? defaultHttp;
  }

  get environment(): BinanceEndpoints {
    return this.endpoints;
  }

  timestamp(): number {
    return this.now() + this.timeOffsetMs;
  }

  async syncTime(): Promise<number> {
    const payload = asRecord(await this.publicGet("/fapi/v1/time"));
    const serverTime = Number(payload.serverTime);
    if (!Number.isFinite(serverTime)) {
      throw new ClockSkewError("serverTime missing from /fapi/v1/time");
    }
    this.timeOffsetMs = serverTime - this.now();
    this.synced = true;
    return serverTime;
  }

  async publicGet(
    path: string,
    params: Record<string, QueryValue> = {},
  ): Promise<unknown> {
    const query =
      Object.keys(params).length === 0 ? "" : `?${buildQuery(params)}`;
    return this.send({
      method: "GET",
      path: `${path}${query}`,
      headers: {},
    });
  }

  async apiKeyRequest(
    method: string,
    path: string,
  ): Promise<unknown> {
    return this.send({
      method,
      path,
      headers: { "X-MBX-APIKEY": this.apiKey },
    });
  }

  async signedRequest(
    method: string,
    path: string,
    params: Record<string, QueryValue> = {},
  ): Promise<unknown> {
    if (!this.synced) {
      await this.syncTime();
    }
    try {
      return await this.signedOnce(method, path, params);
    } catch (error) {
      if (error instanceof BinanceApiError && error.code === INVALID_TIMESTAMP) {
        await this.syncTime();
        return this.signedOnce(method, path, params);
      }
      throw error;
    }
  }

  private async signedOnce(
    method: string,
    path: string,
    params: Record<string, QueryValue>,
  ): Promise<unknown> {
    const signed = signQuery(
      {
        ...params,
        recvWindow: this.recvWindowMs,
        timestamp: this.timestamp(),
      },
      this.apiSecret,
    );
    const query = `${signed.query}&signature=${signed.signature}`;
    const headers = { "X-MBX-APIKEY": this.apiKey };
    if (method === "GET" || method === "DELETE") {
      return this.send({ method, path: `${path}?${query}`, headers });
    }
    return this.send({
      method,
      path,
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: query,
    });
  }

  private async send(input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<unknown> {
    const response = await this.http({
      method: input.method,
      url: `${this.endpoints.restBase}${input.path}`,
      headers: input.headers,
      body: input.body,
    });

    if (response.status === 429 || response.status === 418) {
      throw new RateLimitError(response.status, retryAfterMs(response.headers));
    }

    const payload = parseJson(response.text);
    if (response.status === 503) {
      const message =
        payload !== null &&
        typeof payload === "object" &&
        "msg" in payload &&
        typeof (payload as { msg: unknown }).msg === "string"
          ? (payload as { msg: string }).msg
          : response.text;
      if (message.includes(UNKNOWN_EXECUTION_MESSAGE)) {
        throw new UnknownExecutionError(message);
      }
    }

    if (
      payload !== null &&
      typeof payload === "object" &&
      "code" in payload &&
      typeof (payload as { code: unknown }).code === "number" &&
      (payload as { code: number }).code < 0
    ) {
      const code = (payload as { code: number }).code;
      const message =
        "msg" in payload && typeof (payload as { msg: unknown }).msg === "string"
          ? (payload as { msg: string }).msg
          : "binance error";
      throw new BinanceApiError(message, code, response.status);
    }

    if (response.status >= 400) {
      throw new BinanceApiError(
        `HTTP ${response.status}`,
        response.status,
        response.status,
      );
    }

    return payload;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClockSkewError("unexpected /fapi/v1/time payload");
  }
  return value as Record<string, unknown>;
}

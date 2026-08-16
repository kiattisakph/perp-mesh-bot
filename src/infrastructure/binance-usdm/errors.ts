export class BinanceApiError extends Error {
  readonly code: number;
  readonly httpStatus: number;

  constructor(message: string, code: number, httpStatus: number) {
    super(message);
    this.name = "BinanceApiError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ClockSkewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClockSkewError";
  }
}

export class HedgeModeError extends Error {
  constructor(message = "account is in Hedge Mode; v1 requires One-way") {
    super(message);
    this.name = "HedgeModeError";
  }
}

export class UnknownPrecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownPrecisionError";
  }
}

export class UnknownExecutionError extends Error {
  readonly httpStatus = 503;

  constructor(
    message = "Unknown error, please check your request or try again later.",
  ) {
    super(message);
    this.name = "UnknownExecutionError";
  }
}

export class RateLimitError extends Error {
  readonly httpStatus: number;
  readonly retryAfterMs?: number;

  constructor(httpStatus: number, retryAfterMs?: number) {
    super(`rate limited (${httpStatus})`);
    this.name = "RateLimitError";
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

export class MapperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapperError";
  }
}

export const NO_NEED_TO_CHANGE_MARGIN_TYPE = -4046;
export const INVALID_LISTEN_KEY = -1125;
export const INVALID_TIMESTAMP = -1021;

export const UNKNOWN_EXECUTION_MESSAGE =
  "Unknown error, please check your request or try again later.";

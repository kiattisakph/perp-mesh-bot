import { createHmac } from "node:crypto";

export type QueryValue = string | number | boolean;

export function decimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError("value must be finite");
  }
  const text = value.toFixed(16);
  if (!text.includes(".")) {
    return text;
  }
  return text.replace(/\.?0+$/, "");
}

export function encodeQueryValue(value: QueryValue): string {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return decimalString(value);
  }
  return value;
}

export function buildQuery(params: Record<string, QueryValue>): string {
  return Object.entries(params)
    .map(([key, value]) => `${key}=${encodeQueryValue(value)}`)
    .join("&");
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function signQuery(
  params: Record<string, QueryValue>,
  secret: string,
): { query: string; signature: string } {
  const query = buildQuery(params);
  const signature = hmacSha256Hex(secret, query);
  return { query, signature };
}

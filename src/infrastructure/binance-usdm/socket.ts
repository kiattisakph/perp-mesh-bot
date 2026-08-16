export type SocketListener = (...args: unknown[]) => void;

export type MinimalSocket = {
  on(event: "open" | "message" | "close" | "error", listener: SocketListener): void;
  close(): void;
};

export type WebSocketFactory = (url: string) => MinimalSocket;

export function messageText(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    return Buffer.concat(data).toString("utf8");
  }
  return String(data);
}

export function parseJsonMessage(data: unknown): unknown {
  return JSON.parse(messageText(data)) as unknown;
}

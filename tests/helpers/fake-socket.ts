export class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }

  on(
    event: "open" | "message" | "close" | "error",
    listener: (...args: unknown[]) => void,
  ): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  close(): void {
    this.emit("close");
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

export function fakeWebSocket(url: string): FakeSocket {
  return new FakeSocket(url);
}

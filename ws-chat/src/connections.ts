interface Limits {
  perSource: number;
  total: number;
}

// Соединение стоит памяти ещё до входа, поэтому их число ограничено и по
// каждому адресу, и в сумме: один источник не должен занимать весь сервер, а
// все вместе — не должны его исчерпать.
export class ConnectionLimiter {
  private readonly counts = new Map<string, number>();
  private live = 0;

  constructor(private readonly limits: Limits) {}

  allow(source: string): boolean {
    if (this.live >= this.limits.total) return false;
    const count = this.counts.get(source) ?? 0;
    if (count >= this.limits.perSource) return false;
    this.counts.set(source, count + 1);
    this.live++;
    return true;
  }

  release(source: string): void {
    const count = this.counts.get(source);
    if (!count) return;
    if (count === 1) this.counts.delete(source);
    else this.counts.set(source, count - 1);
    this.live--;
  }

  sources(): number {
    return this.counts.size;
  }
}

// Сокет, который открыли и не представились: heartbeat его не заметит, потому
// что на пинги он отвечает исправно.
export function isAbandoned(client: { nick: string | null; authDeadline?: number }, now: number): boolean {
  if (client.nick || client.authDeadline === undefined) return false;
  return client.authDeadline <= now;
}

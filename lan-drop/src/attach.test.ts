import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachSignaling } from './attach.ts';
import type { ServerMessage } from './protocol.ts';

class FakeWs extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sent: ServerMessage[] = [];
  terminated = false;
  closed = false;
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
  }
}

class FakeWss extends EventEmitter {
  clients = new Set<FakeWs>();
  connect(ws: FakeWs) {
    this.clients.add(ws);
    this.emit('connection', ws);
  }
}

function welcomeId(ws: FakeWs): string {
  const welcome = ws.sent.find((m) => m.type === 'welcome');
  return welcome && welcome.type === 'welcome' ? welcome.id : '';
}

describe('attachSignaling', () => {
  let wss: FakeWss;

  beforeEach(() => {
    wss = new FakeWss();
    attachSignaling(wss as never);
  });

  it('шлёт welcome с именем и id при подключении', () => {
    const ws = new FakeWs();
    wss.connect(ws);
    const welcome = ws.sent.find((m) => m.type === 'welcome');
    expect(welcome).toMatchObject({ type: 'welcome', id: '1' });
    expect(welcome && welcome.type === 'welcome' && welcome.name.length).toBeGreaterThan(0);
  });

  it('сводит двух пиров и роутит сигнал между ними', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    wss.connect(a);
    wss.connect(b);
    expect(a.sent.some((m) => m.type === 'peer-joined')).toBe(true);

    a.emit('message', JSON.stringify({ type: 'signal', to: welcomeId(b), data: { sdp: 'x' } }));
    expect(b.sent.at(-1)).toEqual({ type: 'signal', from: welcomeId(a), data: { sdp: 'x' } });
  });

  it('снимает пира из реестра на close', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    wss.connect(a);
    wss.connect(b);
    a.emit('close');
    expect(b.sent.at(-1)).toEqual({ type: 'peer-left', id: welcomeId(a) });
  });
});

describe('attachSignaling с проверкой доступа', () => {
  let wss: FakeWss;
  let seen: string[];

  beforeEach(() => {
    wss = new FakeWss();
    seen = [];
    attachSignaling(wss as never, {
      authenticate: (raw) => {
        seen.push(raw);
        const parsed = JSON.parse(raw);
        return parsed.token === 'good' ? { name: `пир ${parsed.token}` } : null;
      },
    });
  });

  it('молчит до предъявления пропуска', () => {
    const ws = new FakeWs();
    wss.connect(ws);
    expect(ws.sent).toEqual([]);
  });

  it('впускает по валидному пропуску и берёт имя от хоста', () => {
    const ws = new FakeWs();
    wss.connect(ws);
    ws.emit('message', JSON.stringify({ token: 'good' }));

    expect(seen).toHaveLength(1);
    expect(ws.sent.find((m) => m.type === 'welcome')).toMatchObject({ type: 'welcome', name: 'пир good' });
  });

  it('отбривает негодный пропуск и закрывает сокет', () => {
    const ws = new FakeWs();
    wss.connect(ws);
    ws.emit('message', JSON.stringify({ token: 'bad' }));

    expect(ws.sent.at(-1)).toEqual({ type: 'error', reason: 'Нет доступа' });
    expect(ws.closed).toBe(true);
    expect(ws.sent.some((m) => m.type === 'welcome')).toBe(false);
  });

  it('не пускает сигналы мимо проверки', () => {
    const a = new FakeWs();
    const b = new FakeWs();
    wss.connect(a);
    wss.connect(b);
    a.emit('message', JSON.stringify({ token: 'good' }));

    const outsider = new FakeWs();
    wss.connect(outsider);
    outsider.emit('message', JSON.stringify({ type: 'signal', to: welcomeId(a), data: { sdp: 'x' } }));

    expect(a.sent.some((m) => m.type === 'signal')).toBe(false);
    expect(outsider.closed).toBe(true);
  });

  it('не даёт непредставившимся висеть вечно', () => {
    vi.useFakeTimers();
    const silentWss = new FakeWss();
    attachSignaling(silentWss as never, { authenticate: () => null, authTimeoutMs: 5000 });
    const ws = new FakeWs();
    silentWss.connect(ws);

    vi.advanceTimersByTime(5000);
    expect(ws.terminated).toBe(true);
    vi.useRealTimers();
  });
});

describe('attachSignaling heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('пингует живых и обрывает не ответивших pong', () => {
    const wss = new FakeWss();
    attachSignaling(wss as never, { heartbeatMs: 1000 });
    const ws = new FakeWs();
    wss.connect(ws);

    vi.advanceTimersByTime(1000);
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(ws.terminated).toBe(true);
  });

  it('не обрывает пира, ответившего pong', () => {
    const wss = new FakeWss();
    attachSignaling(wss as never, { heartbeatMs: 1000 });
    const ws = new FakeWs();
    wss.connect(ws);

    vi.advanceTimersByTime(1000);
    ws.emit('pong');
    vi.advanceTimersByTime(1000);
    expect(ws.terminated).toBe(false);
  });

  it('stop() останавливает heartbeat и отписывается от connection', () => {
    const wss = new FakeWss();
    const stop = attachSignaling(wss as never, { heartbeatMs: 1000 });
    stop();

    const ws = new FakeWs();
    wss.connect(ws);
    vi.advanceTimersByTime(3000);
    expect(ws.sent.length).toBe(0);
    expect(ws.pings).toBe(0);
  });
});

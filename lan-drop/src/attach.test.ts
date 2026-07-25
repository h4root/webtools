import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { attachSignaling } from './attach.ts';
import type { ServerMessage } from './protocol.ts';

class FakeWs extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  sent: ServerMessage[] = [];
  terminated = false;
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data));
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

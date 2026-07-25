import { describe, it, expect, beforeEach } from 'vitest';
import { Hub, type Client } from './chat.ts';
import type { ServerMessage } from './protocol.ts';

type TestClient = Client & { inbox: ServerMessage[] };

function makeClient(id: string): TestClient {
  const inbox: ServerMessage[] = [];
  return {
    id,
    nick: null,
    inbox,
    send(message) {
      inbox.push(message);
    },
  };
}

function lastPresence(client: TestClient): string[] | undefined {
  for (let i = client.inbox.length - 1; i >= 0; i--) {
    const message = client.inbox[i];
    if (message.type === 'presence') return message.users;
  }
  return undefined;
}

function chatCount(client: TestClient, text: string): number {
  return client.inbox.filter((m) => m.type === 'chat' && m.text === text).length;
}

describe('Hub', () => {
  let hub: Hub;

  beforeEach(() => {
    hub = new Hub();
  });

  it('принимает валидный ник и шлёт welcome', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    expect(a.nick).toBe('alice');
    expect(a.inbox.some((m) => m.type === 'welcome' && m.nick === 'alice')).toBe(true);
  });

  it('отклоняет занятый ник без учёта регистра', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'Alice');
    expect(b.nick).toBeNull();
    expect(b.inbox.at(-1)).toEqual({ type: 'error', reason: 'Ник уже занят' });
  });

  it('рассылает публичное сообщение всем', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'public', text: 'hi all' }));
    expect(chatCount(a, 'hi all')).toBe(1);
    expect(chatCount(b, 'hi all')).toBe(1);
  });

  it('доставляет личное сообщение только отправителю и получателю', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const c = makeClient('c');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.join(c, 'carol');
    hub.handle(a, JSON.stringify({ type: 'direct', to: 'bob', text: 'psst' }));
    expect(chatCount(a, 'psst')).toBe(1);
    expect(chatCount(b, 'psst')).toBe(1);
    expect(chatCount(c, 'psst')).toBe(0);
  });

  it('маршрутизирует ЛС без учёта регистра ника', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'Bob');
    hub.handle(a, JSON.stringify({ type: 'direct', to: 'bob', text: 'hey' }));
    expect(chatCount(a, 'hey')).toBe(1);
    expect(chatCount(b, 'hey')).toBe(1);
  });

  it('возвращает ошибку при личном сообщении несуществующему нику', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'direct', to: 'ghost', text: 'hey' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'ghost не в сети' });
  });

  it('обновляет presence на вход и выход', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    expect(lastPresence(a)).toEqual(['alice', 'bob']);
    hub.leave(b);
    expect(lastPresence(a)).toEqual(['alice']);
  });

  it('игнорирует битые сообщения', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, '{not json');
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Некорректное сообщение' });
    expect(a.inbox.some((m) => m.type === 'chat')).toBe(false);
  });

  it('требует hello до отправки сообщений', () => {
    const a = makeClient('a');
    hub.handle(a, JSON.stringify({ type: 'public', text: 'hi' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Сначала представьтесь (hello)' });
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { Signaling, type Peer } from './signaling.ts';
import type { ServerMessage } from './protocol.ts';

type TestPeer = Peer & { inbox: ServerMessage[] };

function makePeer(id: string): TestPeer {
  const inbox: ServerMessage[] = [];
  return {
    id,
    name: `peer-${id}`,
    inbox,
    send(message) {
      inbox.push(message);
    },
  };
}

function lastPeers(peer: TestPeer): string[] | undefined {
  for (let i = peer.inbox.length - 1; i >= 0; i--) {
    const message = peer.inbox[i];
    if (message.type === 'peers') return message.peers.map((p) => p.id);
  }
  return undefined;
}

describe('Signaling', () => {
  let hub: Signaling;

  beforeEach(() => {
    hub = new Signaling();
  });

  it('шлёт welcome и список уже подключённых пиров', () => {
    const a = makePeer('1');
    const b = makePeer('2');
    hub.join(a);
    hub.join(b);
    expect(a.inbox.some((m) => m.type === 'welcome' && m.id === '1')).toBe(true);
    expect(lastPeers(b)).toEqual(['1']);
  });

  it('уведомляет остальных о входе и выходе', () => {
    const a = makePeer('1');
    const b = makePeer('2');
    hub.join(a);
    hub.join(b);
    expect(a.inbox.some((m) => m.type === 'peer-joined' && m.peer.id === '2')).toBe(true);
    hub.leave(b);
    expect(a.inbox.at(-1)).toEqual({ type: 'peer-left', id: '2' });
  });

  it('пересылает сигнал только адресату', () => {
    const a = makePeer('1');
    const b = makePeer('2');
    const c = makePeer('3');
    hub.join(a);
    hub.join(b);
    hub.join(c);
    hub.handle(a, JSON.stringify({ type: 'signal', to: '2', data: { sdp: 'offer' } }));
    expect(b.inbox.at(-1)).toEqual({ type: 'signal', from: '1', data: { sdp: 'offer' } });
    expect(c.inbox.some((m) => m.type === 'signal')).toBe(false);
  });

  it('возвращает ошибку на сигнал несуществующему пиру', () => {
    const a = makePeer('1');
    hub.join(a);
    hub.handle(a, JSON.stringify({ type: 'signal', to: '99', data: {} }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Пир недоступен' });
  });

  it('возвращает ошибку на сигнал самому себе', () => {
    const a = makePeer('1');
    hub.join(a);
    hub.handle(a, JSON.stringify({ type: 'signal', to: '1', data: {} }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Пир недоступен' });
  });

  it('игнорирует битые сообщения', () => {
    const a = makePeer('1');
    hub.join(a);
    hub.handle(a, '{not json');
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Некорректное сообщение' });
  });
});

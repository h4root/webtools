import { describe, it, expect, beforeEach } from 'vitest';
import { Hub, type Client } from './chat.ts';
import { Store } from './store.ts';
import type { ServerMessage } from './protocol.ts';

type TestClient = Client & { inbox: ServerMessage[]; closed: boolean };

function makeClient(id: string): TestClient {
  const inbox: ServerMessage[] = [];
  return {
    id,
    nick: null,
    token: `token-${id}`,
    inbox,
    closed: false,
    send(message) {
      inbox.push(message);
    },
    close() {
      this.closed = true;
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

function msgCount(client: TestClient, text: string): number {
  return client.inbox.filter((m) => m.type === 'message' && m.msg.text === text).length;
}

function lastMessage(client: TestClient) {
  for (let i = client.inbox.length - 1; i >= 0; i--) {
    const m = client.inbox[i];
    if (m.type === 'message') return m.msg;
  }
  return undefined;
}

function channelsList(client: TestClient): string[] | undefined {
  for (let i = client.inbox.length - 1; i >= 0; i--) {
    const m = client.inbox[i];
    if (m.type === 'channels') return m.list;
  }
  return undefined;
}

describe('Hub', () => {
  let hub: Hub;

  beforeEach(() => {
    hub = new Hub();
  });

  it('принимает валидный ник, шлёт welcome и список каналов', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    expect(a.nick).toBe('alice');
    expect(a.inbox.some((m) => m.type === 'welcome' && m.nick === 'alice')).toBe(true);
    expect(channelsList(a)).toContain('general');
  });

  it('отклоняет занятый ник без учёта регистра', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'Alice');
    expect(b.nick).toBeNull();
    expect(b.inbox.at(-1)).toEqual({ type: 'error', reason: 'Ник уже занят' });
  });

  it('рассылает сообщение канала всем и присваивает id', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'hi all' }));
    expect(msgCount(a, 'hi all')).toBe(1);
    expect(msgCount(b, 'hi all')).toBe(1);
    expect(lastMessage(b)).toMatchObject({ channel: 'general', from: 'alice', edited: false });
    expect(typeof lastMessage(b)?.id).toBe('number');
  });

  it('отклоняет сообщение в несуществующий канал', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'ghost', text: 'x' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Нет такого канала' });
  });

  it('доставляет ЛС только отправителю и получателю (без учёта регистра)', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const c = makeClient('c');
    hub.join(a, 'alice');
    hub.join(b, 'Bob');
    hub.join(c, 'carol');
    hub.handle(a, JSON.stringify({ type: 'message', to: 'bob', text: 'psst' }));
    expect(msgCount(a, 'psst')).toBe(1);
    expect(msgCount(b, 'psst')).toBe(1);
    expect(msgCount(c, 'psst')).toBe(0);
    expect(lastMessage(b)).toMatchObject({ from: 'alice', to: 'Bob' });
  });

  it('принимает ЛС офлайн-адресату и отдаёт ему при следующем заходе', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'message', to: 'bob', text: 'вернёшься — прочитаешь' }));

    expect(a.inbox.some((m) => m.type === 'error')).toBe(false);
    expect(lastMessage(a)).toMatchObject({ from: 'alice', to: 'bob', text: 'вернёшься — прочитаешь' });

    const b = makeClient('b');
    hub.join(b, 'bob');
    hub.handle(b, JSON.stringify({ type: 'history', to: 'alice' }));
    const hist = b.inbox.at(-1);
    expect(hist?.type === 'history' && hist.messages.map((m) => m.text)).toEqual(['вернёшься — прочитаешь']);
  });

  it('показывает собеседников по переписке, а не по тому, кто сейчас онлайн', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'message', to: 'bob', text: 'привет' }));
    hub.leave(a);

    const again = makeClient('a2');
    hub.join(again, 'alice');
    const dms = again.inbox.find((m) => m.type === 'dms');
    expect(dms?.type === 'dms' && dms.list.map((d) => d.nick)).toEqual(['bob']);
  });

  it('отдаёт историю канала', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'one' }));
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'two' }));
    hub.handle(a, JSON.stringify({ type: 'history', channel: 'general' }));
    const hist = a.inbox.at(-1);
    expect(hist?.type).toBe('history');
    expect(hist && hist.type === 'history' && hist.messages.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('создаёт канал и рассылает обновлённый список', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'channel-create', name: 'dev' }));
    expect(channelsList(a)).toContain('dev');
    expect(channelsList(b)).toContain('dev');
  });

  it('не создаёт дубликат канала', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'channel-create', name: 'general' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Канал уже существует или их слишком много' });
  });

  it('редактирует своё сообщение и рассылает edited', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'typo' }));
    const id = lastMessage(a)!.id;
    hub.handle(a, JSON.stringify({ type: 'edit', id, text: 'fixed' }));
    expect(b.inbox.at(-1)).toEqual({ type: 'edited', id, text: 'fixed' });
  });

  it('не даёт редактировать чужое сообщение', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'mine' }));
    const id = lastMessage(a)!.id;
    hub.handle(b, JSON.stringify({ type: 'edit', id, text: 'hacked' }));
    expect(b.inbox.some((m) => m.type === 'edited')).toBe(false);
  });

  it('удаляет своё сообщение и рассылает deleted', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'bye' }));
    const id = lastMessage(a)!.id;
    hub.handle(a, JSON.stringify({ type: 'delete', id }));
    expect(b.inbox.at(-1)).toEqual({ type: 'deleted', id });
  });

  it('рассылает реакцию всем в канале и переключает её', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'react me' }));
    const id = lastMessage(a)!.id;
    hub.handle(b, JSON.stringify({ type: 'react', id, emoji: '🔥' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'reaction', id, reactions: { '🔥': ['bob'] } });
    hub.handle(b, JSON.stringify({ type: 'react', id, emoji: '🔥' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'reaction', id, reactions: {} });
  });

  it('пересылает сообщение с ответом и вложением', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'first' }));
    const firstId = lastMessage(a)!.id;
    hub.handle(
      b,
      JSON.stringify({
        type: 'message',
        channel: 'general',
        text: 're',
        replyTo: firstId,
        attachments: [{ id: 'aabbccddeeff00112233445566778899', name: 'p.png', size: 5, mime: 'image/png' }],
      }),
    );
    const msg = lastMessage(a)!;
    expect(msg.replyTo).toEqual({ id: firstId, from: 'alice', text: 'first' });
    expect(msg.attachments?.[0].url).toBe('/uploads/aabbccddeeff00112233445566778899');
  });

  it('принимает сообщение без текста, но с вложением', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(
      a,
      JSON.stringify({
        type: 'message',
        channel: 'general',
        attachments: [{ id: '00112233445566778899aabbccddeeff', name: 'p.png', size: 5, mime: 'image/png' }],
      }),
    );
    expect(lastMessage(a)?.attachments).toHaveLength(1);
  });

  it('не отдаёт занятый ник тому, у кого нет токена прошлой сессии', () => {
    const a = makeClient('a');
    const impostor = makeClient('impostor');
    hub.join(a, 'alice');

    hub.handle(impostor, JSON.stringify({ type: 'hello', nick: 'alice' }));
    hub.handle(impostor, JSON.stringify({ type: 'hello', nick: 'alice', resume: 'угадайка' }));

    expect(impostor.nick).toBeNull();
    expect(impostor.inbox.filter((m) => m.type === 'error' && m.reason === 'Ник уже занят')).toHaveLength(2);
    expect(a.closed).toBe(false);
  });

  it('пускает переподключение с тем же ником по токену прошлой сессии', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    const welcome = a.inbox.find((m) => m.type === 'welcome');
    const token = welcome?.type === 'welcome' ? welcome.token : '';

    const again = makeClient('a2');
    hub.handle(again, JSON.stringify({ type: 'hello', nick: 'alice', resume: token }));

    expect(again.nick).toBe('alice');
    expect(a.closed).toBe(true);
    expect(lastPresence(again)).toEqual(['alice']);
  });

  it('берёт размер и mime вложения из блоба, а не из слов клиента', () => {
    const blobs = {
      stat: (id: string) => (id === 'a'.repeat(32) ? { id, size: 4242, mime: 'image/png' } : null),
    };
    const withBlobs = new Hub(new Store(), blobs);
    const a = makeClient('a');
    withBlobs.join(a, 'alice');

    withBlobs.handle(
      a,
      JSON.stringify({
        type: 'message',
        channel: 'general',
        attachments: [
          { id: 'a'.repeat(32), name: 'p.png', size: 1, mime: 'text/html' },
          { id: 'b'.repeat(32), name: 'нет такого.png', size: 5, mime: 'image/png' },
        ],
      }),
    );

    expect(lastMessage(a)?.attachments).toEqual([
      { url: `/uploads/${'a'.repeat(32)}`, name: 'p.png', size: 4242, mime: 'image/png' },
    ]);
  });

  it('отклоняет сообщение, у которого всё вложения оказались несуществующими', () => {
    const withBlobs = new Hub(new Store(), { stat: () => null });
    const a = makeClient('a');
    withBlobs.join(a, 'alice');

    withBlobs.handle(
      a,
      JSON.stringify({
        type: 'message',
        channel: 'general',
        attachments: [{ id: 'c'.repeat(32), name: 'p.png', size: 5, mime: 'image/png' }],
      }),
    );

    expect(lastMessage(a)).toBeUndefined();
    expect(a.inbox.some((m) => m.type === 'error' && m.reason === 'Вложение не найдено')).toBe(true);
  });

  it('ретранслирует typing другим в канале, но не себе', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'typing', channel: 'general' }));
    expect(b.inbox.at(-1)).toEqual({ type: 'typing', from: 'alice', channel: 'general' });
    expect(a.inbox.some((m) => m.type === 'typing')).toBe(false);
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
    expect(a.inbox.some((m) => m.type === 'message')).toBe(false);
  });

  it('требует hello до отправки сообщений', () => {
    const a = makeClient('a');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'hi' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Сначала представьтесь (hello)' });
  });
});

function voicePresence(client: TestClient): Record<string, string[]> | undefined {
  for (let i = client.inbox.length - 1; i >= 0; i--) {
    const message = client.inbox[i];
    if (message.type === 'voice-presence') return message.channels;
  }
  return undefined;
}

function voiceRoster(client: TestClient) {
  const message = client.inbox.find((m) => m.type === 'voice-roster');
  return message && message.type === 'voice-roster' ? { channel: message.channel, users: message.users } : undefined;
}

describe('Hub voice channels', () => {
  let hub: Hub;

  beforeEach(() => {
    hub = new Hub();
  });

  it('шлёт список голосовых каналов при входе', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    const vc = a.inbox.find((m) => m.type === 'voice-channels');
    expect(vc && vc.type === 'voice-channels' && vc.list).toContain('general');
  });

  it('первому в канале — пустой roster, второму — первого', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(b, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    expect(voiceRoster(a)).toEqual({ channel: 'general', users: [] });
    expect(voiceRoster(b)).toEqual({ channel: 'general', users: ['alice'] });
  });

  it('presence раскладывает участников по каналам', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(b, JSON.stringify({ type: 'voice-join', channel: 'games' }));
    const p = voicePresence(a);
    expect(p?.general).toEqual(['alice']);
    expect(p?.games).toEqual(['bob']);
  });

  it('сигнал ходит только внутри одного канала', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const c = makeClient('c');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.join(c, 'carol');
    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(b, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(c, JSON.stringify({ type: 'voice-join', channel: 'games' }));
    hub.handle(a, JSON.stringify({ type: 'voice-signal', to: 'bob', data: { kind: 'offer' } }));
    expect(b.inbox.at(-1)).toEqual({ type: 'voice-signal', from: 'alice', data: { kind: 'offer' } });
    hub.handle(a, JSON.stringify({ type: 'voice-signal', to: 'carol', data: { kind: 'offer' } }));
    expect(c.inbox.some((m) => m.type === 'voice-signal')).toBe(false);
  });

  it('игнорирует сигнал от того, кто не в голосе', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(b, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(a, JSON.stringify({ type: 'voice-signal', to: 'bob', data: { kind: 'offer' } }));
    expect(b.inbox.some((m) => m.type === 'voice-signal')).toBe(false);
  });

  it('обновляет presence на leave и на выход из чата', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(b, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(b, JSON.stringify({ type: 'voice-leave' }));
    expect(voicePresence(a)?.general).toEqual(['alice']);
    hub.leave(a);
    expect(voicePresence(b)?.general).toEqual([]);
  });

  it('создаёт голосовой канал и рассылает список', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'voice-channel-create', name: 'music' }));
    const vc = [...a.inbox].reverse().find((m) => m.type === 'voice-channels');
    expect(vc && vc.type === 'voice-channels' && vc.list).toContain('music');
  });
});

describe('Hub private call', () => {
  let hub: Hub;

  beforeEach(() => {
    hub = new Hub();
  });

  it('пересылает приглашение адресату с ником звонящего', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'call-invite', to: 'bob' }));
    expect(b.inbox.at(-1)).toEqual({ type: 'call-invite', from: 'alice' });
  });

  it('сообщает звонящему, если адресат не в сети', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'call-invite', to: 'ghost' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-end', from: 'ghost', reason: 'offline' });
  });

  it('пересылает accept, signal и end адресату', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(b, JSON.stringify({ type: 'call-accept', to: 'alice' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-accept', from: 'bob' });
    hub.handle(a, JSON.stringify({ type: 'call-signal', to: 'bob', data: { kind: 'offer' } }));
    expect(b.inbox.at(-1)).toEqual({ type: 'call-signal', from: 'alice', data: { kind: 'offer' } });
    hub.handle(b, JSON.stringify({ type: 'call-end', to: 'alice' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-end', from: 'bob' });
  });

  it('передаёт причину отклонения', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(b, JSON.stringify({ type: 'call-decline', to: 'alice', reason: 'busy' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-decline', from: 'bob', reason: 'busy' });
  });
});

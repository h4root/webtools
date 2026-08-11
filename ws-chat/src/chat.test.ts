import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, ACTIONS_PER_WINDOW, RATE_WINDOW_MS, type Client } from './chat.ts';
import { Store, channelKey } from './store.ts';
import { Auth } from './auth.ts';
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
  let store: Store;

  beforeEach(() => {
    store = new Store();
    hub = new Hub(store);
  });

  it('принимает валидный ник, шлёт welcome и список каналов', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    expect(a.nick).toBe('alice');
    expect(a.inbox.some((m) => m.type === 'welcome' && m.nick === 'alice')).toBe(true);
    expect(channelsList(a)).toContain('general');
  });

  it('пускает два устройства одного аккаунта одновременно', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    expect(laptop.closed).toBe(false);
    expect(phone.nick).toBe('alice');

    hub.handle(phone, JSON.stringify({ type: 'message', channel: 'general', text: 'с телефона' }));
    expect(lastMessage(laptop)?.text).toBe('с телефона');
    expect(lastMessage(phone)?.text).toBe('с телефона');
  });

  it('показывает ник в присутствии один раз, сколько бы устройств ни было', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    const bob = makeClient('bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'Alice');
    hub.join(bob, 'bob');

    expect(lastPresence(bob)).toEqual(['alice', 'bob']);
  });

  it('объявляет о приходе только на первом устройстве', () => {
    const bob = makeClient('bob');
    hub.join(bob, 'bob');
    const laptop = makeClient('laptop');
    hub.join(laptop, 'alice');
    const before = bob.inbox.filter((m) => m.type === 'system').length;

    hub.join(makeClient('phone'), 'alice');
    expect(bob.inbox.filter((m) => m.type === 'system')).toHaveLength(before);
  });

  it('объявляет об уходе только когда ушло последнее устройство', () => {
    const bob = makeClient('bob');
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(bob, 'bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.leave(laptop);
    expect(bob.inbox.some((m) => m.type === 'system' && m.text.includes('вышел'))).toBe(false);
    expect(lastPresence(bob)).toEqual(['alice', 'bob']);

    hub.leave(phone);
    expect(bob.inbox.some((m) => m.type === 'system' && m.text.includes('вышел'))).toBe(true);
    expect(lastPresence(bob)).toEqual(['bob']);
  });

  it('доставляет личное сообщение на все устройства обеих сторон', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    const bob = makeClient('bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');
    hub.join(bob, 'bob');

    hub.handle(bob, JSON.stringify({ type: 'message', to: 'alice', text: 'только вам двоим' }));

    expect(lastMessage(laptop)?.text).toBe('только вам двоим');
    expect(lastMessage(phone)?.text).toBe('только вам двоим');
  });

  it('считает бюджет флуда на аккаунт, а не на сокет', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    for (let i = 0; i < ACTIONS_PER_WINDOW; i++) {
      hub.handle(laptop, JSON.stringify({ type: 'message', channel: 'general', text: `раз ${i}` }));
    }
    hub.handle(phone, JSON.stringify({ type: 'message', channel: 'general', text: 'через второе устройство' }));

    expect(store.history(channelKey('general'))).toHaveLength(ACTIONS_PER_WINDOW);
    expect(phone.inbox.at(-1)).toEqual({ type: 'error', reason: 'Слишком часто' });
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

  it('обрывает поток сообщений, когда бюджет исчерпан', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');

    for (let i = 0; i < ACTIONS_PER_WINDOW; i++) {
      hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: `раз ${i}` }));
    }
    expect(store.history(channelKey('general'))).toHaveLength(ACTIONS_PER_WINDOW);

    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'лишнее' }));
    expect(store.history(channelKey('general'))).toHaveLength(ACTIONS_PER_WINDOW);
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Слишком часто' });
  });

  it('не заваливает нарушителя ошибками на каждое сообщение', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    for (let i = 0; i < ACTIONS_PER_WINDOW + 20; i++) {
      hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'спам' }));
    }
    expect(a.inbox.filter((m) => m.type === 'error' && m.reason === 'Слишком часто')).toHaveLength(1);
  });

  it('открывает бюджет заново, когда окно прошло', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const a = makeClient('a');
      hub.join(a, 'alice');
      for (let i = 0; i < ACTIONS_PER_WINDOW + 5; i++) {
        hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'поток' }));
      }
      vi.setSystemTime(Date.now() + RATE_WINDOW_MS + 100);
      hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'снова можно' }));
      expect(lastMessage(a)?.text).toBe('снова можно');
    } finally {
      vi.useRealTimers();
    }
  });

  it('не режет сигналинг по бюджету обычных действий', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(b, JSON.stringify({ type: 'voice-join', channel: 'general' }));

    for (let i = 0; i < ACTIONS_PER_WINDOW * 2; i++) {
      hub.handle(a, JSON.stringify({ type: 'voice-signal', to: 'bob', data: { kind: 'ice', i } }));
    }
    expect(b.inbox.filter((m) => m.type === 'voice-signal').length).toBe(ACTIONS_PER_WINDOW * 2);
  });

  it('считает бюджет по каждому отдельно', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    for (let i = 0; i < ACTIONS_PER_WINDOW + 5; i++) {
      hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'от alice' }));
    }

    hub.handle(b, JSON.stringify({ type: 'message', channel: 'general', text: 'от bob' }));
    expect(lastMessage(b)?.text).toBe('от bob');
  });

  it('не держит счётчики ушедших', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'привет' }));
    hub.leave(a);
    expect(hub.rateEntries()).toBe(0);
  });

  it('вход в голос со второго устройства выводит первое', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.handle(laptop, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(phone, JSON.stringify({ type: 'voice-join', channel: 'general' }));

    expect(laptop.inbox.some((m) => m.type === 'voice-left')).toBe(true);
    expect(voicePresence(phone)?.general).toEqual(['alice']);
  });

  it('выводит из голоса и при переходе в другой канал с другого устройства', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.handle(laptop, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(phone, JSON.stringify({ type: 'voice-join', channel: 'games' }));

    expect(laptop.inbox.some((m) => m.type === 'voice-left')).toBe(true);
    expect(voicePresence(phone)?.general).toEqual([]);
    expect(voicePresence(phone)?.games).toEqual(['alice']);
  });

  it('смена канала на том же устройстве не считается переводом', () => {
    const a = makeClient('a');
    hub.join(a, 'alice');

    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(a, JSON.stringify({ type: 'voice-join', channel: 'games' }));

    expect(a.inbox.some((m) => m.type === 'voice-left')).toBe(false);
    expect(voicePresence(a)?.games).toEqual(['alice']);
  });

  it('сигналинг доходит до того устройства, которое сейчас в канале', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    const bob = makeClient('bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');
    hub.join(bob, 'bob');

    hub.handle(laptop, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(phone, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(bob, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(bob, JSON.stringify({ type: 'voice-signal', to: 'alice', data: { kind: 'offer' } }));

    expect(phone.inbox.some((m) => m.type === 'voice-signal')).toBe(true);
    expect(laptop.inbox.some((m) => m.type === 'voice-signal')).toBe(false);
  });

  it('новичок видит каждого участника один раз', () => {
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    const bob = makeClient('bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');
    hub.join(bob, 'bob');

    hub.handle(laptop, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(phone, JSON.stringify({ type: 'voice-join', channel: 'general' }));
    hub.handle(bob, JSON.stringify({ type: 'voice-join', channel: 'general' }));

    const roster = bob.inbox.filter((m) => m.type === 'voice-roster').at(-1);
    expect(roster?.type === 'voice-roster' && roster.users).toEqual(['alice']);
  });

  it('звонит на все устройства адресата', () => {
    const caller = makeClient('caller');
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(caller, 'bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'alice' }));

    expect(laptop.inbox.some((m) => m.type === 'call-invite' && m.from === 'bob')).toBe(true);
    expect(phone.inbox.some((m) => m.type === 'call-invite' && m.from === 'bob')).toBe(true);
  });

  it('первое принявшее устройство забирает звонок, остальным отбой', () => {
    const caller = makeClient('caller');
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(caller, 'bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'alice' }));
    hub.handle(phone, JSON.stringify({ type: 'call-accept', to: 'bob' }));

    expect(caller.inbox.some((m) => m.type === 'call-accept' && m.from === 'alice')).toBe(true);
    expect(laptop.inbox.some((m) => m.type === 'call-end' && m.reason === 'answered-elsewhere')).toBe(true);
    expect(phone.inbox.some((m) => m.type === 'call-end')).toBe(false);
  });

  it('ответ приходит на то устройство, с которого звонили', () => {
    const callerLaptop = makeClient('caller-laptop');
    const callerPhone = makeClient('caller-phone');
    const alice = makeClient('alice');
    hub.join(callerLaptop, 'bob');
    hub.join(callerPhone, 'bob');
    hub.join(alice, 'alice');

    hub.handle(callerPhone, JSON.stringify({ type: 'call-invite', to: 'alice' }));
    hub.handle(alice, JSON.stringify({ type: 'call-accept', to: 'bob' }));

    expect(callerPhone.inbox.some((m) => m.type === 'call-accept')).toBe(true);
    expect(callerLaptop.inbox.some((m) => m.type === 'call-accept')).toBe(false);
  });

  it('сигналинг идёт в соединение собеседника, а не по нику', () => {
    const caller = makeClient('caller');
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(caller, 'bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'alice' }));
    hub.handle(phone, JSON.stringify({ type: 'call-accept', to: 'bob' }));
    hub.handle(caller, JSON.stringify({ type: 'call-signal', to: 'alice', data: { kind: 'offer' } }));

    expect(phone.inbox.some((m) => m.type === 'call-signal')).toBe(true);
    expect(laptop.inbox.some((m) => m.type === 'call-signal')).toBe(false);
  });

  it('отказ на одном устройстве отменяет звонок целиком', () => {
    const caller = makeClient('caller');
    const laptop = makeClient('laptop');
    const phone = makeClient('phone');
    hub.join(caller, 'bob');
    hub.join(laptop, 'alice');
    hub.join(phone, 'alice');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'alice' }));
    hub.handle(laptop, JSON.stringify({ type: 'call-decline', to: 'bob' }));

    expect(caller.inbox.some((m) => m.type === 'call-decline' && m.from === 'alice')).toBe(true);
    expect(phone.inbox.some((m) => m.type === 'call-end' && m.reason === 'answered-elsewhere')).toBe(true);
  });

  it('звонок офлайн-адресату сразу возвращает отбой', () => {
    const caller = makeClient('caller');
    hub.join(caller, 'bob');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'призрак' }));
    expect(caller.inbox.at(-1)).toEqual({ type: 'call-end', from: 'призрак', reason: 'offline' });
  });

  it('уход собеседника завершает разговор у второго', () => {
    const caller = makeClient('caller');
    const alice = makeClient('alice');
    hub.join(caller, 'bob');
    hub.join(alice, 'alice');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'alice' }));
    hub.handle(alice, JSON.stringify({ type: 'call-accept', to: 'bob' }));
    hub.leave(alice);

    expect(caller.inbox.some((m) => m.type === 'call-end' && m.from === 'alice')).toBe(true);
  });

  it('после завершения сигналинг больше никуда не идёт', () => {
    const caller = makeClient('caller');
    const alice = makeClient('alice');
    hub.join(caller, 'bob');
    hub.join(alice, 'alice');

    hub.handle(caller, JSON.stringify({ type: 'call-invite', to: 'alice' }));
    hub.handle(alice, JSON.stringify({ type: 'call-accept', to: 'bob' }));
    hub.handle(caller, JSON.stringify({ type: 'call-end', to: 'alice' }));

    const before = alice.inbox.length;
    hub.handle(caller, JSON.stringify({ type: 'call-signal', to: 'alice', data: { kind: 'ice' } }));
    expect(alice.inbox).toHaveLength(before);
  });

  it('требует входа до отправки сообщений', () => {
    const a = makeClient('a');
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'hi' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'error', reason: 'Сначала войди' });
  });
});

describe('Hub: вход и выход', () => {
  let dir: string;
  let store: Store;
  let hub: Hub;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-hub-auth-'));
    store = new Store();
    hub = new Hub(store, undefined, new Auth(dir));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function auth(client: TestClient, body: object): Promise<void> {
    hub.handle(client, JSON.stringify({ type: 'auth', ...body }));
    await vi.waitFor(() => {
      expect(client.inbox.some((m) => m.type === 'welcome' || m.type === 'auth-error')).toBe(true);
    });
  }

  function welcomeOf(client: TestClient) {
    const message = client.inbox.find((m) => m.type === 'welcome');
    return message?.type === 'welcome' ? message : undefined;
  }

  it('пускает гостя без пароля', async () => {
    const a = makeClient('a');
    await auth(a, { mode: 'guest', nick: 'гость' });

    expect(a.nick).toBe('гость');
    expect(welcomeOf(a)).toMatchObject({ nick: 'гость', guest: true });
  });

  it('регистрирует с паролем и пускает обратно по нему', async () => {
    const a = makeClient('a');
    await auth(a, { mode: 'register', nick: 'alice', password: 'достаточно-длинный' });
    expect(welcomeOf(a)).toMatchObject({ nick: 'alice', guest: false });

    const again = makeClient('a2');
    await auth(again, { mode: 'login', nick: 'alice', password: 'достаточно-длинный' });
    expect(again.nick).toBe('alice');
  });

  it('не пускает по неверному паролю и не занимает чужой ник гостем', async () => {
    const a = makeClient('a');
    await auth(a, { mode: 'register', nick: 'alice', password: 'достаточно-длинный' });

    const impostor = makeClient('impostor');
    await auth(impostor, { mode: 'login', nick: 'alice', password: 'наугад' });
    expect(impostor.nick).toBeNull();
    expect(impostor.inbox.at(-1)).toMatchObject({ type: 'auth-error', reason: 'Неверный ник или пароль' });

    const guest = makeClient('guest');
    await auth(guest, { mode: 'guest', nick: 'ALICE' });
    expect(guest.nick).toBeNull();
    expect(guest.inbox.at(-1)).toMatchObject({ type: 'auth-error' });
  });

  it('поднимает сессию по токену и не ведётся на чужой', async () => {
    const a = makeClient('a');
    await auth(a, { mode: 'guest', nick: 'гость' });
    const token = welcomeOf(a)!.token;

    const again = makeClient('a2');
    await auth(again, { mode: 'resume', token });
    expect(again.nick).toBe('гость');
    // Прошлое соединение живёт своей жизнью: одна сессия может быть открыта
    // и в двух вкладках, и это больше никого не выбивает.
    expect(a.closed).toBe(false);
    expect(a.nick).toBe('гость');

    const stranger = makeClient('stranger');
    await auth(stranger, { mode: 'resume', token: 'подобранный' });
    expect(stranger.nick).toBeNull();
    expect(stranger.inbox.at(-1)).toMatchObject({ type: 'auth-error', reason: 'Сессия истекла' });
  });

  it('выход гостя стирает его написанное и освобождает ник', async () => {
    const guest = makeClient('guest');
    const watcher = makeClient('watcher');
    await auth(guest, { mode: 'guest', nick: 'гость' });
    await auth(watcher, { mode: 'guest', nick: 'наблюдатель' });
    const token = welcomeOf(guest)!.token;

    hub.handle(guest, JSON.stringify({ type: 'message', channel: 'general', text: 'скоро исчезнет' }));
    expect(store.history(channelKey('general'))).toHaveLength(1);

    hub.handle(guest, JSON.stringify({ type: 'logout' }));

    expect(store.history(channelKey('general'))).toHaveLength(0);
    expect(guest.inbox.some((m) => m.type === 'logged-out')).toBe(true);
    expect(watcher.inbox.some((m) => m.type === 'purged' && m.nick === 'гость')).toBe(true);

    const returning = makeClient('returning');
    await auth(returning, { mode: 'resume', token });
    expect(returning.nick).toBeNull();

    const newcomer = makeClient('newcomer');
    await auth(newcomer, { mode: 'guest', nick: 'гость' });
    expect(newcomer.nick).toBe('гость');
  });

  it('уборка ушедшего гостя стирает его след так же, как явный выход', async () => {
    const guest = makeClient('guest');
    const watcher = makeClient('watcher');
    await auth(guest, { mode: 'guest', nick: 'гость' });
    await auth(watcher, { mode: 'guest', nick: 'наблюдатель' });
    hub.handle(guest, JSON.stringify({ type: 'message', channel: 'general', text: 'следа не останется' }));
    hub.leave(guest);

    hub.purgeAccounts(['гость']);

    expect(store.history(channelKey('general'))).toHaveLength(0);
    expect(watcher.inbox.some((m) => m.type === 'purged' && m.nick === 'гость')).toBe(true);
  });

  it('смена пароля выбивает другие устройства, но не то, с которого меняли', async () => {
    const laptop = makeClient('laptop');
    await auth(laptop, { mode: 'register', nick: 'alice', password: 'старый-пароль-раз' });
    const laptopToken = welcomeOf(laptop)!.token;

    const phone = makeClient('phone');
    await auth(phone, { mode: 'login', nick: 'alice', password: 'старый-пароль-раз' });
    const phoneToken = welcomeOf(phone)!.token;

    hub.handle(phone, JSON.stringify({ type: 'change-password', current: 'старый-пароль-раз', next: 'новый-пароль-два' }));
    await vi.waitFor(() => {
      expect(phone.inbox.some((m) => m.type === 'password-changed')).toBe(true);
    });

    expect(phone.nick).toBe('alice');
    expect(laptop.closed).toBe(true);
    expect(laptop.inbox.some((m) => m.type === 'logged-out' && m.reason?.includes('Пароль изменён'))).toBe(true);

    const returning = makeClient('returning');
    await auth(returning, { mode: 'resume', token: laptopToken });
    expect(returning.nick).toBeNull();

    const stillHere = makeClient('still');
    await auth(stillHere, { mode: 'resume', token: phoneToken });
    expect(stillHere.nick).toBe('alice');
  });

  it('не меняет пароль по неверному текущему', async () => {
    const a = makeClient('a');
    await auth(a, { mode: 'register', nick: 'alice', password: 'настоящий-пароль' });

    hub.handle(a, JSON.stringify({ type: 'change-password', current: 'не-тот', next: 'новый-пароль-два' }));
    await vi.waitFor(() => {
      expect(a.inbox.some((m) => m.type === 'error')).toBe(true);
    });

    expect(a.inbox.some((m) => m.type === 'password-changed')).toBe(false);
    const back = makeClient('back');
    await auth(back, { mode: 'login', nick: 'alice', password: 'настоящий-пароль' });
    expect(back.nick).toBe('alice');
  });

  it('выход отовсюду закрывает все устройства этого ника', async () => {
    const laptop = makeClient('laptop');
    await auth(laptop, { mode: 'register', nick: 'alice', password: 'достаточно-длинный' });
    const phone = makeClient('phone');
    await auth(phone, { mode: 'login', nick: 'alice', password: 'достаточно-длинный' });
    const phoneToken = welcomeOf(phone)!.token;

    const bob = makeClient('bob');
    await auth(bob, { mode: 'guest', nick: 'bob' });

    hub.handle(phone, JSON.stringify({ type: 'logout', everywhere: true }));

    expect(phone.inbox.some((m) => m.type === 'logged-out')).toBe(true);
    expect(laptop.closed).toBe(true);
    expect(bob.closed).toBe(false);
    expect(bob.nick).toBe('bob');

    // Ни одна сессия этого ника больше не поднимается, чужие не задеты.
    for (const token of [phoneToken, welcomeOf(laptop)!.token]) {
      const returning = makeClient(`r-${token.slice(0, 4)}`);
      await auth(returning, { mode: 'resume', token });
      expect(returning.nick).toBeNull();
    }

    const bobAgain = makeClient('bob-again');
    await auth(bobAgain, { mode: 'resume', token: welcomeOf(bob)!.token });
    expect(bobAgain.nick).toBe('bob');
  });

  it('показывает свои сессии с пометкой текущей и метками устройств', async () => {
    const laptop = makeClient('laptop');
    await auth(laptop, { mode: 'register', nick: 'alice', password: 'достаточно-длинный', device: 'Mac' });
    const phone = makeClient('phone');
    await auth(phone, { mode: 'login', nick: 'alice', password: 'достаточно-длинный', device: 'iPhone' });

    hub.handle(phone, JSON.stringify({ type: 'sessions' }));
    const list = phone.inbox.filter((m) => m.type === 'sessions').at(-1);
    const sessions = list?.type === 'sessions' ? list.list : [];

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.device).sort()).toEqual(['Mac', 'iPhone']);
    expect(sessions.find((s) => s.current)?.device).toBe('iPhone');
  });

  it('отзыв сессии обрывает то соединение, которое ею пользовалось', async () => {
    const laptop = makeClient('laptop');
    await auth(laptop, { mode: 'register', nick: 'alice', password: 'достаточно-длинный', device: 'Mac' });
    const laptopToken = welcomeOf(laptop)!.token;
    const phone = makeClient('phone');
    await auth(phone, { mode: 'login', nick: 'alice', password: 'достаточно-длинный', device: 'iPhone' });

    hub.handle(phone, JSON.stringify({ type: 'sessions' }));
    const list = phone.inbox.filter((m) => m.type === 'sessions').at(-1);
    const target = list?.type === 'sessions' ? list.list.find((s) => !s.current)! : null;
    hub.handle(phone, JSON.stringify({ type: 'session-revoke', id: target!.id }));

    expect(laptop.closed).toBe(true);
    expect(laptop.inbox.some((m) => m.type === 'logged-out')).toBe(true);

    const returning = makeClient('returning');
    await auth(returning, { mode: 'resume', token: laptopToken });
    expect(returning.nick).toBeNull();

    const after = phone.inbox.filter((m) => m.type === 'sessions').at(-1);
    expect(after?.type === 'sessions' && after.list).toHaveLength(1);
  });

  it('не даёт отозвать чужую сессию', async () => {
    const alice = makeClient('alice');
    await auth(alice, { mode: 'register', nick: 'alice', password: 'достаточно-длинный', device: 'Mac' });
    const aliceToken = welcomeOf(alice)!.token;

    const mallory = makeClient('mallory');
    await auth(mallory, { mode: 'guest', nick: 'mallory' });

    hub.handle(alice, JSON.stringify({ type: 'sessions' }));
    const list = alice.inbox.filter((m) => m.type === 'sessions').at(-1);
    const victim = list?.type === 'sessions' ? list.list[0] : null;

    hub.handle(mallory, JSON.stringify({ type: 'session-revoke', id: victim!.id }));

    expect(alice.closed).toBe(false);
    const still = makeClient('still');
    await auth(still, { mode: 'resume', token: aliceToken });
    expect(still.nick).toBe('alice');
  });

  it('выход по паролю гасит сессию, но не трогает написанное', async () => {
    const a = makeClient('a');
    await auth(a, { mode: 'register', nick: 'alice', password: 'достаточно-длинный' });
    const token = welcomeOf(a)!.token;
    hub.handle(a, JSON.stringify({ type: 'message', channel: 'general', text: 'останется' }));

    hub.handle(a, JSON.stringify({ type: 'logout' }));
    expect(store.history(channelKey('general')).map((m) => m.text)).toEqual(['останется']);

    const returning = makeClient('returning');
    await auth(returning, { mode: 'resume', token });
    expect(returning.nick).toBeNull();

    const back = makeClient('back');
    await auth(back, { mode: 'login', nick: 'alice', password: 'достаточно-длинный' });
    expect(back.nick).toBe('alice');
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
    hub.handle(a, JSON.stringify({ type: 'call-invite', to: 'bob' }));
    hub.handle(b, JSON.stringify({ type: 'call-accept', to: 'alice' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-accept', from: 'bob' });
    hub.handle(a, JSON.stringify({ type: 'call-signal', to: 'bob', data: { kind: 'offer' } }));
    expect(b.inbox.at(-1)).toEqual({ type: 'call-signal', from: 'alice', data: { kind: 'offer' } });
    hub.handle(b, JSON.stringify({ type: 'call-end', to: 'alice' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-end', from: 'bob' });
  });

  it('не пересылает accept и signal без приглашения', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');

    const before = a.inbox.length;
    hub.handle(b, JSON.stringify({ type: 'call-accept', to: 'alice' }));
    hub.handle(b, JSON.stringify({ type: 'call-signal', to: 'alice', data: { kind: 'offer' } }));
    expect(a.inbox).toHaveLength(before);
  });

  it('передаёт причину отклонения', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    hub.join(a, 'alice');
    hub.join(b, 'bob');
    hub.handle(a, JSON.stringify({ type: 'call-invite', to: 'bob' }));
    hub.handle(b, JSON.stringify({ type: 'call-decline', to: 'alice', reason: 'busy' }));
    expect(a.inbox.at(-1)).toEqual({ type: 'call-decline', from: 'bob', reason: 'busy' });
  });
});

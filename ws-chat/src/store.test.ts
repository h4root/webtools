import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, channelKey, dmKey, recipientsOf, CHANNEL_LIMIT } from './store.ts';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it('стартует с дефолтными каналами и создаёт новые без дублей', () => {
    expect(store.listChannels()).toContain('general');
    expect(store.createChannel('dev')).toBe(true);
    expect(store.createChannel('dev')).toBe(false);
    expect(store.hasChannel('dev')).toBe(true);
  });

  it('присваивает возрастающие id и хранит историю канала', () => {
    const a = store.addChannelMessage('general', 'alice', 'one');
    const b = store.addChannelMessage('general', 'bob', 'two');
    expect(b.id).toBe(a.id + 1);
    expect(store.history(channelKey('general')).map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('ключует ЛС по паре ников независимо от порядка', () => {
    store.addDirectMessage('alice', 'Bob', 'hi');
    expect(dmKey('alice', 'Bob')).toBe(dmKey('bob', 'ALICE'));
    expect(store.history(dmKey('bob', 'alice')).map((m) => m.text)).toEqual(['hi']);
  });

  it('редактирует только своё сообщение', () => {
    const m = store.addChannelMessage('general', 'alice', 'typo');
    expect(store.edit(m.id, 'bob', 'x')).toBeNull();
    const edited = store.edit(m.id, 'alice', 'fixed');
    expect(edited).not.toBeNull();
    expect(store.history(channelKey('general'))[0]).toMatchObject({ text: 'fixed', edited: true });
  });

  it('удаляет только своё сообщение', () => {
    const m = store.addChannelMessage('general', 'alice', 'bye');
    expect(store.remove(m.id, 'bob')).toBeNull();
    expect(store.remove(m.id, 'alice')).not.toBeNull();
    expect(store.history(channelKey('general'))).toHaveLength(0);
  });

  it('recipientsOf: канал — all, ЛС — обе стороны', () => {
    expect(recipientsOf({ channel: 'general', from: 'alice' })).toBe('all');
    expect(recipientsOf({ from: 'alice', to: 'bob' })).toEqual(['alice', 'bob']);
  });

  it('прикладывает снапшот ответа и маппит вложения в url', () => {
    const a = store.addChannelMessage('general', 'alice', 'original');
    const b = store.addChannelMessage('general', 'bob', 'reply', {
      replyTo: a.id,
      attachments: [{ id: 'deadbeef001122334455667788990011', name: 'pic.png', size: 10, mime: 'image/png' }],
    });
    expect(b.replyTo).toEqual({ id: a.id, from: 'alice', text: 'original' });
    expect(b.attachments).toEqual([
      { url: '/uploads/deadbeef001122334455667788990011', name: 'pic.png', size: 10, mime: 'image/png' },
    ]);
  });

  it('игнорирует ответ на несуществующее сообщение', () => {
    const m = store.addChannelMessage('general', 'alice', 'x', { replyTo: 999 });
    expect(m.replyTo).toBeUndefined();
  });

  it('не даёт ответом вытащить текст чужого ЛС в канал', () => {
    const secret = store.addDirectMessage('alice', 'bob', 'пароль от сейфа 1234');
    const leak = store.addChannelMessage('general', 'mallory', 'а что там?', { replyTo: secret.id });
    expect(leak.replyTo).toBeUndefined();
  });

  it('разрешает ответ внутри того же разговора', () => {
    const first = store.addDirectMessage('alice', 'bob', 'привет');
    const second = store.addDirectMessage('bob', 'alice', 'здравствуй', { replyTo: first.id });
    expect(second.replyTo).toMatchObject({ id: first.id, from: 'alice', text: 'привет' });
  });

  it('не даёт ставить реакции в чужое ЛС', () => {
    const dm = store.addDirectMessage('alice', 'bob', 'секрет');
    expect(store.toggleReaction(dm.id, 'mallory', '🔥')).toBeNull();
    expect(store.history(dmKey('alice', 'bob'))[0].reactions).toBeUndefined();

    expect(store.toggleReaction(dm.id, 'BOB', '🔥')).not.toBeNull();
    expect(store.history(dmKey('alice', 'bob'))[0].reactions).toEqual({ '🔥': ['BOB'] });
  });

  it('не переиспользует id, если в файле нет корректного nextId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-chat-'));
    const file = join(dir, 'store.json');
    try {
      writeFileSync(
        file,
        JSON.stringify({
          messages: [{ id: 7, key: channelKey('general'), from: 'alice', channel: 'general', text: 'old', ts: 1, edited: false }],
        }),
      );
      const loaded = new Store(file);
      const fresh = loaded.addChannelMessage('general', 'bob', 'new');
      expect(fresh.id).toBe(8);
      expect(loaded.find(7)?.text).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('не плодит каналы без предела', () => {
    for (let i = 0; i < 200; i++) store.createChannel(`c${i}`);
    expect(store.listChannels()).toHaveLength(CHANNEL_LIMIT);
  });

  it('удаляет канал вместе с историей, но не последний', () => {
    store.addChannelMessage('random', 'alice', 'пока');
    expect(store.removeChannel('random')).toBe(true);
    expect(store.hasChannel('random')).toBe(false);
    expect(store.history(channelKey('random'))).toHaveLength(0);

    expect(store.removeChannel('general')).toBe(false);
    expect(store.listChannels()).toEqual(['general']);
  });

  it('purgeUser уносит сообщения, ЛС, реакции и цитаты ушедшего', () => {
    const guestMsg = store.addChannelMessage('general', 'гость', 'меня тут не было');
    store.addDirectMessage('гость', 'alice', 'личное');
    store.addDirectMessage('alice', 'гость', 'ответ в личку');
    const quote = store.addChannelMessage('general', 'alice', 'согласен', { replyTo: guestMsg.id });
    const keep = store.addChannelMessage('general', 'alice', 'не трогать');
    store.toggleReaction(keep.id, 'гость', '🔥');
    store.toggleReaction(keep.id, 'bob', '🔥');

    expect(store.purgeUser('ГОСТЬ').removed).toBe(3);

    const left = store.history(channelKey('general'));
    expect(left.map((m) => m.text)).toEqual(['согласен', 'не трогать']);
    expect(left.find((m) => m.id === quote.id)?.replyTo).toBeUndefined();
    expect(left.find((m) => m.id === keep.id)?.reactions).toEqual({ '🔥': ['bob'] });
    expect(store.history(dmKey('гость', 'alice'))).toHaveLength(0);
    expect(store.dmPartners('alice')).toEqual([]);
  });

  it('регистр ника не мешает править и удалять своё сообщение', () => {
    const m = store.addChannelMessage('general', 'Alice', 'typo');
    expect(store.edit(m.id, 'alice', 'fixed')?.text).toBe('fixed');
    expect(store.remove(m.id, 'ALICE')).not.toBeNull();
  });

  it('переключает реакцию: добавляет и убирает', () => {
    const m = store.addChannelMessage('general', 'alice', 'hey');
    store.toggleReaction(m.id, 'bob', '🔥');
    store.toggleReaction(m.id, 'carol', '🔥');
    expect(store.history(channelKey('general'))[0].reactions).toEqual({ '🔥': ['bob', 'carol'] });
    store.toggleReaction(m.id, 'bob', '🔥');
    expect(store.history(channelKey('general'))[0].reactions).toEqual({ '🔥': ['carol'] });
    store.toggleReaction(m.id, 'carol', '🔥');
    expect(store.history(channelKey('general'))[0].reactions).toBeUndefined();
  });
});

describe('Store: персистентность', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-'));
    file = join(dir, 'store.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('flush сохраняет то, что ещё висит в дебаунсе', () => {
    const store = new Store(file);
    store.addChannelMessage('general', 'alice', 'до выключения');
    expect(existsSync(file)).toBe(false);

    store.flush();
    expect(new Store(file).history(channelKey('general')).map((m) => m.text)).toEqual(['до выключения']);
  });

  it('flush без изменений не трогает файл и не оставляет временных', () => {
    const store = new Store(file);
    store.addChannelMessage('general', 'alice', 'once');
    store.flush();
    const first = readFileSync(file, 'utf8');

    store.flush();
    expect(readFileSync(file, 'utf8')).toBe(first);
    expect(readdirSync(dir)).toEqual(['store.json']);
  });

  it('не затирает битый файл, а откладывает его рядом', () => {
    writeFileSync(file, '{"messages": [{"id": 1,');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = new Store(file);
    store.addChannelMessage('general', 'alice', 'новая жизнь');
    store.flush();

    const corrupt = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(corrupt).toHaveLength(1);
    expect(readFileSync(join(dir, corrupt[0]), 'utf8')).toBe('{"messages": [{"id": 1,');
    expect(new Store(file).history(channelKey('general')).map((m) => m.text)).toEqual(['новая жизнь']);
  });

  it('с ключом не оставляет переписку читаемой на диске', () => {
    const key = Buffer.alloc(32, 1);
    const store = new Store(file, key);
    store.addDirectMessage('alice', 'bob', 'пароль от сейфа 1234');
    store.flush();

    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from('пароль от сейфа'))).toBe(false);
    expect(raw.includes(Buffer.from('alice'))).toBe(false);

    expect(new Store(file, key).history(dmKey('alice', 'bob')).map((m) => m.text)).toEqual(['пароль от сейфа 1234']);
  });

  it('подхватывает старый открытый файл и запечатывает его при первом сохранении', () => {
    writeFileSync(
      file,
      JSON.stringify({
        messages: [{ id: 1, key: channelKey('general'), from: 'alice', channel: 'general', text: 'старое', ts: 1, edited: false }],
        nextId: 2,
      }),
    );

    const key = Buffer.alloc(32, 2);
    const store = new Store(file, key);
    expect(store.history(channelKey('general')).map((m) => m.text)).toEqual(['старое']);

    store.addChannelMessage('general', 'bob', 'новое');
    store.flush();

    expect(readFileSync(file).includes(Buffer.from('старое'))).toBe(false);
    expect(new Store(file, key).history(channelKey('general')).map((m) => m.text)).toEqual(['старое', 'новое']);
  });

  it('при неверном ключе не затирает историю, а отказывается сохранять', () => {
    const key = Buffer.alloc(32, 3);
    const first = new Store(file, key);
    first.addChannelMessage('general', 'alice', 'ценное');
    first.flush();
    const sealed = readFileSync(file);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrong = new Store(file, Buffer.alloc(32, 9));
    expect(wrong.history(channelKey('general'))).toHaveLength(0);

    wrong.addChannelMessage('general', 'mallory', 'поверх');
    wrong.flush();

    expect(readFileSync(file).equals(sealed)).toBe(true);
    expect(new Store(file, key).history(channelKey('general')).map((m) => m.text)).toEqual(['ценное']);
  });

  it('под непрерывным потоком сообщений всё равно сохраняется', async () => {
    const store = new Store(file);
    for (let i = 0; i < 5; i++) {
      store.addChannelMessage('general', 'alice', `msg ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    expect(existsSync(file)).toBe(true);
    store.flush();
    expect(new Store(file).history(channelKey('general'))).toHaveLength(5);
  });
});

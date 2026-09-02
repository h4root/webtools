import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, channelKey, dmKey, recipientsOf, CHANNEL_LIMIT, HISTORY_LIMIT } from './store.ts';

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

  it('в цитату попадает первое вложение оригинала — для миниатюры', () => {
    const withPic = store.addChannelMessage('general', 'alice', '', {
      attachments: [
        { id: 'aa11223344556677889900aabbccddee', name: 'shot.png', size: 10, mime: 'image/png' },
        { id: 'bb11223344556677889900aabbccddee', name: 'doc.pdf', size: 20, mime: 'application/pdf' },
      ],
    });
    const answer = store.addChannelMessage('general', 'bob', 'красиво', { replyTo: withPic.id });
    expect(answer.replyTo?.media).toEqual({
      url: '/uploads/aa11223344556677889900aabbccddee',
      name: 'shot.png',
      size: 10,
      mime: 'image/png',
    });
  });

  it('у цитаты на обычный текст миниатюры нет', () => {
    const plain = store.addChannelMessage('general', 'alice', 'просто текст');
    const answer = store.addChannelMessage('general', 'bob', 'ага', { replyTo: plain.id });
    expect(answer.replyTo?.media).toBeUndefined();
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

  it('усечение по лимиту не задевает соседние разговоры', () => {
    for (let i = 0; i < HISTORY_LIMIT + 50; i++) store.addChannelMessage('general', 'alice', `общий ${i}`);
    store.addChannelMessage('random', 'bob', 'в другом канале');
    store.addDirectMessage('alice', 'bob', 'в личке');

    const general = store.history(channelKey('general'), HISTORY_LIMIT);
    expect(general).toHaveLength(HISTORY_LIMIT);
    expect(general[0].text).toBe('общий 50');
    expect(general.at(-1)?.text).toBe(`общий ${HISTORY_LIMIT + 49}`);
    expect(store.history(channelKey('random')).map((m) => m.text)).toEqual(['в другом канале']);
    expect(store.history(dmKey('alice', 'bob')).map((m) => m.text)).toEqual(['в личке']);
  });

  it('после усечения id вытесненных больше не находятся', () => {
    const first = store.addChannelMessage('general', 'alice', 'самое первое');
    for (let i = 0; i < HISTORY_LIMIT; i++) store.addChannelMessage('general', 'alice', `ещё ${i}`);

    expect(store.find(first.id)).toBeUndefined();
    expect(store.edit(first.id, 'alice', 'поздно')).toBeNull();
    expect(store.toggleReaction(first.id, 'bob', '🔥')).toBeNull();
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

describe('Store: метка отправки', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it('находит сообщение по метке его автора', () => {
    const m = store.addChannelMessage('general', 'alice', 'раз', { nonce: 'n1' });
    expect(store.findByNonce('alice', 'n1')?.id).toBe(m.id);
  });

  it('метки разных авторов не путаются', () => {
    store.addChannelMessage('general', 'alice', 'моё', { nonce: 'общая' });
    store.addChannelMessage('general', 'bob', 'чужое', { nonce: 'общая' });

    expect(store.findByNonce('alice', 'общая')?.text).toBe('моё');
    expect(store.findByNonce('bob', 'общая')?.text).toBe('чужое');
  });

  it('регистр ника не заводит вторую метку', () => {
    store.addChannelMessage('general', 'Alice', 'привет', { nonce: 'n1' });
    expect(store.findByNonce('alice', 'n1')).not.toBeNull();
  });

  it('без метки ничего не находится', () => {
    store.addChannelMessage('general', 'alice', 'без метки');
    expect(store.findByNonce('alice', 'n1')).toBeNull();
  });

  it('метка работает и в личке', () => {
    const m = store.addDirectMessage('alice', 'bob', 'личное', { nonce: 'n2' });
    expect(store.findByNonce('alice', 'n2')?.id).toBe(m.id);
  });

  it('вытесненное из истории по метке больше не находится', () => {
    store.addChannelMessage('general', 'alice', 'самое первое', { nonce: 'старая' });
    for (let i = 0; i < HISTORY_LIMIT; i++) store.addChannelMessage('general', 'alice', `ещё ${i}`);

    expect(store.findByNonce('alice', 'старая')).toBeNull();
  });

  it('удалённое по метке больше не находится', () => {
    const m = store.addChannelMessage('general', 'alice', 'пока', { nonce: 'n3' });
    store.remove(m.id, 'alice');
    expect(store.findByNonce('alice', 'n3')).toBeNull();
  });
});

describe('Store: отметки чтения', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it('двигает отметку вперёд и не откатывает назад', () => {
    const a = store.addChannelMessage('general', 'bob', 'раз');
    const b = store.addChannelMessage('general', 'bob', 'два');

    expect(store.markRead('alice', channelKey('general'), b.id)).toBe(true);
    expect(store.markRead('alice', channelKey('general'), a.id)).toBe(false);
    expect(store.readMark('alice', channelKey('general'))).toBe(b.id);
  });

  it('считает непрочитанным только чужое после отметки', () => {
    const first = store.addChannelMessage('general', 'bob', 'до отметки');
    store.markRead('alice', channelKey('general'), first.id);
    store.addChannelMessage('general', 'bob', 'после');
    store.addChannelMessage('general', 'alice', 'своё не считается');
    store.addChannelMessage('general', 'carol', 'ещё чужое');

    expect(store.unreadCount('alice', channelKey('general'))).toBe(2);
  });

  it('без отметки не считает ничего: истории чтения ещё нет', () => {
    store.addChannelMessage('general', 'bob', 'старое');
    expect(store.unreadCount('alice', channelKey('general'))).toBe(0);
  });

  it('не путает отметки разных людей и разных разговоров', () => {
    const m = store.addChannelMessage('general', 'bob', 'общее');
    store.markRead('alice', channelKey('general'), m.id);

    expect(store.readMark('carol', channelKey('general'))).toBe(0);
    expect(store.readMark('alice', channelKey('random'))).toBe(0);
  });

  it('регистр ника не заводит вторую отметку', () => {
    const m = store.addChannelMessage('general', 'bob', 'привет');
    store.markRead('Alice', channelKey('general'), m.id);
    expect(store.readMark('alice', channelKey('general'))).toBe(m.id);
  });

  it('пустой разговор при первом заходе всё равно получает отметку', () => {
    expect(store.hasMark('alice', channelKey('general'))).toBe(false);
    store.ensureMark('alice', channelKey('general'), 0);
    expect(store.hasMark('alice', channelKey('general'))).toBe(true);

    store.addChannelMessage('general', 'bob', 'пришло позже');
    expect(store.unreadCount('alice', channelKey('general'))).toBe(1);
  });

  it('ensureMark не перебивает уже поставленную отметку', () => {
    const m = store.addChannelMessage('general', 'bob', 'раз');
    store.markRead('alice', channelKey('general'), m.id);
    store.ensureMark('alice', channelKey('general'), 0);
    expect(store.readMark('alice', channelKey('general'))).toBe(m.id);
  });

  it('purgeUser уносит отметки ушедшего', () => {
    const m = store.addChannelMessage('general', 'bob', 'общее');
    store.markRead('гость', channelKey('general'), m.id);
    store.purgeUser('гость');
    expect(store.readMark('гость', channelKey('general'))).toBe(0);
  });

  it('удаление канала уносит отметки по нему', () => {
    store.createChannel('dev');
    const m = store.addChannelMessage('dev', 'bob', 'черновик');
    store.markRead('alice', channelKey('dev'), m.id);
    store.removeChannel('dev');
    expect(store.readMark('alice', channelKey('dev'))).toBe(0);
  });
});

describe('Store: поиск', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store();
  });

  it('находит сообщение канала по куску текста', () => {
    store.addChannelMessage('general', 'alice', 'встречаемся в среду');
    store.addChannelMessage('general', 'bob', 'ок');
    expect(store.search('carol', 'сред').map((m) => m.text)).toEqual(['встречаемся в среду']);
  });

  it('не находит чужую переписку', () => {
    store.addDirectMessage('bob', 'carol', 'секрет про среду');
    expect(store.search('alice', 'среду')).toEqual([]);
  });

  it('находит мою переписку с обеих сторон', () => {
    store.addDirectMessage('alice', 'bob', 'мой вопрос');
    store.addDirectMessage('bob', 'alice', 'мой ответ');
    expect(store.search('ALICE', 'мой').map((m) => m.text)).toEqual(['мой ответ', 'мой вопрос']);
  });

  it('не различает регистр', () => {
    store.addChannelMessage('general', 'alice', 'Привет, МИР');
    expect(store.search('bob', 'привет, мир')).toHaveLength(1);
  });

  it('на пустой запрос ничего не отдаёт', () => {
    store.addChannelMessage('general', 'alice', 'что-нибудь');
    expect(store.search('alice', '   ')).toEqual([]);
  });

  it('отдаёт свежие первыми и не больше лимита', () => {
    for (let i = 0; i < 5; i++) store.addChannelMessage('general', 'alice', `отчёт ${i}`);
    expect(store.search('bob', 'отчёт', 3).map((m) => m.text)).toEqual(['отчёт 4', 'отчёт 3', 'отчёт 2']);
  });

  it('не отдаёт сообщения удалённого канала', () => {
    store.createChannel('dev');
    store.addChannelMessage('dev', 'alice', 'черновик');
    store.removeChannel('dev');
    expect(store.search('alice', 'черновик')).toEqual([]);
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

  it('отметки чтения переживают перезапуск', () => {
    const store = new Store(file);
    const m = store.addChannelMessage('general', 'bob', 'до перезапуска');
    store.markRead('alice', channelKey('general'), m.id);
    store.addChannelMessage('general', 'bob', 'после отметки');
    store.flush();

    const loaded = new Store(file);
    expect(loaded.readMark('alice', channelKey('general'))).toBe(m.id);
    expect(loaded.unreadCount('alice', channelKey('general'))).toBe(1);
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

describe('Store: сколько истории отдаётся', () => {
  it('по умолчанию отдаёт всё, что хранит: половина на сервере была бы невидимой', () => {
    const store = new Store();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) store.addChannelMessage('general', 'alice', `строка ${i}`);

    const sent = store.history(channelKey('general'));
    expect(sent).toHaveLength(HISTORY_LIMIT);
    expect(sent.at(-1)?.text).toBe(`строка ${HISTORY_LIMIT + 19}`);
  });

  it('меньший кусок по-прежнему можно попросить явно', () => {
    const store = new Store();
    for (let i = 0; i < 10; i++) store.addChannelMessage('general', 'alice', `строка ${i}`);
    expect(store.history(channelKey('general'), 3)).toHaveLength(3);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { Store, channelKey, dmKey, recipientsOf } from './store.ts';

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
      attachments: [{ id: 'deadbeef00112233.png', name: 'pic.png', size: 10, mime: 'image/png' }],
    });
    expect(b.replyTo).toEqual({ id: a.id, from: 'alice', text: 'original' });
    expect(b.attachments).toEqual([
      { url: '/uploads/deadbeef00112233.png', name: 'pic.png', size: 10, mime: 'image/png' },
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

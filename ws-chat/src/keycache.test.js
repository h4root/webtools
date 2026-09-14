import { describe, it, expect, vi } from 'vitest';
import { createKeyCache } from '../public/keycache.js';

const device = (id) => ({ id, key: `key-${id}` });

describe('createKeyCache', () => {
  it('ждёт ответ сервера, а не отвечает пустотой сразу', async () => {
    const asked = [];
    const cache = createKeyCache({ request: (nick) => asked.push(nick) });
    const pending = cache.get('bob');
    expect(asked).toEqual(['bob']);
    cache.remember('bob', [device('b1')]);
    expect(await pending).toEqual([device('b1')]);
  });

  it('на повторный вопрос про известного не ходит на сервер', async () => {
    const asked = [];
    const cache = createKeyCache({ request: (nick) => asked.push(nick) });
    cache.remember('bob', [device('b1')]);
    expect(await cache.get('bob')).toEqual([device('b1')]);
    expect(asked).toEqual([]);
  });

  it('на два вопроса подряд спрашивает один раз', async () => {
    const asked = [];
    const cache = createKeyCache({ request: (nick) => asked.push(nick) });
    const first = cache.get('bob');
    const second = cache.get('bob');
    cache.remember('bob', [device('b1')]);
    expect([await first, await second]).toEqual([[device('b1')], [device('b1')]]);
    expect(asked).toEqual(['bob']);
  });

  it('не виснет, если сервер молчит: по сроку отвечает пустотой', async () => {
    vi.useFakeTimers();
    try {
      const cache = createKeyCache({ request: () => {}, timeoutMs: 1000 });
      const pending = cache.get('bob');
      vi.advanceTimersByTime(1000);
      expect(await pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ник в другом регистре — тот же собеседник', async () => {
    const asked = [];
    const cache = createKeyCache({ request: (nick) => asked.push(nick) });
    cache.remember('Bob', [device('b1')]);
    expect(await cache.get('bOB')).toEqual([device('b1')]);
    expect(asked).toEqual([]);
  });

  it('сразу отдаёт известное без ожидания', () => {
    const cache = createKeyCache({ request: () => {} });
    cache.remember('bob', [device('b1')]);
    expect(cache.peek('bob')).toEqual([device('b1')]);
    expect(cache.peek('carol')).toBeNull();
  });

  it('после выхода не помнит чужие ключи', async () => {
    const asked = [];
    const cache = createKeyCache({ request: (nick) => asked.push(nick) });
    cache.remember('bob', [device('b1')]);
    cache.clear();
    expect(cache.peek('bob')).toBeNull();
    const pending = cache.get('bob');
    cache.remember('bob', []);
    expect(await pending).toEqual([]);
    expect(asked).toEqual(['bob']);
  });
});

import { describe, it, expect } from 'vitest';
import { searchLocal, mergeHits } from '../public/localsearch.js';

const msg = (id, over = {}) => ({ id, from: 'bob', to: 'alice', text: `сообщение ${id}`, ts: id * 1000, ...over });

function conversations(entries) {
  return new Map(entries);
}

describe('searchLocal', () => {
  it('находит расшифрованное личное сообщение, которого сервер не видит', () => {
    const store = conversations([['dm:bob', [msg(1, { text: 'секретное слово' })]]]);
    expect(searchLocal(store, 'alice', 'секретное').map((m) => m.id)).toEqual([1]);
  });

  it('ищет без оглядки на регистр', () => {
    const store = conversations([['dm:bob', [msg(1, { text: 'Буратино' })]]]);
    expect(searchLocal(store, 'alice', 'бурат')).toHaveLength(1);
  });

  it('не лезет в каналы: их ищет сервер и по всей истории', () => {
    const store = conversations([['ch:general', [msg(1, { text: 'секретное слово', channel: 'general', to: undefined })]]]);
    expect(searchLocal(store, 'alice', 'секретное')).toEqual([]);
  });

  it('не выдаёт то, что расшифровать не удалось', () => {
    const store = conversations([['dm:bob', [msg(1, { text: 'не удалось расшифровать', locked: true })]]]);
    expect(searchLocal(store, 'alice', 'расшифровать')).toEqual([]);
  });

  it('на пустой запрос ничего не возвращает', () => {
    const store = conversations([['dm:bob', [msg(1)]]]);
    expect(searchLocal(store, 'alice', '   ')).toEqual([]);
  });

  it('отдаёт свежие сверху', () => {
    const store = conversations([['dm:bob', [msg(1, { text: 'общее' }), msg(2, { text: 'общее' })]]]);
    expect(searchLocal(store, 'alice', 'общее').map((m) => m.id)).toEqual([2, 1]);
  });
});

describe('mergeHits', () => {
  it('сводит находки сервера и свои, свежие сверху', () => {
    expect(mergeHits([msg(5)], [msg(9)]).map((m) => m.id)).toEqual([9, 5]);
  });

  it('не показывает одно сообщение дважды', () => {
    expect(mergeHits([msg(5)], [msg(5)]).map((m) => m.id)).toEqual([5]);
  });

  it('своя расшифрованная версия важнее серверной', () => {
    const mine = msg(5, { text: 'расшифровано' });
    expect(mergeHits([msg(5, { text: '' })], [mine])[0].text).toBe('расшифровано');
  });

  it('режет по пределу', () => {
    const many = Array.from({ length: 60 }, (_, i) => msg(i + 1));
    expect(mergeHits([], many, 50)).toHaveLength(50);
  });

  it('переживает отсутствующие списки', () => {
    expect(mergeHits(undefined, undefined)).toEqual([]);
  });
});

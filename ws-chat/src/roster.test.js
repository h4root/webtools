import { describe, it, expect } from 'vitest';
import { isOnline, orderDms } from '../public/roster.js';

describe('isOnline', () => {
  it('сам пользователь всегда в сети', () => {
    expect(isOnline('alice', { me: 'alice', online: [] })).toBe(true);
  });

  it('сверяет ник без учёта регистра', () => {
    expect(isOnline('BoB', { me: 'alice', online: ['bob'] })).toBe(true);
    expect(isOnline('bob', { me: 'alice', online: ['carol'] })).toBe(false);
  });
});

describe('orderDms', () => {
  const active = { kind: 'channel', id: 'general' };

  it('себя в список не кладёт', () => {
    expect(orderDms({ me: 'alice', online: ['alice', 'bob'], partners: [], active })).toEqual(['bob']);
  });

  it('свежие переписки идут выше давних', () => {
    const partners = [
      { nick: 'bob', ts: 10 },
      { nick: 'carol', ts: 200 },
    ];
    expect(orderDms({ me: 'alice', online: [], partners, active })).toEqual(['carol', 'bob']);
  });

  it('среди тех, кому не писали, сначала идут те, кто в сети', () => {
    const partners = [{ nick: 'dave', ts: 0 }];
    const order = orderDms({ me: 'alice', online: ['dave'], partners: [], active });
    expect(order).toEqual(['dave']);
    expect(orderDms({ me: 'alice', online: ['carol'], partners, active })).toEqual(['carol', 'dave']);
  });

  it('при равных условиях сортирует по алфавиту', () => {
    expect(orderDms({ me: 'alice', online: ['carol', 'bob'], partners: [], active })).toEqual(['bob', 'carol']);
  });

  it('один и тот же ник в разном регистре не двоится', () => {
    const partners = [{ nick: 'Bob', ts: 5 }];
    expect(orderDms({ me: 'alice', online: ['bob'], partners, active })).toEqual(['Bob']);
  });

  it('открытая переписка попадает в список, даже если собеседник ушёл', () => {
    const open = { kind: 'dm', id: 'zoe' };
    expect(orderDms({ me: 'alice', online: [], partners: [], active: open })).toEqual(['zoe']);
  });
});

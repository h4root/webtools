import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinkCodes, LINK_TTL_MS, normalizeCode } from './linkcodes.ts';

describe('normalizeCode', () => {
  it('прощает регистр, пробелы и дефисы', () => {
    expect(normalizeCode(' ab3-9kf ')).toBe('AB39KF');
    expect(normalizeCode('AB39KF')).toBe('AB39KF');
  });

  it('на мусоре не падает', () => {
    expect(normalizeCode('')).toBe('');
    expect(normalizeCode('!!!')).toBe('');
  });
});

describe('LinkCodes', () => {
  let codes: LinkCodes<string>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    codes = new LinkCodes<string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('выдаёт код без похожих друг на друга символов', () => {
    const { code } = codes.create('устройство');
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('обменивает код на то, что за ним стояло', () => {
    const { code } = codes.create('телефон');
    expect(codes.claim(code)).toBe('телефон');
  });

  it('код одноразовый', () => {
    const { code } = codes.create('телефон');
    codes.claim(code);
    expect(codes.claim(code)).toBeNull();
  });

  it('код протухает', () => {
    const { code } = codes.create('телефон');
    vi.setSystemTime(Date.now() + LINK_TTL_MS + 1000);
    expect(codes.claim(code)).toBeNull();
  });

  it('прощает пользователю регистр и дефисы при вводе', () => {
    const { code } = codes.create('телефон');
    const typed = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase();
    expect(codes.claim(typed)).toBe('телефон');
  });

  it('на неизвестный код отвечает пусто', () => {
    expect(codes.claim('ZZZZZZ')).toBeNull();
    expect(codes.claim('')).toBeNull();
  });

  it('не выдаёт одному владельцу пачку кодов', () => {
    const first = codes.create('телефон');
    const second = codes.create('телефон');

    expect(codes.size()).toBe(1);
    expect(codes.claim(first.code)).toBeNull();
    expect(codes.claim(second.code)).toBe('телефон');
  });

  it('release убирает код ушедшего устройства', () => {
    const { code } = codes.create('телефон');
    codes.release('телефон');

    expect(codes.size()).toBe(0);
    expect(codes.claim(code)).toBeNull();
  });

  it('sweep выносит протухшие и не трогает живые', () => {
    const stale = codes.create('старое');
    vi.setSystemTime(Date.now() + LINK_TTL_MS + 1000);
    const fresh = codes.create('новое');

    codes.sweep();
    expect(codes.size()).toBe(1);
    expect(codes.claim(stale.code)).toBeNull();
    expect(codes.claim(fresh.code)).toBe('новое');
  });

  it('не копит коды сверх потолка', () => {
    const small = new LinkCodes<string>({ max: 3 });
    for (let i = 0; i < 10; i++) small.create(`устройство-${i}`);
    expect(small.size()).toBeLessThanOrEqual(3);
  });

  it('сообщает, когда именно код истечёт', () => {
    const { expiresAt } = codes.create('телефон');
    expect(expiresAt).toBe(Date.now() + LINK_TTL_MS);
  });
});

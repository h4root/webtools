import { describe, it, expect } from 'vitest';
import { ConnectionLimiter, isAbandoned } from './connections.ts';

describe('ConnectionLimiter: предел на источник', () => {
  it('пускает до предела и отказывает дальше', () => {
    const limiter = new ConnectionLimiter({ perSource: 2, total: 10 });
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(limiter.allow('1.1.1.1')).toBe(false);
  });

  it('один адрес не занимает место другого', () => {
    const limiter = new ConnectionLimiter({ perSource: 1, total: 10 });
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(limiter.allow('2.2.2.2')).toBe(true);
  });

  it('освобождённое место снова доступно', () => {
    const limiter = new ConnectionLimiter({ perSource: 1, total: 10 });
    limiter.allow('1.1.1.1');
    expect(limiter.allow('1.1.1.1')).toBe(false);
    limiter.release('1.1.1.1');
    expect(limiter.allow('1.1.1.1')).toBe(true);
  });

  it('отказ не занимает место', () => {
    const limiter = new ConnectionLimiter({ perSource: 1, total: 10 });
    limiter.allow('1.1.1.1');
    limiter.allow('1.1.1.1');
    limiter.release('1.1.1.1');
    expect(limiter.allow('1.1.1.1')).toBe(true);
  });
});

describe('ConnectionLimiter: общий предел', () => {
  it('держит потолок по всем источникам сразу', () => {
    const limiter = new ConnectionLimiter({ perSource: 10, total: 2 });
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(limiter.allow('2.2.2.2')).toBe(true);
    expect(limiter.allow('3.3.3.3')).toBe(false);
  });
});

describe('ConnectionLimiter: уборка', () => {
  it('пустой источник не остаётся в памяти', () => {
    const limiter = new ConnectionLimiter({ perSource: 2, total: 10 });
    limiter.allow('1.1.1.1');
    limiter.release('1.1.1.1');
    expect(limiter.sources()).toBe(0);
  });

  it('лишнее освобождение не уводит счёт в минус', () => {
    const limiter = new ConnectionLimiter({ perSource: 1, total: 10 });
    limiter.release('1.1.1.1');
    limiter.release('1.1.1.1');
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(limiter.allow('1.1.1.1')).toBe(false);
  });
});

describe('isAbandoned', () => {
  it('невошедший после срока считается брошенным', () => {
    expect(isAbandoned({ nick: null, authDeadline: 100 }, 101)).toBe(true);
  });

  it('до срока его не трогаем', () => {
    expect(isAbandoned({ nick: null, authDeadline: 100 }, 99)).toBe(false);
  });

  it('вошедшего не трогаем никогда', () => {
    expect(isAbandoned({ nick: 'alice', authDeadline: 1 }, 10_000)).toBe(false);
  });

  it('без срока не трогаем: значит про него не знают', () => {
    expect(isAbandoned({ nick: null }, 10_000)).toBe(false);
  });
});

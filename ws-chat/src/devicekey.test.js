import { describe, it, expect } from 'vitest';
import { deviceId } from '../public/devicekey.js';

const key = (seed) => btoa(String.fromCharCode(...Array.from({ length: 65 }, (_, i) => (i * seed) % 256)));

describe('deviceId', () => {
  it('выводится из самого ключа, а не из выданного сервером номера', async () => {
    expect(await deviceId(key(7))).toBe(await deviceId(key(7)));
  });

  it('разводит разные ключи', async () => {
    expect(await deviceId(key(7))).not.toBe(await deviceId(key(11)));
  });

  it('умещается в опознавательный знак получателя', async () => {
    expect(await deviceId(key(7))).toMatch(/^[a-f0-9]{32}$/);
  });
});

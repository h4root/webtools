import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { deriveKey, isSealed, openJson, sealJson } from './sealed.ts';

const key = Buffer.alloc(32, 5);

describe('sealJson / openJson', () => {
  it('возвращает то же значение', () => {
    const data = { messages: [{ id: 1, text: 'привет' }], nextId: 2 };
    expect(openJson(key, sealJson(key, data))).toEqual(data);
  });

  it('не оставляет содержимое читаемым', () => {
    const sealed = sealJson(key, { text: 'СЕКРЕТНАЯ-СТРОКА' });
    expect(sealed.includes(Buffer.from('СЕКРЕТНАЯ-СТРОКА'))).toBe(false);
    expect(sealed.includes(Buffer.from('text'))).toBe(false);
  });

  it('не открывается чужим ключом', () => {
    const sealed = sealJson(key, { text: 'своё' });
    expect(() => openJson(Buffer.alloc(32, 6), sealed)).toThrow();
  });

  it('замечает правку шифротекста', () => {
    const sealed = sealJson(key, { text: 'целостность' });
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => openJson(key, sealed)).toThrow();
  });

  it('каждый раз даёт разный шифротекст на одних данных', () => {
    const a = sealJson(key, { text: 'одно и то же' });
    const b = sealJson(key, { text: 'одно и то же' });
    expect(a.equals(b)).toBe(false);
  });

  it('отличает запечатанное от обычного JSON', () => {
    expect(isSealed(sealJson(key, { a: 1 }))).toBe(true);
    expect(isSealed(Buffer.from('{"a":1}'))).toBe(false);
    expect(isSealed(Buffer.alloc(2))).toBe(false);
  });

  it('разводит ключи по назначению', () => {
    const master = randomBytes(32);
    const store = deriveKey(master, 'store');
    const other = deriveKey(master, 'blobs');

    expect(store.equals(other)).toBe(false);
    expect(store.equals(master)).toBe(false);
    expect(deriveKey(master, 'store').equals(store)).toBe(true);
    expect(store).toHaveLength(32);
  });
});

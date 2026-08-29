import { describe, it, expect } from 'vitest';
import { fingerprint, FINGERPRINT_BYTES } from '../public/fingerprint.js';

const bytes = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i * 7 % 256));

describe('fingerprint', () => {
  it('режет на четвёрки, чтобы читать вслух', () => {
    expect(fingerprint(new Uint8Array([0x0a, 0x1b, 0x2c, 0x3d]))).toBe('0A1B 2C3D');
  });

  it('берёт только начало свёртки: остальное на слух всё равно не сверить', () => {
    const long = fingerprint(bytes(32));
    expect(long.replaceAll(' ', '')).toHaveLength(FINGERPRINT_BYTES * 2);
  });

  it('одинаковый вход даёт одинаковый отпечаток', () => {
    expect(fingerprint(bytes(32))).toBe(fingerprint(bytes(32)));
  });

  it('разный вход разводит отпечатки', () => {
    const other = bytes(32);
    other[0] ^= 0xff;
    expect(fingerprint(other)).not.toBe(fingerprint(bytes(32)));
  });

  it('принимает и буфер, и массив байтов', () => {
    const source = bytes(32);
    expect(fingerprint(source.buffer)).toBe(fingerprint(source));
  });

  it('на пустом входе не притворяется, что отпечаток есть', () => {
    expect(fingerprint(new Uint8Array())).toBe('');
  });
});

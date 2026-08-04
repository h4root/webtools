import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, loadKey } from './blobs.ts';

const KEY = Buffer.alloc(32, 7);

describe('BlobStore', () => {
  let dir: string;
  let blobs: BlobStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-blobs-'));
    blobs = new BlobStore(dir, KEY);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('возвращает то же содержимое и mime', () => {
    const data = Buffer.from('привет, это картинка');
    const { id } = blobs.put(data, 'image/png');

    const opened = blobs.open(id);
    expect(opened?.data.equals(data)).toBe(true);
    expect(opened?.meta).toEqual({ id, size: data.length, mime: 'image/png' });
  });

  it('не оставляет содержимое на диске в открытом виде', () => {
    const secret = Buffer.from('СЕКРЕТНАЯ-СТРОКА-В-ФАЙЛЕ');
    const { id } = blobs.put(secret, 'text/plain');

    const onDisk = readFileSync(join(dir, id));
    expect(onDisk.includes(secret)).toBe(false);
    expect(id).not.toContain('СЕКРЕТ');
    expect(readdirSync(dir)).toEqual([id]);
  });

  it('кладёт одинаковое содержимое один раз', () => {
    const data = Buffer.from('дубль');
    const first = blobs.put(data, 'text/plain');
    const second = blobs.put(data, 'text/plain');

    expect(second.id).toBe(first.id);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('сжимает то, что сжимается, и не раздувает то, что нет', () => {
    const text = Buffer.from('а'.repeat(50000));
    const noise = randomBytes(50000);

    const textId = blobs.put(text, 'text/plain').id;
    const noiseId = blobs.put(noise, 'application/octet-stream').id;

    expect(statSync(join(dir, textId)).size).toBeLessThan(text.length / 10);
    expect(statSync(join(dir, noiseId)).size).toBeLessThan(noise.length + 200);

    expect(blobs.open(textId)?.data.equals(text)).toBe(true);
    expect(blobs.open(noiseId)?.data.equals(noise)).toBe(true);
  });

  it('не отдаёт содержимое по чужому ключу', () => {
    const { id } = blobs.put(Buffer.from('только для своих'), 'text/plain');
    const stranger = new BlobStore(dir, Buffer.alloc(32, 9));
    expect(stranger.open(id)).toBeNull();
  });

  it('замечает правку файла на диске', () => {
    const { id } = blobs.put(Buffer.from('целостность'), 'text/plain');
    const file = join(dir, id);
    const raw = readFileSync(file);
    raw[raw.length - 1] ^= 0xff;
    writeFileSync(file, raw);

    expect(blobs.open(id)).toBeNull();
  });

  it('замечает блоб, подложенный под чужой id', () => {
    const { id: real } = blobs.put(Buffer.from('настоящий'), 'text/plain');
    const { id: fake } = blobs.put(Buffer.from('подложенный'), 'text/plain');
    writeFileSync(join(dir, real), readFileSync(join(dir, fake)));

    expect(blobs.open(real)).toBeNull();
  });

  it('не ведётся на выход за пределы каталога', () => {
    expect(blobs.open('../store.json')).toBeNull();
    expect(blobs.stat('..%2Fstore.json')).toBeNull();
    expect(blobs.open('нет-такого')).toBeNull();
  });

  it('stat читает метаданные, не расшифровывая целиком', () => {
    const { id } = blobs.put(Buffer.from('x'.repeat(1000)), 'image/webp');
    expect(blobs.stat(id)).toEqual({ id, size: 1000, mime: 'image/webp' });
    expect(blobs.stat('a'.repeat(32))).toBeNull();
  });

  it('sweep выносит только то, на что не осталось ссылок', () => {
    const keep = blobs.put(Buffer.from('нужный'), 'text/plain').id;
    const drop = blobs.put(Buffer.from('осиротевший'), 'text/plain').id;

    expect(blobs.sweep(new Set([keep]))).toBe(1);
    expect(readdirSync(dir)).toEqual([keep]);
    expect(blobs.open(drop)).toBeNull();
  });

  it('sweep щадит свежезалитое, на что ссылок ещё нет', () => {
    const pending = blobs.put(Buffer.from('ещё не отправлено'), 'text/plain').id;

    expect(blobs.sweep(new Set(), 60_000)).toBe(0);
    expect(blobs.open(pending)).not.toBeNull();
    expect(blobs.sweep(new Set(), 0)).toBe(1);
  });
});

describe('loadKey', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('создаёт ключ один раз и переиспользует его', () => {
    const first = loadKey(dir);
    expect(loadKey(dir).equals(first)).toBe(true);
    expect(statSync(join(dir, 'upload.key')).mode & 0o777).toBe(0o600);
  });

  it('берёт ключ из окружения, не трогая файл', () => {
    const hex = randomBytes(32).toString('hex');
    expect(loadKey(dir, hex).toString('hex')).toBe(hex);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ругается на ключ неверной длины', () => {
    expect(() => loadKey(dir, 'abcd')).toThrow(/UPLOAD_KEY/);
  });
});

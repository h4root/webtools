import { describe, it, expect } from 'vitest';
import { createReceiver } from '../public/transfer.js';

function collectingSinks() {
  const files = [];
  return {
    files,
    openSink(meta) {
      const parts = [];
      const record = { meta, parts, closed: false, aborted: false };
      files.push(record);
      return {
        write(chunk) {
          parts.push(new Uint8Array(chunk));
        },
        close() {
          record.closed = true;
        },
        abort() {
          record.aborted = true;
        },
      };
    },
  };
}

function bytes(...values) {
  return new Uint8Array(values).buffer;
}

function meta(name, size, mime = 'application/octet-stream') {
  return JSON.stringify({ t: 'file', name, size, mime });
}

function received(record) {
  return record.parts.reduce((sum, part) => sum + part.length, 0);
}

describe('createReceiver', () => {
  it('собирает файл из чанков и закрывает его по достижении размера', async () => {
    const sinks = collectingSinks();
    const receiver = createReceiver(sinks);

    await receiver.handle(meta('note.txt', 5));
    await receiver.handle(bytes(1, 2, 3));
    await receiver.handle(bytes(4, 5));

    expect(sinks.files).toHaveLength(1);
    expect(received(sinks.files[0])).toBe(5);
    expect(sinks.files[0].closed).toBe(true);
  });

  it('сохраняет файл нулевого размера', async () => {
    const sinks = collectingSinks();
    const receiver = createReceiver(sinks);

    await receiver.handle(meta('empty.txt', 0));
    await receiver.handle(JSON.stringify({ t: 'done' }));

    expect(sinks.files).toHaveLength(1);
    expect(sinks.files[0].closed).toBe(true);
  });

  it('не падает на байтах сверх заявленного размера', async () => {
    const sinks = collectingSinks();
    const receiver = createReceiver(sinks);

    await receiver.handle(meta('short.bin', 2));
    await receiver.handle(bytes(1, 2));
    await expect(receiver.handle(bytes(3, 4))).resolves.not.toThrow();

    expect(received(sinks.files[0])).toBe(2);
  });

  it('принимает несколько файлов подряд, не смешивая их', async () => {
    const sinks = collectingSinks();
    const receiver = createReceiver(sinks);

    await receiver.handle(meta('a.bin', 2));
    await receiver.handle(bytes(1, 2));
    await receiver.handle(meta('b.bin', 3));
    await receiver.handle(bytes(3, 4, 5));
    await receiver.handle(JSON.stringify({ t: 'done' }));

    expect(sinks.files.map((f) => f.meta.name)).toEqual(['a.bin', 'b.bin']);
    expect(received(sinks.files[0])).toBe(2);
    expect(received(sinks.files[1])).toBe(3);
    expect(sinks.files.every((f) => f.closed)).toBe(true);
  });

  it('сообщает прогресс по текущему файлу', async () => {
    const sinks = collectingSinks();
    const seen = [];
    const receiver = createReceiver({ ...sinks, onProgress: (got, size) => seen.push([got, size]) });

    await receiver.handle(meta('x.bin', 4));
    await receiver.handle(bytes(1, 2));
    await receiver.handle(bytes(3, 4));

    expect(seen).toEqual([
      [2, 4],
      [4, 4],
    ]);
  });

  it('игнорирует байты, пришедшие до метаданных', async () => {
    const sinks = collectingSinks();
    const receiver = createReceiver(sinks);

    await expect(receiver.handle(bytes(1, 2))).resolves.not.toThrow();
    expect(sinks.files).toHaveLength(0);
  });

  it('abort закрывает недописанный файл', async () => {
    const sinks = collectingSinks();
    const receiver = createReceiver(sinks);

    await receiver.handle(meta('big.bin', 10));
    await receiver.handle(bytes(1, 2));
    await receiver.abort();

    expect(sinks.files[0].aborted).toBe(true);
    expect(sinks.files[0].closed).toBe(false);
  });
});

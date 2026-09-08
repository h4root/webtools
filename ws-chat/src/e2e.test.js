import { describe, it, expect } from 'vitest';
import { seal, open, ENVELOPE_VERSION } from '../public/e2e.js';
import { parseClientMessage } from './protocol.ts';

async function device(id) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { id, key: btoa(String.fromCharCode(...new Uint8Array(raw))), privateKey: pair.privateKey };
}

const recipient = ({ id, key }) => ({ id, key });

describe('сквозное шифрование личных сообщений', () => {
  it('получатель читает то, что отправитель запечатал', async () => {
    const alice = await device('a1');
    const bob = await device('b1');
    const envelope = await seal('привет', [recipient(alice), recipient(bob)]);
    expect(await open(envelope, bob)).toBe('привет');
  });

  it('отправитель читает собственное сообщение со своего второго устройства', async () => {
    const laptop = await device('a1');
    const phone = await device('a2');
    const bob = await device('b1');
    const envelope = await seal('с телефона', [recipient(laptop), recipient(phone), recipient(bob)]);
    expect(await open(envelope, phone)).toBe('с телефона');
  });

  it('не выпускает шифротекст в открытом виде', async () => {
    const bob = await device('b1');
    const envelope = await seal('секрет', [recipient(bob)]);
    expect(JSON.stringify(envelope)).not.toContain('секрет');
    expect(envelope.v).toBe(ENVELOPE_VERSION);
  });

  it('чужому устройству не отдаёт ключ сообщения', async () => {
    const bob = await device('b1');
    const eve = await device('e1');
    const envelope = await seal('не для всех', [recipient(bob)]);
    expect(await open(envelope, eve)).toBeNull();
  });

  it('подменённый ключ сообщения не расшифровывается', async () => {
    const bob = await device('b1');
    const other = await device('b2');
    const envelope = await seal('целостность', [recipient(bob), recipient(other)]);
    envelope.to[0].ct = envelope.to[1].ct;
    expect(await open(envelope, bob)).toBeNull();
  });

  it('подправленный шифротекст не проходит проверку целостности', async () => {
    const bob = await device('b1');
    const envelope = await seal('целостность', [recipient(bob)]);
    const bytes = Uint8Array.from(atob(envelope.ct), (c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    envelope.ct = btoa(String.fromCharCode(...bytes));
    expect(await open(envelope, bob)).toBeNull();
  });

  it('конверт другой версии не вскрывается', async () => {
    const bob = await device('b1');
    const envelope = await seal('будущее', [recipient(bob)]);
    envelope.v = ENVELOPE_VERSION + 1;
    expect(await open(envelope, bob)).toBeNull();
  });

  it('каждое сообщение шифруется своим ключом', async () => {
    const bob = await device('b1');
    const first = await seal('одно и то же', [recipient(bob)]);
    const second = await seal('одно и то же', [recipient(bob)]);
    expect(first.ct).not.toBe(second.ct);
    expect(first.epk).not.toBe(second.epk);
  });

  it('без получателей запечатывать нечего', async () => {
    await expect(seal('в пустоту', [])).rejects.toThrow();
  });

  it('переживает юникод и перевод строки', async () => {
    const bob = await device('b1');
    const text = 'привет 👋\nвторая строка';
    expect(await open(await seal(text, [recipient(bob)]), bob)).toBe(text);
  });
});

describe('конверт и протокол', () => {
  it('сервер принимает ровно то, что запечатал клиент', async () => {
    const bob = await device('b1');
    const enc = await seal('привет', [recipient(bob)]);
    const parsed = parseClientMessage(JSON.stringify({ type: 'message', to: 'bob', text: '', enc }));
    expect(parsed).toMatchObject({ type: 'message', to: 'bob', enc });
  });

  it('сервер принимает правку с конвертом', async () => {
    const bob = await device('b1');
    const enc = await seal('исправлено', [recipient(bob)]);
    expect(parseClientMessage(JSON.stringify({ type: 'edit', id: 1, text: '', enc }))).toMatchObject({ id: 1, enc });
  });

  it('конверт на длинный текст и десяток устройств проходит по размерам', async () => {
    const devices = await Promise.all(Array.from({ length: 10 }, (_, i) => device(`d${i}`)));
    const enc = await seal('я'.repeat(2000), devices.map(recipient));
    expect(parseClientMessage(JSON.stringify({ type: 'message', to: 'bob', text: '', enc }))).not.toBeNull();
  });
});

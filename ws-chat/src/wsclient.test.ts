import { describe, it, expect, vi } from 'vitest';
import { createClient, SEND_QUEUE_MAX } from './wsclient.ts';
import type { ServerMessage } from './protocol.ts';

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  terminated = false;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  terminate() {
    this.terminated = true;
  }
}

const hello: ServerMessage = { type: 'system', text: 'привет' };

describe('createClient', () => {
  it('пишет в открытый сокет и молчит в закрытый', () => {
    const socket = new FakeSocket();
    const client = createClient(socket as never, '1', '10.0.0.1');

    client.send(hello);
    expect(socket.sent).toHaveLength(1);

    socket.readyState = 3;
    client.send(hello);
    expect(socket.sent).toHaveLength(1);
  });

  it('запоминает источник соединения', () => {
    const client = createClient(new FakeSocket() as never, '7', '10.0.0.9');
    expect(client.source).toBe('10.0.0.9');
    expect(client.id).toBe('7');
  });

  it('отключает того, кто не разгребает очередь', () => {
    const socket = new FakeSocket();
    const onDrop = vi.fn();
    const client = createClient(socket as never, '1', '10.0.0.1', onDrop);

    socket.bufferedAmount = SEND_QUEUE_MAX + 1;
    client.send(hello);

    expect(socket.sent).toHaveLength(0);
    expect(socket.terminated).toBe(true);
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it('после отключения больше ничего не пишет и не дёргает повторно', () => {
    const socket = new FakeSocket();
    const onDrop = vi.fn();
    const client = createClient(socket as never, '1', '10.0.0.1', onDrop);

    socket.bufferedAmount = SEND_QUEUE_MAX + 1;
    client.send(hello);
    client.send(hello);
    client.send(hello);

    expect(socket.sent).toHaveLength(0);
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it('терпит очередь в пределах лимита', () => {
    const socket = new FakeSocket();
    const client = createClient(socket as never, '1', '10.0.0.1');

    socket.bufferedAmount = SEND_QUEUE_MAX - 1;
    client.send(hello);

    expect(socket.sent).toHaveLength(1);
    expect(socket.terminated).toBe(false);
  });

  it('close закрывает сокет вежливо', () => {
    const socket = new FakeSocket();
    createClient(socket as never, '1', '10.0.0.1').close?.();
    expect(socket.closed).toBe(true);
  });
});

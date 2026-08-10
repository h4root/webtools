import type { WebSocket } from 'ws';
import type { Client } from './chat.ts';

// Клиент, который не разгребает входящее, копит очередь в памяти сервера:
// ws буферизует всё, что не влезло в сокет. В шумном канале это растёт быстрее,
// чем кажется, поэтому такого клиента честнее отключить, чем тащить.
export const SEND_QUEUE_MAX = 4 * 1024 * 1024;

export function createClient(socket: WebSocket, id: string, source: string, onDrop?: () => void): Client {
  let dropped = false;

  return {
    id,
    nick: null,
    token: '',
    source,
    send(message) {
      if (dropped || socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > SEND_QUEUE_MAX) {
        dropped = true;
        socket.terminate();
        onDrop?.();
        return;
      }
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
}

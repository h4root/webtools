import type { WebSocket } from 'ws';
import type { Client } from './chat.ts';

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

import type { WebSocketServer, WebSocket } from 'ws';
import { Signaling, type Peer } from './signaling.ts';
import { generateName } from './names.ts';

export interface AttachOptions {
  heartbeatMs?: number;
}

export function attachSignaling(wss: WebSocketServer, options: AttachOptions = {}): () => void {
  const heartbeatMs = options.heartbeatMs ?? 30000;
  const signaling = new Signaling();
  const alive = new WeakMap<WebSocket, boolean>();
  let nextId = 1;

  const onConnection = (ws: WebSocket): void => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));

    const id = String(nextId++);
    const peer: Peer = {
      id,
      name: generateName(Number(id)),
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
    };

    signaling.join(peer);

    ws.on('message', (data) => signaling.handle(peer, data.toString()));
    ws.on('close', () => signaling.leave(peer));
    ws.on('error', () => {
      signaling.leave(peer);
      ws.terminate();
    });
  };

  wss.on('connection', onConnection);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const stop = (): void => {
    clearInterval(heartbeat);
    wss.off('connection', onConnection);
  };
  wss.on('close', stop);

  return stop;
}

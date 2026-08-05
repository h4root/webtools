import type { WebSocketServer, WebSocket } from 'ws';
import { Signaling, type Peer } from './signaling.ts';
import { generateName } from './names.ts';

export interface AuthenticatedPeer {
  name: string;
}

export interface AttachOptions {
  heartbeatMs?: number;
  authenticate?: (raw: string) => AuthenticatedPeer | null;
  authTimeoutMs?: number;
}

export function attachSignaling(wss: WebSocketServer, options: AttachOptions = {}): () => void {
  const heartbeatMs = options.heartbeatMs ?? 30000;
  const authTimeoutMs = options.authTimeoutMs ?? 10000;
  const authenticate = options.authenticate;
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

    let admitted = false;
    const admit = (): void => {
      admitted = true;
      signaling.join(peer);
    };

    let authTimer: ReturnType<typeof setTimeout> | null = null;
    if (authenticate) {
      authTimer = setTimeout(() => ws.terminate(), authTimeoutMs);
      authTimer.unref?.();
    } else {
      admit();
    }

    ws.on('message', (data) => {
      const raw = data.toString();
      if (admitted) {
        signaling.handle(peer, raw);
        return;
      }

      const granted = safeAuthenticate(authenticate!, raw);
      if (!granted) {
        peer.send({ type: 'error', reason: 'Нет доступа' });
        ws.close();
        return;
      }
      if (authTimer) clearTimeout(authTimer);
      peer.name = granted.name;
      admit();
    });

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      if (admitted) signaling.leave(peer);
    });
    ws.on('error', () => {
      if (authTimer) clearTimeout(authTimer);
      if (admitted) signaling.leave(peer);
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

function safeAuthenticate(authenticate: (raw: string) => AuthenticatedPeer | null, raw: string): AuthenticatedPeer | null {
  try {
    const granted = authenticate(raw);
    return granted && typeof granted.name === 'string' && granted.name.length > 0 ? granted : null;
  } catch {
    return null;
  }
}

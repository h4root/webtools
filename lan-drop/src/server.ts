import 'dotenv/config';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Signaling, type Peer } from './signaling.ts';
import { generateName } from './names.ts';
import { SIGNAL_MAX } from './protocol.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Некорректный PORT: ${process.env.PORT}`);
  process.exit(1);
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.use(express.static(publicDir));

const HEARTBEAT_MS = 30000;

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: SIGNAL_MAX * 2 });
const signaling = new Signaling();

let nextId = 1;
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  const id = String(nextId++);
  const peer: Peer = {
    id,
    name: generateName(Number(id)),
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
  };

  signaling.join(peer);

  ws.on('message', (data) => signaling.handle(peer, data.toString()));
  ws.on('close', () => signaling.leave(peer));
  ws.on('error', () => {
    signaling.leave(peer);
    ws.terminate();
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`lan-drop on http://${HOST}:${PORT}`);
});

function shutdown(): void {
  console.log('останавливаюсь');
  for (const ws of wss.clients) ws.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

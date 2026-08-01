import 'dotenv/config';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Hub, type Client } from './chat.ts';
import { Store } from './store.ts';
import { TEXT_MAX, SIGNAL_MAX } from './protocol.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Некорректный PORT: ${process.env.PORT}`);
  process.exit(1);
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.use(
  express.static(publicDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

const HEARTBEAT_MS = 30000;

const tlsKey = process.env.TLS_KEY;
const tlsCert = process.env.TLS_CERT;
const useTls = Boolean(tlsKey && tlsCert);

const server = useTls
  ? createHttpsServer({ key: readFileSync(tlsKey!), cert: readFileSync(tlsCert!) }, app)
  : createHttpServer(app);

const wss = new WebSocketServer({ server, maxPayload: Math.max(TEXT_MAX * 4, SIGNAL_MAX * 2) });
const dataFile = join(process.env.DATA_DIR ?? join(publicDir, '..', 'data'), 'store.json');
const hub = new Hub(new Store(dataFile));

let nextId = 1;
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  const client: Client = {
    id: String(nextId++),
    nick: null,
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
  };

  ws.on('message', (data) => hub.handle(client, data.toString()));
  ws.on('close', () => hub.leave(client));
  ws.on('error', () => {
    hub.leave(client);
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
  const scheme = useTls ? 'https' : 'http';
  console.log(`chat server on ${scheme}://${HOST}:${PORT}`);
  if (!useTls) {
    console.log('HTTP: микрофон/камера будут работать только на localhost. Для доступа с других устройств задай TLS_KEY и TLS_CERT (HTTPS).');
  }
});

function shutdown(): void {
  console.log('останавливаюсь');
  for (const ws of wss.clients) ws.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

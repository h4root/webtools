import 'dotenv/config';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
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
const dataDir = process.env.DATA_DIR ?? join(publicDir, '..', 'data');
const uploadsDir = join(dataDir, 'uploads');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);

const app = express();
app.use(
  express.static(publicDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

app.use(
  '/uploads',
  express.static(uploadsDir, {
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Не-картинки отдаём как вложение — чтобы svg/html не исполнялись в origin.
      if (!IMAGE_EXT.has(extname(filePath).toLowerCase())) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  }),
);

app.post('/upload', express.raw({ type: () => true, limit: SIGNAL_MAX * 1600 }), (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: 'empty' });
    return;
  }
  const rawName = typeof req.headers['x-filename'] === 'string' ? decodeURIComponent(req.headers['x-filename']) : 'file';
  const name = rawName.slice(0, 255);
  const mime = req.headers['content-type'] ?? 'application/octet-stream';
  const ext = safeExt(name);
  const id = randomBytes(16).toString('hex') + ext;
  try {
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, id), body);
  } catch {
    res.status(500).json({ error: 'write' });
    return;
  }
  res.json({ id, name, size: body.length, mime });
});

function safeExt(name: string): string {
  const ext = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

const HEARTBEAT_MS = 30000;

const tlsKey = process.env.TLS_KEY;
const tlsCert = process.env.TLS_CERT;
const useTls = Boolean(tlsKey && tlsCert);

const server = useTls
  ? createHttpsServer({ key: readFileSync(tlsKey!), cert: readFileSync(tlsCert!) }, app)
  : createHttpServer(app);

const wss = new WebSocketServer({ server, maxPayload: Math.max(TEXT_MAX * 4, SIGNAL_MAX * 2) });
const dataFile = join(dataDir, 'store.json');
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

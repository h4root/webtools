import 'dotenv/config';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express, { type Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Hub, type Client } from './chat.ts';
import { Store } from './store.ts';
import { BlobStore, loadKey } from './blobs.ts';
import { Auth } from './auth.ts';
import { ATTACH_SIZE_MAX, TEXT_MAX, SIGNAL_MAX } from './protocol.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Некорректный PORT: ${process.env.PORT}`);
  process.exit(1);
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const dataDir = process.env.DATA_DIR ?? join(publicDir, '..', 'data');
const uploadsDir = join(dataDir, 'uploads');

const HEARTBEAT_MS = 30000;
const SWEEP_MS = 60000;
// Файл уже залит, но сообщение с ним ещё не отправлено — не выметать.
const UPLOAD_GRACE_MS = 30 * 60 * 1000;
// Показывать в браузере встроенно можно только заведомо безопасные растровые
// форматы. Всё прочее (в том числе svg — это документ со скриптами) уходит
// вложением, чтобы ничего не исполнилось в нашем origin.
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const UPLOADS_PER_MIN = 30;

const store = new Store(join(dataDir, 'store.json'));
const blobs = new BlobStore(uploadsDir, loadKey(dataDir, process.env.UPLOAD_KEY));
const auth = new Auth(dataDir);
const hub = new Hub(store, blobs, auth);

const app = express();
app.use(
  express.static(publicDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

// Вложения открываются по той же сессии, что и чат, — она переживает и
// перезагрузку страницы, и обрыв сокета.
function authorize(req: Request): { nick: string; token: string } | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  const session = auth.resume(token);
  return session ? { nick: session.nick, token } : null;
}

const uploadRate = new Map<string, { count: number; until: number }>();

function rateLimited(token: string): boolean {
  const now = Date.now();
  const entry = uploadRate.get(token);
  if (!entry || entry.until < now) {
    uploadRate.set(token, { count: 1, until: now + 60000 });
    return false;
  }
  entry.count++;
  return entry.count > UPLOADS_PER_MIN;
}

app.post('/upload', express.raw({ type: () => true, limit: ATTACH_SIZE_MAX }), (req, res) => {
  const client = authorize(req);
  if (!client) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (rateLimited(client.token)) {
    res.status(429).json({ error: 'too-many-uploads' });
    return;
  }

  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: 'empty' });
    return;
  }

  const rawName = typeof req.headers['x-filename'] === 'string' ? safeName(req.headers['x-filename']) : 'file';
  const mime = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'].slice(0, 128) : 'application/octet-stream';

  try {
    const meta = blobs.put(body, mime);
    res.json({ id: meta.id, name: rawName, size: meta.size, mime: meta.mime });
  } catch (error) {
    console.error('upload:', (error as Error).message);
    res.status(500).json({ error: 'write' });
  }
});

// Отдаём только расшифровав и только тому, кто участвует в разговоре, где это
// вложение приложено. Знания ссылки недостаточно — заголовок обязателен, так
// что открыть картинку, просто вставив адрес в браузер, нельзя.
app.get('/uploads/:id', (req, res) => {
  const client = authorize(req);
  if (!client) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const attachment = store.findAttachment(req.params.id, client.nick);
  if (!attachment) {
    res.status(404).json({ error: 'not-found' });
    return;
  }

  const blob = blobs.open(attachment.id);
  if (!blob) {
    res.status(410).json({ error: 'gone' });
    return;
  }

  const inline = INLINE_MIME.has(blob.meta.mime);
  res.setHeader('Content-Type', inline ? blob.meta.mime : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
  );
  res.send(blob.data);
});

function safeName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* пришло не как URI-компонент — берём как есть */
  }
  // Имя используется только в Content-Disposition и в интерфейсе, но пусть в
  // нём заведомо не будет разделителей пути.
  return decoded.replace(/[/\\\r\n]/g, '_').slice(0, 255) || 'file';
}

const tlsKey = process.env.TLS_KEY;
const tlsCert = process.env.TLS_CERT;
const useTls = Boolean(tlsKey && tlsCert);

const server = useTls
  ? createHttpsServer({ key: readFileSync(tlsKey!), cert: readFileSync(tlsCert!) }, app)
  : createHttpServer(app);

const wss = new WebSocketServer({ server, maxPayload: Math.max(TEXT_MAX * 4, SIGNAL_MAX * 2) });

let nextId = 1;
const alive = new WeakMap<WebSocket, boolean>();

wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  const client: Client = {
    id: String(nextId++),
    nick: null,
    // До входа токена ещё нет: настоящий приходит вместе с сессией.
    token: '',
    send(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close() {
      ws.close();
    },
  };

  ws.on('message', (data) => hub.handle(client, data.toString()));
  ws.on('close', () => {
    uploadRate.delete(client.token);
    hub.leave(client);
  });
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

// Блобы, на которые не осталось ссылок (сообщение удалили или его вытеснило из
// истории), иначе копились бы на диске вечно.
function sweepUploads(): void {
  const removed = blobs.sweep(store.attachmentIds(), UPLOAD_GRACE_MS);
  if (removed) console.log(`вложения: убрано ${removed} без ссылок`);
}

const sweeper = setInterval(sweepUploads, SWEEP_MS);
sweeper.unref();
sweepUploads();

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(sweeper);
});

server.listen(PORT, HOST, () => {
  const scheme = useTls ? 'https' : 'http';
  console.log(`chat server on ${scheme}://${HOST}:${PORT}`);
  if (!useTls) {
    console.log('HTTP: микрофон/камера будут работать только на localhost. Для доступа с других устройств задай TLS_KEY и TLS_CERT (HTTPS).');
  }
});

function shutdown(): void {
  console.log('останавливаюсь');
  store.flush();
  for (const ws of wss.clients) ws.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Подстраховка на случай выхода мимо shutdown (например process.exit при ошибке
// конфигурации): flush синхронный, поэтому в 'exit' он ещё успевает отработать.
process.on('exit', () => store.flush());

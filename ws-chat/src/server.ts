import 'dotenv/config';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Hub, type Client } from './chat.ts';
import { Store } from './store.ts';
import { BlobStore, loadKey } from './blobs.ts';
import { Auth } from './auth.ts';
import { deriveKey } from './sealed.ts';
import { createClient } from './wsclient.ts';
import { attachSignaling } from 'lan-drop';
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
const ACCOUNT_SWEEP_MS = 5 * 60 * 1000;
const UPLOAD_GRACE_MS = 30 * 60 * 1000;
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);
const UPLOADS_PER_MIN = 30;

// Блобы шифруются мастер-ключом напрямую — так сложилось, и менять это нельзя,
// иначе уже загруженные вложения перестанут открываться. Истории даём отдельный
// производный ключ: одна утечка не раскрывает второе хранилище.
const masterKey = loadKey(dataDir, process.env.UPLOAD_KEY);
const store = new Store(join(dataDir, 'store.json'), deriveKey(masterKey, 'store'));
const blobs = new BlobStore(uploadsDir, masterKey);
const auth = new Auth(dataDir);
const hub = new Hub(store, blobs, auth);

const dropClientDir = join(dirname(fileURLToPath(import.meta.resolve('lan-drop/client'))));

// Страница вендорит всё локально и наружу не ходит, поэтому политику можно
// затянуть до предела. blob: нужен картинкам и файлам: вложения скачиваются
// по токену и показываются из локальных blob-ссылок, а не по адресу сервера.
const CSP = [
  "default-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (useTls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(
  express.static(publicDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);
app.use(
  '/drop-client',
  express.static(dropClientDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }),
);

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

// Всё, что не нашлось, и всё, что упало, наружу выглядит одинаково скупо:
// стандартный обработчик express отдавал клиенту стек с путями до файлов.
app.use((_req, res) => {
  res.status(404).json({ error: 'not-found' });
});

app.use((error: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = error.status ?? error.statusCode ?? 500;
  if (status >= 500) console.error('http:', error.message);
  res.status(status).json({ error: status === 413 ? 'too-large' : 'request-failed' });
});

function safeName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {}
  return decoded.replace(/[/\\\r\n]/g, '_').slice(0, 255) || 'file';
}

const tlsKey = process.env.TLS_KEY;
const tlsCert = process.env.TLS_CERT;
const useTls = Boolean(tlsKey && tlsCert);

const server = useTls
  ? createHttpsServer({ key: readFileSync(tlsKey!), cert: readFileSync(tlsCert!) }, app)
  : createHttpServer(app);

const maxPayload = Math.max(TEXT_MAX * 4, SIGNAL_MAX * 2);
const wss = new WebSocketServer({ noServer: true, maxPayload });
const dropWss = new WebSocketServer({ noServer: true, maxPayload });

attachSignaling(dropWss, {
  authenticate: (raw) => {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token !== 'string') return null;
    const session = auth.resume(parsed.token);
    if (!session) return null;
    const device = typeof parsed.device === 'string' ? parsed.device.replace(/[^\p{L}\p{N} .-]/gu, '').slice(0, 16).trim() : '';
    return { name: device ? `${session.nick} · ${device}` : session.nick };
  },
});

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const target = pathname === '/drop' ? dropWss : pathname === '/' ? wss : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
});

let nextId = 1;
const alive = new WeakMap<WebSocket, boolean>();

// За обратным прокси remoteAddress у всех одинаковый, и лимит по нему запер бы
// всех разом. Но верить X-Forwarded-For по умолчанию нельзя — заголовок ставит
// кто угодно, и лимит обходится подстановкой случайного адреса.
const trustProxy = process.env.TRUST_PROXY === '1';

function sourceOf(request: IncomingMessage): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? 'неизвестно';
}

wss.on('connection', (ws, request: IncomingMessage) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  const client: Client = createClient(ws, String(nextId++), sourceOf(request), () => {
    console.error(`сокет ${client.nick ?? 'без имени'}: очередь переполнена, отключаю`);
    hub.leave(client);
  });

  ws.on('message', (data) => {
    try {
      hub.handle(client, data.toString());
    } catch (error) {
      console.error('обработка сообщения:', (error as Error).message);
    }
  });
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

function sweepUploads(): void {
  const removed = blobs.sweep(store.attachmentIds(), UPLOAD_GRACE_MS);
  if (removed) console.log(`вложения: убрано ${removed} без ссылок`);
}

const sweeper = setInterval(sweepUploads, SWEEP_MS);
sweeper.unref();
sweepUploads();

function sweepAccounts(): void {
  const freed = auth.sweep(hub.onlineNicks());
  if (!freed.length) return;
  hub.purgeAccounts(freed);
  console.log(`аккаунты: освобождены гостевые ники ${freed.join(', ')}`);
}

const accountSweeper = setInterval(sweepAccounts, ACCOUNT_SWEEP_MS);
accountSweeper.unref();
sweepAccounts();

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
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) ws.close();
  for (const ws of dropWss.clients) ws.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Один необработанный отказ не должен уносить чат у всех. Историю сбрасываем
// на диск в любом случае: пусть лучше сервер уйдёт, чем останется в состоянии,
// про которое мы ничего не знаем.
process.on('unhandledRejection', (reason) => {
  console.error('необработанный отказ:', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', (error) => {
  console.error('необработанное исключение:', error.message);
  store.flush();
  process.exit(1);
});
process.on('exit', () => store.flush());

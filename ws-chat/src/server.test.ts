import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(base: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('сервер не поднялся');
}

interface Peer {
  socket: WebSocket;
  token: string;
  send(message: unknown): void;
  wait(type: string): Promise<Record<string, unknown> | null>;
}

function connect(base: string, path = ''): Promise<{ socket: WebSocket; inbox: Record<string, unknown>[] }> {
  const url = base.replace('http', 'ws') + path;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox: Record<string, unknown>[] = [];
    socket.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    socket.on('open', () => resolve({ socket, inbox }));
    socket.on('error', reject);
  });
}

async function login(base: string, nick: string): Promise<Peer> {
  const { socket, inbox } = await connect(base);
  const peer: Peer = {
    socket,
    token: '',
    send: (message) => socket.send(JSON.stringify(message)),
    async wait(type) {
      for (let i = 0; i < 100; i++) {
        const found = inbox.filter((m) => m.type === type).at(-1);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    },
  };
  peer.send({ type: 'auth', mode: 'guest', nick });
  const welcome = await peer.wait('welcome');
  if (!welcome) throw new Error(`не пустило под ником ${nick}`);
  peer.token = welcome.token as string;
  return peer;
}

function upload(base: string, token: string | null, body: string | Uint8Array, mime = 'image/png', name = 'pic.png') {
  const headers: Record<string, string> = { 'Content-Type': mime, 'X-Filename': encodeURIComponent(name) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${base}/upload`, { method: 'POST', headers, body });
}

const payload = () => new Uint8Array(64).fill(9);

interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
}

async function uploaded(res: Response): Promise<Attachment> {
  return (await res.json()) as Attachment;
}

describe('HTTP-слой', () => {
  let child: ChildProcess;
  let base: string;
  let dataDir: string;
  let alice: Peer;
  let bob: Peer;
  let mallory: Peer;

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    dataDir = mkdtempSync(join(tmpdir(), 'ws-chat-http-'));

    child = spawn(join(projectDir, 'node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
      stdio: 'ignore',
    });

    await waitForServer(base);
    alice = await login(base, 'alice');
    bob = await login(base, 'bob');
    mallory = await login(base, 'mallory');
  }, 60000);

  afterAll(() => {
    for (const peer of [alice, bob, mallory]) peer?.socket.close();
    child?.kill();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('отдаёт страницу с политикой, запрещающей внешние запросы', async () => {
    const res = await fetch(base);
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('разрешает blob: для картинок — на них держатся вложения', async () => {
    const csp = (await fetch(base)).headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/img-src[^;]*blob:/);
  });

  it('без TLS не обещает HSTS', async () => {
    expect((await fetch(base)).headers.get('strict-transport-security')).toBeNull();
  });

  it('на слишком большое тело отвечает без внутренностей сервера', async () => {
    const res = await upload(base, alice.token, new Uint8Array(27 * 1024 * 1024));
    const body = await res.text();

    expect(res.status).toBe(413);
    expect(body).not.toMatch(/at .+\.js:\d+/);
    expect(body).not.toContain('node_modules');
    expect(body).not.toContain(projectDir);
  }, 30000);

  it('не пускает сокет со сторонней страницы', async () => {
    const url = base.replace('http', 'ws');
    const refused = await new Promise<string>((resolve) => {
      const socket = new WebSocket(url, { origin: 'https://evil.example' });
      socket.on('open', () => resolve('пустило'));
      socket.on('error', () => resolve('отказ'));
      socket.on('close', () => resolve('отказ'));
    });
    expect(refused).toBe('отказ');
  });

  it('пускает сокет со своей же страницы', async () => {
    const url = base.replace('http', 'ws');
    const host = new URL(base).host;
    const opened = await new Promise<string>((resolve) => {
      const socket = new WebSocket(url, { origin: `http://${host}` });
      socket.on('open', () => {
        socket.close();
        resolve('пустило');
      });
      socket.on('error', () => resolve('отказ'));
    });
    expect(opened).toBe('пустило');
  });

  it('пускает клиента без Origin: это не браузер', async () => {
    const { socket } = await connect(base);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('health отвечает и не кешируется', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('health не раскрывает, кто в чате', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(JSON.stringify(body)).not.toMatch(/nick|token|user/i);
  });

  it('шрифты кешируются надолго, а код приложения — нет', async () => {
    const font = await fetch(`${base}/fonts/jetbrains-mono-400.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('cache-control')).toMatch(/max-age=\d{5,}/);

    const app = await fetch(`${base}/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get('cache-control')).toContain('no-cache');
  });

  it('на неизвестный путь отвечает коротко и без разметки', async () => {
    const res = await fetch(`${base}/нет-такого`);
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(body).not.toContain('<html');
    expect(body).not.toContain('node_modules');
  });

  it('не принимает загрузку без токена', async () => {
    const res = await upload(base, null, 'nope');
    expect(res.status).toBe(401);
  });

  it('не принимает загрузку с чужим токеном', async () => {
    const res = await upload(base, 'guessed-token', 'nope');
    expect(res.status).toBe(401);
  });

  it('принимает загрузку по сессии и возвращает id блоба', async () => {
    const res = await upload(base, alice.token, payload());
    expect(res.status).toBe(200);
    const meta = await uploaded(res);
    expect(meta.id).toMatch(/^[a-f0-9]{32}$/);
    expect(meta.size).toBe(64);
  });

  it('не отдаёт блоб, на который ещё нет сообщения', async () => {
    const { id } = await uploaded(await upload(base, alice.token, new Uint8Array(32).fill(3)));
    const res = await fetch(`${base}/uploads/${id}`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(res.status).toBe(404);
  });

  it('вложение из личной переписки видят только её участники', async () => {
    const { id, name, size, mime } = await uploaded(await upload(base, alice.token, payload()));
    alice.send({ type: 'message', to: 'bob', text: 'только тебе', attachments: [{ id, name, size, mime }] });
    await new Promise((r) => setTimeout(r, 300));

    const anonymous = await fetch(`${base}/uploads/${id}`);
    expect(anonymous.status).toBe(401);

    for (const peer of [alice, bob]) {
      const res = await fetch(`${base}/uploads/${id}`, { headers: { Authorization: `Bearer ${peer.token}` } });
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload());
    }

    const stranger = await fetch(`${base}/uploads/${id}`, { headers: { Authorization: `Bearer ${mallory.token}` } });
    expect(stranger.status).toBe(404);
  });

  it('картинку отдаёт встроенно, остальное — только вложением', async () => {
    const png = await uploaded(await upload(base, alice.token, payload(), 'image/png', 'кот.png'));
    const page = await uploaded(await upload(base, alice.token, new Uint8Array([60, 33]), 'text/html', 'страница.html'));
    alice.send({ type: 'message', channel: 'general', text: 'два файла', attachments: [png, page] });
    await new Promise((r) => setTimeout(r, 300));

    const asImage = await fetch(`${base}/uploads/${png.id}`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(asImage.headers.get('content-type')).toBe('image/png');
    expect(asImage.headers.get('content-disposition')).toContain('inline');

    const asFile = await fetch(`${base}/uploads/${page.id}`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(asFile.headers.get('content-type')).toBe('application/octet-stream');
    expect(asFile.headers.get('content-disposition')).toContain('attachment');
    expect(asFile.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('не пускает в сигналинг передачи файлов без сессии', async () => {
    const { socket, inbox } = await connect(base, '/drop');
    socket.send(JSON.stringify({ token: 'guessed-token' }));
    await new Promise((r) => setTimeout(r, 400));

    expect(inbox.at(-1)).toEqual({ type: 'error', reason: 'Нет доступа' });
    expect(inbox.some((m) => m.type === 'welcome')).toBe(false);
    socket.close();
  });

  it('пускает в сигналинг по токену сессии и называет пира ником', async () => {
    const { socket, inbox } = await connect(base, '/drop');
    socket.send(JSON.stringify({ token: alice.token, device: 'Mac' }));
    for (let i = 0; i < 60 && !inbox.some((m) => m.type === 'welcome'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(inbox.find((m) => m.type === 'welcome')).toMatchObject({ name: 'alice · Mac' });
    socket.close();
  });

  it('закрывает неизвестные пути для веб-сокетов', async () => {
    await expect(connect(base, '/чужое')).rejects.toThrow();
  });

  it('осаживает слишком частые загрузки', async () => {
    const fresh = await login(base, 'торопыга');
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const res = await upload(base, fresh.token, new Uint8Array([i]));
      if (res.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    fresh.socket.close();
  });
});

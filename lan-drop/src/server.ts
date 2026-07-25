import 'dotenv/config';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { attachSignaling } from './attach.ts';
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

const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: SIGNAL_MAX * 2 });
attachSignaling(wss);

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

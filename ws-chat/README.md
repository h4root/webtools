# ws-chat

## Запуск

```bash
cd ws-chat
cp .env.example .env
npm install
npm run dev     # http://localhost:3000
npm start       # прод
```

С других устройств в LAN: `http://<ip-хоста>:3000` (сервер слушает `0.0.0.0`).

## Конфигурация

| Переменная | По умолчанию | Назначение                        |
|------------|--------------|-----------------------------------|
| `PORT`     | `3000`       | Порт HTTP/WebSocket-сервера.      |
| `HOST`     | `0.0.0.0`    | Адрес привязки (LAN — `0.0.0.0`). |

## Голосовой чат

Кнопка «Голос» в сайдбаре включает голосовой канал. Звук идёт по **WebRTC-аудио напрямую между устройствами** (mesh: каждый шлёт микрофон каждому), кодек Opus поверх UDP/SRTP - минимальная задержка, на LAN это десятки миллисекунд. Сервер только пересылает сигналинг (SDP/ICE), медиа через него не проходит.

- Участники голоса привязаны к никам чата; видно, кто в голосе.
- Открытый микрофон + кнопка mute.
- `iceServers` пуст: на LAN хватает host-кандидатов, трафик не покидает сеть.
- Рассчитано на небольшую группу (mesh); для десятков участников нужен был бы SFU.

## Структура

```
src/
  protocol.ts   типы сообщений + валидация входящих
  chat.ts       Hub - роутинг public / direct + сигналинг голоса
  chat.test.ts  тесты роутинга и голоса
  server.ts     Express (раздаёт public/) + WebSocketServer
public/
  app.js        клиент чата
  voice.js      mesh WebRTC-аудио (createVoice)
  index.html styles.css
```

## Протокол (JSON поверх WebSocket)

Клиент → сервер:

- `{ "type": "hello", "nick": "alice" }`
- `{ "type": "public", "text": "…" }`
- `{ "type": "direct", "to": "bob", "text": "…" }`
- `{ "type": "voice-join" }` / `{ "type": "voice-leave" }`
- `{ "type": "voice-signal", "to": "bob", "data": … }` - SDP/ICE конкретному нику

Сервер → клиент: `welcome`, `presence`, `chat`, `system`, `error`, `voice-roster` (кто уже в голосе - новичок шлёт им offer), `voice-presence`, `voice-signal`.

## Тесты

```bash
npm test
npm run typecheck
```

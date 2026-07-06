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

## Структура

```
src/
  protocol.ts   типы сообщений + валидация входящих
  chat.ts       Hub — роутинг public / direct
  chat.test.ts  тесты роутинга
  server.ts     Express (раздаёт public/) + WebSocketServer
public/         клиент (index.html / app.js / styles.css)
```

## Протокол (JSON поверх WebSocket)

Клиент → сервер:

- `{ "type": "hello", "nick": "alice" }`
- `{ "type": "public", "text": "…" }`
- `{ "type": "direct", "to": "bob", "text": "…" }`

Сервер → клиент: `welcome`, `presence`, `chat`, `system`, `error`.

## Тесты

```bash
npm test
npm run typecheck
```

# ws-chat

Минималистичный реалтайм-чат поверх WebSocket для локальной сети — задумано как
общение без интернета на домашнем сервере (в духе [Bitchat](https://github.com/permissionlesstech/bitchat),
только по Wi-Fi/LAN вместо Bluetooth-mesh). Без регистрации: ввёл ник — и пишешь.
Есть общий канал и личные сообщения. Состояние эфемерное, полностью в памяти
сервера — ничего не хранится на диске.

## Стек

- **Бэкенд:** Node.js + Express + [`ws`](https://github.com/websockets/ws), TypeScript (ESM).
- **Фронтенд:** статика без сборки (`public/`), ванильный JS.
- **Тесты:** Vitest.

TypeScript запускается напрямую через [`tsx`](https://github.com/privatenumber/tsx) —
шага сборки нет.

## Запуск

```bash
cd ws-chat
cp .env.example .env      # при желании поменять порт/хост
npm install
npm run dev               # http://localhost:3000
```

Прод-режим — `npm start`.

### Подключение с других устройств в той же сети

Сервер слушает `0.0.0.0`, поэтому с любого устройства в локальной сети открывай
`http://<ip-хоста>:3000`. Узнать IP хоста: `ipconfig` (Windows) или `ip addr` (Linux).

## Конфигурация

| Переменная | По умолчанию | Назначение                          |
|------------|--------------|-------------------------------------|
| `PORT`     | `3000`       | Порт HTTP/WebSocket-сервера.        |
| `HOST`     | `0.0.0.0`    | Адрес привязки (LAN — `0.0.0.0`).   |

## Архитектура

```
src/
  protocol.ts   типы сообщений клиент↔сервер + парсинг/валидация входящих
  chat.ts       Hub — реестр подключений и роутинг (public / direct), без привязки
                к сокетам, поэтому покрыт юнит-тестами
  chat.test.ts  тесты роутинга
  server.ts     Express (раздаёт public/) + WebSocketServer, чтение .env, graceful shutdown
public/         клиент (index.html / app.js / styles.css)
```

Ключевое решение: `Hub` не знает про WebSocket — клиент описан интерфейсом
`{ id, nick, send() }`, а транспорт инжектится в `server.ts`. Это даёт тестируемость
логики и упрощает будущую замену транспорта.

## Протокол (JSON поверх WebSocket)

Клиент → сервер:

- `{ "type": "hello", "nick": "alice" }`
- `{ "type": "public", "text": "…" }`
- `{ "type": "direct", "to": "bob", "text": "…" }`

Сервер → клиент: `welcome`, `presence`, `chat`, `system`, `error`.

## Тесты

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## Роадмап

- Именованные комнаты/каналы помимо `public`.
- Опциональная персистентность истории.
- Масштабирование на открытый сервер: аутентификация, TLS (`wss`), rate-limiting,
  общий стейт между инстансами (Redis pub/sub).

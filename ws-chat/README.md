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

## Приватный звонок

В личке (DM с ником) есть кнопка «Позвонить» - отдельный **1-на-1 звонок в стиле Discord** поверх того же сигналинга: приглашение → входящий баннер с «Принять / Отклонить» → соединение. Звонящий шлёт offer после приёма (нет glare). Если ник не в сети - звонящий получает `call-end` с `reason: offline`; если абонент уже в звонке - автоматический `call-decline` с `reason: busy`.

Панель звонка (справа-снизу, живёт поверх любого канала) показывает:

- **Кто говорит** - зелёное кольцо у активного участника (детект речи через WebAudio `AnalyserNode`, RMS по потоку локально).
- **Аудио-индикатор** - шкала уровня по каждому участнику.
- **Задержку и качество** - из `RTCPeerConnection.getStats()` раз в секунду: RTT (мс), потери, джиттер, битрейт, кодек (opus), и **используемый транспорт** - протокол (UDP/TCP) и типы ICE-кандидатов (`host` / `srflx` / `relay`). Точка слева меняет цвет: зелёная (хорошо) / жёлтая (норм) / красная (плохо).

Всё P2P, `iceServers` пуст - на LAN это host-кандидаты по UDP. Панель звонка можно перетаскивать за верхний хват.

## Настройки

Кнопка-шестерёнка снизу-слева открывает попап:

- **Микрофон / Динамик** - выбор устройств ввода и вывода (`enumerateDevices`; вывод через `HTMLMediaElement.setSinkId`, где поддерживается). Смена применяется на лету в активном голосе/звонке (`replaceTrack`).
- **Эффекты микрофона** - шумоподавление, эхоподавление, автоусиление (constraints `noiseSuppression` / `echoCancellation` / `autoGainControl`).
- **Шрифт** - переключение между JetBrains Mono, Victor Mono, IBM Plex Mono и системным моно. Шрифты забандлены локально (`public/fonts/*.woff2`), работает офлайн.

Настройки хранятся в `localStorage`. Иконки - [akar-icons](https://github.com/artcoholic/akar-icons) (MIT), инлайн-SVG без внешних запросов.

## Структура

```
src/
  protocol.ts   типы сообщений + валидация входящих
  chat.ts       Hub - роутинг public / direct + сигналинг голоса и звонка
  chat.test.ts  тесты роутинга, голоса и звонка
  server.ts     Express (раздаёт public/) + WebSocketServer
public/
  app.js        клиент чата
  voice.js      mesh WebRTC-аудио группового голоса (createVoice)
  call.js       приватный 1-на-1 звонок + индикаторы и статистика (createCall)
  settings.js   попап настроек: устройства, эффекты, шрифт (localStorage)
  icons.js      инлайн akar-icons
  fonts/        забандленные woff2 (JetBrains Mono / Victor Mono / IBM Plex Mono)
  vendor/       auto-animate.mjs (@formkit/auto-animate, MIT) - анимация ленты
  index.html styles.css
```

Анимации: появление сообщений через [@formkit/auto-animate](https://github.com/formkit/auto-animate) (MIT, забандлен локально в `public/vendor/`), остальное - CSS-кейфреймы (вход панелей/попапа, пульс входящего звонка и кольца «говорит», ховеры). По умолчанию уважают системный `prefers-reduced-motion`, но в настройках есть переключатель **Анимации: Система / Вкл / Выкл** (`Вкл` форсит их даже при системном «уменьшить движение»).

## Протокол (JSON поверх WebSocket)

Клиент → сервер:

- `{ "type": "hello", "nick": "alice" }`
- `{ "type": "public", "text": "…" }`
- `{ "type": "direct", "to": "bob", "text": "…" }`
- `{ "type": "voice-join" }` / `{ "type": "voice-leave" }`
- `{ "type": "voice-signal", "to": "bob", "data": … }` - SDP/ICE конкретному нику
- `{ "type": "call-invite" | "call-accept" | "call-decline" | "call-end", "to": "bob" }` - управление приватным звонком
- `{ "type": "call-signal", "to": "bob", "data": … }` - SDP/ICE звонка

Сервер → клиент: `welcome`, `presence`, `chat`, `system`, `error`, `voice-roster` (кто уже в голосе - новичок шлёт им offer), `voice-presence`, `voice-signal`, и зеркальные `call-*` с полем `from` (плюс `reason` у `call-end`/`call-decline`: `offline` / `busy`).

## Тесты

```bash
npm test
npm run typecheck
```

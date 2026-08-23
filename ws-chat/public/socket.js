const RECONNECT_MS = 2000;
const RECONNECT_MAX_MS = 15000;

// Что имеет смысл придержать до восстановления связи. Всё остальное
// (история, набор текста, сигналинг) к моменту переподключения устареет.
const QUEUEABLE = new Set(['message', 'edit', 'delete', 'react', 'channel-create', 'voice-channel-create']);

const QUEUE_MAX = 100;

export function createSocket({ isJoined, hello, onMessage, onDown, onQueueChange }) {
  let ws = null;
  let timer = null;
  let delay = RECONNECT_MS;
  let outbox = [];
  // Отправленные, но ещё не вернувшиеся эхом: метка -> сообщение.
  const unsent = new Map();

  function url() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}`;
  }

  function isOpen() {
    return Boolean(ws) && ws.readyState === WebSocket.OPEN;
  }

  function connect() {
    const socket = new WebSocket(url());
    ws = socket;
    socket.addEventListener('open', () => {
      delay = RECONNECT_MS;
      if (isOpen()) hello();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage(message);
    });
    socket.addEventListener('close', () => {
      onDown();
      schedule();
    });
    socket.addEventListener('error', () => socket.close());
  }

  function schedule() {
    if (timer || !isJoined()) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    delay = Math.min(RECONNECT_MAX_MS, delay * 2);
  }

  function send(message) {
    if (isOpen()) {
      ws.send(JSON.stringify(message));
      return;
    }
    if (isJoined() && QUEUEABLE.has(message.type) && outbox.length < QUEUE_MAX) {
      outbox.push(message);
      onQueueChange();
    }
  }

  // Форма входа шлёт либо в живой сокет, либо поднимает его: hello повторит
  // запрос сам, как только соединение откроется.
  function request(message) {
    if (isOpen()) ws.send(JSON.stringify(message));
    else connect();
  }

  function newNonce() {
    return crypto.randomUUID().replaceAll('-', '');
  }

  function sendMessage(message) {
    unsent.set(message.nonce, message);
    send(message);
  }

  function flush() {
    const pending = outbox;
    outbox = [];
    for (const message of pending) send(message);
    // Отправленное в уже мёртвый сокет не попадало в очередь и пропадало молча.
    // Повторяем сами; сервер узнает повтор по метке и второй раз не создаст.
    for (const message of unsent.values()) send(message);
  }

  function confirm(nonce) {
    unsent.delete(nonce);
  }

  function stop() {
    outbox = [];
    if (!ws) return;
    const socket = ws;
    ws = null;
    socket.close();
  }

  function reset() {
    clearTimeout(timer);
    timer = null;
    unsent.clear();
  }

  return { connect, request, send, sendMessage, newNonce, flush, confirm, stop, reset, isOpen, queued: () => outbox.length };
}

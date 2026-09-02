import { splitText } from './linkify.js';

function mentionsMe(text, me) {
  const lower = me.toLowerCase();
  return splitText(text ?? '').some((part) => part.kind === 'mention' && part.value.slice(1).toLowerCase() === lower);
}

// Уведомление оправдано, только когда человек не смотрит и сообщение к нему
// обращено. Всё подряд из каналов приучает нажимать «выключить».
export function shouldNotify(msg, { me, hidden, enabled }) {
  if (!enabled || !hidden || msg.system) return false;
  if (msg.from === me) return false;
  if (msg.to !== undefined) return true;
  return mentionsMe(msg.text, me);
}

const TAG = 'ws-chat';

// Разрешение спрашивают только по явному действию человека: браузеры давно
// не любят, когда его просят при загрузке, а Safari такой запрос просто
// игнорирует.
export function createNotifier({ getNick, isEnabled, onOpen }) {
  function supported() {
    return typeof Notification !== 'undefined' && window.isSecureContext;
  }

  async function ask() {
    if (!supported()) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    return Notification.requestPermission();
  }

  function show(msg) {
    if (!supported() || Notification.permission !== 'granted') return;
    if (!shouldNotify(msg, { me: getNick(), hidden: document.hidden, enabled: isEnabled() })) return;

    const where = msg.to !== undefined ? msg.from : `${msg.from} · # ${msg.channel}`;
    // tag схлопывает подряд идущие сообщения из одного места в одно окошко:
    // десять уведомлений о десяти строках — это наказание, а не помощь.
    const note = new Notification(where, { body: msg.text || 'вложение', tag: `${TAG}:${msg.to !== undefined ? msg.from : msg.channel}` });
    note.addEventListener('click', () => {
      window.focus();
      note.close();
      onOpen(msg);
    });
  }

  return { supported, ask, show };
}

import { splitText } from './linkify.js';

function mentionsMe(text, me) {
  const lower = me.toLowerCase();
  return splitText(text ?? '').some((part) => part.kind === 'mention' && part.value.slice(1).toLowerCase() === lower);
}

export function shouldNotify(msg, { me, hidden, enabled }) {
  if (!enabled || !hidden || msg.system) return false;
  if (msg.from === me) return false;
  if (msg.to !== undefined) return true;
  return mentionsMe(msg.text, me);
}

const TAG = 'ws-chat';

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
    const note = new Notification(where, { body: msg.text || 'вложение', tag: `${TAG}:${msg.to !== undefined ? msg.from : msg.channel}` });
    note.addEventListener('click', () => {
      window.focus();
      note.close();
      onOpen(msg);
    });
  }

  return { supported, ask, show };
}

import { keyOf } from './keys.js';

export const SHOW_MS = 5000;
export const SEND_MS = 2500;

export function createTyping({ send, onChange }) {
  const byKey = new Map();
  let watching = null;
  let lastSent = 0;

  function notify(key) {
    if (key === watching) onChange(nicks(key));
  }

  function nicks(key) {
    return [...(byKey.get(key)?.keys() ?? [])];
  }

  function clear(key, nick) {
    const map = byKey.get(key);
    if (!map?.has(nick)) return;
    clearTimeout(map.get(nick));
    map.delete(nick);
    notify(key);
  }

  function receive(message) {
    const key = message.channel ? keyOf('channel', message.channel) : keyOf('dm', message.from);
    const map = byKey.get(key) ?? new Map();
    byKey.set(key, map);
    if (map.has(message.from)) clearTimeout(map.get(message.from));
    map.set(message.from, setTimeout(() => clear(key, message.from), SHOW_MS));
    notify(key);
  }

  return {
    receive,
    clear,
    nicks,
    watch(key) {
      watching = key;
      onChange(nicks(key));
    },
    send(target) {
      const now = Date.now();
      if (now - lastSent < SEND_MS) return;
      lastSent = now;
      send(target.kind === 'channel' ? { type: 'typing', channel: target.id } : { type: 'typing', to: target.id });
    },
    reset() {
      for (const map of byKey.values()) {
        for (const timer of map.values()) clearTimeout(timer);
      }
      byKey.clear();
      lastSent = 0;
      notify(watching);
    },
  };
}

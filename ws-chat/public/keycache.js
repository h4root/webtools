const WAIT_MS = 4000;

export function createKeyCache({ request, timeoutMs = WAIT_MS }) {
  const known = new Map();
  const waiting = new Map();

  function remember(nick, devices) {
    const lower = nick.toLowerCase();
    known.set(lower, devices);
    const pending = waiting.get(lower);
    if (!pending) return;
    waiting.delete(lower);
    clearTimeout(pending.timer);
    pending.resolve(devices);
  }

  function get(nick) {
    const lower = nick.toLowerCase();
    if (known.has(lower)) return Promise.resolve(known.get(lower));

    const pending = waiting.get(lower);
    if (pending) return pending.promise;

    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => {
      waiting.delete(lower);
      resolve([]);
    }, timeoutMs);
    waiting.set(lower, { promise, resolve, timer });
    request(nick);
    return promise;
  }

  function peek(nick) {
    return known.get(nick.toLowerCase()) ?? null;
  }

  function clear() {
    known.clear();
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    waiting.clear();
  }

  return { remember, get, peek, clear };
}

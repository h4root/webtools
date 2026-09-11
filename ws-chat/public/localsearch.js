export const LOCAL_LIMIT = 50;

export function searchLocal(conversations, nick, query, limit = LOCAL_LIMIT) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const found = [];
  for (const [key, messages] of conversations) {
    if (!key.startsWith('dm:')) continue;
    for (const msg of messages) {
      if (msg.locked || msg.system) continue;
      if (!msg.text?.toLowerCase().includes(needle)) continue;
      found.push(msg);
    }
  }
  return found.sort((a, b) => b.id - a.id).slice(0, limit);
}

export function mergeHits(fromServer, mine, limit = LOCAL_LIMIT) {
  const byId = new Map();
  for (const msg of fromServer ?? []) byId.set(msg.id, msg);
  for (const msg of mine ?? []) byId.set(msg.id, msg);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, limit);
}

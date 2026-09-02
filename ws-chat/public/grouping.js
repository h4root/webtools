const GAP_MS = 5 * 60 * 1000;

export function sameGroup(prev, msg, gapMs = GAP_MS) {
  if (!prev || prev.system || msg.system) return false;
  if (msg.replyTo) return false;
  if (prev.from.toLowerCase() !== msg.from.toLowerCase()) return false;
  return msg.ts - prev.ts < gapMs;
}

export function avatarHue(nick) {
  const text = String(nick ?? '').toLowerCase();
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.codePointAt(0)) % 360;
  }
  return hash;
}

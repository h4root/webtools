// Пять минут молчания — уже другой заход в разговор, и подписывать его именем
// заново правильнее, чем клеить к сказанному до паузы.
const GAP_MS = 5 * 60 * 1000;

export function sameGroup(prev, msg, gapMs = GAP_MS) {
  if (!prev || prev.system || msg.system) return false;
  // У ответа сверху своя цитата: приклеенный к предыдущей строке, он теряет
  // и подпись автора, и понятную границу.
  if (msg.replyTo) return false;
  if (prev.from.toLowerCase() !== msg.from.toLowerCase()) return false;
  return msg.ts - prev.ts < gapMs;
}

// Цвет выводится из ника, а не выдаётся по порядку: тогда у человека он
// одинаковый на всех устройствах и не пляшет от того, кто раньше вошёл.
export function avatarHue(nick) {
  const text = String(nick ?? '').toLowerCase();
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + char.codePointAt(0)) % 360;
  }
  return hash;
}

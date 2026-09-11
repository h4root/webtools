// Тон берётся не из всего круга, а из дюжины ступеней через 30°. На непрерывном
// круге соседние ники то и дело расходились на пару градусов — формально разные
// цвета, на глаз один. Со ступенями два ника либо совпадают, либо различимы.
const STOPS = 12;
const STEP = 360 / STOPS;

// Светлота и насыщенность общие: так ни один ник не выходит ярче или бледнее
// остальных. OKLCH, а не HSL, потому что в HSL при равной светлоте жёлтый
// выглядит ярче синего.
const LIGHTNESS = 0.84;
const CHROMA = 0.1;

function hash(nick) {
  let h = 2166136261;
  for (const char of String(nick ?? '').toLowerCase()) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  // Перемешивание обязательно: без него user1 и user2 садятся на соседние тона.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return h >>> 0;
}

export function nickHue(nick) {
  return (hash(nick) % STOPS) * STEP;
}

export function nickColor(nick) {
  return `oklch(${LIGHTNESS} ${CHROMA} ${nickHue(nick)})`;
}

export function paintNick(el, nick) {
  el.style.color = nickColor(nick);
  return el;
}

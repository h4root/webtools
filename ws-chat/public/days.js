const DAY_MS = 24 * 60 * 60 * 1000;

function midnight(ts) {
  const date = new Date(ts);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function sameDay(a, b) {
  return midnight(a) === midnight(b);
}

// «Вчера» — это про календарь, а не про сутки назад: в час ночи вчерашним
// считается всё, что было до полуночи, хоть двадцать минут назад.
export function dayLabel(ts, now) {
  const start = midnight(now);
  if (ts >= start) return 'Сегодня';
  if (ts >= start - DAY_MS) return 'Вчера';

  const date = new Date(ts);
  const options = { day: 'numeric', month: 'long' };
  if (date.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString('ru-RU', options).replace(' г.', '');
}

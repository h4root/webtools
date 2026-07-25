const ADJECTIVES = [
  'Тихий',
  'Смелый',
  'Быстрый',
  'Хитрый',
  'Ясный',
  'Тёплый',
  'Острый',
  'Лёгкий',
  'Дерзкий',
  'Мудрый',
  'Синий',
  'Рыжий',
];

const ANIMALS = [
  'Барсук',
  'Филин',
  'Лис',
  'Кит',
  'Ёж',
  'Волк',
  'Ворон',
  'Тюлень',
  'Рысь',
  'Бобр',
  'Сокол',
  'Крот',
];

export function generateName(seed: number): string {
  const adjective = ADJECTIVES[seed % ADJECTIVES.length];
  const animal = ANIMALS[Math.floor(seed / ADJECTIVES.length) % ANIMALS.length];
  return `${adjective} ${animal}`;
}

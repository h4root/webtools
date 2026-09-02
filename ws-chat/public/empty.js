export const NO_DMS = 'Личных переписок пока нет. Нажми на человека в списке участников.';
export const NO_VOICE = 'Голосовых каналов нет.';

export function emptyLogText(target = {}) {
  if (target.kind === 'dm') {
    return target.id ? `С ${target.id} ещё не переписывались. Первое сообщение за тобой.` : 'Переписка пока пуста.';
  }
  return target.id ? `В канале # ${target.id} ещё ничего не написали. Начни первым.` : 'В канале пока пусто.';
}

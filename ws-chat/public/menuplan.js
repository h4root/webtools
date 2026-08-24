const SEPARATOR = { separator: true };

function nickItems(nick, me, canCopy) {
  const items = [];
  if (nick.toLowerCase() !== me.toLowerCase()) {
    items.push({ id: 'dm', label: 'Написать лично' });
    items.push({ id: 'mention', label: 'Упомянуть' });
  }
  if (canCopy) items.push({ id: 'copy-nick', label: 'Копировать ник' });
  return items;
}

function messageItems(message, me, canCopy) {
  if (message.system) return [];
  const items = [
    { id: 'reply', label: 'Ответить' },
    { id: 'react', label: 'Реакция' },
  ];
  if (message.text && canCopy) items.push({ id: 'copy-text', label: 'Копировать текст' });
  if (message.replyTo) items.push({ id: 'jump', label: 'К оригиналу' });
  if (message.from !== me) return items;
  items.push(SEPARATOR, { id: 'edit', label: 'Изменить' }, { id: 'delete', label: 'Удалить', danger: true });
  return items;
}

// Ник важнее сообщения: щелчок по имени внутри строки — это про человека,
// а не про то, что он написал.
export function planMenu({ message, nick, me, canCopy }) {
  if (nick) return nickItems(nick, me, canCopy);
  if (message) return messageItems(message, me, canCopy);
  return [];
}

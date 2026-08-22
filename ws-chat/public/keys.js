// Ключ разговора. Имя канала сервер различает по регистру, а ник — нет,
// поэтому нижний регистр только у личной переписки.
export function keyOf(kind, id) {
  return kind === 'channel' ? `ch:${id}` : `dm:${id.toLowerCase()}`;
}

// Разговор, к которому относится сообщение: для личного это собеседник, а не
// отправитель, иначе своё же сообщение уехало бы в переписку с самим собой.
export function targetOf(msg, myNick) {
  if (msg.channel) return { kind: 'channel', id: msg.channel };
  const mine = msg.from.toLowerCase() === myNick.toLowerCase();
  return { kind: 'dm', id: mine ? msg.to : msg.from };
}

export function messageKey(msg, myNick) {
  const target = targetOf(msg, myNick);
  return keyOf(target.kind, target.id);
}

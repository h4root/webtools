export function keyOf(kind, id) {
  return kind === 'channel' ? `ch:${id}` : `dm:${id.toLowerCase()}`;
}

export function targetOf(msg, myNick) {
  if (msg.channel) return { kind: 'channel', id: msg.channel };
  const mine = msg.from.toLowerCase() === myNick.toLowerCase();
  return { kind: 'dm', id: mine ? msg.to : msg.from };
}

export function messageKey(msg, myNick) {
  const target = targetOf(msg, myNick);
  return keyOf(target.kind, target.id);
}

const CHANNEL = /^[a-z0-9-]{1,24}$/;

export function channelSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  return CHANNEL.test(slug) ? slug : null;
}

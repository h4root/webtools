export function isOnline(nick, { me, online }) {
  const lower = nick.toLowerCase();
  return nick === me || online.some((n) => n.toLowerCase() === lower);
}

// Свежие переписки сверху, как в мессенджерах. Ниже — те, кому ещё не писали:
// они попадают в список просто потому, что сейчас в сети, и двигать их нечему.
export function orderDms({ me, online, partners, active }) {
  const seen = new Map();
  for (const nick of online) if (nick !== me) seen.set(nick.toLowerCase(), nick);
  for (const partner of partners) if (partner.nick !== me) seen.set(partner.nick.toLowerCase(), partner.nick);
  if (active.kind === 'dm' && !seen.has(active.id.toLowerCase())) seen.set(active.id.toLowerCase(), active.id);

  return [...seen.entries()]
    .map(([lower, nick]) => ({ nick, ts: partners.find((p) => p.nick.toLowerCase() === lower)?.ts ?? 0 }))
    .sort(
      (a, b) =>
        b.ts - a.ts ||
        Number(isOnline(b.nick, { me, online })) - Number(isOnline(a.nick, { me, online })) ||
        a.nick.localeCompare(b.nick),
    )
    .map((entry) => entry.nick);
}

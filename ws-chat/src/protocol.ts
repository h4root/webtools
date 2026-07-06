export const NICK_MAX = 24;
export const TEXT_MAX = 2000;

export type ClientMessage =
  | { type: 'hello'; nick: string }
  | { type: 'public'; text: string }
  | { type: 'direct'; to: string; text: string };

export type ChatChannel = 'public' | 'direct';

export type ServerMessage =
  | { type: 'welcome'; nick: string }
  | { type: 'presence'; users: string[] }
  | { type: 'chat'; channel: ChatChannel; from: string; to?: string; text: string; ts: number }
  | { type: 'system'; text: string }
  | { type: 'error'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  switch (data.type) {
    case 'hello':
      return isBoundedString(data.nick, NICK_MAX) ? { type: 'hello', nick: data.nick.trim() } : null;
    case 'public':
      return isBoundedString(data.text, TEXT_MAX) ? { type: 'public', text: data.text } : null;
    case 'direct':
      return isBoundedString(data.to, NICK_MAX) && isBoundedString(data.text, TEXT_MAX)
        ? { type: 'direct', to: data.to.trim(), text: data.text }
        : null;
    default:
      return null;
  }
}

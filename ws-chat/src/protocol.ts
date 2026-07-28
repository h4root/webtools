export const NICK_MAX = 24;
export const TEXT_MAX = 2000;
export const SIGNAL_MAX = 16384;

export type ClientMessage =
  | { type: 'hello'; nick: string }
  | { type: 'public'; text: string }
  | { type: 'direct'; to: string; text: string }
  | { type: 'voice-join' }
  | { type: 'voice-leave' }
  | { type: 'voice-signal'; to: string; data: unknown }
  | { type: 'call-invite'; to: string }
  | { type: 'call-accept'; to: string }
  | { type: 'call-decline'; to: string; reason?: string }
  | { type: 'call-end'; to: string }
  | { type: 'call-signal'; to: string; data: unknown };

export type ChatChannel = 'public' | 'direct';

export type ServerMessage =
  | { type: 'welcome'; nick: string }
  | { type: 'presence'; users: string[] }
  | { type: 'chat'; channel: ChatChannel; from: string; to?: string; text: string; ts: number }
  | { type: 'system'; text: string }
  | { type: 'error'; reason: string }
  | { type: 'voice-roster'; users: string[] }
  | { type: 'voice-presence'; users: string[] }
  | { type: 'voice-signal'; from: string; data: unknown }
  | { type: 'call-invite'; from: string }
  | { type: 'call-accept'; from: string }
  | { type: 'call-decline'; from: string; reason?: string }
  | { type: 'call-end'; from: string; reason?: string }
  | { type: 'call-signal'; from: string; data: unknown };

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
    case 'voice-join':
      return { type: 'voice-join' };
    case 'voice-leave':
      return { type: 'voice-leave' };
    case 'voice-signal':
      if (!isBoundedString(data.to, NICK_MAX)) return null;
      if (data.data === undefined) return null;
      if (JSON.stringify(data.data).length > SIGNAL_MAX) return null;
      return { type: 'voice-signal', to: data.to.trim(), data: data.data };
    case 'call-invite':
      return isBoundedString(data.to, NICK_MAX) ? { type: 'call-invite', to: data.to.trim() } : null;
    case 'call-accept':
      return isBoundedString(data.to, NICK_MAX) ? { type: 'call-accept', to: data.to.trim() } : null;
    case 'call-end':
      return isBoundedString(data.to, NICK_MAX) ? { type: 'call-end', to: data.to.trim() } : null;
    case 'call-decline': {
      if (!isBoundedString(data.to, NICK_MAX)) return null;
      const reason = typeof data.reason === 'string' && data.reason.length <= 64 ? data.reason : undefined;
      return { type: 'call-decline', to: data.to.trim(), reason };
    }
    case 'call-signal':
      if (!isBoundedString(data.to, NICK_MAX)) return null;
      if (data.data === undefined) return null;
      if (JSON.stringify(data.data).length > SIGNAL_MAX) return null;
      return { type: 'call-signal', to: data.to.trim(), data: data.data };
    default:
      return null;
  }
}

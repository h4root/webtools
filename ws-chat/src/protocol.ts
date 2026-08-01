export const NICK_MAX = 24;
export const TEXT_MAX = 2000;
export const SIGNAL_MAX = 16384;
export const CHANNEL_MAX = 24;

const CHANNEL_PATTERN = /^[a-z0-9-]{1,24}$/;

export interface WireMessage {
  id: number;
  from: string;
  text: string;
  ts: number;
  edited: boolean;
  channel?: string;
  to?: string;
}

export type ClientMessage =
  | { type: 'hello'; nick: string }
  | { type: 'channel-create'; name: string }
  | { type: 'message'; channel?: string; to?: string; text: string }
  | { type: 'history'; channel?: string; to?: string }
  | { type: 'edit'; id: number; text: string }
  | { type: 'delete'; id: number }
  | { type: 'typing'; channel?: string; to?: string }
  | { type: 'voice-join' }
  | { type: 'voice-leave' }
  | { type: 'voice-signal'; to: string; data: unknown }
  | { type: 'call-invite'; to: string }
  | { type: 'call-accept'; to: string }
  | { type: 'call-decline'; to: string; reason?: string }
  | { type: 'call-end'; to: string }
  | { type: 'call-signal'; to: string; data: unknown };

export type ServerMessage =
  | { type: 'welcome'; nick: string }
  | { type: 'channels'; list: string[] }
  | { type: 'presence'; users: string[] }
  | { type: 'message'; msg: WireMessage }
  | { type: 'history'; channel?: string; to?: string; messages: WireMessage[] }
  | { type: 'edited'; id: number; text: string }
  | { type: 'deleted'; id: number }
  | { type: 'typing'; from: string; channel?: string; to?: string }
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

export function isValidChannelName(name: unknown): name is string {
  return typeof name === 'string' && CHANNEL_PATTERN.test(name);
}

// Ровно одно из channel / to; channel — валидное имя, to — ник.
function parseTarget(data: Record<string, unknown>): { channel?: string; to?: string } | null {
  const hasChannel = data.channel !== undefined;
  const hasTo = data.to !== undefined;
  if (hasChannel === hasTo) return null;
  if (hasChannel) return isValidChannelName(data.channel) ? { channel: data.channel } : null;
  return isBoundedString(data.to, NICK_MAX) ? { to: data.to.trim() } : null;
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
    case 'channel-create':
      return isValidChannelName(data.name) ? { type: 'channel-create', name: data.name } : null;
    case 'message': {
      const target = parseTarget(data);
      if (!target || !isBoundedString(data.text, TEXT_MAX)) return null;
      return { type: 'message', ...target, text: data.text };
    }
    case 'history': {
      const target = parseTarget(data);
      return target ? { type: 'history', ...target } : null;
    }
    case 'typing': {
      const target = parseTarget(data);
      return target ? { type: 'typing', ...target } : null;
    }
    case 'edit':
      if (typeof data.id !== 'number' || !isBoundedString(data.text, TEXT_MAX)) return null;
      return { type: 'edit', id: data.id, text: data.text };
    case 'delete':
      return typeof data.id === 'number' ? { type: 'delete', id: data.id } : null;
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

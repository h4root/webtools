export const NICK_MAX = 24;
export const TEXT_MAX = 2000;
export const SIGNAL_MAX = 16384;
export const CHANNEL_MAX = 24;
export const ATTACH_MAX = 10;
export const ATTACH_SIZE_MAX = 26_214_400;
export const PASSWORD_LIMIT = 200;

const ATTACH_ID = /^[a-f0-9]{32}$/;

export const REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '👀'];

const CHANNEL_PATTERN = /^[a-z0-9-]{1,24}$/;

export type Reactions = Record<string, string[]>;

export interface Attachment {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface ReplyRef {
  id: number;
  from: string;
  text: string;
}

export interface WireMessage {
  id: number;
  from: string;
  text: string;
  ts: number;
  edited: boolean;
  channel?: string;
  to?: string;
  reactions?: Reactions;
  replyTo?: ReplyRef;
  attachments?: Attachment[];
}

export type AuthMode = 'guest' | 'register' | 'login' | 'resume';

export type ClientMessage =
  | { type: 'auth'; mode: AuthMode; nick?: string; password?: string; token?: string }
  | { type: 'logout'; everywhere?: boolean }
  | { type: 'change-password'; current: string; next: string }
  | { type: 'channel-create'; name: string }
  | { type: 'channel-delete'; name: string }
  | { type: 'voice-channel-delete'; name: string }
  | { type: 'message'; channel?: string; to?: string; text: string; replyTo?: number; attachments?: AttachmentRef[] }
  | { type: 'history'; channel?: string; to?: string }
  | { type: 'edit'; id: number; text: string }
  | { type: 'delete'; id: number }
  | { type: 'react'; id: number; emoji: string }
  | { type: 'typing'; channel?: string; to?: string }
  | { type: 'voice-channel-create'; name: string }
  | { type: 'voice-join'; channel: string }
  | { type: 'voice-leave' }
  | { type: 'voice-signal'; to: string; data: unknown }
  | { type: 'call-invite'; to: string }
  | { type: 'call-accept'; to: string }
  | { type: 'call-decline'; to: string; reason?: string }
  | { type: 'call-end'; to: string }
  | { type: 'call-signal'; to: string; data: unknown };

export type ServerMessage =
  | { type: 'welcome'; nick: string; token: string; guest: boolean }
  | { type: 'auth-error'; reason: string; retryAfterMs?: number }
  | { type: 'logged-out'; reason?: string }
  | { type: 'password-changed' }
  | { type: 'purged'; nick: string }
  | { type: 'channels'; list: string[] }
  | { type: 'presence'; users: string[] }
  | { type: 'dms'; list: { nick: string; ts: number }[] }
  | { type: 'message'; msg: WireMessage }
  | { type: 'history'; channel?: string; to?: string; messages: WireMessage[] }
  | { type: 'edited'; id: number; text: string }
  | { type: 'deleted'; id: number }
  | { type: 'reaction'; id: number; reactions: Reactions }
  | { type: 'typing'; from: string; channel?: string; to?: string }
  | { type: 'system'; text: string }
  | { type: 'error'; reason: string }
  | { type: 'voice-channels'; list: string[] }
  | { type: 'voice-roster'; channel: string; users: string[] }
  | { type: 'voice-presence'; channels: Record<string, string[]> }
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

function parseTarget(data: Record<string, unknown>): { channel?: string; to?: string } | null {
  const hasChannel = data.channel !== undefined;
  const hasTo = data.to !== undefined;
  if (hasChannel === hasTo) return null;
  if (hasChannel) return isValidChannelName(data.channel) ? { channel: data.channel } : null;
  return isBoundedString(data.to, NICK_MAX) ? { to: data.to.trim() } : null;
}

function parseAttachments(value: unknown): AttachmentRef[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACH_MAX) return null;
  const out: AttachmentRef[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const { id, name, size, mime } = item;
    if (typeof id !== 'string' || !ATTACH_ID.test(id)) return null;
    if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
    if (typeof size !== 'number' || size < 0 || size > ATTACH_SIZE_MAX) return null;
    if (typeof mime !== 'string' || mime.length === 0 || mime.length > 128) return null;
    out.push({ id, name, size, mime });
  }
  return out;
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
    case 'auth': {
      const mode = data.mode;
      if (mode !== 'guest' && mode !== 'register' && mode !== 'login' && mode !== 'resume') return null;
      if (mode === 'resume') {
        return typeof data.token === 'string' && data.token.length <= 128 ? { type: 'auth', mode, token: data.token } : null;
      }
      if (!isBoundedString(data.nick, NICK_MAX)) return null;
      if (mode === 'guest') return { type: 'auth', mode, nick: data.nick.trim() };
      if (typeof data.password !== 'string' || data.password.length > PASSWORD_LIMIT) return null;
      return { type: 'auth', mode, nick: data.nick.trim(), password: data.password };
    }
    case 'logout':
      return { type: 'logout', everywhere: data.everywhere === true };
    case 'change-password': {
      if (typeof data.current !== 'string' || data.current.length > PASSWORD_LIMIT) return null;
      if (typeof data.next !== 'string' || data.next.length > PASSWORD_LIMIT) return null;
      return { type: 'change-password', current: data.current, next: data.next };
    }
    case 'channel-create':
      return isValidChannelName(data.name) ? { type: 'channel-create', name: data.name } : null;
    case 'channel-delete':
      return isValidChannelName(data.name) ? { type: 'channel-delete', name: data.name } : null;
    case 'voice-channel-delete':
      return isValidChannelName(data.name) ? { type: 'voice-channel-delete', name: data.name } : null;
    case 'message': {
      const target = parseTarget(data);
      if (!target) return null;
      const attachments = parseAttachments(data.attachments);
      if (attachments === null) return null;
      const text = typeof data.text === 'string' ? data.text : '';
      if (text.length > TEXT_MAX) return null;
      const hasText = text.trim().length > 0;
      if (!hasText && attachments.length === 0) return null;
      const replyTo = typeof data.replyTo === 'number' ? data.replyTo : undefined;
      return {
        type: 'message',
        ...target,
        text: hasText ? text : '',
        replyTo,
        attachments: attachments.length ? attachments : undefined,
      };
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
    case 'react':
      if (typeof data.id !== 'number' || typeof data.emoji !== 'string' || !REACTIONS.includes(data.emoji)) return null;
      return { type: 'react', id: data.id, emoji: data.emoji };
    case 'voice-channel-create':
      return isValidChannelName(data.name) ? { type: 'voice-channel-create', name: data.name } : null;
    case 'voice-join':
      return isValidChannelName(data.channel) ? { type: 'voice-join', channel: data.channel } : null;
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

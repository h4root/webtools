import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttachmentRef, Reactions, ReplyRef, WireMessage } from './protocol.ts';

export const DEFAULT_CHANNELS = ['general', 'random'];
export const DEFAULT_VOICE_CHANNELS = ['general', 'games'];
const HISTORY_LIMIT = 200;
const SAVE_DEBOUNCE_MS = 400;

interface StoredMessage {
  id: number;
  key: string;
  from: string;
  to?: string;
  channel?: string;
  text: string;
  ts: number;
  edited: boolean;
  reactions?: Reactions;
  replyTo?: ReplyRef;
  attachments?: AttachmentRef[];
}

interface MessageExtra {
  replyTo?: number;
  attachments?: AttachmentRef[];
}

export function channelKey(name: string): string {
  return `ch:${name}`;
}

export function dmKey(a: string, b: string): string {
  return 'dm:' + [a.toLowerCase(), b.toLowerCase()].sort().join('|');
}

function toWire(message: StoredMessage): WireMessage {
  return {
    id: message.id,
    from: message.from,
    text: message.text,
    ts: message.ts,
    edited: message.edited,
    channel: message.channel,
    to: message.to,
    reactions: message.reactions && Object.keys(message.reactions).length ? message.reactions : undefined,
    replyTo: message.replyTo,
    attachments: message.attachments?.map((a) => ({
      url: `/uploads/${a.id}`,
      name: a.name,
      size: a.size,
      mime: a.mime,
    })),
  };
}

export class Store {
  private channels: string[];
  private voiceChannels: string[];
  private messages: StoredMessage[] = [];
  private nextId = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath?: string) {
    this.channels = [...DEFAULT_CHANNELS];
    this.voiceChannels = [...DEFAULT_VOICE_CHANNELS];
    if (filePath) this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath!, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.channels) && data.channels.length) this.channels = data.channels;
      if (Array.isArray(data.voiceChannels) && data.voiceChannels.length) this.voiceChannels = data.voiceChannels;
      if (Array.isArray(data.messages)) this.messages = data.messages;
      if (typeof data.nextId === 'number') this.nextId = data.nextId;
      // nextId может отсутствовать или отстать (правка файла руками, обрезанная
      // запись). Пересекающиеся id ломают find(): edit/delete/react попадут в
      // чужое сообщение, поэтому берём заведомо свободный.
      for (const message of this.messages) {
        if (typeof message?.id === 'number' && message.id >= this.nextId) this.nextId = message.id + 1;
      }
    } catch {
      /* нет файла или битый — стартуем с дефолтов */
    }
  }

  private scheduleSave(): void {
    if (!this.filePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.filePath!), { recursive: true });
        writeFileSync(
          this.filePath!,
          JSON.stringify({
            channels: this.channels,
            voiceChannels: this.voiceChannels,
            messages: this.messages,
            nextId: this.nextId,
          }),
        );
      } catch {
        /* сохранение необязательно — данные остаются в памяти */
      }
    }, SAVE_DEBOUNCE_MS);
  }

  listChannels(): string[] {
    return [...this.channels];
  }

  hasChannel(name: string): boolean {
    return this.channels.includes(name);
  }

  createChannel(name: string): boolean {
    if (this.channels.includes(name)) return false;
    this.channels.push(name);
    this.scheduleSave();
    return true;
  }

  listVoiceChannels(): string[] {
    return [...this.voiceChannels];
  }

  hasVoiceChannel(name: string): boolean {
    return this.voiceChannels.includes(name);
  }

  createVoiceChannel(name: string): boolean {
    if (this.voiceChannels.includes(name)) return false;
    this.voiceChannels.push(name);
    this.scheduleSave();
    return true;
  }

  private append(message: StoredMessage): WireMessage {
    this.messages.push(message);
    this.trim(message.key);
    this.scheduleSave();
    return toWire(message);
  }

  // Отвечать можно только на сообщение из того же разговора: иначе снапшот
  // текста утёк бы из чужого ЛС в канал.
  private makeReply(replyTo: number | undefined, key: string): ReplyRef | undefined {
    if (replyTo === undefined) return undefined;
    const target = this.find(replyTo);
    if (!target || target.key !== key) return undefined;
    return { id: target.id, from: target.from, text: target.text.slice(0, 120) };
  }

  private canAccess(message: StoredMessage, nick: string): boolean {
    if (message.channel !== undefined) return true;
    const lower = nick.toLowerCase();
    return message.from.toLowerCase() === lower || message.to?.toLowerCase() === lower;
  }

  addChannelMessage(channel: string, from: string, text: string, extra: MessageExtra = {}): WireMessage {
    const key = channelKey(channel);
    return this.append({
      id: this.nextId++,
      key,
      from,
      channel,
      text,
      ts: Date.now(),
      edited: false,
      replyTo: this.makeReply(extra.replyTo, key),
      attachments: extra.attachments,
    });
  }

  addDirectMessage(from: string, to: string, text: string, extra: MessageExtra = {}): WireMessage {
    const key = dmKey(from, to);
    return this.append({
      id: this.nextId++,
      key,
      from,
      to,
      text,
      ts: Date.now(),
      edited: false,
      replyTo: this.makeReply(extra.replyTo, key),
      attachments: extra.attachments,
    });
  }

  private trim(key: string): void {
    const forKey = this.messages.filter((m) => m.key === key);
    if (forKey.length <= HISTORY_LIMIT) return;
    const drop = new Set(forKey.slice(0, forKey.length - HISTORY_LIMIT).map((m) => m.id));
    this.messages = this.messages.filter((m) => !drop.has(m.id));
  }

  find(id: number): StoredMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  edit(id: number, from: string, text: string): StoredMessage | null {
    const message = this.find(id);
    if (!message || message.from !== from) return null;
    message.text = text;
    message.edited = true;
    this.scheduleSave();
    return message;
  }

  remove(id: number, from: string): StoredMessage | null {
    const message = this.find(id);
    if (!message || message.from !== from) return null;
    this.messages = this.messages.filter((m) => m.id !== id);
    this.scheduleSave();
    return message;
  }

  toggleReaction(id: number, nick: string, emoji: string): StoredMessage | null {
    const message = this.find(id);
    if (!message || !this.canAccess(message, nick)) return null;
    const reactions = (message.reactions ??= {});
    const users = reactions[emoji] ?? [];
    reactions[emoji] = users.includes(nick) ? users.filter((n) => n !== nick) : [...users, nick];
    if (reactions[emoji].length === 0) delete reactions[emoji];
    if (Object.keys(reactions).length === 0) delete message.reactions;
    this.scheduleSave();
    return message;
  }

  history(key: string, limit = 100): WireMessage[] {
    return this.messages
      .filter((m) => m.key === key)
      .slice(-limit)
      .map(toWire);
  }
}

export function recipientsOf(message: { channel?: string; from: string; to?: string }): 'all' | string[] {
  if (message.channel) return 'all';
  return [message.from, message.to!];
}

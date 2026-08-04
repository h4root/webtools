import { readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from './jsonfile.ts';
import type { AttachmentRef, Reactions, ReplyRef, WireMessage } from './protocol.ts';

export const DEFAULT_CHANNELS = ['general', 'random'];
export const DEFAULT_VOICE_CHANNELS = ['general', 'games'];
const HISTORY_LIMIT = 200;
export const CHANNEL_LIMIT = 100;
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
  private dirty = false;
  private persistBlocked = false;

  constructor(private readonly filePath?: string) {
    this.channels = [...DEFAULT_CHANNELS];
    this.voiceChannels = [...DEFAULT_VOICE_CHANNELS];
    if (filePath) this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath!, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.persistBlocked = true;
      console.error(`store: не читается ${this.filePath} (${(error as Error).message}); история не будет сохраняться`);
      return;
    }

    try {
      this.apply(JSON.parse(raw));
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath!, backup);
        console.error(`store: ${this.filePath} испорчен (${(error as Error).message}); отложен в ${backup}, стартую с чистой историей`);
      } catch {
        this.persistBlocked = true;
        console.error(`store: ${this.filePath} испорчен (${(error as Error).message}) и не отодвигается; история не будет сохраняться`);
      }
    }
  }

  private apply(data: unknown): void {
    if (typeof data !== 'object' || data === null) throw new Error('ожидался объект');
    const { channels, voiceChannels, messages, nextId } = data as Record<string, unknown>;
    if (Array.isArray(channels) && channels.length) this.channels = channels;
    if (Array.isArray(voiceChannels) && voiceChannels.length) this.voiceChannels = voiceChannels;
    if (Array.isArray(messages)) this.messages = messages;
    if (typeof nextId === 'number') this.nextId = nextId;
    for (const message of this.messages) {
      if (typeof message?.id === 'number' && message.id >= this.nextId) this.nextId = message.id + 1;
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (!this.filePath || this.persistBlocked || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    if (!this.filePath || this.persistBlocked || !this.dirty) return;
    try {
      writeJsonAtomic(this.filePath, {
        channels: this.channels,
        voiceChannels: this.voiceChannels,
        messages: this.messages,
        nextId: this.nextId,
      });
      this.dirty = false;
    } catch (error) {
      console.error(`store: не сохранить ${this.filePath}: ${(error as Error).message}`);
    }
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  listChannels(): string[] {
    return [...this.channels];
  }

  hasChannel(name: string): boolean {
    return this.channels.includes(name);
  }

  createChannel(name: string): boolean {
    if (this.channels.includes(name) || this.channels.length >= CHANNEL_LIMIT) return false;
    this.channels.push(name);
    this.scheduleSave();
    return true;
  }

  removeChannel(name: string): boolean {
    if (!this.channels.includes(name) || this.channels.length <= 1) return false;
    this.channels = this.channels.filter((c) => c !== name);
    const key = channelKey(name);
    this.messages = this.messages.filter((m) => m.key !== key);
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
    if (this.voiceChannels.includes(name) || this.voiceChannels.length >= CHANNEL_LIMIT) return false;
    this.voiceChannels.push(name);
    this.scheduleSave();
    return true;
  }

  removeVoiceChannel(name: string): boolean {
    if (!this.voiceChannels.includes(name)) return false;
    this.voiceChannels = this.voiceChannels.filter((c) => c !== name);
    this.scheduleSave();
    return true;
  }

  private append(message: StoredMessage): WireMessage {
    this.messages.push(message);
    this.trim(message.key);
    this.scheduleSave();
    return toWire(message);
  }

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

  private isAuthor(message: StoredMessage, nick: string): boolean {
    return message.from.toLowerCase() === nick.toLowerCase();
  }

  edit(id: number, from: string, text: string): StoredMessage | null {
    const message = this.find(id);
    if (!message || !this.isAuthor(message, from)) return null;
    message.text = text;
    message.edited = true;
    this.scheduleSave();
    return message;
  }

  remove(id: number, from: string): StoredMessage | null {
    const message = this.find(id);
    if (!message || !this.isAuthor(message, from)) return null;
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

  purgeUser(nick: string): { removed: number } {
    const lower = nick.toLowerCase();
    const before = this.messages.length;
    const gone = new Set<number>();

    this.messages = this.messages.filter((message) => {
      const mine = message.from.toLowerCase() === lower;
      const inMyDm = message.to !== undefined && (mine || message.to.toLowerCase() === lower);
      if (mine || inMyDm) {
        gone.add(message.id);
        return false;
      }
      return true;
    });

    for (const message of this.messages) {
      if (message.replyTo && gone.has(message.replyTo.id)) delete message.replyTo;
      if (!message.reactions) continue;
      for (const [emoji, users] of Object.entries(message.reactions)) {
        const left = users.filter((user) => user.toLowerCase() !== lower);
        if (left.length) message.reactions[emoji] = left;
        else delete message.reactions[emoji];
      }
      if (Object.keys(message.reactions).length === 0) delete message.reactions;
    }

    if (before !== this.messages.length) this.scheduleSave();
    return { removed: before - this.messages.length };
  }

  dmPartners(nick: string): { nick: string; ts: number }[] {
    const lower = nick.toLowerCase();
    const latest = new Map<string, { nick: string; ts: number }>();
    for (const message of this.messages) {
      if (message.to === undefined) continue;
      const from = message.from.toLowerCase();
      const to = message.to.toLowerCase();
      if (from !== lower && to !== lower) continue;
      const other = from === lower ? message.to : message.from;
      const key = other.toLowerCase();
      const seen = latest.get(key);
      if (!seen || seen.ts < message.ts) latest.set(key, { nick: other, ts: message.ts });
    }
    return [...latest.values()].sort((a, b) => b.ts - a.ts);
  }

  attachmentIds(): Set<string> {
    const ids = new Set<string>();
    for (const message of this.messages) {
      for (const attachment of message.attachments ?? []) ids.add(attachment.id);
    }
    return ids;
  }

  findAttachment(id: string, nick: string): AttachmentRef | null {
    for (const message of this.messages) {
      const attachment = message.attachments?.find((a) => a.id === id);
      if (attachment && this.canAccess(message, nick)) return attachment;
    }
    return null;
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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WireMessage } from './protocol.ts';

export const DEFAULT_CHANNELS = ['general', 'random'];
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
  };
}

export class Store {
  private channels: string[];
  private messages: StoredMessage[] = [];
  private nextId = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly filePath?: string) {
    this.channels = [...DEFAULT_CHANNELS];
    if (filePath) this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath!, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.channels) && data.channels.length) this.channels = data.channels;
      if (Array.isArray(data.messages)) this.messages = data.messages;
      if (typeof data.nextId === 'number') this.nextId = data.nextId;
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
          JSON.stringify({ channels: this.channels, messages: this.messages, nextId: this.nextId }),
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

  private append(message: StoredMessage): WireMessage {
    this.messages.push(message);
    this.trim(message.key);
    this.scheduleSave();
    return toWire(message);
  }

  addChannelMessage(channel: string, from: string, text: string): WireMessage {
    return this.append({ id: this.nextId++, key: channelKey(channel), from, channel, text, ts: Date.now(), edited: false });
  }

  addDirectMessage(from: string, to: string, text: string): WireMessage {
    return this.append({ id: this.nextId++, key: dmKey(from, to), from, to, text, ts: Date.now(), edited: false });
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

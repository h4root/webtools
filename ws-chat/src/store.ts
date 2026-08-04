import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttachmentRef, Reactions, ReplyRef, WireMessage } from './protocol.ts';

export const DEFAULT_CHANNELS = ['general', 'random'];
export const DEFAULT_VOICE_CHANNELS = ['general', 'games'];
const HISTORY_LIMIT = 200;
// Каналы никто не чистит, а создать их мог кто угодно и сколько угодно.
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
  // Файл существует, но прочитать его не удалось. Затирать его новым состоянием
  // нельзя — под ним могут лежать данные, которые ещё можно спасти руками.
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
      // Обрезанная или испорченная запись. Молча стартовать с дефолтов нельзя:
      // следующее же сохранение затрёт остатки, и потеря пройдёт незамеченной.
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
    // nextId может отсутствовать или отстать (правка файла руками, обрезанная
    // запись). Пересекающиеся id ломают find(): edit/delete/react попадут в
    // чужое сообщение, поэтому берём заведомо свободный.
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

  // Запись через временный файл: оборванный writeFileSync оставил бы обрезанный
  // JSON, а его уже не отличить от валидного — вся история ушла бы в мусор.
  private save(): void {
    if (!this.filePath || this.persistBlocked || !this.dirty) return;
    const tmp = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        tmp,
        JSON.stringify({
          channels: this.channels,
          voiceChannels: this.voiceChannels,
          messages: this.messages,
          nextId: this.nextId,
        }),
      );
      renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (error) {
      console.error(`store: не сохранить ${this.filePath}: ${(error as Error).message}`);
      try {
        unlinkSync(tmp);
      } catch {
        /* временного файла может и не быть */
      }
    }
  }

  // Дебаунс сохранения означает, что последние сообщения живут только в памяти.
  // Без явного сброса на выходе они теряются при каждом штатном рестарте.
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

  // Последний текстовый канал не удаляем — чату надо куда-то писать.
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

  // Ник занимается регистронезависимо, поэтому и авторство сверяем так же:
  // иначе Alice, перезашедшая как alice, теряет доступ к своим сообщениям.
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

  // Собеседники, с которыми у ника есть переписка, свежие сверху. Без этого
  // список ЛС можно было строить только из тех, кто сейчас онлайн, и диалог
  // вместе со всей историей пропадал из интерфейса, стоило человеку выйти.
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

  // Все блобы, на которые ещё кто-то ссылается, — вход для BlobStore.sweep().
  attachmentIds(): Set<string> {
    const ids = new Set<string>();
    for (const message of this.messages) {
      for (const attachment of message.attachments ?? []) ids.add(attachment.id);
    }
    return ids;
  }

  // Скачать вложение может только участник разговора, в котором оно приложено:
  // иначе ссылка на картинку из ЛС читалась бы кем угодно.
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

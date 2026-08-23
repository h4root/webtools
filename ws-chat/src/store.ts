import { readFileSync, renameSync } from 'node:fs';
import { writeFileAtomic, writeJsonAtomic } from './jsonfile.ts';
import { isSealed, openJson, sealJson } from './sealed.ts';
import type { Attachment, AttachmentRef, Reactions, ReplyRef, WireMessage } from './protocol.ts';

export const DEFAULT_CHANNELS = ['general', 'random'];
export const DEFAULT_VOICE_CHANNELS = ['general', 'games'];
export const HISTORY_LIMIT = 200;
export const CHANNEL_LIMIT = 100;
export const SEARCH_LIMIT = 50;
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
  nonce?: string;
}

interface MessageExtra {
  replyTo?: number;
  attachments?: AttachmentRef[];
  nonce?: string;
}

export function channelKey(name: string): string {
  return `ch:${name}`;
}

export function dmKey(a: string, b: string): string {
  return 'dm:' + [a.toLowerCase(), b.toLowerCase()].sort().join('|');
}

function toAttachment(ref: AttachmentRef): Attachment {
  return { url: `/uploads/${ref.id}`, name: ref.name, size: ref.size, mime: ref.mime };
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
    nonce: message.nonce,
    attachments: message.attachments?.map(toAttachment),
  };
}

export class Store {
  private channels: string[];
  private voiceChannels: string[];
  // Разговоры — основная структура: история читается срезом, а не фильтром по
  // всему. byId и byBlob держат ссылки на те же объекты.
  private byKey = new Map<string, StoredMessage[]>();
  private byId = new Map<number, StoredMessage>();
  private byBlob = new Map<string, Set<number>>();
  // Метка отправки автора -> id: по ней повтор узнаётся как тот же самый.
  private byNonce = new Map<string, number>();
  // ник в нижнем регистре -> разговор -> id последнего прочитанного
  private reads = new Map<string, Map<string, number>>();
  private nextId = 1;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private persistBlocked = false;

  constructor(
    private readonly filePath?: string,
    private readonly key?: Buffer,
  ) {
    this.channels = [...DEFAULT_CHANNELS];
    this.voiceChannels = [...DEFAULT_VOICE_CHANNELS];
    if (filePath) this.load();
  }

  private load(): void {
    let raw: Buffer;
    try {
      raw = readFileSync(this.filePath!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.persistBlocked = true;
      console.error(`store: не читается ${this.filePath} (${(error as Error).message}); история не будет сохраняться`);
      return;
    }

    // Запечатанный файл, который не открывается, — это почти всегда не порча, а
    // не тот ключ. Отодвигать его нельзя: с правильным ключом он ещё живой.
    if (isSealed(raw)) {
      if (!this.key) {
        this.persistBlocked = true;
        console.error(`store: ${this.filePath} зашифрован, а ключа нет; история не будет сохраняться`);
        return;
      }
      try {
        this.apply(openJson(this.key, raw));
      } catch (error) {
        this.persistBlocked = true;
        console.error(`store: ${this.filePath} не открывается этим ключом (${(error as Error).message}); проверь UPLOAD_KEY, история не будет сохраняться`);
      }
      return;
    }

    try {
      this.apply(JSON.parse(raw.toString('utf8')));
      // Файл со старых времён: перезапечатается при первом же сохранении.
      if (this.key) this.dirty = true;
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
    const { channels, voiceChannels, messages, nextId, reads } = data as Record<string, unknown>;
    if (Array.isArray(channels) && channels.length) this.channels = channels;
    if (Array.isArray(voiceChannels) && voiceChannels.length) this.voiceChannels = voiceChannels;
    if (typeof nextId === 'number') this.nextId = nextId;
    if (reads && typeof reads === 'object') {
      for (const [nick, marks] of Object.entries(reads as Record<string, Record<string, number>>)) {
        if (!marks || typeof marks !== 'object') continue;
        const own = new Map<string, number>();
        for (const [key, id] of Object.entries(marks)) {
          if (typeof id === 'number') own.set(key, id);
        }
        if (own.size) this.reads.set(nick.toLowerCase(), own);
      }
    }
    if (Array.isArray(messages)) {
      for (const message of messages as StoredMessage[]) {
        if (typeof message?.id !== 'number' || typeof message?.key !== 'string') continue;
        this.conversation(message.key).push(message);
        this.index(message);
        if (message.id >= this.nextId) this.nextId = message.id + 1;
      }
    }
  }

  private readsSnapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [nick, marks] of this.reads) out[nick] = Object.fromEntries(marks);
    return out;
  }

  private flatten(): StoredMessage[] {
    return [...this.byId.values()].sort((a, b) => a.id - b.id);
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
    const snapshot = {
      channels: this.channels,
      voiceChannels: this.voiceChannels,
      messages: this.flatten(),
      nextId: this.nextId,
      reads: this.readsSnapshot(),
    };
    try {
      if (this.key) writeFileAtomic(this.filePath, sealJson(this.key, snapshot), 0o600);
      else writeJsonAtomic(this.filePath, snapshot, 0o600);
      this.dirty = false;
    } catch (error) {
      console.error(`store: не сохранить ${this.filePath}: ${(error as Error).message}`);
    }
  }

  // Сервер может работать, но молча терять историю: не тот ключ, нет прав на
  // запись. Наружу это видно только отсюда.
  canPersist(): boolean {
    return !this.persistBlocked;
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
    for (const message of this.byKey.get(key) ?? []) this.unindex(message);
    this.byKey.delete(key);
    for (const marks of this.reads.values()) marks.delete(key);
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

  private conversation(key: string): StoredMessage[] {
    let messages = this.byKey.get(key);
    if (!messages) {
      messages = [];
      this.byKey.set(key, messages);
    }
    return messages;
  }

  private nonceKey(from: string, nonce: string): string {
    return `${from.toLowerCase()}|${nonce}`;
  }

  private index(message: StoredMessage): void {
    this.byId.set(message.id, message);
    if (message.nonce) this.byNonce.set(this.nonceKey(message.from, message.nonce), message.id);
    for (const attachment of message.attachments ?? []) {
      const users = this.byBlob.get(attachment.id) ?? new Set<number>();
      users.add(message.id);
      this.byBlob.set(attachment.id, users);
    }
  }

  private unindex(message: StoredMessage): void {
    this.byId.delete(message.id);
    if (message.nonce) this.byNonce.delete(this.nonceKey(message.from, message.nonce));
    for (const attachment of message.attachments ?? []) {
      const users = this.byBlob.get(attachment.id);
      if (!users) continue;
      users.delete(message.id);
      if (users.size === 0) this.byBlob.delete(attachment.id);
    }
  }

  private append(message: StoredMessage): WireMessage {
    const messages = this.conversation(message.key);
    messages.push(message);
    this.index(message);
    // Вытесняем только из этого разговора: соседние трогать незачем, а раньше
    // на каждой вставке просеивалась вся история целиком.
    if (messages.length > HISTORY_LIMIT) {
      for (const dropped of messages.splice(0, messages.length - HISTORY_LIMIT)) this.unindex(dropped);
    }
    this.scheduleSave();
    return toWire(message);
  }

  private makeReply(replyTo: number | undefined, key: string): ReplyRef | undefined {
    if (replyTo === undefined) return undefined;
    const target = this.find(replyTo);
    if (!target || target.key !== key) return undefined;
    const media = target.attachments?.[0];
    return {
      id: target.id,
      from: target.from,
      text: target.text.slice(0, 120),
      media: media && toAttachment(media),
    };
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
      nonce: extra.nonce,
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
      nonce: extra.nonce,
    });
  }

  // Метка своя у каждого автора: чужую не подобрать и на чужую не наткнуться.
  findByNonce(from: string, nonce: string): WireMessage | null {
    const id = this.byNonce.get(this.nonceKey(from, nonce));
    const message = id === undefined ? undefined : this.byId.get(id);
    return message ? toWire(message) : null;
  }

  find(id: number): StoredMessage | undefined {
    return this.byId.get(id);
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
    this.detach(message);
    this.scheduleSave();
    return message;
  }

  private detach(message: StoredMessage): void {
    const messages = this.byKey.get(message.key);
    const at = messages?.indexOf(message) ?? -1;
    if (messages && at !== -1) messages.splice(at, 1);
    this.unindex(message);
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
    const gone = new Set<number>();
    this.reads.delete(lower);

    for (const [key, messages] of this.byKey) {
      const kept: StoredMessage[] = [];
      for (const message of messages) {
        const mine = message.from.toLowerCase() === lower;
        const inMyDm = message.to !== undefined && (mine || message.to.toLowerCase() === lower);
        if (mine || inMyDm) {
          gone.add(message.id);
          this.unindex(message);
        } else {
          kept.push(message);
        }
      }
      if (kept.length) this.byKey.set(key, kept);
      else this.byKey.delete(key);
    }

    for (const message of this.byId.values()) {
      if (message.replyTo && gone.has(message.replyTo.id)) delete message.replyTo;
      if (!message.reactions) continue;
      for (const [emoji, users] of Object.entries(message.reactions)) {
        const left = users.filter((user) => user.toLowerCase() !== lower);
        if (left.length) message.reactions[emoji] = left;
        else delete message.reactions[emoji];
      }
      if (Object.keys(message.reactions).length === 0) delete message.reactions;
    }

    if (gone.size) this.scheduleSave();
    return { removed: gone.size };
  }

  dmPartners(nick: string): { nick: string; ts: number }[] {
    const lower = nick.toLowerCase();
    const latest = new Map<string, { nick: string; ts: number }>();
    for (const [key, messages] of this.byKey) {
      if (!key.startsWith('dm:') || !messages.length) continue;
      for (const message of messages) {
        if (message.to === undefined) continue;
        const from = message.from.toLowerCase();
        const to = message.to.toLowerCase();
        if (from !== lower && to !== lower) continue;
        const other = from === lower ? message.to : message.from;
        const seen = latest.get(other.toLowerCase());
        if (!seen || seen.ts < message.ts) latest.set(other.toLowerCase(), { nick: other, ts: message.ts });
      }
    }
    return [...latest.values()].sort((a, b) => b.ts - a.ts);
  }

  attachmentIds(): Set<string> {
    return new Set(this.byBlob.keys());
  }

  findAttachment(id: string, nick: string): AttachmentRef | null {
    for (const messageId of this.byBlob.get(id) ?? []) {
      const message = this.byId.get(messageId);
      if (!message || !this.canAccess(message, nick)) continue;
      const attachment = message.attachments?.find((a) => a.id === id);
      if (attachment) return attachment;
    }
    return null;
  }

  // Доступ проверяется здесь, а не в интерфейсе: иначе поиск стал бы способом
  // читать чужие личные сообщения в обход всех остальных проверок.
  search(nick: string, query: string, limit = SEARCH_LIMIT): WireMessage[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    const found: StoredMessage[] = [];
    for (const messages of this.byKey.values()) {
      for (const message of messages) {
        if (!message.text.toLowerCase().includes(needle)) continue;
        if (!this.canAccess(message, nick)) continue;
        found.push(message);
      }
    }
    return found
      .sort((a, b) => b.id - a.id)
      .slice(0, Math.max(0, Math.min(limit, SEARCH_LIMIT)))
      .map(toWire);
  }

  // Отметка только растёт: два устройства читают вразнобой, и более старое
  // «прочитано» не должно возвращать уже разобранные сообщения в непрочитанные.
  markRead(nick: string, key: string, id: number): boolean {
    const lower = nick.toLowerCase();
    const marks = this.reads.get(lower) ?? new Map<string, number>();
    if ((marks.get(key) ?? 0) >= id) return false;
    marks.set(key, id);
    this.reads.set(lower, marks);
    this.scheduleSave();
    return true;
  }

  readMark(nick: string, key: string): number {
    return this.reads.get(nick.toLowerCase())?.get(key) ?? 0;
  }

  knownReader(nick: string): boolean {
    return (this.reads.get(nick.toLowerCase())?.size ?? 0) > 0;
  }

  hasMark(nick: string, key: string): boolean {
    return this.reads.get(nick.toLowerCase())?.has(key) ?? false;
  }

  // Отметка на нуле — это не то же самое, что её отсутствие: разговор мог быть
  // пуст в момент первого захода, и пришедшее потом обязано считаться новым.
  ensureMark(nick: string, key: string, id: number): void {
    if (this.hasMark(nick, key)) return;
    const lower = nick.toLowerCase();
    const marks = this.reads.get(lower) ?? new Map<string, number>();
    marks.set(key, id);
    this.reads.set(lower, marks);
    this.scheduleSave();
  }

  // Без отметки считать нечего: истории чтения в этом разговоре ещё не было, и
  // весь старый хвост не должен свалиться как непрочитанное.
  unreadCount(nick: string, key: string): number {
    if (!this.hasMark(nick, key)) return 0;
    const mark = this.readMark(nick, key);
    const lower = nick.toLowerCase();
    let count = 0;
    for (const message of this.byKey.get(key) ?? []) {
      if (message.id > mark && message.from.toLowerCase() !== lower) count++;
    }
    return count;
  }

  history(key: string, limit = 100): WireMessage[] {
    return (this.byKey.get(key) ?? []).slice(-limit).map(toWire);
  }
}

export function recipientsOf(message: { channel?: string; from: string; to?: string }): 'all' | string[] {
  if (message.channel) return 'all';
  return [message.from, message.to!];
}

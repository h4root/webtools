import { NICK_MAX, PROTOCOL_VERSION, parseClientMessage, type AttachmentRef, type ClientMessage, type ReadMark, type ServerMessage } from './protocol.ts';
import { Store, channelKey, dmKey, recipientsOf } from './store.ts';
import { safeDevice, type Auth } from './auth.ts';
import { LinkCodes } from './linkcodes.ts';

export interface Client {
  id: string;
  nick: string | null;
  token: string;
  source?: string;
  guest?: boolean;
  authPending?: boolean;
  authDeadline?: number;
  send(message: ServerMessage): void;
  close?(): void;
}

export interface BlobLookup {
  stat(id: string): { id: string; size: number; mime: string } | null;
}

const AUTH_ERRORS: Record<string, string> = {
  'nick-taken': 'Ник уже занят',
  'nick-registered': 'Этот ник зарегистрирован — войди с паролем',
  'no-account': 'Неверный ник или пароль',
  'bad-password': 'Неверный ник или пароль',
  'weak-password': 'Пароль должен быть не короче 8 символов',
  'locked': 'Слишком много попыток, подожди',
  'guest-has-no-password': 'Этот ник занят гостем',
  'guests-full': 'Слишком много гостей — заходи с паролем',
};

const NICK_PATTERN = /^[\p{L}\p{N} _.-]+$/u;
const NAME_MAX = 255;

export const RATE_WINDOW_MS = 10000;
export const ACTIONS_PER_WINDOW = 30;
export const SIGNALS_PER_WINDOW = 400;

const SIGNAL_TYPES = new Set(['voice-signal', 'call-signal', 'call-invite', 'call-accept', 'call-decline', 'call-end']);

interface VoiceState {
  channel: string;
  muted: boolean;
}

interface RateEntry {
  windowStartedAt: number;
  actions: number;
  signals: number;
  warned: boolean;
}

function isValidNick(nick: string): boolean {
  return nick.length > 0 && nick.length <= NICK_MAX && NICK_PATTERN.test(nick);
}

export class Hub {
  private readonly clients = new Set<Client>();
  private readonly voiceOf = new Map<Client, VoiceState>();
  private readonly rate = new Map<string, RateEntry>();
  private readonly ringing = new Map<Client, Set<Client>>();
  private readonly invitedBy = new Map<Client, Client>();
  private readonly talking = new Map<Client, Client>();
  private readonly links = new LinkCodes<Client>();
  private readonly linkDevice = new Map<Client, string>();

  constructor(
    private readonly store: Store = new Store(),
    private readonly blobs?: BlobLookup,
    private readonly auth?: Auth,
  ) {}

  private async authenticate(client: Client, message: Extract<ClientMessage, { type: 'auth' }>): Promise<void> {
    if (!this.auth!.allowAttempt(client.source ?? 'неизвестно')) {
      client.send({ type: 'auth-error', reason: 'Слишком много попыток, подожди' });
      return;
    }

    if (message.mode === 'resume') {
      const session = this.auth!.resume(message.token!);
      if (!session) {
        client.send({ type: 'auth-error', reason: 'Сессия истекла' });
        return;
      }
      this.join(client, session.nick, message.token!, session.guest);
      return;
    }

    const nick = message.nick!.trim();
    if (!isValidNick(nick)) {
      client.send({ type: 'auth-error', reason: 'Недопустимый ник' });
      return;
    }

    const result =
      message.mode === 'guest'
        ? await this.auth!.registerGuest(nick, message.device)
        : message.mode === 'register'
          ? await this.auth!.register(nick, message.password!, message.device)
          : await this.auth!.login(nick, message.password!, message.device);

    if (!result.ok) {
      client.send({
        type: 'auth-error',
        reason: AUTH_ERRORS[result.error!] ?? 'Не удалось войти',
        retryAfterMs: result.retryAfterMs,
      });
      return;
    }
    this.join(client, result.nick!, result.token!, result.guest!);
  }

  join(client: Client, nick: string, token = client.token, guest = false): void {
    const trimmed = nick.trim();
    if (!isValidNick(trimmed)) {
      client.send({ type: 'auth-error', reason: 'Недопустимый ник' });
      return;
    }
    const firstDevice = !this.findByNick(trimmed);

    client.nick = trimmed;
    client.token = token;
    client.guest = guest;
    this.clients.add(client);
    client.send({ type: 'welcome', nick: trimmed, token, guest, protocol: PROTOCOL_VERSION });
    client.send({ type: 'channels', list: this.store.listChannels() });
    client.send({ type: 'dms', list: this.store.dmPartners(trimmed) });
    client.send({ type: 'voice-channels', list: this.store.listVoiceChannels() });
    client.send({ type: 'voice-presence', channels: this.voicePresenceMap() });
    client.send({ type: 'reads', list: this.readMarks(trimmed) });
    if (firstDevice) this.broadcast({ type: 'system', text: `${trimmed} присоединился` });
    this.broadcastPresence();
  }

  private readMarks(nick: string): ReadMark[] {
    const known = this.store.knownReader(nick);
    const list: ReadMark[] = [];
    for (const channel of this.store.listChannels()) {
      const key = channelKey(channel);
      list.push({ channel, ...this.markFor(nick, key, known) });
    }
    for (const partner of this.store.dmPartners(nick)) {
      const key = dmKey(nick, partner.nick);
      list.push({ to: partner.nick, ...this.markFor(nick, key, known) });
    }
    return list;
  }

  private markFor(nick: string, key: string, known: boolean): { id: number; unread: number } {
    const baseline = known ? 0 : (this.store.history(key, 1)[0]?.id ?? 0);
    this.store.ensureMark(nick, key, baseline);
    return { id: this.store.readMark(nick, key), unread: this.store.unreadCount(nick, key) };
  }

  private markRead(client: Client, message: Extract<ClientMessage, { type: 'read' }>): void {
    const key = message.channel ? channelKey(message.channel) : dmKey(client.nick!, message.to!);
    if (!this.store.markRead(client.nick!, key, message.id)) return;
    const lower = client.nick!.toLowerCase();
    for (const peer of this.clients) {
      if (peer === client || peer.nick?.toLowerCase() !== lower) continue;
      peer.send({ type: 'read', channel: message.channel, to: message.to, id: message.id });
    }
  }

  private async changePassword(client: Client, message: Extract<ClientMessage, { type: 'change-password' }>): Promise<void> {
    const nick = client.nick!;
    const result = await this.auth!.changePassword(nick, message.current, message.next, client.token);
    if (!result.ok) {
      client.send({ type: 'error', reason: AUTH_ERRORS[result.error!] ?? 'Не удалось сменить пароль' });
      return;
    }
    this.disconnectOthers(nick, client, 'Пароль изменён, войди заново');
    client.send({ type: 'password-changed' });
  }

  private approveLink(client: Client, code: string): void {
    if (client.guest) {
      client.send({ type: 'error', reason: 'Гость не может подключать устройства' });
      return;
    }

    const waiting = this.links.claim(code);
    if (!waiting || !this.auth) {
      client.send({ type: 'error', reason: 'Код неверный или истёк' });
      return;
    }

    const device = this.linkDevice.get(waiting) ?? '';
    this.linkDevice.delete(waiting);

    const token = this.auth.issueFor(client.nick!, device);
    if (!token) {
      client.send({ type: 'error', reason: 'Код неверный или истёк' });
      return;
    }

    this.join(waiting, client.nick!, token, false);
    client.send({ type: 'link-approved', device: device || 'новое устройство' });
  }

  private sendSessions(client: Client): void {
    if (!this.auth) return;
    client.send({ type: 'sessions', list: this.auth.listSessions(client.nick!, client.token) });
  }

  private revokeSession(client: Client, id: string): void {
    if (!this.auth?.revokeSession(client.nick!, id)) return;

    for (const peer of [...this.clients]) {
      if (peer === client || peer.nick?.toLowerCase() !== client.nick!.toLowerCase()) continue;
      if (this.auth.sessionIdFor(peer.token)) continue;
      peer.send({ type: 'logged-out', reason: 'Сессия отозвана' });
      this.leave(peer);
      peer.close?.();
    }
    this.sendSessions(client);
  }

  private disconnectOthers(nick: string, client: Client, reason: string): void {
    const lower = nick.toLowerCase();
    for (const peer of [...this.clients]) {
      if (peer === client || peer.nick?.toLowerCase() !== lower) continue;
      peer.send({ type: 'logged-out', reason });
      this.leave(peer);
      peer.close?.();
    }
  }

  logout(client: Client, everywhere = false): void {
    const nick = client.nick!;
    const guest = client.guest;
    this.auth?.revoke(client.token);
    if (everywhere) {
      this.auth?.revokeAllFor(nick);
      this.disconnectOthers(nick, client, 'Выход со всех устройств');
    }
    if (guest) {
      this.auth?.removeAccount(nick);
      this.store.purgeUser(nick);
    }

    client.send({ type: 'logged-out' });
    this.leave(client);
    if (guest) this.broadcast({ type: 'purged', nick });
  }

  private allow(client: Client, type: string): boolean {
    const key = client.nick!.toLowerCase();
    const now = Date.now();
    const entry = this.rate.get(key) ?? { windowStartedAt: now, actions: 0, signals: 0, warned: false };
    if (now - entry.windowStartedAt >= RATE_WINDOW_MS) {
      entry.windowStartedAt = now;
      entry.actions = 0;
      entry.signals = 0;
      entry.warned = false;
    }
    this.rate.set(key, entry);

    const signal = SIGNAL_TYPES.has(type);
    if (signal) entry.signals++;
    else entry.actions++;

    if (signal ? entry.signals <= SIGNALS_PER_WINDOW : entry.actions <= ACTIONS_PER_WINDOW) return true;

    if (!entry.warned) {
      entry.warned = true;
      client.send({ type: 'error', reason: 'Слишком часто' });
    }
    return false;
  }

  rateEntries(): number {
    return this.rate.size;
  }

  leave(client: Client): void {
    this.links.release(client);
    this.linkDevice.delete(client);
    if (!this.clients.delete(client)) return;
    this.callEnd(client);
    const wasInVoice = this.voiceOf.delete(client);
    const nick = client.nick;
    client.nick = null;
    if (nick) {
      if (!this.findByNick(nick)) {
        this.rate.delete(nick.toLowerCase());
        this.broadcast({ type: 'system', text: `${nick} вышел` });
      }
      this.broadcastPresence();
    }
    if (wasInVoice) this.broadcastVoicePresence();
  }

  handle(client: Client, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) {
      client.send({ type: 'error', reason: 'Некорректное сообщение' });
      return;
    }

    if (message.type === 'auth') {
      if (client.nick || !this.auth) return;
      if (client.authPending) return;
      client.authPending = true;
      void this.authenticate(client, message).finally(() => {
        client.authPending = false;
      });
      return;
    }

    if (message.type === 'link-request') {
      if (client.nick || !this.auth) return;
      if (!this.auth.allowAttempt(client.source ?? 'неизвестно')) {
        client.send({ type: 'auth-error', reason: 'Слишком много попыток, подожди' });
        return;
      }
      const device = safeDevice(message.device);
      const { code, expiresAt } = this.links.create(client);
      this.linkDevice.set(client, device);
      client.authDeadline = expiresAt;
      client.send({ type: 'link-code', code, expiresAt });
      return;
    }

    if (!client.nick || !this.clients.has(client)) {
      client.send({ type: 'error', reason: 'Сначала войди' });
      return;
    }

    if (message.type === 'link-approve') {
      if (this.allow(client, message.type)) this.approveLink(client, message.code);
      return;
    }

    if (message.type === 'logout') {
      this.logout(client, message.everywhere);
      return;
    }

    if (message.type === 'sessions') {
      this.sendSessions(client);
      return;
    }

    if (message.type === 'session-revoke') {
      this.revokeSession(client, message.id);
      return;
    }

    if (message.type === 'change-password') {
      if (client.authPending) return;
      client.authPending = true;
      void this.changePassword(client, message).finally(() => {
        client.authPending = false;
      });
      return;
    }

    if (!this.allow(client, message.type)) return;

    switch (message.type) {
      case 'key-publish':
        if (client.token) this.auth?.setDeviceKey(client.token, message.key);
        break;
      case 'keys':
        client.send({ type: 'keys', nick: message.nick, devices: this.auth?.deviceKeys(message.nick) ?? [] });
        break;
      case 'channel-create':
        this.createChannel(client, message.name);
        break;
      case 'channel-delete':
        this.deleteChannel(client, message.name);
        break;
      case 'voice-channel-delete':
        this.deleteVoiceChannel(client, message.name);
        break;
      case 'message':
        this.sendMessage(client, message);
        break;
      case 'history':
        this.sendHistory(client, message);
        break;
      case 'read':
        this.markRead(client, message);
        break;
      case 'search':
        client.send({ type: 'search', query: message.query, messages: this.store.search(client.nick!, message.query) });
        break;
      case 'edit':
        this.editMessage(client, message.id, message.text);
        break;
      case 'delete':
        this.deleteMessage(client, message.id);
        break;
      case 'react':
        this.reactMessage(client, message.id, message.emoji);
        break;
      case 'typing':
        this.relayTyping(client, message);
        break;
      case 'voice-channel-create':
        this.voiceChannelCreate(client, message.name);
        break;
      case 'voice-join':
        this.voiceJoin(client, message.channel);
        break;
      case 'voice-leave':
        this.voiceLeave(client);
        break;
      case 'voice-mute':
        this.voiceMute(client, message.muted);
        break;
      case 'voice-signal':
        this.voiceSignal(client, message.to, message.data);
        break;
      case 'call-invite':
        this.callInvite(client, message.to);
        break;
      case 'call-accept':
        this.callAccept(client);
        break;
      case 'call-decline':
        this.callDecline(client, message.reason);
        break;
      case 'call-end':
        this.callEnd(client);
        break;
      case 'call-signal':
        this.talking.get(client)?.send({ type: 'call-signal', from: client.nick!, data: message.data });
        break;
    }
  }

  private createChannel(client: Client, name: string): void {
    if (this.store.createChannel(name)) {
      this.broadcast({ type: 'channels', list: this.store.listChannels() });
      this.broadcast({ type: 'system', text: `Создан канал #${name}` });
    } else {
      client.send({ type: 'error', reason: 'Канал уже существует или их слишком много' });
    }
  }

  private deleteChannel(client: Client, name: string): void {
    if (this.store.removeChannel(name)) {
      this.broadcast({ type: 'channels', list: this.store.listChannels() });
      this.broadcast({ type: 'system', text: `Канал #${name} удалён вместе с историей` });
    } else {
      client.send({ type: 'error', reason: 'Канал не удалить' });
    }
  }

  private deleteVoiceChannel(client: Client, name: string): void {
    if (!this.store.removeVoiceChannel(name)) {
      client.send({ type: 'error', reason: 'Канал не удалить' });
      return;
    }
    for (const [peer, state] of [...this.voiceOf]) {
      if (state.channel !== name) continue;
      this.voiceOf.delete(peer);
      peer.send({ type: 'voice-left' });
    }
    this.broadcast({ type: 'voice-channels', list: this.store.listVoiceChannels() });
    this.broadcastVoicePresence();
    this.broadcast({ type: 'system', text: `Голосовой канал ${name} удалён` });
  }

  private resolveAttachments(refs: AttachmentRef[] | undefined): AttachmentRef[] | undefined {
    if (!refs?.length) return undefined;
    const out: AttachmentRef[] = [];
    for (const ref of refs) {
      const real = this.blobs ? this.blobs.stat(ref.id) : { id: ref.id, size: ref.size, mime: ref.mime };
      if (!real) continue;
      out.push({ id: real.id, size: real.size, mime: real.mime, name: ref.name.slice(0, NAME_MAX) });
    }
    return out.length ? out : undefined;
  }

  private sendMessage(client: Client, message: Extract<ClientMessage, { type: 'message' }>): void {
    if (message.nonce) {
      const known = this.store.findByNonce(client.nick!, message.nonce);
      if (known) {
        client.send({ type: 'message', msg: known });
        return;
      }
    }

    const attachments = this.resolveAttachments(message.attachments);
    if (!message.text && !attachments) {
      client.send({ type: 'error', reason: 'Вложение не найдено' });
      return;
    }

    if (message.channel) {
      if (!this.store.hasChannel(message.channel)) {
        client.send({ type: 'error', reason: 'Нет такого канала' });
        return;
      }
      const wire = this.store.addChannelMessage(message.channel, client.nick!, message.text, {
        replyTo: message.replyTo,
        attachments,
        nonce: message.nonce,
      });
      this.broadcast({ type: 'message', msg: wire });
      return;
    }

    const account = this.auth?.find(message.to!);
    if (this.auth && !account) {
      client.send({ type: 'error', reason: 'Нет такого собеседника' });
      return;
    }
    const target = this.findByNick(message.to!);
    const to = target?.nick ?? account?.nick ?? message.to!;
    const wire = this.store.addDirectMessage(client.nick!, to, message.text, {
      replyTo: message.replyTo,
      attachments,
      nonce: message.nonce,
    });
    this.sendToNicks([client.nick!, to], { type: 'message', msg: wire });
  }

  private sendHistory(client: Client, message: Extract<ClientMessage, { type: 'history' }>): void {
    if (message.channel) {
      client.send({ type: 'history', channel: message.channel, messages: this.store.history(channelKey(message.channel)) });
    } else {
      const key = dmKey(client.nick!, message.to!);
      client.send({ type: 'history', to: message.to, messages: this.store.history(key) });
    }
  }

  private editMessage(client: Client, id: number, text: string): void {
    const message = this.store.edit(id, client.nick!, text);
    if (!message) return;
    this.dispatch(recipientsOf(message), { type: 'edited', id, text });
  }

  private deleteMessage(client: Client, id: number): void {
    const message = this.store.remove(id, client.nick!);
    if (!message) return;
    this.dispatch(recipientsOf(message), { type: 'deleted', id });
  }

  private reactMessage(client: Client, id: number, emoji: string): void {
    const message = this.store.toggleReaction(id, client.nick!, emoji);
    if (!message) return;
    this.dispatch(recipientsOf(message), { type: 'reaction', id, reactions: message.reactions ?? {} });
  }

  private relayTyping(client: Client, message: Extract<ClientMessage, { type: 'typing' }>): void {
    const mine = client.nick!.toLowerCase();
    if (message.channel) {
      for (const peer of this.clients) {
        if (peer.nick?.toLowerCase() === mine) continue;
        peer.send({ type: 'typing', from: client.nick!, channel: message.channel });
      }
      return;
    }
    const target = message.to!.toLowerCase();
    for (const peer of this.clients) {
      if (peer === client || peer.nick?.toLowerCase() !== target) continue;
      peer.send({ type: 'typing', from: client.nick!, to: client.nick! });
    }
  }

  private dispatch(recipients: 'all' | string[], message: ServerMessage): void {
    if (recipients === 'all') this.broadcast(message);
    else this.sendToNicks(recipients, message);
  }

  private sendToNicks(nicks: string[], message: ServerMessage): void {
    const set = new Set(nicks.map((n) => n.toLowerCase()));
    for (const c of this.clients) {
      if (c.nick && set.has(c.nick.toLowerCase())) c.send(message);
    }
  }

  private findByNick(nick: string): Client | undefined {
    const lower = nick.toLowerCase();
    return [...this.clients].find((c) => c.nick?.toLowerCase() === lower);
  }

  private callInvite(client: Client, to: string): void {
    const lower = to.toLowerCase();
    if (lower === client.nick!.toLowerCase()) {
      client.send({ type: 'call-end', from: to, reason: 'offline' });
      return;
    }

    const devices = [...this.clients].filter((peer) => peer.nick?.toLowerCase() === lower);
    if (devices.length === 0) {
      client.send({ type: 'call-end', from: to, reason: 'offline' });
      return;
    }

    this.dropCall(client);
    this.ringing.set(client, new Set(devices));
    for (const device of devices) {
      this.invitedBy.set(device, client);
      device.send({ type: 'call-invite', from: client.nick! });
    }
  }

  private callAccept(client: Client): void {
    const caller = this.invitedBy.get(client);
    if (!caller) return;

    for (const device of this.ringing.get(caller) ?? []) {
      this.invitedBy.delete(device);
      if (device !== client) device.send({ type: 'call-end', from: caller.nick!, reason: 'answered-elsewhere' });
    }
    this.ringing.delete(caller);

    this.talking.set(caller, client);
    this.talking.set(client, caller);
    caller.send({ type: 'call-accept', from: client.nick! });
  }

  private callDecline(client: Client, reason?: string): void {
    const caller = this.invitedBy.get(client);
    if (!caller) return;

    for (const device of this.ringing.get(caller) ?? []) {
      this.invitedBy.delete(device);
      if (device !== client) device.send({ type: 'call-end', from: caller.nick!, reason: 'answered-elsewhere' });
    }
    this.ringing.delete(caller);
    caller.send({ type: 'call-decline', from: client.nick!, reason });
  }

  private callEnd(client: Client): void {
    const peer = this.talking.get(client);
    if (peer) peer.send({ type: 'call-end', from: client.nick! });
    this.dropCall(client);
  }

  private dropCall(client: Client): void {
    const peer = this.talking.get(client);
    if (peer) {
      this.talking.delete(peer);
      this.talking.delete(client);
    }
    for (const device of this.ringing.get(client) ?? []) this.invitedBy.delete(device);
    this.ringing.delete(client);

    const caller = this.invitedBy.get(client);
    if (caller) {
      this.invitedBy.delete(client);
      this.ringing.get(caller)?.delete(client);
    }
  }

  private voiceChannelCreate(client: Client, name: string): void {
    if (this.store.createVoiceChannel(name)) {
      this.broadcast({ type: 'voice-channels', list: this.store.listVoiceChannels() });
      this.broadcastVoicePresence();
    } else {
      client.send({ type: 'error', reason: 'Голосовой канал уже существует' });
    }
  }

  private voiceJoin(client: Client, channel: string): void {
    if (!this.store.hasVoiceChannel(channel)) {
      client.send({ type: 'error', reason: 'Нет такого голосового канала' });
      return;
    }
    if (this.voiceOf.get(client)?.channel === channel) return;

    for (const [peer] of [...this.voiceOf]) {
      if (peer === client || peer.nick?.toLowerCase() !== client.nick!.toLowerCase()) continue;
      this.voiceOf.delete(peer);
      peer.send({ type: 'voice-left', reason: 'Голос переключился на другое устройство' });
    }

    const present = [...this.voiceOf]
      .filter(([c, state]) => state.channel === channel && c !== client && c.nick)
      .map(([c, state]) => ({ nick: c.nick!, muted: state.muted }))
      .sort((a, b) => a.nick.localeCompare(b.nick));

    this.voiceOf.set(client, { channel, muted: false });
    client.send({ type: 'voice-roster', channel, users: present });
    this.broadcastVoicePresence();
  }

  private voiceLeave(client: Client): void {
    if (this.voiceOf.delete(client)) this.broadcastVoicePresence();
  }

  private voiceMute(client: Client, muted: boolean): void {
    const state = this.voiceOf.get(client);
    if (!state || state.muted === muted) return;
    state.muted = muted;
    for (const [peer, peerState] of this.voiceOf) {
      if (peer !== client && peerState.channel === state.channel) {
        peer.send({ type: 'voice-mute', nick: client.nick!, muted });
      }
    }
  }

  private voiceSignal(client: Client, toNick: string, data: unknown): void {
    const channel = this.voiceOf.get(client)?.channel;
    if (!channel) return;
    const lower = toNick.toLowerCase();
    const target = [...this.voiceOf].find(([c, state]) => state.channel === channel && c.nick?.toLowerCase() === lower)?.[0];
    target?.send({ type: 'voice-signal', from: client.nick!, data });
  }

  purgeAccounts(nicks: string[]): void {
    for (const nick of nicks) {
      this.store.purgeUser(nick);
      this.broadcast({ type: 'purged', nick });
    }
  }

  onlineNicks(): string[] {
    const unique = new Map<string, string>();
    for (const client of this.clients) {
      if (client.nick && !unique.has(client.nick.toLowerCase())) unique.set(client.nick.toLowerCase(), client.nick);
    }
    return [...unique.values()].sort((a, b) => a.localeCompare(b));
  }

  private voicePresenceMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const name of this.store.listVoiceChannels()) map[name] = [];
    const seen = new Set<string>();
    for (const [client, state] of this.voiceOf) {
      if (!client.nick || !map[state.channel]) continue;
      const key = `${state.channel}:${client.nick.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      map[state.channel].push(client.nick);
    }
    for (const name of Object.keys(map)) map[name].sort((a, b) => a.localeCompare(b));
    return map;
  }

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', users: this.onlineNicks() });
  }

  private broadcastVoicePresence(): void {
    this.broadcast({ type: 'voice-presence', channels: this.voicePresenceMap() });
  }

  private broadcast(message: ServerMessage): void {
    for (const c of this.clients) c.send(message);
  }
}

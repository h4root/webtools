import { NICK_MAX, parseClientMessage, type ClientMessage, type ServerMessage } from './protocol.ts';
import { Store, channelKey, dmKey, recipientsOf } from './store.ts';

export interface Client {
  id: string;
  nick: string | null;
  send(message: ServerMessage): void;
}

const NICK_PATTERN = /^[\p{L}\p{N} _.-]+$/u;

export class Hub {
  private readonly clients = new Set<Client>();
  private readonly voiceOf = new Map<Client, string>();

  constructor(private readonly store: Store = new Store()) {}

  join(client: Client, nick: string): void {
    const trimmed = nick.trim();
    if (trimmed.length === 0 || trimmed.length > NICK_MAX || !NICK_PATTERN.test(trimmed)) {
      client.send({ type: 'error', reason: 'Недопустимый ник' });
      return;
    }
    if (this.nickTaken(trimmed)) {
      client.send({ type: 'error', reason: 'Ник уже занят' });
      return;
    }

    client.nick = trimmed;
    this.clients.add(client);
    client.send({ type: 'welcome', nick: trimmed });
    client.send({ type: 'channels', list: this.store.listChannels() });
    client.send({ type: 'voice-channels', list: this.store.listVoiceChannels() });
    client.send({ type: 'voice-presence', channels: this.voicePresenceMap() });
    this.broadcast({ type: 'system', text: `${trimmed} присоединился` });
    this.broadcastPresence();
  }

  leave(client: Client): void {
    if (!this.clients.delete(client)) return;
    const wasInVoice = this.voiceOf.delete(client);
    const nick = client.nick;
    client.nick = null;
    if (nick) {
      this.broadcast({ type: 'system', text: `${nick} вышел` });
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

    if (message.type === 'hello') {
      if (!client.nick) this.join(client, message.nick);
      return;
    }

    if (!client.nick || !this.clients.has(client)) {
      client.send({ type: 'error', reason: 'Сначала представьтесь (hello)' });
      return;
    }

    switch (message.type) {
      case 'channel-create':
        this.createChannel(client, message.name);
        break;
      case 'message':
        this.sendMessage(client, message);
        break;
      case 'history':
        this.sendHistory(client, message);
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
      case 'voice-signal':
        this.voiceSignal(client, message.to, message.data);
        break;
      case 'call-invite': {
        const target = this.findByNick(message.to);
        if (target) target.send({ type: 'call-invite', from: client.nick! });
        else client.send({ type: 'call-end', from: message.to, reason: 'offline' });
        break;
      }
      case 'call-accept':
        this.findByNick(message.to)?.send({ type: 'call-accept', from: client.nick! });
        break;
      case 'call-decline':
        this.findByNick(message.to)?.send({ type: 'call-decline', from: client.nick!, reason: message.reason });
        break;
      case 'call-end':
        this.findByNick(message.to)?.send({ type: 'call-end', from: client.nick! });
        break;
      case 'call-signal':
        this.findByNick(message.to)?.send({ type: 'call-signal', from: client.nick!, data: message.data });
        break;
    }
  }

  private createChannel(client: Client, name: string): void {
    if (this.store.createChannel(name)) {
      this.broadcast({ type: 'channels', list: this.store.listChannels() });
      this.broadcast({ type: 'system', text: `Создан канал #${name}` });
    } else {
      client.send({ type: 'error', reason: 'Канал уже существует' });
    }
  }

  private sendMessage(client: Client, message: Extract<ClientMessage, { type: 'message' }>): void {
    if (message.channel) {
      if (!this.store.hasChannel(message.channel)) {
        client.send({ type: 'error', reason: 'Нет такого канала' });
        return;
      }
      const wire = this.store.addChannelMessage(message.channel, client.nick!, message.text, {
        replyTo: message.replyTo,
        attachments: message.attachments,
      });
      this.broadcast({ type: 'message', msg: wire });
      return;
    }

    const target = this.findByNick(message.to!);
    if (!target) {
      client.send({ type: 'error', reason: `${message.to} не в сети` });
      return;
    }
    const wire = this.store.addDirectMessage(client.nick!, target.nick!, message.text, {
      replyTo: message.replyTo,
      attachments: message.attachments,
    });
    this.sendToNicks([client.nick!, target.nick!], { type: 'message', msg: wire });
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
    if (message.channel) {
      for (const c of this.clients) {
        if (c !== client) c.send({ type: 'typing', from: client.nick!, channel: message.channel });
      }
    } else {
      this.findByNick(message.to!)?.send({ type: 'typing', from: client.nick!, to: client.nick! });
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
    if (this.voiceOf.get(client) === channel) return;

    const present = [...this.voiceOf]
      .filter(([c, ch]) => ch === channel && c !== client && c.nick)
      .map(([c]) => c.nick!)
      .sort((a, b) => a.localeCompare(b));

    this.voiceOf.set(client, channel);
    client.send({ type: 'voice-roster', channel, users: present });
    this.broadcastVoicePresence();
  }

  private voiceLeave(client: Client): void {
    if (this.voiceOf.delete(client)) this.broadcastVoicePresence();
  }

  private voiceSignal(client: Client, toNick: string, data: unknown): void {
    const channel = this.voiceOf.get(client);
    if (!channel) return;
    const lower = toNick.toLowerCase();
    const target = [...this.voiceOf].find(([c, ch]) => ch === channel && c.nick?.toLowerCase() === lower)?.[0];
    target?.send({ type: 'voice-signal', from: client.nick!, data });
  }

  private nickTaken(nick: string): boolean {
    const lower = nick.toLowerCase();
    for (const c of this.clients) {
      if (c.nick?.toLowerCase() === lower) return true;
    }
    return false;
  }

  private onlineNicks(): string[] {
    return [...this.clients]
      .map((c) => c.nick)
      .filter((nick): nick is string => nick !== null)
      .sort((a, b) => a.localeCompare(b));
  }

  private voicePresenceMap(): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const name of this.store.listVoiceChannels()) map[name] = [];
    for (const [client, channel] of this.voiceOf) {
      if (client.nick && map[channel]) map[channel].push(client.nick);
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

import { NICK_MAX, parseClientMessage, type ServerMessage } from './protocol.ts';

export interface Client {
  id: string;
  nick: string | null;
  send(message: ServerMessage): void;
}

const NICK_PATTERN = /^[\p{L}\p{N} _.-]+$/u;

export class Hub {
  private readonly clients = new Set<Client>();

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
    this.broadcast({ type: 'system', text: `${trimmed} присоединился` });
    this.broadcastPresence();
  }

  leave(client: Client): void {
    if (!this.clients.delete(client)) return;
    const nick = client.nick;
    client.nick = null;
    if (nick) {
      this.broadcast({ type: 'system', text: `${nick} вышел` });
      this.broadcastPresence();
    }
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

    if (message.type === 'public') {
      this.sendPublic(client, message.text);
    } else {
      this.sendDirect(client, message.to, message.text);
    }
  }

  private sendPublic(client: Client, text: string): void {
    this.broadcast({
      type: 'chat',
      channel: 'public',
      from: client.nick!,
      text,
      ts: Date.now(),
    });
  }

  private sendDirect(client: Client, toNick: string, text: string): void {
    const targets = [...this.clients].filter((c) => c.nick === toNick);
    if (targets.length === 0) {
      client.send({ type: 'error', reason: `${toNick} не в сети` });
      return;
    }

    const message: ServerMessage = {
      type: 'chat',
      channel: 'direct',
      from: client.nick!,
      to: toNick,
      text,
      ts: Date.now(),
    };

    const recipients = new Set<Client>(targets);
    recipients.add(client);
    for (const recipient of recipients) recipient.send(message);
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

  private broadcastPresence(): void {
    this.broadcast({ type: 'presence', users: this.onlineNicks() });
  }

  private broadcast(message: ServerMessage): void {
    for (const c of this.clients) c.send(message);
  }
}

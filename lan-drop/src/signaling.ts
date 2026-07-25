import { parseClientMessage, type PeerInfo, type ServerMessage } from './protocol.ts';

export interface Peer {
  id: string;
  name: string;
  send(message: ServerMessage): void;
}

export class Signaling {
  private readonly peers = new Map<string, Peer>();

  join(peer: Peer): void {
    const others = [...this.peers.values()];
    this.peers.set(peer.id, peer);

    peer.send({ type: 'welcome', id: peer.id, name: peer.name });
    peer.send({ type: 'peers', peers: others.map(toInfo) });
    for (const other of others) other.send({ type: 'peer-joined', peer: toInfo(peer) });
  }

  leave(peer: Peer): void {
    if (!this.peers.delete(peer.id)) return;
    for (const other of this.peers.values()) other.send({ type: 'peer-left', id: peer.id });
  }

  handle(peer: Peer, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) {
      peer.send({ type: 'error', reason: 'Некорректное сообщение' });
      return;
    }

    const target = this.peers.get(message.to);
    if (!target || target.id === peer.id) {
      peer.send({ type: 'error', reason: 'Пир недоступен' });
      return;
    }

    target.send({ type: 'signal', from: peer.id, data: message.data });
  }
}

function toInfo(peer: Peer): PeerInfo {
  return { id: peer.id, name: peer.name };
}

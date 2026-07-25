import { parseClientMessage, type PeerInfo, type ServerMessage } from './protocol.ts';

export interface Peer {
  id: string;
  roomId: string;
  name: string;
  send(message: ServerMessage): void;
}

export class Signaling {
  private readonly peers = new Map<string, Peer>();

  join(peer: Peer): void {
    this.peers.set(peer.id, peer);
    const roommates = this.roommates(peer);

    peer.send({ type: 'welcome', id: peer.id, name: peer.name });
    peer.send({ type: 'peers', peers: roommates.map(toInfo) });
    for (const other of roommates) other.send({ type: 'peer-joined', peer: toInfo(peer) });
  }

  leave(peer: Peer): void {
    if (!this.peers.delete(peer.id)) return;
    for (const other of this.roommates(peer)) other.send({ type: 'peer-left', id: peer.id });
  }

  handle(peer: Peer, raw: string): void {
    const message = parseClientMessage(raw);
    if (!message) {
      peer.send({ type: 'error', reason: 'Некорректное сообщение' });
      return;
    }

    const target = this.peers.get(message.to);
    if (!target || target.roomId !== peer.roomId) {
      peer.send({ type: 'error', reason: 'Пир недоступен' });
      return;
    }

    target.send({ type: 'signal', from: peer.id, data: message.data });
  }

  private roommates(peer: Peer): Peer[] {
    return [...this.peers.values()].filter((p) => p.roomId === peer.roomId && p.id !== peer.id);
  }
}

function toInfo(peer: Peer): PeerInfo {
  return { id: peer.id, name: peer.name };
}

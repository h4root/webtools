export const NAME_MAX = 32;
export const SIGNAL_MAX = 16384;

export type ClientMessage = { type: 'signal'; to: string; data: unknown };

export interface PeerInfo {
  id: string;
  name: string;
}

export type ServerMessage =
  | { type: 'welcome'; id: string; name: string }
  | { type: 'peers'; peers: PeerInfo[] }
  | { type: 'peer-joined'; peer: PeerInfo }
  | { type: 'peer-left'; id: string }
  | { type: 'signal'; from: string; data: unknown }
  | { type: 'error'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  if (data.type !== 'signal') return null;
  if (!isBoundedString(data.to, NAME_MAX)) return null;
  if (data.data === undefined) return null;
  if (JSON.stringify(data.data).length > SIGNAL_MAX) return null;

  return { type: 'signal', to: data.to.trim(), data: data.data };
}

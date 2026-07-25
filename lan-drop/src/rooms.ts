export function roomForAddress(address: string | undefined): string {
  if (!address) return 'unknown';

  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  const octets = normalized.split('.');
  if (octets.length === 4 && octets.every((o) => /^\d+$/.test(o))) {
    return octets.slice(0, 3).join('.');
  }
  return normalized;
}

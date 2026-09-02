export const FINGERPRINT_BYTES = 16;

export function fingerprint(digest) {
  const bytes = digest instanceof Uint8Array ? digest : new Uint8Array(digest);
  const hex = [...bytes.slice(0, FINGERPRINT_BYTES)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return hex.match(/.{1,4}/g)?.join(' ') ?? '';
}

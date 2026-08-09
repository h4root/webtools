import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('WSS1');
const IV_LEN = 12;
const TAG_LEN = 16;

export function deriveKey(master: Buffer, purpose: string): Buffer {
  return createHmac('sha256', master).update(`ws-chat:${purpose}`).digest();
}

export function isSealed(raw: Buffer): boolean {
  return raw.length >= MAGIC.length && raw.subarray(0, MAGIC.length).equals(MAGIC);
}

export function sealJson(key: Buffer, data: unknown): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function openJson<T>(key: Buffer, raw: Buffer): T {
  if (!isSealed(raw)) throw new Error('не запечатанный файл');
  const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = raw.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const body = raw.subarray(MAGIC.length + IV_LEN + TAG_LEN);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Формат файла на диске:
//   'WSC1' (4) | metaLen (2, BE) | meta JSON (metaLen) | iv (12) | tag (16) | ciphertext
// meta лежит открытым текстом, но входит в AAD — подменить mime или размер, не
// сломав проверку GCM, нельзя. Хэша содержимого в meta намеренно нет: он был бы
// отпечатком, по которому имеющий доступ к диску опознал бы известный файл.
const MAGIC = Buffer.from('WSC1');
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEAD_LEN = MAGIC.length + 2;

export const BLOB_ID = /^[a-f0-9]{32}$/;

// Сжатие оправдано только если оно реально что-то даёт: jpeg/png/видео уже
// сжаты, и gzip на них тратит время, увеличивая размер.
const GZIP_MIN_GAIN = 0.95;

export interface BlobMeta {
  id: string;
  size: number;
  mime: string;
}

interface StoredMeta {
  mime: string;
  size: number;
  gz: boolean;
}

export class BlobStore {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== KEY_LEN) throw new Error(`ключ должен быть ${KEY_LEN} байт, получено ${key.length}`);
  }

  // id детерминированно выводится из содержимого, поэтому один и тот же файл,
  // залитый десять раз, лежит на диске один раз. HMAC, а не сам хэш: иначе имя
  // файла выдавало бы, что именно в нём лежит.
  private idFor(plain: Buffer): string {
    const digest = createHash('sha256').update(plain).digest();
    return createHmac('sha256', this.key).update('blob:').update(digest).digest('hex').slice(0, 32);
  }

  private pathFor(id: string): string {
    return join(this.dir, id);
  }

  put(plain: Buffer, mime: string): BlobMeta {
    const id = this.idFor(plain);
    const file = this.pathFor(id);
    const meta: StoredMeta = { mime, size: plain.length, gz: false };

    try {
      statSync(file);
      return { id, size: plain.length, mime }; // такой блоб уже есть
    } catch {
      /* нет — пишем */
    }

    let payload = plain;
    const packed = gzipSync(plain);
    if (packed.length < plain.length * GZIP_MIN_GAIN) {
      payload = packed;
      meta.gz = true;
    }

    const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.concat([Buffer.from(id, 'utf8'), metaBuf]));
    const body = Buffer.concat([cipher.update(payload), cipher.final()]);

    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(metaBuf.length);

    mkdirSync(this.dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, Buffer.concat([MAGIC, lenBuf, metaBuf, iv, cipher.getAuthTag(), body]), { mode: 0o600 });
    renameSync(tmp, file);

    return { id, size: plain.length, mime };
  }

  stat(id: string): BlobMeta | null {
    if (!BLOB_ID.test(id)) return null;
    try {
      const head = readFileSync(this.pathFor(id));
      const meta = this.readMeta(head);
      return meta && { id, size: meta.size, mime: meta.mime };
    } catch {
      return null;
    }
  }

  private readMeta(raw: Buffer): StoredMeta | null {
    if (raw.length < HEAD_LEN || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    const metaLen = raw.readUInt16BE(MAGIC.length);
    if (raw.length < HEAD_LEN + metaLen + IV_LEN + TAG_LEN) return null;
    try {
      const meta = JSON.parse(raw.subarray(HEAD_LEN, HEAD_LEN + metaLen).toString('utf8'));
      if (typeof meta?.mime !== 'string' || typeof meta?.size !== 'number') return null;
      return { mime: meta.mime, size: meta.size, gz: Boolean(meta.gz) };
    } catch {
      return null;
    }
  }

  open(id: string): { data: Buffer; meta: BlobMeta } | null {
    if (!BLOB_ID.test(id)) return null;

    let raw: Buffer;
    try {
      raw = readFileSync(this.pathFor(id));
    } catch {
      return null;
    }

    const meta = this.readMeta(raw);
    if (!meta) return null;

    const metaLen = raw.readUInt16BE(MAGIC.length);
    const metaBuf = raw.subarray(HEAD_LEN, HEAD_LEN + metaLen);
    const iv = raw.subarray(HEAD_LEN + metaLen, HEAD_LEN + metaLen + IV_LEN);
    const tag = raw.subarray(HEAD_LEN + metaLen + IV_LEN, HEAD_LEN + metaLen + IV_LEN + TAG_LEN);
    const body = raw.subarray(HEAD_LEN + metaLen + IV_LEN + TAG_LEN);

    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.concat([Buffer.from(id, 'utf8'), metaBuf]));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
      if (meta.gz) plain = gunzipSync(plain);
    } catch {
      return null; // не тот ключ, подмена или битый файл
    }

    // Имя файла выводится из содержимого, так что несовпадение означает, что
    // блоб подложили под чужой id.
    if (this.idFor(plain) !== id) return null;

    return { data: plain, meta: { id, size: plain.length, mime: meta.mime } };
  }

  // Сообщение удалили или его вытеснило из истории — файл больше никому не
  // нужен. Считаем по факту ссылок, а не счётчиком: при дедупликации один блоб
  // делят несколько сообщений, и рассинхрон счётчика стирал бы живые вложения.
  // minAgeMs защищает от гонки: файл уже загружен, но сообщение с ним ещё висит
  // в поле ввода, так что ссылок на него пока нет ни у кого.
  sweep(keep: Set<string>, minAgeMs = 0): number {
    let removed = 0;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - minAgeMs;
    for (const name of names) {
      if (!BLOB_ID.test(name) || keep.has(name)) continue;
      try {
        if (minAgeMs > 0 && statSync(join(this.dir, name)).mtimeMs > cutoff) continue;
        unlinkSync(join(this.dir, name));
        removed++;
      } catch {
        /* уже удалён или занят — не страшно */
      }
    }
    return removed;
  }
}

// Ключ переживает рестарт, иначе все старые вложения превратятся в тыкву.
export function loadKey(dataDir: string, fromEnv?: string): Buffer {
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'hex');
    if (key.length !== KEY_LEN) throw new Error(`UPLOAD_KEY должен быть ${KEY_LEN} байт в hex (${KEY_LEN * 2} символов)`);
    return key;
  }

  const file = join(dataDir, 'upload.key');
  try {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length === KEY_LEN) return key;
    throw new Error(`в ${file} лежит не ${KEY_LEN}-байтный ключ`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const key = randomBytes(KEY_LEN);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

import type { AttachmentRef } from './protocol.ts';

const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

const NAME_MAX = 255;
const MIME_MAX = 128;

export function safeName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded.replace(/[/\\\r\n]/g, '_').slice(0, NAME_MAX) || 'file';
}

export interface Disposition {
  inline: boolean;
  contentType: string;
  header(name: string): string;
}

export function attachmentDisposition(mime: string): Disposition {
  const inline = INLINE_MIME.has(mime.toLowerCase());
  return {
    inline,
    contentType: inline ? mime.toLowerCase() : 'application/octet-stream',
    header(name: string) {
      return `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeName(name))}`;
    },
  };
}

export function describeUpload(headers: Record<string, string | string[] | undefined>): { name: string; mime: string } {
  const rawName = headers['x-filename'];
  const rawMime = headers['content-type'];
  return {
    name: typeof rawName === 'string' ? safeName(rawName) : 'file',
    mime: typeof rawMime === 'string' ? rawMime.slice(0, MIME_MAX) : 'application/octet-stream',
  };
}

export type DownloadPlan =
  | { status: 404; error: 'not-found' }
  | { status: 410; error: 'gone' }
  | { status: 200; contentType: string; disposition: string };

export function planDownload(attachment: AttachmentRef | null, blob: { mime: string } | null): DownloadPlan {
  if (!attachment) return { status: 404, error: 'not-found' };
  if (!blob) return { status: 410, error: 'gone' };

  const disposition = attachmentDisposition(blob.mime);
  return { status: 200, contentType: disposition.contentType, disposition: disposition.header(attachment.name) };
}

const PRUNE_AT = 1000;

export class UploadQuota {
  private counters = new Map<string, { count: number; until: number }>();

  constructor(
    private readonly perWindow: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    if (this.counters.size > PRUNE_AT) this.prune(now);
    const entry = this.counters.get(key);
    if (!entry || entry.until < now) {
      this.counters.set(key, { count: 1, until: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.perWindow;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.counters) {
      if (entry.until < now) this.counters.delete(key);
    }
  }

  forget(key: string): void {
    this.counters.delete(key);
  }

  size(): number {
    return this.counters.size;
  }
}

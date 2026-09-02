import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

export const LINK_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX = 500;

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

interface Pending<T> {
  value: T;
  expiresAt: number;
}

export class LinkCodes<T> {
  private readonly byCode = new Map<string, Pending<T>>();
  private readonly max: number;

  constructor(options: { max?: number } = {}) {
    this.max = options.max ?? DEFAULT_MAX;
  }

  private generate(): string {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    return code;
  }

  create(value: T): { code: string; expiresAt: number } {
    this.release(value);
    this.sweep();
    if (this.byCode.size >= this.max) {
      this.byCode.delete(this.byCode.keys().next().value!);
    }

    let code = this.generate();
    while (this.byCode.has(code)) code = this.generate();

    const expiresAt = Date.now() + LINK_TTL_MS;
    this.byCode.set(code, { value, expiresAt });
    return { code, expiresAt };
  }

  claim(raw: string): T | null {
    const code = normalizeCode(raw);
    const pending = this.byCode.get(code);
    if (!pending) return null;

    this.byCode.delete(code);
    return pending.expiresAt > Date.now() ? pending.value : null;
  }

  release(value: T): void {
    for (const [code, pending] of this.byCode) {
      if (pending.value === value) this.byCode.delete(code);
    }
  }

  sweep(): void {
    const now = Date.now();
    for (const [code, pending] of this.byCode) {
      if (pending.expiresAt <= now) this.byCode.delete(code);
    }
  }

  size(): number {
    return this.byCode.size;
  }
}

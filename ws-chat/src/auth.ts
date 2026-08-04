import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './jsonfile.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LEN = 64;
const SALT_LEN = 16;

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

const FAILURES_BEFORE_LOCK = 5;
const LOCK_BASE_MS = 2000;
const LOCK_MAX_MS = 15 * 60 * 1000;

export interface Account {
  nick: string;
  guest: boolean;
  salt?: string;
  hash?: string;
  createdAt: number;
}

interface Session {
  tokenHash: string;
  nick: string;
  guest: boolean;
  expiresAt: number;
}

export type AuthFailure =
  | 'nick-taken'
  | 'nick-registered'
  | 'no-account'
  | 'bad-password'
  | 'weak-password'
  | 'locked'
  | 'guest-has-no-password';

export interface AuthResult {
  ok: boolean;
  nick?: string;
  guest?: boolean;
  token?: string;
  error?: AuthFailure;
  retryAfterMs?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class Auth {
  private accounts = new Map<string, Account>();
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { count: number; until: number }>();
  private readonly accountsFile: string;
  private readonly sessionsFile: string;
  private readonly decoySalt = randomBytes(SALT_LEN);

  constructor(private readonly dataDir: string) {
    this.accountsFile = join(dataDir, 'accounts.json');
    this.sessionsFile = join(dataDir, 'sessions.json');
    this.load();
  }

  private load(): void {
    try {
      for (const account of readJson<Account[]>(this.accountsFile) ?? []) {
        this.accounts.set(account.nick.toLowerCase(), account);
      }
    } catch (error) {
      console.error(`auth: не читается ${this.accountsFile}: ${(error as Error).message}`);
    }
    try {
      const now = Date.now();
      for (const session of readJson<Session[]>(this.sessionsFile) ?? []) {
        if (session.expiresAt > now) this.sessions.set(session.tokenHash, session);
      }
    } catch (error) {
      console.error(`auth: не читается ${this.sessionsFile}: ${(error as Error).message}`);
    }
  }

  private saveAccounts(): void {
    try {
      writeJsonAtomic(this.accountsFile, [...this.accounts.values()], 0o600);
    } catch (error) {
      console.error(`auth: не сохранить аккаунты: ${(error as Error).message}`);
    }
  }

  private saveSessions(): void {
    try {
      writeJsonAtomic(this.sessionsFile, [...this.sessions.values()], 0o600);
    } catch (error) {
      console.error(`auth: не сохранить сессии: ${(error as Error).message}`);
    }
  }

  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    return scrypt(password.normalize('NFKC'), salt, KEY_LEN, SCRYPT);
  }

  private lockState(nick: string): number {
    const entry = this.failures.get(nick.toLowerCase());
    if (!entry) return 0;
    const left = entry.until - Date.now();
    return left > 0 ? left : 0;
  }

  private noteFailure(nick: string): void {
    const key = nick.toLowerCase();
    const entry = this.failures.get(key) ?? { count: 0, until: 0 };
    entry.count++;
    if (entry.count > FAILURES_BEFORE_LOCK) {
      const step = entry.count - FAILURES_BEFORE_LOCK;
      entry.until = Date.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (step - 1));
    }
    this.failures.set(key, entry);
  }

  private clearFailures(nick: string): void {
    this.failures.delete(nick.toLowerCase());
  }

  find(nick: string): Account | undefined {
    return this.accounts.get(nick.toLowerCase());
  }

  private issue(account: Account): string {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    this.sessions.set(sha256(token), {
      tokenHash: sha256(token),
      nick: account.nick,
      guest: account.guest,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    this.saveSessions();
    return token;
  }

  async registerGuest(nick: string): Promise<AuthResult> {
    const existing = this.find(nick);
    if (existing) return { ok: false, error: existing.guest ? 'nick-taken' : 'nick-registered' };

    const account: Account = { nick, guest: true, createdAt: Date.now() };
    this.accounts.set(nick.toLowerCase(), account);
    this.saveAccounts();
    return { ok: true, nick, guest: true, token: this.issue(account) };
  }

  async register(nick: string, password: string): Promise<AuthResult> {
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return { ok: false, error: 'weak-password' };
    const existing = this.find(nick);
    if (existing) return { ok: false, error: existing.guest ? 'nick-taken' : 'nick-registered' };

    const salt = randomBytes(SALT_LEN);
    const hash = await this.derive(password, salt);
    const account: Account = {
      nick,
      guest: false,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      createdAt: Date.now(),
    };
    this.accounts.set(nick.toLowerCase(), account);
    this.saveAccounts();
    return { ok: true, nick, guest: false, token: this.issue(account) };
  }

  async login(nick: string, password: string): Promise<AuthResult> {
    const locked = this.lockState(nick);
    if (locked) return { ok: false, error: 'locked', retryAfterMs: locked };

    const account = this.find(nick);
    if (!account || account.guest || !account.salt || !account.hash) {
      await this.derive(password, this.decoySalt);
      this.noteFailure(nick);
      return { ok: false, error: account?.guest ? 'guest-has-no-password' : 'no-account' };
    }

    const expected = Buffer.from(account.hash, 'hex');
    const actual = await this.derive(password, Buffer.from(account.salt, 'hex'));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.noteFailure(nick);
      return { ok: false, error: 'bad-password' };
    }

    this.clearFailures(nick);
    return { ok: true, nick: account.nick, guest: false, token: this.issue(account) };
  }

  resume(token: string): { nick: string; guest: boolean } | null {
    const session = this.sessions.get(sha256(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(session.tokenHash);
      this.saveSessions();
      return null;
    }
    const account = this.find(session.nick);
    if (!account) {
      this.sessions.delete(session.tokenHash);
      this.saveSessions();
      return null;
    }
    return { nick: account.nick, guest: session.guest };
  }

  revoke(token: string): void {
    if (this.sessions.delete(sha256(token))) this.saveSessions();
  }

  removeAccount(nick: string): void {
    const lower = nick.toLowerCase();
    if (!this.accounts.delete(lower)) return;
    for (const [hash, session] of this.sessions) {
      if (session.nick.toLowerCase() === lower) this.sessions.delete(hash);
    }
    this.saveAccounts();
    this.saveSessions();
  }
}

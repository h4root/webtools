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

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSIONS_PER_ACCOUNT = 10;
export const FAILURE_TTL_MS = 60 * 60 * 1000;
export const FAILURES_MAX = 10000;
const LAST_SEEN_STEP_MS = 60 * 60 * 1000;
export const AUTH_ATTEMPTS_PER_WINDOW = 20;
export const AUTH_ATTEMPT_WINDOW_MS = 60 * 1000;
export const MAX_GUEST_ACCOUNTS = 200;
const TOKEN_BYTES = 32;

const FAILURES_BEFORE_LOCK = 5;
const LOCK_BASE_MS = 2000;
const LOCK_MAX_MS = 15 * 60 * 1000;

export interface AuthLimits {
  failuresMax?: number;
}

export interface Account {
  nick: string;
  guest: boolean;
  salt?: string;
  hash?: string;
  createdAt: number;
}

interface Session {
  key?: string;
  id: string;
  tokenHash: string;
  nick: string;
  guest: boolean;
  device: string;
  expiresAt: number;
  issuedAt: number;
  lastSeenAt: number;
}

export interface DeviceKey {
  id: string;
  device: string;
  key: string;
}

export interface SessionInfo {
  id: string;
  device: string;
  issuedAt: number;
  lastSeenAt: number;
  current: boolean;
}

const DEVICE_MAX = 32;

export function safeDevice(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^\p{L}\p{N} .-]/gu, '').slice(0, DEVICE_MAX).trim();
}

export type AuthFailure =
  | 'nick-taken'
  | 'nick-registered'
  | 'no-account'
  | 'bad-password'
  | 'weak-password'
  | 'locked'
  | 'guest-has-no-password'
  | 'guests-full';

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
  private failures = new Map<string, { count: number; until: number; seenAt: number }>();
  private attempts = new Map<string, { count: number; windowStartedAt: number }>();
  private readonly accountsFile: string;
  private readonly sessionsFile: string;
  private readonly decoySalt = randomBytes(SALT_LEN);
  private readonly failuresMax: number;

  constructor(
    private readonly dataDir: string,
    limits: AuthLimits = {},
  ) {
    this.accountsFile = join(dataDir, 'accounts.json');
    this.sessionsFile = join(dataDir, 'sessions.json');
    this.failuresMax = limits.failuresMax ?? FAILURES_MAX;
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
        if (session.expiresAt <= now) continue;
        session.id ??= randomBytes(8).toString('hex');
        session.device ??= '';
        session.lastSeenAt ??= session.issuedAt ?? now;
        this.sessions.set(session.tokenHash, session);
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
    const now = Date.now();
    const entry = this.failures.get(key) ?? { count: 0, until: 0, seenAt: now };
    entry.count++;
    entry.seenAt = now;
    if (entry.count > FAILURES_BEFORE_LOCK) {
      const step = entry.count - FAILURES_BEFORE_LOCK;
      entry.until = now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (step - 1));
    }
    this.failures.set(key, entry);
    this.capFailures();
  }

  private capFailures(): void {
    if (this.failures.size <= this.failuresMax) return;
    for (const [key, entry] of this.failures) {
      if (this.failures.size <= this.failuresMax) break;
      if (entry.until <= Date.now()) this.failures.delete(key);
    }
    while (this.failures.size > this.failuresMax) {
      this.failures.delete(this.failures.keys().next().value!);
    }
  }

  failureCount(): number {
    return this.failures.size;
  }

  private clearFailures(nick: string): void {
    this.failures.delete(nick.toLowerCase());
  }

  find(nick: string): Account | undefined {
    return this.accounts.get(nick.toLowerCase());
  }

  private ttlFor(guest: boolean): number {
    return guest ? GUEST_TTL_MS : SESSION_TTL_MS;
  }

  private issue(account: Account, device = ''): string {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    this.sessions.set(sha256(token), {
      id: randomBytes(8).toString('hex'),
      tokenHash: sha256(token),
      nick: account.nick,
      guest: account.guest,
      device: safeDevice(device),
      expiresAt: now + this.ttlFor(account.guest),
      issuedAt: now,
      lastSeenAt: now,
    });
    this.capSessions(account.nick);
    this.saveSessions();
    return token;
  }

  private capSessions(nick: string): void {
    const lower = nick.toLowerCase();
    const mine = [...this.sessions.values()]
      .filter((session) => session.nick.toLowerCase() === lower)
      .sort((a, b) => a.issuedAt - b.issuedAt);
    for (const session of mine.slice(0, Math.max(0, mine.length - SESSIONS_PER_ACCOUNT))) {
      this.sessions.delete(session.tokenHash);
    }
  }

  private guestCount(): number {
    let count = 0;
    for (const account of this.accounts.values()) if (account.guest) count++;
    return count;
  }

  allowAttempt(source: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(source);
    if (!entry || now - entry.windowStartedAt >= AUTH_ATTEMPT_WINDOW_MS) {
      this.attempts.set(source, { count: 1, windowStartedAt: now });
      this.capAttempts();
      return true;
    }
    entry.count++;
    return entry.count <= AUTH_ATTEMPTS_PER_WINDOW;
  }

  private capAttempts(): void {
    while (this.attempts.size > this.failuresMax) {
      this.attempts.delete(this.attempts.keys().next().value!);
    }
  }

  attemptSources(): number {
    return this.attempts.size;
  }

  async registerGuest(nick: string, device = ''): Promise<AuthResult> {
    const existing = this.find(nick);
    if (existing) return { ok: false, error: existing.guest ? 'nick-taken' : 'nick-registered' };
    if (this.guestCount() >= MAX_GUEST_ACCOUNTS) return { ok: false, error: 'guests-full' };

    const account: Account = { nick, guest: true, createdAt: Date.now() };
    this.accounts.set(nick.toLowerCase(), account);
    this.saveAccounts();
    return { ok: true, nick, guest: true, token: this.issue(account, device) };
  }

  async register(nick: string, password: string, device = ''): Promise<AuthResult> {
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
    return { ok: true, nick, guest: false, token: this.issue(account, device) };
  }

  async login(nick: string, password: string, device = ''): Promise<AuthResult> {
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
    return { ok: true, nick: account.nick, guest: false, token: this.issue(account, device) };
  }

  async changePassword(nick: string, current: string, next: string, keepToken?: string): Promise<AuthResult> {
    const locked = this.lockState(nick);
    if (locked) return { ok: false, error: 'locked', retryAfterMs: locked };

    const account = this.find(nick);
    if (!account || account.guest || !account.salt || !account.hash) {
      await this.derive(current, this.decoySalt);
      return { ok: false, error: account?.guest ? 'guest-has-no-password' : 'no-account' };
    }

    const expected = Buffer.from(account.hash, 'hex');
    const actual = await this.derive(current, Buffer.from(account.salt, 'hex'));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.noteFailure(nick);
      return { ok: false, error: 'bad-password' };
    }

    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) return { ok: false, error: 'weak-password' };

    const salt = randomBytes(SALT_LEN);
    account.salt = salt.toString('hex');
    account.hash = (await this.derive(next, salt)).toString('hex');
    this.clearFailures(nick);
    this.saveAccounts();
    this.revokeAllFor(nick, keepToken);

    return { ok: true, nick: account.nick, guest: false };
  }

  issueFor(nick: string, device = ''): string | null {
    const account = this.find(nick);
    if (!account || account.guest) return null;
    return this.issue(account, device);
  }

  setDeviceKey(token: string, key: string): boolean {
    const session = this.sessions.get(sha256(token));
    if (!session || session.key === key) return false;
    session.key = key;
    this.saveSessions();
    return true;
  }

  deviceKeys(nick: string): DeviceKey[] {
    const lower = nick.toLowerCase();
    return [...this.sessions.values()]
      .filter((session) => session.nick.toLowerCase() === lower && session.key)
      .map((session) => ({ id: session.id, device: session.device, key: session.key! }));
  }

  listSessions(nick: string, currentToken?: string): SessionInfo[] {
    const lower = nick.toLowerCase();
    const currentHash = currentToken ? sha256(currentToken) : null;
    return [...this.sessions.values()]
      .filter((session) => session.nick.toLowerCase() === lower)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({
        id: session.id,
        device: session.device,
        issuedAt: session.issuedAt,
        lastSeenAt: session.lastSeenAt,
        current: session.tokenHash === currentHash,
      }));
  }

  revokeSession(nick: string, id: string): boolean {
    const lower = nick.toLowerCase();
    for (const [hash, session] of this.sessions) {
      if (session.id !== id || session.nick.toLowerCase() !== lower) continue;
      this.sessions.delete(hash);
      this.saveSessions();
      return true;
    }
    return false;
  }

  sessionIdFor(token: string): string | null {
    return this.sessions.get(sha256(token))?.id ?? null;
  }

  revokeAllFor(nick: string, keepToken?: string): number {
    const lower = nick.toLowerCase();
    const keepHash = keepToken ? sha256(keepToken) : null;
    let revoked = 0;

    for (const [hash, session] of this.sessions) {
      if (session.nick.toLowerCase() !== lower || hash === keepHash) continue;
      this.sessions.delete(hash);
      revoked++;
    }
    if (revoked) this.saveSessions();
    return revoked;
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

    const ttl = this.ttlFor(session.guest);
    const now = Date.now();
    if (session.expiresAt - now < ttl / 2 || now - session.lastSeenAt > LAST_SEEN_STEP_MS) {
      session.expiresAt = now + ttl;
      session.lastSeenAt = now;
      this.saveSessions();
    }
    return { nick: account.nick, guest: session.guest };
  }

  sweep(activeNicks: Iterable<string> = []): string[] {
    const now = Date.now();
    let changed = false;

    for (const [hash, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(hash);
        changed = true;
      }
    }

    const alive = new Set<string>();
    for (const session of this.sessions.values()) alive.add(session.nick.toLowerCase());
    for (const nick of activeNicks) alive.add(nick.toLowerCase());

    const freed: string[] = [];
    for (const account of [...this.accounts.values()]) {
      if (!account.guest || alive.has(account.nick.toLowerCase())) continue;
      this.accounts.delete(account.nick.toLowerCase());
      freed.push(account.nick);
    }

    for (const [key, entry] of this.failures) {
      if (entry.until <= now && entry.seenAt + FAILURE_TTL_MS <= now) this.failures.delete(key);
    }
    for (const [source, entry] of this.attempts) {
      if (now - entry.windowStartedAt >= AUTH_ATTEMPT_WINDOW_MS) this.attempts.delete(source);
    }

    if (freed.length) this.saveAccounts();
    if (changed || freed.length) this.saveSessions();
    return freed;
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Auth,
  GUEST_TTL_MS,
  SESSION_TTL_MS,
  SESSIONS_PER_ACCOUNT,
  FAILURE_TTL_MS,
  AUTH_ATTEMPTS_PER_WINDOW,
  AUTH_ATTEMPT_WINDOW_MS,
  MAX_GUEST_ACCOUNTS,
} from './auth.ts';

describe('Auth', () => {
  let dir: string;
  let auth: Auth;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-auth-'));
    auth = new Auth(dir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('заводит аккаунт с паролем и пускает по нему', async () => {
    const created = await auth.register('alice', 'правильный-пароль');
    expect(created.ok).toBe(true);
    expect(created.token).toMatch(/^[a-f0-9]{64}$/);

    const back = await auth.login('alice', 'правильный-пароль');
    expect(back.ok).toBe(true);
    expect(back.nick).toBe('alice');
    expect(back.token).not.toBe(created.token);
  });

  it('не хранит пароль и не хранит токен целиком', async () => {
    const { token } = await auth.register('alice', 'секретный-пароль');

    const accounts = readFileSync(join(dir, 'accounts.json'), 'utf8');
    expect(accounts).not.toContain('секретный-пароль');
    const sessions = readFileSync(join(dir, 'sessions.json'), 'utf8');
    expect(sessions).not.toContain(token);

    expect(statSync(join(dir, 'accounts.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'sessions.json')).mode & 0o777).toBe(0o600);
  });

  it('солит пароли: одинаковые дают разные хэши', async () => {
    await auth.register('alice', 'одинаковый-пароль');
    await auth.register('bob', 'одинаковый-пароль');
    const [a, b] = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'));
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it('отклоняет неверный пароль и короткий пароль', async () => {
    await auth.register('alice', 'правильный-пароль');
    expect((await auth.login('alice', 'неправильный')).error).toBe('bad-password');
    expect((await auth.register('bob', 'корот')).error).toBe('weak-password');
  });

  it('тормозит перебор после серии промахов', async () => {
    await auth.register('alice', 'правильный-пароль');
    for (let i = 0; i < 6; i++) await auth.login('alice', `попытка-${i}`);

    const locked = await auth.login('alice', 'правильный-пароль');
    expect(locked.error).toBe('locked');
    expect(locked.retryAfterMs).toBeGreaterThan(0);
  });

  it('не выдаёт по ошибке, заведён ли ник', async () => {
    await auth.register('alice', 'правильный-пароль');
    const guessKnown = await auth.login('alice', 'мимо');
    const guessUnknown = await auth.login('несуществующий', 'мимо');
    expect(guessKnown.ok).toBe(false);
    expect(guessUnknown.ok).toBe(false);
  });

  it('не даёт занять гостем ник, у которого есть пароль', async () => {
    await auth.register('alice', 'правильный-пароль');
    expect((await auth.registerGuest('ALICE')).error).toBe('nick-registered');
  });

  it('не даёт двум гостям один ник', async () => {
    expect((await auth.registerGuest('гость')).ok).toBe(true);
    expect((await auth.registerGuest('ГОСТЬ')).error).toBe('nick-taken');
  });

  it('resume поднимает сессию, revoke её гасит', async () => {
    const { token } = await auth.register('alice', 'правильный-пароль');
    expect(auth.resume(token!)).toEqual({ nick: 'alice', guest: false });

    auth.revoke(token!);
    expect(auth.resume(token!)).toBeNull();
    expect(auth.resume('чужой-токен')).toBeNull();
  });

  it('выход гостя освобождает ник и убивает все его сессии', async () => {
    const first = await auth.registerGuest('гость');
    const second = auth.resume(first.token!);
    expect(second).not.toBeNull();

    auth.removeAccount('гость');
    expect(auth.resume(first.token!)).toBeNull();
    expect((await auth.registerGuest('гость')).ok).toBe(true);
  });

  it('освобождает ник гостя, ушедшего не через кнопку выхода', async () => {
    const { token } = await auth.registerGuest('гость');
    expect(auth.find('гость')).toBeDefined();

    vi.setSystemTime(Date.now() + GUEST_TTL_MS + 1000);
    expect(auth.sweep()).toEqual(['гость']);

    expect(auth.find('гость')).toBeUndefined();
    expect(auth.resume(token!)).toBeNull();
    expect((await auth.registerGuest('гость')).ok).toBe(true);
  });

  it('не трогает гостя, который сейчас в сети', async () => {
    await auth.registerGuest('гость');
    vi.setSystemTime(Date.now() + GUEST_TTL_MS + 1000);

    expect(auth.sweep(['ГОСТЬ'])).toEqual([]);
    expect(auth.find('гость')).toBeDefined();
  });

  it('не трогает аккаунт с паролем, даже когда сессии протухли', async () => {
    await auth.register('alice', 'достаточно-длинный');
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);

    expect(auth.sweep()).toEqual([]);
    expect(auth.find('alice')).toBeDefined();
    expect((await auth.login('alice', 'достаточно-длинный')).ok).toBe(true);
  });

  it('продлевает сессию, пока ею пользуются', async () => {
    const { token } = await auth.registerGuest('гость');

    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(Date.now() + GUEST_TTL_MS * 0.75);
      expect(auth.resume(token!)).not.toBeNull();
    }

    vi.setSystemTime(Date.now() + GUEST_TTL_MS * 0.75);
    expect(auth.sweep()).toEqual([]);
    expect(auth.find('гость')).toBeDefined();
  });

  it('не копит сессии без предела на одном аккаунте', async () => {
    await auth.register('alice', 'достаточно-длинный');
    const tokens = [];
    for (let i = 0; i < SESSIONS_PER_ACCOUNT + 5; i++) {
      tokens.push((await auth.login('alice', 'достаточно-длинный')).token!);
    }

    const stored = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
    expect(stored.length).toBeLessThanOrEqual(SESSIONS_PER_ACCOUNT);
    expect(auth.resume(tokens.at(-1)!)).not.toBeNull();
    expect(auth.resume(tokens[0])).toBeNull();
  });

  it('выметает протухшие сессии с диска', async () => {
    const { token } = await auth.register('alice', 'достаточно-длинный');
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);

    auth.sweep();
    expect(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))).toEqual([]);
    expect(auth.resume(token!)).toBeNull();
  });

  it('не копит счётчики промахов по чужим никам', async () => {
    for (let i = 0; i < 4; i++) await auth.login(`неизвестный-${i}`, 'мимо');
    expect(auth.failureCount()).toBe(4);

    vi.setSystemTime(Date.now() + FAILURE_TTL_MS + 1000);
    auth.sweep();
    expect(auth.failureCount()).toBe(0);
  });

  it('держит счётчики промахов в рамках даже без уборки', async () => {
    const tight = new Auth(dir, { failuresMax: 5 });
    for (let i = 0; i < 9; i++) await tight.login(`шум-${i}`, 'мимо');
    expect(tight.failureCount()).toBeLessThanOrEqual(5);
  });

  it('блокировку по нику уборка не снимает досрочно', async () => {
    await auth.register('alice', 'достаточно-длинный');
    for (let i = 0; i < 6; i++) await auth.login('alice', 'мимо');
    expect((await auth.login('alice', 'достаточно-длинный')).error).toBe('locked');

    auth.sweep();
    expect((await auth.login('alice', 'достаточно-длинный')).error).toBe('locked');
  });

  it('осаживает частые попытки входа с одного адреса', async () => {
    for (let i = 0; i < AUTH_ATTEMPTS_PER_WINDOW; i++) {
      expect(auth.allowAttempt('10.0.0.1')).toBe(true);
    }
    expect(auth.allowAttempt('10.0.0.1')).toBe(false);
    expect(auth.allowAttempt('10.0.0.2')).toBe(true);

    vi.setSystemTime(Date.now() + AUTH_ATTEMPT_WINDOW_MS + 100);
    expect(auth.allowAttempt('10.0.0.1')).toBe(true);
  });

  it('не даёт наплодить гостей без предела', async () => {
    for (let i = 0; i < MAX_GUEST_ACCOUNTS; i++) {
      expect((await auth.registerGuest(`гость-${i}`)).ok).toBe(true);
    }
    expect((await auth.registerGuest('лишний')).error).toBe('guests-full');

    await auth.register('alice', 'достаточно-длинный');
    expect(auth.find('alice')).toBeDefined();
  });

  it('потолок гостей отпускает после уборки', async () => {
    for (let i = 0; i < MAX_GUEST_ACCOUNTS; i++) await auth.registerGuest(`гость-${i}`);
    vi.setSystemTime(Date.now() + GUEST_TTL_MS + 1000);
    auth.sweep();

    expect((await auth.registerGuest('новичок')).ok).toBe(true);
  });

  it('не копит записи о попытках', async () => {
    for (let i = 0; i < 50; i++) auth.allowAttempt(`10.0.1.${i}`);
    expect(auth.attemptSources()).toBe(50);

    vi.setSystemTime(Date.now() + AUTH_ATTEMPT_WINDOW_MS * 3);
    auth.sweep();
    expect(auth.attemptSources()).toBe(0);
  });

  it('переживает перезапуск: аккаунты и сессии читаются с диска', async () => {
    const { token } = await auth.register('alice', 'правильный-пароль');
    const restarted = new Auth(dir);

    expect(restarted.resume(token!)).toEqual({ nick: 'alice', guest: false });
    expect((await restarted.login('alice', 'правильный-пароль')).ok).toBe(true);
  });
});

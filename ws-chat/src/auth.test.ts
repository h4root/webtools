import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from './auth.ts';

describe('Auth', () => {
  let dir: string;
  let auth: Auth;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-auth-'));
    auth = new Auth(dir);
  });

  afterEach(() => {
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

  it('переживает перезапуск: аккаунты и сессии читаются с диска', async () => {
    const { token } = await auth.register('alice', 'правильный-пароль');
    const restarted = new Auth(dir);

    expect(restarted.resume(token!)).toEqual({ nick: 'alice', guest: false });
    expect((await restarted.login('alice', 'правильный-пароль')).ok).toBe(true);
  });
});

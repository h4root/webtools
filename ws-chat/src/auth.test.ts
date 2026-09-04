import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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

  it('меняет пароль: старый перестаёт работать, новый пускает', async () => {
    await auth.register('alice', 'старый-пароль-раз');
    expect((await auth.changePassword('alice', 'старый-пароль-раз', 'новый-пароль-два')).ok).toBe(true);

    expect((await auth.login('alice', 'старый-пароль-раз')).error).toBe('bad-password');
    expect((await auth.login('alice', 'новый-пароль-два')).ok).toBe(true);
  });

  it('при смене пароля берёт новую соль', async () => {
    await auth.register('alice', 'один-и-тот-же-пароль');
    const before = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))[0];

    await auth.changePassword('alice', 'один-и-тот-же-пароль', 'один-и-тот-же-пароль');
    const after = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))[0];

    expect(after.salt).not.toBe(before.salt);
    expect(after.hash).not.toBe(before.hash);
  });

  it('не меняет пароль без верного текущего и считает это промахом', async () => {
    await auth.register('alice', 'настоящий-пароль');
    expect((await auth.changePassword('alice', 'не-тот', 'новый-пароль-два')).error).toBe('bad-password');
    expect((await auth.login('alice', 'настоящий-пароль')).ok).toBe(true);
  });

  it('не принимает слишком короткий новый пароль', async () => {
    await auth.register('alice', 'настоящий-пароль');
    expect((await auth.changePassword('alice', 'настоящий-пароль', 'корот')).error).toBe('weak-password');
    expect((await auth.login('alice', 'настоящий-пароль')).ok).toBe(true);
  });

  it('гостю менять нечего', async () => {
    await auth.registerGuest('гость');
    expect((await auth.changePassword('гость', 'что-угодно', 'новый-пароль-два')).error).toBe('guest-has-no-password');
  });

  it('смена пароля гасит остальные сессии, но не текущую', async () => {
    const first = await auth.register('alice', 'старый-пароль-раз');
    const second = await auth.login('alice', 'старый-пароль-раз');
    const third = await auth.login('alice', 'старый-пароль-раз');

    await auth.changePassword('alice', 'старый-пароль-раз', 'новый-пароль-два', third.token);

    expect(auth.resume(third.token!)).not.toBeNull();
    expect(auth.resume(first.token!)).toBeNull();
    expect(auth.resume(second.token!)).toBeNull();
  });

  it('выход отовсюду гасит все сессии ника и возвращает их', async () => {
    const first = await auth.register('alice', 'достаточно-длинный');
    const second = await auth.login('alice', 'достаточно-длинный');
    const other = await auth.register('bob', 'достаточно-длинный');

    expect(auth.revokeAllFor('ALICE')).toBe(2);
    expect(auth.resume(first.token!)).toBeNull();
    expect(auth.resume(second.token!)).toBeNull();
    expect(auth.resume(other.token!)).not.toBeNull();
  });

  it('перечисляет свои сессии и помечает текущую', async () => {
    const first = await auth.register('alice', 'достаточно-длинный', 'Mac');
    vi.setSystemTime(Date.now() + 60_000);
    const second = await auth.login('alice', 'достаточно-длинный', 'iPhone');

    const list = auth.listSessions('alice', second.token);
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.device).sort()).toEqual(['Mac', 'iPhone']);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)?.device).toBe('iPhone');
    expect(list.every((s) => typeof s.id === 'string' && s.id.length > 0)).toBe(true);
    expect(first.token).not.toBe(second.token);
  });

  it('не показывает чужие сессии', async () => {
    await auth.register('alice', 'достаточно-длинный', 'Mac');
    const bob = await auth.register('bob', 'достаточно-длинный', 'Windows');

    const list = auth.listSessions('alice', undefined);
    expect(list.map((s) => s.device)).toEqual(['Mac']);
    expect(auth.listSessions('bob', bob.token).map((s) => s.device)).toEqual(['Windows']);
  });

  it('отзывает одну сессию, не трогая остальные', async () => {
    const laptop = await auth.register('alice', 'достаточно-длинный', 'Mac');
    const phone = await auth.login('alice', 'достаточно-длинный', 'iPhone');

    const target = auth.listSessions('alice', phone.token).find((s) => !s.current)!;
    expect(auth.revokeSession('alice', target.id)).toBe(true);

    expect(auth.resume(laptop.token!)).toBeNull();
    expect(auth.resume(phone.token!)).not.toBeNull();
  });

  it('не даёт отозвать чужую сессию по её идентификатору', async () => {
    const alice = await auth.register('alice', 'достаточно-длинный', 'Mac');
    await auth.register('bob', 'достаточно-длинный', 'Windows');

    const aliceSession = auth.listSessions('alice', alice.token)[0];
    expect(auth.revokeSession('bob', aliceSession.id)).toBe(false);
    expect(auth.resume(alice.token!)).not.toBeNull();
  });

  it('запоминает, когда сессией пользовались в последний раз', async () => {
    const { token } = await auth.register('alice', 'достаточно-длинный', 'Mac');
    const created = auth.listSessions('alice', token)[0].lastSeenAt;

    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
    auth.resume(token!);

    expect(auth.listSessions('alice', token)[0].lastSeenAt).toBeGreaterThan(created);
  });

  it('поднимает старые сессии без метки и идентификатора', async () => {
    const { token } = await auth.register('alice', 'достаточно-длинный', 'Mac');
    const raw = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
    for (const session of raw) {
      delete session.id;
      delete session.device;
      delete session.lastSeenAt;
    }
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify(raw));

    const restarted = new Auth(dir);
    expect(restarted.resume(token!)).not.toBeNull();
    const list = restarted.listSessions('alice', token);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBeTruthy();
  });

  it('переживает перезапуск: аккаунты и сессии читаются с диска', async () => {
    const { token } = await auth.register('alice', 'правильный-пароль');
    const restarted = new Auth(dir);

    expect(restarted.resume(token!)).toEqual({ nick: 'alice', guest: false });
    expect((await restarted.login('alice', 'правильный-пароль')).ok).toBe(true);
  });
});

describe('Auth: ключи устройств', () => {
  let dir: string;
  let auth: Auth;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ws-chat-keys-'));
    auth = new Auth(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const KEY_A = 'A'.repeat(88);
  const KEY_B = 'B'.repeat(88);

  it('ключ живёт на сессии и выдаётся по нику', async () => {
    const alice = await auth.registerGuest('alice', 'Mac');
    expect(auth.setDeviceKey(alice.token!, KEY_A)).toBe(true);

    expect(auth.deviceKeys('alice')).toEqual([{ id: expect.any(String), device: 'Mac', key: KEY_A }]);
  });

  it('ник в запросе регистр не различает', async () => {
    const alice = await auth.registerGuest('Alice', 'Mac');
    auth.setDeviceKey(alice.token!, KEY_A);
    expect(auth.deviceKeys('ALICE')).toHaveLength(1);
  });

  it('у каждого устройства свой ключ', async () => {
    const first = await auth.register('bob', 'пароль подлиннее', 'Mac');
    const second = await auth.login('bob', 'пароль подлиннее', 'Телефон');
    auth.setDeviceKey(first.token!, KEY_A);
    auth.setDeviceKey(second.token!, KEY_B);

    const keys = auth.deviceKeys('bob');
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.key).sort()).toEqual([KEY_A, KEY_B]);
  });

  it('без ключа устройство в выдачу не попадает: писать в него нечем', async () => {
    const carol = await auth.register('carol', 'пароль подлиннее', 'Mac');
    await auth.login('carol', 'пароль подлиннее', 'Второй');
    auth.setDeviceKey(carol.token!, KEY_A);

    expect(auth.deviceKeys('carol')).toHaveLength(1);
  });

  it('чужой токен ключ не проставляет', () => {
    expect(auth.setDeviceKey('чужой-токен', KEY_A)).toBe(false);
  });

  it('ключ уходит вместе с сессией', async () => {
    const dave = await auth.registerGuest('dave', 'Mac');
    auth.setDeviceKey(dave.token!, KEY_A);
    auth.revoke(dave.token!);
    expect(auth.deviceKeys('dave')).toEqual([]);
  });

  it('повторная публикация того же ключа ничего не меняет и не пишет на диск', async () => {
    const gina = await auth.registerGuest('gina', 'Mac');
    expect(auth.setDeviceKey(gina.token!, KEY_A)).toBe(true);
    expect(auth.setDeviceKey(gina.token!, KEY_A)).toBe(false);
    expect(auth.deviceKeys('gina')).toHaveLength(1);
  });

  it('переизданный ключ вытесняет прежний, а не копится', async () => {
    const eve = await auth.registerGuest('eve', 'Mac');
    auth.setDeviceKey(eve.token!, KEY_A);
    auth.setDeviceKey(eve.token!, KEY_B);
    expect(auth.deviceKeys('eve')).toEqual([{ id: expect.any(String), device: 'Mac', key: KEY_B }]);
  });

  it('ключи переживают перезапуск сервера', async () => {
    const frank = await auth.registerGuest('frank', 'Mac');
    auth.setDeviceKey(frank.token!, KEY_A);

    const restarted = new Auth(dir);
    expect(restarted.deviceKeys('frank')).toEqual([{ id: expect.any(String), device: 'Mac', key: KEY_A }]);
  });
});

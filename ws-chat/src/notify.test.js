import { describe, it, expect } from 'vitest';
import { shouldNotify } from '../public/notify.js';

const base = {
  me: 'alice',
  hidden: true,
  enabled: true,
};

const dm = { from: 'bob', to: 'alice', text: 'зайдёшь?' };
const channel = { from: 'bob', channel: 'general', text: 'всем привет' };

describe('shouldNotify', () => {
  it('личное сообщение в свёрнутом окне — повод', () => {
    expect(shouldNotify(dm, base)).toBe(true);
  });

  it('обычное сообщение в канале — не повод: так и до ненависти недалеко', () => {
    expect(shouldNotify(channel, base)).toBe(false);
  });

  it('упоминание в канале — повод', () => {
    expect(shouldNotify({ ...channel, text: 'глянь, @alice' }, base)).toBe(true);
  });

  it('упоминание сверяется без учёта регистра и не цепляет чужие ники', () => {
    expect(shouldNotify({ ...channel, text: 'привет, @ALICE' }, base)).toBe(true);
    expect(shouldNotify({ ...channel, text: 'привет, @alicia' }, base)).toBe(false);
  });

  it('своё же сообщение не тревожит', () => {
    expect(shouldNotify({ ...dm, from: 'alice', to: 'bob' }, base)).toBe(false);
  });

  it('при открытом окне молчим: человек и так смотрит', () => {
    expect(shouldNotify(dm, { ...base, hidden: false })).toBe(false);
  });

  it('выключенные уведомления выключены', () => {
    expect(shouldNotify(dm, { ...base, enabled: false })).toBe(false);
  });

  it('системные строки не тревожат', () => {
    expect(shouldNotify({ ...dm, system: true }, base)).toBe(false);
  });
});

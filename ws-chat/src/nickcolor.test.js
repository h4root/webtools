import { describe, it, expect } from 'vitest';
import { nickHue, nickColor } from '../public/nickcolor.js';

const STEP = 30;

describe('nickHue', () => {
  it('один ник — всегда один тон', () => {
    expect(nickHue('alice')).toBe(nickHue('alice'));
  });

  it('регистр не меняет тон: ники и так сравниваются без регистра', () => {
    expect(nickHue('Alice')).toBe(nickHue('alice'));
  });

  it('тон садится на ступень, а не куда попало', () => {
    for (const nick of ['alice', 'bob', 'дмитрий', '', '😀', 'x'.repeat(64)]) {
      const hue = nickHue(nick);
      expect(hue % STEP).toBe(0);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('ники, различающиеся одним знаком, не садятся рядом', () => {
    // Ради этого в хэше и стоит перемешивание: без него они шли подряд.
    expect(Math.abs(nickHue('user1') - nickHue('user2'))).toBeGreaterThanOrEqual(STEP);
  });

  it('занимает разные ступени, а не жмётся в одну', () => {
    const nicks = ['alice', 'bob', 'carol', 'dave', 'eve', 'mallory', 'trent', 'node47', 'rx0', 'anon'];
    expect(new Set(nicks.map(nickHue)).size).toBeGreaterThan(4);
  });
});

describe('nickColor', () => {
  it('светлота и насыщенность у всех одни, иначе часть ников читалась бы бледнее', () => {
    for (const nick of ['alice', 'bob', 'carol']) {
      expect(nickColor(nick)).toMatch(/^oklch\(0\.84 0\.1 \d+\)$/);
    }
  });
});

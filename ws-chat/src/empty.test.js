import { describe, it, expect } from 'vitest';
import { emptyLogText } from '../public/empty.js';

describe('emptyLogText', () => {
  it('в канале зовёт написать первым и называет сам канал', () => {
    const text = emptyLogText({ kind: 'channel', id: 'general' });
    expect(text).toContain('general');
    expect(text.length).toBeGreaterThan(10);
  });

  it('в личной переписке обращается к собеседнику по имени', () => {
    const text = emptyLogText({ kind: 'dm', id: 'Boris' });
    expect(text).toContain('Boris');
  });

  it('канал и личка звучат по-разному: это разные ситуации', () => {
    expect(emptyLogText({ kind: 'channel', id: 'x' })).not.toBe(emptyLogText({ kind: 'dm', id: 'x' }));
  });

  it('не ломается на пустом адресате', () => {
    expect(typeof emptyLogText({ kind: 'channel', id: '' })).toBe('string');
    expect(typeof emptyLogText({})).toBe('string');
  });
});

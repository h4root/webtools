import { describe, it, expect } from 'vitest';
import { sameGroup } from '../public/grouping.js';

const at = (iso) => new Date(iso).getTime();
const msg = (over = {}) => ({ id: 2, from: 'alice', text: 'вторая', ts: at('2026-08-28T12:00:30'), ...over });
const prev = { id: 1, from: 'alice', text: 'первая', ts: at('2026-08-28T12:00:00') };

describe('sameGroup', () => {
  it('подряд от одного человека — одна группа', () => {
    expect(sameGroup(prev, msg())).toBe(true);
  });

  it('другой автор группу обрывает', () => {
    expect(sameGroup(prev, msg({ from: 'bob' }))).toBe(false);
  });

  it('ник сверяется без учёта регистра: сервер его сохраняет как есть', () => {
    expect(sameGroup(prev, msg({ from: 'Alice' }))).toBe(true);
  });

  it('после долгой паузы это уже другой разговор', () => {
    expect(sameGroup(prev, msg({ ts: at('2026-08-28T12:06:00') }))).toBe(false);
    expect(sameGroup(prev, msg({ ts: at('2026-08-28T12:04:59') }))).toBe(true);
  });

  it('первое сообщение в ленте ни к чему не липнет', () => {
    expect(sameGroup(null, msg())).toBe(false);
  });

  it('системные строки в группы не собираются', () => {
    expect(sameGroup(prev, msg({ system: true }))).toBe(false);
    expect(sameGroup({ ...prev, system: true }, msg())).toBe(false);
  });

  it('ответ начинает группу заново: у него своя цитата сверху', () => {
    expect(sameGroup(prev, msg({ replyTo: { id: 0, from: 'bob', text: 'что?' } }))).toBe(false);
  });
});

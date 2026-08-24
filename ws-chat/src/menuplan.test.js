import { describe, it, expect } from 'vitest';
import { planMenu } from '../public/menuplan.js';

const ids = (plan) => plan.map((item) => (item.separator ? '—' : item.id));

const mine = { id: 5, from: 'alice', text: 'моё сообщение' };
const theirs = { id: 6, from: 'bob', text: 'чужое сообщение' };

describe('planMenu: сообщение', () => {
  it('своё можно править и удалять', () => {
    expect(ids(planMenu({ message: mine, me: 'alice', canCopy: true }))).toEqual([
      'reply',
      'react',
      'copy-text',
      '—',
      'edit',
      'delete',
    ]);
  });

  it('чужое — только ответить, реакция и копирование', () => {
    expect(ids(planMenu({ message: theirs, me: 'alice', canCopy: true }))).toEqual(['reply', 'react', 'copy-text']);
  });

  it('у сообщения без текста копировать нечего', () => {
    const picture = { id: 7, from: 'bob', text: '' };
    expect(ids(planMenu({ message: picture, me: 'alice', canCopy: true }))).toEqual(['reply', 'react']);
  });

  it('у ответа появляется переход к оригиналу', () => {
    const answer = { ...theirs, replyTo: { id: 1, from: 'carol', text: 'начало' } };
    expect(ids(planMenu({ message: answer, me: 'alice', canCopy: true }))).toContain('jump');
  });

  it('системную строку меню не обслуживает', () => {
    expect(planMenu({ message: { id: 0, system: true, text: 'вошёл' }, me: 'alice', canCopy: true })).toEqual([]);
  });
});

describe('planMenu: ник', () => {
  it('чужой ник открывает переписку и упоминание', () => {
    expect(ids(planMenu({ nick: 'bob', me: 'alice', canCopy: true }))).toEqual(['dm', 'mention', 'copy-nick']);
  });

  it('на себе писать самому себе не предлагает', () => {
    expect(ids(planMenu({ nick: 'Alice', me: 'alice', canCopy: true }))).toEqual(['copy-nick']);
  });

  it('ник важнее сообщения: щёлкнули по имени внутри строки', () => {
    expect(ids(planMenu({ message: theirs, nick: 'bob', me: 'alice', canCopy: true }))).toEqual([
      'dm',
      'mention',
      'copy-nick',
    ]);
  });
});

describe('planMenu: копирование', () => {
  it('вне защищённого контекста пунктов копирования нет', () => {
    expect(ids(planMenu({ message: mine, me: 'alice', canCopy: false }))).toEqual(['reply', 'react', '—', 'edit', 'delete']);
    expect(ids(planMenu({ nick: 'bob', me: 'alice', canCopy: false }))).toEqual(['dm', 'mention']);
  });

  it('пустая цель меню не открывает', () => {
    expect(planMenu({ me: 'alice', canCopy: true })).toEqual([]);
  });
});

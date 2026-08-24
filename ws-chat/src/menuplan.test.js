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

describe('planMenu: канал', () => {
  it('текстовый канал открывают, копируют и удаляют', () => {
    expect(ids(planMenu({ channel: { name: 'general', last: false }, me: 'alice', canCopy: true }))).toEqual([
      'open-channel',
      'copy-channel',
      '—',
      'delete-channel',
    ]);
  });

  it('последний канал удалить не предлагают: чату нужен хотя бы один', () => {
    expect(ids(planMenu({ channel: { name: 'general', last: true }, me: 'alice', canCopy: true }))).toEqual([
      'open-channel',
      'copy-channel',
    ]);
  });

  it('голосовой зовёт войти, а тот, где ты сидишь, — выйти', () => {
    const plan = planMenu({ voice: { name: 'games', joined: false }, me: 'alice', canCopy: true });
    expect(ids(plan)).toEqual(['voice-toggle', '—', 'delete-voice']);
    expect(plan[0].label).toBe('Войти');
    expect(planMenu({ voice: { name: 'games', joined: true }, me: 'alice', canCopy: true })[0].label).toBe('Выйти');
  });
});

describe('planMenu: вложение', () => {
  const picture = { url: '/uploads/1', name: 'shot.png', mime: 'image/png' };
  const file = { url: '/uploads/2', name: 'doc.pdf', mime: 'application/pdf' };

  it('картинку открывают в просмотрщике и скачивают', () => {
    expect(ids(planMenu({ attachment: picture, me: 'alice', canCopy: true }))).toEqual([
      'open-image',
      'download',
      'copy-file',
    ]);
  });

  it('у файла открывать нечего', () => {
    expect(ids(planMenu({ attachment: file, me: 'alice', canCopy: true }))).toEqual(['download', 'copy-file']);
  });

  it('вложение важнее сообщения, в котором лежит', () => {
    expect(ids(planMenu({ message: mine, attachment: file, me: 'alice', canCopy: true }))).toEqual([
      'download',
      'copy-file',
    ]);
  });

  it('вне защищённого контекста имя не скопировать', () => {
    expect(ids(planMenu({ attachment: file, me: 'alice', canCopy: false }))).toEqual(['download']);
  });
});

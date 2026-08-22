import { describe, it, expect } from 'vitest';
import { keyOf, targetOf, messageKey } from '../public/keys.js';

describe('keyOf', () => {
  it('канал и личка живут в разных пространствах имён', () => {
    expect(keyOf('channel', 'general')).toBe('ch:general');
    expect(keyOf('dm', 'alice')).toBe('dm:alice');
  });

  it('ник в ключе личной переписки не зависит от регистра', () => {
    expect(keyOf('dm', 'Alice')).toBe(keyOf('dm', 'ALICE'));
  });

  it('имя канала регистр сохраняет: сервер различает', () => {
    expect(keyOf('channel', 'General')).toBe('ch:General');
  });
});

describe('targetOf', () => {
  it('у сообщения канала цель — сам канал', () => {
    expect(targetOf({ channel: 'general', from: 'bob' }, 'alice')).toEqual({ kind: 'channel', id: 'general' });
  });

  it('в чужом сообщении цель — отправитель', () => {
    expect(targetOf({ from: 'bob', to: 'alice' }, 'alice')).toEqual({ kind: 'dm', id: 'bob' });
  });

  it('в своём сообщении цель — получатель', () => {
    expect(targetOf({ from: 'alice', to: 'bob' }, 'alice')).toEqual({ kind: 'dm', id: 'bob' });
  });

  it('свой ник узнаётся без учёта регистра', () => {
    expect(targetOf({ from: 'ALICE', to: 'bob' }, 'alice')).toEqual({ kind: 'dm', id: 'bob' });
  });

  it('переписка с самим собой не сваливается в undefined', () => {
    expect(targetOf({ from: 'alice', to: 'alice' }, 'alice')).toEqual({ kind: 'dm', id: 'alice' });
  });
});

describe('messageKey', () => {
  it('каждая сторона ключует переписку по собеседнику', () => {
    const msg = { from: 'alice', to: 'Bob' };
    expect(messageKey(msg, 'alice')).toBe('dm:bob');
    expect(messageKey(msg, 'Bob')).toBe('dm:alice');
  });

  it('сообщение канала ключуется каналом', () => {
    expect(messageKey({ channel: 'random', from: 'bob' }, 'alice')).toBe('ch:random');
  });
});

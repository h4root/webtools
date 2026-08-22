import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTyping, SHOW_MS, SEND_MS } from '../public/typing.js';

function harness() {
  const sent = [];
  const rendered = [];
  const typing = createTyping({
    send: (m) => sent.push(m),
    onChange: (nicks) => rendered.push(nicks),
  });
  return { typing, sent, rendered };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createTyping: кто печатает', () => {
  it('запоминает пишущего в своём разговоре', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    expect(typing.nicks('ch:general')).toEqual(['bob']);
  });

  it('раскладывает по разговорам, не смешивая', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    typing.receive({ from: 'carol', to: 'alice' });
    expect(typing.nicks('ch:general')).toEqual(['bob']);
    expect(typing.nicks('dm:carol')).toEqual(['carol']);
  });

  it('в личке ключует по отправителю: это и есть твой собеседник', () => {
    const { typing } = harness();
    typing.receive({ from: 'Bob', to: 'alice' });
    expect(typing.nicks('dm:bob')).toEqual(['Bob']);
  });

  it('двое в одном разговоре не затирают друг друга', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    typing.receive({ from: 'carol', channel: 'general' });
    expect(typing.nicks('ch:general')).toEqual(['bob', 'carol']);
  });

  it('повтор от того же не плодит дубль', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    typing.receive({ from: 'bob', channel: 'general' });
    expect(typing.nicks('ch:general')).toEqual(['bob']);
  });
});

describe('createTyping: угасание', () => {
  it('через SHOW_MS пишущий пропадает сам', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    vi.advanceTimersByTime(SHOW_MS + 1);
    expect(typing.nicks('ch:general')).toEqual([]);
  });

  it('новый сигнал продлевает, а не добавляет второй таймер', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    vi.advanceTimersByTime(SHOW_MS - 100);
    typing.receive({ from: 'bob', channel: 'general' });
    vi.advanceTimersByTime(200);
    expect(typing.nicks('ch:general')).toEqual(['bob']);
  });

  it('своё сообщение снимает индикатор сразу', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    typing.clear('ch:general', 'bob');
    expect(typing.nicks('ch:general')).toEqual([]);
  });

  it('сброс уносит всех', () => {
    const { typing } = harness();
    typing.receive({ from: 'bob', channel: 'general' });
    typing.receive({ from: 'carol', to: 'alice' });
    typing.reset();
    expect(typing.nicks('ch:general')).toEqual([]);
    expect(typing.nicks('dm:carol')).toEqual([]);
  });
});

describe('createTyping: отправка', () => {
  it('шлёт в канал и в личку по-разному', () => {
    const { typing, sent } = harness();
    typing.send({ kind: 'channel', id: 'general' });
    vi.advanceTimersByTime(SEND_MS + 1);
    typing.send({ kind: 'dm', id: 'bob' });
    expect(sent).toEqual([
      { type: 'typing', channel: 'general' },
      { type: 'typing', to: 'bob' },
    ]);
  });

  it('не частит: между отправками выдерживается пауза', () => {
    const { typing, sent } = harness();
    typing.send({ kind: 'channel', id: 'general' });
    typing.send({ kind: 'channel', id: 'general' });
    typing.send({ kind: 'channel', id: 'general' });
    expect(sent).toHaveLength(1);

    vi.advanceTimersByTime(SEND_MS + 1);
    typing.send({ kind: 'channel', id: 'general' });
    expect(sent).toHaveLength(2);
  });
});

describe('createTyping: уведомление наружу', () => {
  it('сообщает список для того разговора, что просили', () => {
    const { typing, rendered } = harness();
    typing.watch('ch:general');
    typing.receive({ from: 'bob', channel: 'general' });
    expect(rendered.at(-1)).toEqual(['bob']);
  });

  it('молчит про чужой разговор', () => {
    const { typing, rendered } = harness();
    typing.watch('ch:general');
    const before = rendered.length;
    typing.receive({ from: 'carol', to: 'alice' });
    expect(rendered).toHaveLength(before);
  });
});

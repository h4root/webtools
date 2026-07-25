import { describe, it, expect } from 'vitest';
import { parseClientMessage, SIGNAL_MAX } from './protocol.ts';
import { generateName } from './names.ts';

describe('parseClientMessage', () => {
  it('принимает валидный сигнал', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'signal', to: '2', data: { a: 1 } }))).toEqual({
      type: 'signal',
      to: '2',
      data: { a: 1 },
    });
  });

  it('отклоняет неизвестный тип, пустой to и битый json', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'ping' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'signal', to: '', data: {} }))).toBeNull();
    expect(parseClientMessage('{')).toBeNull();
  });

  it('отклоняет сигнал без data и превышающий лимит размера', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'signal', to: '2' }))).toBeNull();
    const huge = { type: 'signal', to: '2', data: 'x'.repeat(SIGNAL_MAX + 1) };
    expect(parseClientMessage(JSON.stringify(huge))).toBeNull();
  });
});

describe('generateName', () => {
  it('детерминирован и не пустой', () => {
    expect(generateName(1)).toBe(generateName(1));
    expect(generateName(1).length).toBeGreaterThan(0);
  });

  it('различает соседние seed', () => {
    expect(generateName(1)).not.toBe(generateName(2));
  });
});

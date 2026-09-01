import { describe, it, expect } from 'vitest';
import { EMOJI } from '../public/emoji.js';
import { REACTIONS } from './protocol.ts';

describe('палитра реакций', () => {
  // Палитру рисует клиент, а принимает сервер. Разъедутся — часть смайликов
  // будет молча отвергаться: нажал, а реакции нет.
  it('совпадает с тем, что принимает сервер', () => {
    expect(EMOJI).toEqual(REACTIONS);
  });

  it('в ней нет повторов', () => {
    expect(new Set(EMOJI).size).toBe(EMOJI.length);
  });
});

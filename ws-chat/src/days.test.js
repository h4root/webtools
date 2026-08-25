import { describe, it, expect } from 'vitest';
import { sameDay, dayLabel } from '../public/days.js';

const at = (iso) => new Date(iso).getTime();
const now = at('2026-08-24T12:00:00');

describe('sameDay', () => {
  it('утро и вечер одного дня — один день', () => {
    expect(sameDay(at('2026-08-24T00:05:00'), at('2026-08-24T23:55:00'))).toBe(true);
  });

  it('пять минут через полночь — уже разные', () => {
    expect(sameDay(at('2026-08-23T23:58:00'), at('2026-08-24T00:03:00'))).toBe(false);
  });

  it('тот же день год назад — не тот же день', () => {
    expect(sameDay(at('2025-08-24T12:00:00'), now)).toBe(false);
  });
});

describe('dayLabel', () => {
  it('сегодняшнее и вчерашнее называет словами', () => {
    expect(dayLabel(at('2026-08-24T09:00:00'), now)).toBe('Сегодня');
    expect(dayLabel(at('2026-08-23T22:00:00'), now)).toBe('Вчера');
  });

  it('позавчерашнее уже датой, без года', () => {
    expect(dayLabel(at('2026-08-22T10:00:00'), now)).toBe('22 августа');
    expect(dayLabel(at('2026-03-14T10:00:00'), now)).toBe('14 марта');
  });

  it('прошлогоднее — с годом, чтобы не спутать', () => {
    expect(dayLabel(at('2025-12-31T10:00:00'), now)).toBe('31 декабря 2025');
  });

  it('«вчера» считается по календарю, а не по суткам назад', () => {
    // Полночь только что миновала: сообщение часовой давности — вчерашнее.
    const justAfterMidnight = at('2026-08-24T00:30:00');
    expect(dayLabel(at('2026-08-23T23:30:00'), justAfterMidnight)).toBe('Вчера');
  });
});

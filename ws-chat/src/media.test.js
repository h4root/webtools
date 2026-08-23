import { describe, it, expect } from 'vitest';
import { isImage, replyPreview, imagesOf, stepIndex } from '../public/media.js';

const png = { url: '/uploads/1', name: 'shot.png', size: 10, mime: 'image/png' };
const pdf = { url: '/uploads/2', name: 'doc.pdf', size: 20, mime: 'application/pdf' };

describe('isImage', () => {
  it('признаёт только то, что браузер точно покажет сам', () => {
    expect(isImage('image/png')).toBe(true);
    expect(isImage('image/webp')).toBe(true);
    expect(isImage('image/svg+xml')).toBe(false);
    expect(isImage('application/pdf')).toBe(false);
    expect(isImage(undefined)).toBe(false);
  });
});

describe('replyPreview', () => {
  it('текст оригинала показывает как есть', () => {
    expect(replyPreview({ text: 'привет', media: png })).toBe('привет');
  });

  it('без текста называет вид вложения', () => {
    expect(replyPreview({ text: '', media: png })).toBe('Фото');
    expect(replyPreview({ text: '', media: pdf })).toBe('Файл');
  });

  it('без текста и без вложения не оставляет цитату пустой', () => {
    expect(replyPreview({ text: '' })).toBe('Сообщение');
  });
});

describe('imagesOf', () => {
  it('собирает картинки из сообщений по порядку, пропуская прочее', () => {
    const messages = [
      { id: 1, from: 'alice', attachments: [png, pdf] },
      { id: 2, from: 'bob' },
      { id: 3, from: 'carol', attachments: [{ ...png, url: '/uploads/3' }] },
    ];
    expect(imagesOf(messages)).toEqual([
      { att: png, from: 'alice', id: 1 },
      { att: { ...png, url: '/uploads/3' }, from: 'carol', id: 3 },
    ]);
  });

  it('на пустой ленте отдаёт пустой список', () => {
    expect(imagesOf([])).toEqual([]);
  });
});

describe('stepIndex', () => {
  it('ходит по кругу в обе стороны', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });

  it('на пустом списке остаётся на месте', () => {
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});

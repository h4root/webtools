import { describe, it, expect } from 'vitest';
import { isImage, replyPreview } from '../public/media.js';

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

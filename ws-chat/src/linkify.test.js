import { describe, it, expect } from 'vitest';
import { splitText } from '../public/linkify.js';

const kinds = (text) => splitText(text).map((p) => `${p.kind}:${p.value}`);

describe('splitText: ссылки', () => {
  it('обычный текст остаётся одним куском', () => {
    expect(kinds('просто сообщение')).toEqual(['text:просто сообщение']);
  });

  it('узнаёт ссылку целиком', () => {
    expect(kinds('https://example.com/a?b=1#c')).toEqual(['link:https://example.com/a?b=1#c']);
  });

  it('находит ссылку в середине предложения', () => {
    expect(kinds('смотри https://example.com дальше')).toEqual([
      'text:смотри ',
      'link:https://example.com',
      'text: дальше',
    ]);
  });

  it('не забирает знак препинания в конце', () => {
    expect(kinds('вот тут https://example.com/a.')).toEqual(['text:вот тут ', 'link:https://example.com/a', 'text:.']);
    expect(kinds('раз https://example.com, два')).toEqual(['text:раз ', 'link:https://example.com', 'text:, два']);
  });

  it('не забирает закрывающую скобку, но оставляет парную внутри', () => {
    expect(kinds('(см. https://example.com/a)')).toEqual(['text:(см. ', 'link:https://example.com/a', 'text:)']);
    expect(kinds('https://ru.wikipedia.org/wiki/Кот_(значения)')).toEqual([
      'link:https://ru.wikipedia.org/wiki/Кот_(значения)',
    ]);
  });

  it('находит несколько ссылок подряд', () => {
    expect(kinds('http://a.test и https://b.test')).toEqual([
      'link:http://a.test',
      'text: и ',
      'link:https://b.test',
    ]);
  });
});

describe('splitText: что ссылкой не становится', () => {
  it('javascript: и data: остаются текстом', () => {
    expect(kinds('javascript:alert(1)')).toEqual(['text:javascript:alert(1)']);
    expect(kinds('data:text/html,<script>')).toEqual(['text:data:text/html,<script>']);
    expect(kinds('JaVaScRiPt://example.com')).toEqual(['text:JaVaScRiPt://example.com']);
  });

  it('схема без адреса ссылкой не считается', () => {
    expect(kinds('https://')).toEqual(['text:https://']);
  });

  it('голый домен не трогаем: слишком легко ошибиться', () => {
    expect(kinds('зайди на example.com')).toEqual(['text:зайди на example.com']);
  });
});

describe('splitText: упоминания', () => {
  it('узнаёт упоминание', () => {
    expect(kinds('привет @alice')).toEqual(['text:привет ', 'mention:@alice']);
  });

  it('не рвёт ссылку на упоминании', () => {
    expect(kinds('https://example.com/@alice/photos')).toEqual(['link:https://example.com/@alice/photos']);
  });

  it('упоминание и ссылка рядом уживаются', () => {
    expect(kinds('@bob глянь https://example.com')).toEqual([
      'mention:@bob',
      'text: глянь ',
      'link:https://example.com',
    ]);
  });

  it('одинокая собака остаётся текстом', () => {
    expect(kinds('почта @ дома')).toEqual(['text:почта @ дома']);
  });

  it('адрес почты не становится упоминанием', () => {
    expect(kinds('пиши на me@example.com')).toEqual(['text:пиши на me@example.com']);
  });
});

describe('splitText: мелочи', () => {
  it('схема в верхнем регистре тоже ссылка', () => {
    expect(kinds('HTTPS://EXAMPLE.COM/A')).toEqual(['link:HTTPS://EXAMPLE.COM/A']);
  });

  it('перенос строки обрывает ссылку', () => {
    expect(kinds('https://example.com\nдальше')).toEqual(['link:https://example.com', 'text:\nдальше']);
  });

  it('пустой текст ничего не даёт', () => {
    expect(splitText('')).toEqual([]);
  });
});

// Только то, что браузер рисует сам и без сюрпризов: svg умеет исполнять
// скрипты, поэтому картинкой здесь не считается.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);

export function isImage(mime) {
  return INLINE.has(mime);
}

export function replyPreview({ text, media }) {
  if (text) return text;
  if (!media) return 'Сообщение';
  return isImage(media.mime) ? 'Фото' : 'Файл';
}

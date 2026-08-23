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

export function imagesOf(messages) {
  const found = [];
  for (const msg of messages) {
    for (const att of msg.attachments ?? []) {
      if (isImage(att.mime)) found.push({ att, from: msg.from, id: msg.id });
    }
  }
  return found;
}

export function stepIndex(index, count, delta) {
  if (count === 0) return 0;
  return (index + delta + count) % count;
}

import { isImage } from './media.js';

const SEPARATOR = { separator: true };

function nickItems(nick, me, canCopy) {
  const items = [];
  if (nick.toLowerCase() !== me.toLowerCase()) {
    items.push({ id: 'dm', label: 'Написать лично' });
    items.push({ id: 'mention', label: 'Упомянуть' });
  }
  if (canCopy) items.push({ id: 'copy-nick', label: 'Копировать ник' });
  items.push({ id: 'keys', label: 'Ключи устройств' });
  return items;
}

function messageItems(message, me, canCopy) {
  if (message.system) return [];
  const items = [
    { id: 'reply', label: 'Ответить' },
    { id: 'react', label: 'Реакция' },
  ];
  if (message.text && canCopy) items.push({ id: 'copy-text', label: 'Копировать текст' });
  if (message.replyTo) items.push({ id: 'jump', label: 'К оригиналу' });
  if (message.from !== me) return items;
  items.push(SEPARATOR, { id: 'edit', label: 'Изменить' }, { id: 'delete', label: 'Удалить', danger: true });
  return items;
}

function attachmentItems(attachment, canCopy) {
  const items = [];
  if (isImage(attachment.mime)) items.push({ id: 'open-image', label: 'Открыть' });
  items.push({ id: 'download', label: 'Скачать' });
  if (canCopy) items.push({ id: 'copy-file', label: 'Копировать имя' });
  return items;
}

function linkItems(canCopy) {
  const items = [{ id: 'open-link', label: 'Открыть в браузере' }];
  if (canCopy) items.push({ id: 'copy-link', label: 'Копировать адрес' });
  return items;
}

function logItems() {
  return [
    { id: 'mark-read', label: 'Отметить прочитанным' },
    { id: 'find', label: 'Найти сообщение' },
    { id: 'to-bottom', label: 'В конец ленты' },
  ];
}

function channelItems(channel, canCopy) {
  const items = [{ id: 'open-channel', label: 'Открыть' }];
  if (canCopy) items.push({ id: 'copy-channel', label: 'Копировать имя' });
  if (!channel.last) items.push(SEPARATOR, { id: 'delete-channel', label: 'Удалить канал', danger: true });
  return items;
}

function voiceItems(voice) {
  return [
    { id: 'voice-toggle', label: voice.joined ? 'Выйти' : 'Войти' },
    SEPARATOR,
    { id: 'delete-voice', label: 'Удалить канал', danger: true },
  ];
}

export function planMenu({ attachment, link, nick, message, voice, channel, log, me, canCopy }) {
  if (attachment) return attachmentItems(attachment, canCopy);
  if (link) return linkItems(canCopy);
  if (nick) return nickItems(nick, me, canCopy);
  if (message) return messageItems(message, me, canCopy);
  if (voice) return voiceItems(voice);
  if (channel) return channelItems(channel, canCopy);
  if (log) return logItems();
  return [];
}

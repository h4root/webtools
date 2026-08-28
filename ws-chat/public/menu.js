import { planMenu } from './menuplan.js';
import { secureContext } from './format.js';

const EDGE = 8;

// Буфер обмена живёт только в защищённом контексте: по http с телефона его
// просто нет. Пункт, который молча не сработает, хуже отсутствующего.
function canCopy() {
  return secureContext() && Boolean(navigator.clipboard);
}

function nickAt(node) {
  const member = node.closest('.member');
  if (member?.dataset.name) return member.dataset.name;
  const who = node.closest('.who, .rq-who');
  if (who) return who.textContent;
  const mention = node.closest('.mention');
  if (mention) return mention.textContent.replace(/^@/, '');
  return null;
}

export function createContextMenu({ getNick, findMessage, channelCount, voiceCurrent, actions }) {
  let node = null;

  function targetAt(origin) {
    const row = origin.closest('.row[data-id]');
    const message = row ? findMessage(Number(row.dataset.id)) : null;
    const media = origin.closest('.att-image, .att-file');
    const attachment = message?.attachments?.find((att) => att.url === media?.dataset.url) ?? null;
    const link = origin.closest('a.msg-link')?.href ?? null;

    const voiceEl = origin.closest('.voice-chan');
    const voice = voiceEl ? { name: voiceEl.dataset.voice, joined: voiceEl.dataset.voice === voiceCurrent() } : null;

    const item = origin.closest('.channel[data-kind]');
    // Личная переписка в боковой панели — это про человека, а не про канал.
    const nick = item?.dataset.kind === 'dm' ? item.dataset.name : nickAt(origin);
    const channel = item?.dataset.kind === 'channel' ? { name: item.dataset.name, last: channelCount() <= 1 } : null;

    // Лента идёт последней: щелчок по строке — про сообщение, и только мимо
    // строк остаётся сам разговор.
    const log = Boolean(origin.closest('#log'));

    return { message, attachment, link, nick, voice, channel, log, row };
  }

  function close() {
    node?.remove();
    node = null;
  }

  function build(items, context) {
    const box = document.createElement('div');
    box.className = 'ctx-menu';
    for (const item of items) {
      if (item.separator) {
        box.appendChild(document.createElement('hr'));
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.danger ? 'ctx-item danger' : 'ctx-item';
      button.textContent = item.label;
      button.addEventListener('click', () => {
        close();
        actions[item.id](context);
      });
      box.appendChild(button);
    }
    return box;
  }

  // Меню рисуется у курсора, но не вылезает за окно: у нижнего края
  // разворачивается вверх, у правого — влево.
  function place(box, x, y) {
    const { width, height } = box.getBoundingClientRect();
    const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x;
    const top = y + height + EDGE > window.innerHeight ? Math.max(EDGE, y - height) : y;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
  }

  function open(x, y, items, context) {
    close();
    node = build(items, context);
    document.body.appendChild(node);
    place(node, x, y);
  }

  document.addEventListener('contextmenu', (event) => {
    // Внутри полей ввода родное меню полезнее: там правка, вставка и проверка
    // орфографии, которых у нас нет.
    if (event.target.closest('input, textarea')) return;

    const context = targetAt(event.target);
    const items = planMenu({ ...context, me: getNick(), canCopy: canCopy() });
    if (items.length === 0) {
      close();
      return;
    }
    event.preventDefault();
    open(event.clientX, event.clientY, items, context);
  });

  document.addEventListener('click', close);
  document.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  return { close, isOpen: () => Boolean(node) };
}

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

export function createContextMenu({ getNick, findMessage, actions }) {
  let node = null;

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

    const row = event.target.closest('.row[data-id]');
    const context = {
      message: row ? findMessage(Number(row.dataset.id)) : null,
      nick: nickAt(event.target),
      row,
    };
    const items = planMenu({ message: context.message, nick: context.nick, me: getNick(), canCopy: canCopy() });
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

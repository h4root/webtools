const EDGE = 8;

// Заготовка: меню открывается и закрывается по-настоящему, пункты пока
// неактивны. Набор пунктов будет зависеть от того, по чему кликнули.
const PLACEHOLDER = [
  { label: 'Ответить' },
  { label: 'Копировать текст' },
  { label: 'Копировать ссылку' },
  { separator: true },
  { label: 'Изменить' },
  { label: 'Удалить', danger: true },
];

export function createContextMenu() {
  let node = null;

  function close() {
    node?.remove();
    node = null;
  }

  function build(items) {
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
      button.disabled = true;
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

  function open(x, y, items = PLACEHOLDER) {
    close();
    node = build(items);
    document.body.appendChild(node);
    place(node, x, y);
  }

  document.addEventListener('contextmenu', (event) => {
    // Внутри полей ввода родное меню полезнее: там правка, вставка и проверка
    // орфографии, которых у нас пока нет.
    if (event.target.closest('input, textarea')) return;
    event.preventDefault();
    open(event.clientX, event.clientY);
  });

  document.addEventListener('click', close);
  document.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  return { open, close };
}

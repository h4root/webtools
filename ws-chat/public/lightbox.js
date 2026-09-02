import { icon } from './icons.js';
import { formatSize } from './format.js';
import { imagesOf, stepIndex } from './media.js';

export function createLightbox({ getMessages, urlOf }) {
  let items = [];
  let index = 0;
  let root = null;
  let picture = null;
  let caption = null;

  function close() {
    root?.remove();
    root = null;
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(event) {
    if (!root) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'ArrowRight') {
      show(stepIndex(index, items.length, 1));
    } else if (event.key === 'ArrowLeft') {
      show(stepIndex(index, items.length, -1));
    }
  }

  function show(next) {
    index = next;
    const { att, from } = items[index];
    picture.removeAttribute('src');
    picture.alt = att.name;
    urlOf(att).then(
      (url) => {
        if (root && items[index]?.att === att) picture.src = url;
      },
      () => {
        if (root) caption.textContent = `Не удалось загрузить ${att.name}`;
      },
    );
    const where = items.length > 1 ? ` · ${index + 1} из ${items.length}` : '';
    caption.textContent = `${from} · ${att.name} · ${formatSize(att.size)}${where}`;
  }

  function arrow(name, delta) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `lb-arrow lb-${name}`;
    btn.appendChild(icon(name === 'prev' ? 'chevron-left' : 'chevron-right', 22));
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      show(stepIndex(index, items.length, delta));
    });
    return btn;
  }

  function open(att) {
    close();
    items = imagesOf(getMessages());
    const start = items.findIndex((item) => item.att.url === att.url);
    if (start === -1) items = [{ att, from: '' }];

    root = document.createElement('div');
    root.className = 'lightbox';

    picture = document.createElement('img');
    picture.className = 'lb-image';

    caption = document.createElement('div');
    caption.className = 'lb-caption';

    const shut = document.createElement('button');
    shut.type = 'button';
    shut.className = 'lb-close';
    shut.title = 'Закрыть';
    shut.appendChild(icon('cross', 20));
    shut.addEventListener('click', close);

    root.append(picture, caption, shut);
    if (items.length > 1) root.append(arrow('prev', -1), arrow('next', 1));

    root.addEventListener('click', (event) => {
      if (event.target === root) close();
    });
    picture.addEventListener('click', (event) => event.stopPropagation());

    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    show(start === -1 ? 0 : start);
  }

  return { open, close, isOpen: () => Boolean(root) };
}

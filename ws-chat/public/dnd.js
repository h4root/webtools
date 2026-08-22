import { dropHint } from './dom.js';

// Скриншот из буфера и файл, брошенный в окно, — два самых коротких пути
// прикрепить что-то. Оба ведут туда же, куда и скрепка.
export function createDropZone({ isReady, onFiles }) {
  // dragenter и dragleave срабатывают и на дочерних элементах, поэтому считаем
  // вход и выход: одного события хватило бы только на пустой странице.
  let depth = 0;

  function show(visible) {
    if (!visible) depth = 0;
    dropHint.hidden = !visible;
  }

  function hasFiles(event) {
    return [...(event.dataTransfer?.types ?? [])].includes('Files');
  }

  document.addEventListener('paste', (event) => {
    if (!isReady()) return;
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    onFiles(files);
  });

  document.addEventListener('dragenter', (event) => {
    if (!isReady() || !hasFiles(event)) return;
    depth++;
    show(true);
  });

  // Без preventDefault браузер откроет файл вместо того, чтобы отдать его нам.
  document.addEventListener('dragover', (event) => {
    if (!isReady() || !hasFiles(event)) return;
    event.preventDefault();
  });

  document.addEventListener('dragleave', () => {
    if (depth > 0) depth--;
    if (depth === 0) dropHint.hidden = true;
  });

  document.addEventListener('drop', (event) => {
    if (!isReady() || !hasFiles(event)) return;
    event.preventDefault();
    show(false);
    onFiles([...(event.dataTransfer?.files ?? [])]);
  });
}

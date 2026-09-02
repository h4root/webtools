import { dropHint } from './dom.js';

export function createDropZone({ isReady, onFiles }) {
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

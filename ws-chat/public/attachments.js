import { icon } from './icons.js';
import { formatSize } from './format.js';
import { isImage } from './media.js';
import { attachTray } from './dom.js';

const ATTACH_MAX = 10;

export function createAttachments({ getToken, onError, onOpenImage }) {
  const blobUrls = new Map();
  let pending = [];

  function urlOf(att) {
    if (!blobUrls.has(att.url)) {
      blobUrls.set(
        att.url,
        fetch(att.url, { headers: { Authorization: `Bearer ${getToken()}` } })
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
          .then((data) => URL.createObjectURL(new Blob([data], { type: isImage(att.mime) ? att.mime : 'application/octet-stream' })))
          .catch((error) => {
            blobUrls.delete(att.url);
            throw error;
          }),
      );
    }
    return blobUrls.get(att.url);
  }

  function releaseUrls() {
    for (const promise of blobUrls.values()) {
      promise.then(URL.revokeObjectURL, () => {});
    }
    blobUrls.clear();
  }

  function imageLink(att) {
    const link = document.createElement('a');
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'att-image';
    link.dataset.url = att.url;
    const img = document.createElement('img');
    img.alt = att.name;
    img.loading = 'lazy';
    urlOf(att).then(
      (url) => {
        img.src = url;
        link.href = url;
      },
      () => {
        link.replaceChildren(document.createTextNode(`Не удалось загрузить ${att.name}`));
        link.classList.add('att-failed');
      },
    );
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || link.classList.contains('att-failed')) return;
      event.preventDefault();
      onOpenImage(att);
    });
    link.appendChild(img);
    return link;
  }

  function fileLink(att) {
    const link = document.createElement('a');
    link.download = att.name;
    link.className = 'att-file';
    link.dataset.url = att.url;
    urlOf(att).then(
      (url) => {
        link.href = url;
      },
      () => link.classList.add('att-failed'),
    );
    link.appendChild(icon('file', 18));
    const info = document.createElement('span');
    info.className = 'att-info';
    const name = document.createElement('span');
    name.className = 'att-name';
    name.textContent = att.name;
    const size = document.createElement('span');
    size.className = 'att-size';
    size.textContent = formatSize(att.size);
    info.append(name, size);
    link.appendChild(info);
    return link;
  }

  function download(att) {
    urlOf(att).then(
      (url) => {
        const link = document.createElement('a');
        link.href = url;
        link.download = att.name;
        link.click();
      },
      () => onError(`Не удалось загрузить ${att.name}`),
    );
  }

  function render(attachments) {
    const box = document.createElement('div');
    box.className = 'attachments';
    for (const att of attachments) {
      box.appendChild(isImage(att.mime) ? imageLink(att) : fileLink(att));
    }
    return box;
  }

  async function upload(file) {
    const res = await fetch('/upload', {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
        Authorization: `Bearer ${getToken()}`,
      },
      body: file,
    });
    if (!res.ok) throw new Error(res.status === 429 ? 'слишком много загрузок подряд' : `ошибка ${res.status}`);
    return res.json();
  }

  async function add(files) {
    for (const file of files) {
      if (pending.length >= ATTACH_MAX) break;
      try {
        pending.push(await upload(file));
        renderTray();
      } catch (error) {
        onError(`Не удалось загрузить ${file.name}: ${error.message}`);
      }
    }
  }

  function remove(id) {
    pending = pending.filter((a) => a.id !== id);
    renderTray();
  }

  function renderTray() {
    attachTray.replaceChildren();
    for (const att of pending) {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      const name = document.createElement('span');
      name.className = 'ac-name';
      name.textContent = att.name;
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.appendChild(icon('cross', 12));
      drop.addEventListener('click', () => remove(att.id));
      chip.append(name, drop);
      attachTray.appendChild(chip);
    }
  }

  return {
    render,
    urlOf,
    download,
    releaseUrls,
    add,
    pending: () => pending,
    clear() {
      pending = [];
      renderTray();
    },
  };
}

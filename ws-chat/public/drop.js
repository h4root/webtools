import { mountLanDrop } from '/drop-client/lan-drop.js';
import { deviceLabel } from './format.js';
import { dropBtn, dropPanel, dropMount } from './dom.js';

export function createDrop({ getToken, onPendingChange }) {
  let client = null;
  let pending = 0;

  function renderBadge() {
    dropBtn.classList.toggle('pending', pending > 0);
    dropBtn.title = pending > 0 ? `Входящие файлы: ${pending}` : 'Передача файлов';
  }

  function setPending(count) {
    pending = count;
    renderBadge();
    onPendingChange();
  }

  // Соединение живёт всё время, пока ты в чате. Иначе файл можно прислать
  // только в ту минуту, когда панель открыта, — то есть практически никогда.
  function start() {
    if (client) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    client = mountLanDrop(dropMount, {
      url: `${proto}://${location.host}/drop`,
      auth: () => ({ token: getToken(), device: deviceLabel() }),
      emptyHint: 'Никого рядом. Откройте эту панель на другом устройстве — увидите его здесь.',
      onPending: setPending,
    });
  }

  function stop() {
    client?.destroy();
    client = null;
    pending = 0;
    renderBadge();
  }

  function setPanel(open) {
    dropPanel.hidden = !open;
    dropBtn.classList.toggle('active', open);
  }

  return {
    start,
    stop,
    setPanel,
    isOpen: () => !dropPanel.hidden,
    pending: () => pending,
  };
}

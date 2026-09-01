import { settings } from './settings.js';
import { logEl } from './dom.js';
import { EMOJI } from './emoji.js';

const BURST_COUNT = 6;
const BURST_MS = 1150;
const EDGE = 8;

export function createReactions({ send, getNick, findMessage }) {
  let picker = null;

  function rowOf(id) {
    return logEl.querySelector(`[data-id="${id}"]`);
  }

  function toggle(msg, emoji) {
    if (!msg.reactions?.[emoji]?.includes(getNick())) burst(emoji, rowOf(msg.id));
    send({ type: 'react', id: msg.id, emoji });
  }

  // Частицы живут вне ленты и сами себя убирают: внутри строки они ломали бы
  // её высоту и уезжали вместе со скроллом.
  function burst(emoji, row) {
    if (!settings.animationsEnabled() || !row) return;
    const rect = row.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    for (let i = 0; i < BURST_COUNT; i++) {
      const particle = document.createElement('span');
      particle.className = 'reaction-burst';
      particle.textContent = emoji;
      particle.style.left = `${cx}px`;
      particle.style.top = `${rect.bottom}px`;
      particle.style.fontSize = `${22 + Math.random() * 18}px`;
      particle.style.setProperty('--dx', `${(Math.random() - 0.5) * 120}px`);
      particle.style.setProperty('--dy', `${-60 - Math.random() * 90}px`);
      particle.style.setProperty('--rot', `${(Math.random() - 0.5) * 80}deg`);
      document.body.appendChild(particle);
      setTimeout(() => particle.remove(), BURST_MS);
    }
  }

  function render(row, msg, changed = new Set()) {
    row.querySelector('.reactions')?.remove();
    const reactions = msg.reactions;
    if (!reactions || Object.keys(reactions).length === 0) return;

    const box = document.createElement('div');
    box.className = 'reactions';
    for (const [emoji, users] of Object.entries(reactions)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction';
      if (users.includes(getNick())) chip.classList.add('mine');
      if (changed.has(emoji)) chip.classList.add('bump');
      chip.title = users.join(', ');
      const face = document.createElement('span');
      face.textContent = emoji;
      const count = document.createElement('span');
      count.className = 'rcount';
      count.textContent = String(users.length);
      chip.append(face, count);
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle(msg, emoji);
      });
      box.appendChild(chip);
    }
    row.appendChild(box);
  }

  // Подсвечиваем только те эмодзи, у которых изменился счёт: иначе дёргалась бы
  // вся строка на каждое чужое нажатие.
  function apply(id, reactions) {
    const msg = findMessage(id);
    if (!msg) return;
    const old = msg.reactions ?? {};
    const changed = new Set();
    for (const emoji of new Set([...Object.keys(old), ...Object.keys(reactions)])) {
      if ((old[emoji]?.length ?? 0) !== (reactions[emoji]?.length ?? 0)) changed.add(emoji);
    }
    msg.reactions = Object.keys(reactions).length ? reactions : undefined;
    const row = rowOf(id);
    if (row) render(row, msg, changed);
  }

  function close() {
    picker?.remove();
    picker = null;
  }

  function place(node, anchor) {
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(window.innerWidth - node.offsetWidth - EDGE, rect.left + rect.width / 2 - node.offsetWidth / 2));
    let top = rect.top - node.offsetHeight - EDGE;
    if (top < EDGE) top = Math.min(window.innerHeight - node.offsetHeight - EDGE, rect.bottom + EDGE);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  function open(anchor, msg) {
    close();
    const node = document.createElement('div');
    node.className = 'react-picker';
    for (const emoji of EMOJI) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = emoji;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle(msg, emoji);
        close();
      });
      node.appendChild(button);
    }
    document.body.appendChild(node);
    place(node, anchor);
    picker = node;
    // Тот же клик, что открыл палитру, закрыл бы её сразу — вешаем на следующий
    // оборот цикла событий.
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  }

  return { render, apply, open, close, burst };
}

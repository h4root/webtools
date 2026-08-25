import autoAnimate from './vendor/auto-animate.mjs';
import { icon } from './icons.js';
import { settings } from './settings.js';
import { splitText, shortenUrl } from './linkify.js';
import { timeLabel } from './format.js';
import { sameDay, dayLabel } from './days.js';
import { logEl, jumpNewBtn } from './dom.js';

const BOTTOM_SLACK_PX = 80;
const EDIT_MAX = 2000;

export function createLog({ getNick, send, attachments, reactions, quote, onReply, getMessages, onSeen, onRendered }) {
  const animation = autoAnimate(logEl, { duration: 180, disrespectUserMotionPreference: true });
  let missedBelow = 0;
  // Метка времени последней нарисованной строки: по ней видно, что следующая
  // пришла уже в другой день.
  let lastTs = null;

  function applyMotion() {
    if (settings.animationsEnabled()) animation.enable();
    else animation.disable();
  }

  function renderText(parent, text) {
    let mentionsMe = false;
    for (const part of splitText(text)) {
      if (part.kind === 'mention') {
        const span = document.createElement('span');
        span.className = 'mention';
        span.textContent = part.value;
        if (part.value.slice(1).toLowerCase() === getNick().toLowerCase()) {
          span.classList.add('me');
          mentionsMe = true;
        }
        parent.appendChild(span);
      } else if (part.kind === 'link') {
        const link = document.createElement('a');
        link.className = 'msg-link';
        // href присваиваем свойством, а не разметкой, и схему уже проверил
        // splitText — в DOM ничего исполняемого не попадает.
        link.href = part.value;
        link.target = '_blank';
        // noopener обязателен: без него открытая вкладка получает window.opener
        // и может увести исходную страницу куда угодно.
        link.rel = 'noopener noreferrer';
        link.textContent = shortenUrl(part.value);
        link.title = part.value;
        parent.appendChild(link);
      } else {
        parent.appendChild(document.createTextNode(part.value));
      }
    }
    return mentionsMe;
  }

  function actionsOf(row, msg) {
    const actions = document.createElement('span');
    actions.className = 'row-actions';

    const reply = document.createElement('button');
    reply.type = 'button';
    reply.title = 'Ответить';
    reply.appendChild(icon('reply', 14));
    reply.addEventListener('click', (event) => {
      event.stopPropagation();
      onReply(msg);
    });
    actions.appendChild(reply);

    const react = document.createElement('button');
    react.type = 'button';
    react.title = 'Реакция';
    react.appendChild(icon('smiley', 14));
    react.addEventListener('click', (event) => {
      event.stopPropagation();
      reactions.open(react, msg);
    });
    actions.appendChild(react);

    if (!msg.mine) return actions;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = 'Изменить';
    edit.appendChild(icon('pencil', 14));
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      startEdit(row, msg);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.title = 'Удалить';
    del.appendChild(icon('trash', 14));
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      if (confirm('Удалить сообщение?')) send({ type: 'delete', id: msg.id });
    });
    actions.append(edit, del);
    return actions;
  }

  function fillRow(row, msg) {
    row.replaceChildren();
    if (msg.replyTo) row.appendChild(quote.render(msg.replyTo, scrollTo));

    if (!msg.mine) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = msg.from;
      row.appendChild(who);
    }

    let mentionsMe = false;
    if (msg.text) {
      const text = document.createElement('span');
      text.className = 'text';
      mentionsMe = renderText(text, msg.text);
      row.appendChild(text);
    }

    if (msg.attachments?.length) row.appendChild(attachments.render(msg.attachments));

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = (msg.edited ? 'изм. · ' : '') + timeLabel(msg.ts);
    row.appendChild(meta);

    row.classList.toggle('mention', mentionsMe && !msg.mine);
    row.appendChild(actionsOf(row, msg));
    reactions.render(row, msg);
  }

  function daySeparator(ts) {
    const line = document.createElement('div');
    line.className = 'day-sep';
    line.dataset.ts = String(ts);
    const label = document.createElement('span');
    label.textContent = dayLabel(ts, Date.now());
    line.appendChild(label);
    return line;
  }

  // Вкладку не закрывают неделями: с наступлением полуночи вчерашние плашки
  // обязаны перестать говорить «Сегодня».
  function relabelDays() {
    const now = Date.now();
    for (const line of logEl.querySelectorAll('.day-sep')) {
      line.firstChild.textContent = dayLabel(Number(line.dataset.ts), now);
    }
  }

  // Системные строки живут только до перезагрузки и своей даты не имеют:
  // разделитель из-за них появляться не должен.
  function opensNewDay(msg) {
    if (msg.system) return false;
    return lastTs === null || !sameDay(lastTs, msg.ts);
  }

  function createRow(msg) {
    const row = document.createElement('div');
    if (msg.system) {
      row.className = 'row system';
      row.textContent = msg.text;
      return row;
    }
    msg.mine = msg.from === getNick();
    row.className = msg.mine ? 'row mine' : 'row';
    row.dataset.id = String(msg.id);
    fillRow(row, msg);
    return row;
  }

  function startEdit(row, msg) {
    row.replaceChildren();
    const input = document.createElement('input');
    input.className = 'edit-input';
    input.value = msg.text;
    input.maxLength = EDIT_MAX;
    row.appendChild(input);
    input.focus();
    // Перерисовка убирает поле из строки, и оно на прощание шлёт blur. Если
    // обработчик оставить висеть, отрисовка пойдёт по второму кругу изнутри
    // самой себя, и браузер оборвёт её ошибкой.
    const restore = () => {
      input.removeEventListener('blur', restore);
      fillRow(row, msg);
    };
    const commit = () => {
      const value = input.value.trim();
      if (value && value !== msg.text) {
        input.removeEventListener('blur', restore);
        send({ type: 'edit', id: msg.id, text: value });
      } else {
        restore();
      }
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      } else if (event.key === 'Escape') {
        restore();
      }
    });
    input.addEventListener('blur', restore);
  }

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight <= BOTTOM_SLACK_PX;
  }

  function renderJumpNew() {
    jumpNewBtn.hidden = missedBelow === 0;
    if (missedBelow) jumpNewBtn.textContent = `↓ новых: ${missedBelow}`;
  }

  function scrollToBottom() {
    logEl.scrollTop = logEl.scrollHeight;
    missedBelow = 0;
    renderJumpNew();
    onSeen();
  }

  function append(msg) {
    const stick = atBottom() || msg.from === getNick() || msg.system;
    if (opensNewDay(msg)) {
      relabelDays();
      logEl.appendChild(daySeparator(msg.ts));
      lastTs = msg.ts;
    }
    logEl.appendChild(createRow(msg));
    if (stick) {
      scrollToBottom();
    } else {
      missedBelow++;
      renderJumpNew();
    }
  }

  function system(text) {
    append({ id: 0, from: '', text, ts: Date.now(), edited: false, system: true });
  }

  function render() {
    animation.disable();
    logEl.replaceChildren();
    lastTs = null;
    for (const msg of getMessages()) {
      if (opensNewDay(msg)) {
        logEl.appendChild(daySeparator(msg.ts));
        lastTs = msg.ts;
      }
      logEl.appendChild(createRow(msg));
    }
    missedBelow = 0;
    scrollToBottom();
    applyMotion();
    onRendered();
  }

  function edit(msg) {
    const row = rowOf(msg.id);
    if (row) startEdit(row, msg);
  }

  function rowOf(id) {
    return logEl.querySelector(`[data-id="${id}"]`);
  }

  function update(msg) {
    const row = rowOf(msg.id);
    if (row) fillRow(row, msg);
  }

  function remove(id) {
    rowOf(id)?.remove();
  }

  function clear() {
    logEl.replaceChildren();
    lastTs = null;
  }

  function scrollTo(id) {
    const row = rowOf(id);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }

  jumpNewBtn.addEventListener('click', scrollToBottom);
  logEl.addEventListener('scroll', () => {
    if (missedBelow && atBottom()) {
      missedBelow = 0;
      renderJumpNew();
    }
  });
  settings.onMotionChange(applyMotion);
  applyMotion();

  return { render, append, system, update, remove, clear, scrollTo, rowOf, edit };
}

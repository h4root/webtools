import autoAnimate from './vendor/auto-animate.mjs';
import { icon } from './icons.js';
import { settings } from './settings.js';
import { splitText, shortenUrl } from './linkify.js';
import { timeLabel } from './format.js';
import { sameDay, dayLabel } from './days.js';
import { sameGroup, avatarHue } from './grouping.js';
import { logEl, logEmpty, jumpNewBtn } from './dom.js';

const BOTTOM_SLACK_PX = 80;
const EDIT_MAX = 2000;

export function createLog({ getNick, send, attachments, reactions, quote, onReply, getMessages, emptyText, onSeen, onRendered }) {
  const animation = autoAnimate(logEl, { duration: 180, disrespectUserMotionPreference: true });
  let missedBelow = 0;
  let lastTs = null;
  let lastMsg = null;

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
        link.href = part.value;
        link.target = '_blank';
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

  function actionsOf(msg) {
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

    return actions;
  }

  function fillRow(row, msg) {
    row.replaceChildren();
    if (msg.replyTo) row.appendChild(quote.render(msg.replyTo, scrollTo));

    if (!msg.mine && !msg.grouped) {
      const who = document.createElement('span');
      who.className = 'who';
      who.style.color = `hsl(${avatarHue(msg.from)} 55% 68%)`;
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
    row.appendChild(actionsOf(msg));
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

  function relabelDays() {
    const now = Date.now();
    for (const line of logEl.querySelectorAll('.day-sep')) {
      line.firstChild.textContent = dayLabel(Number(line.dataset.ts), now);
    }
  }

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
    if (msg.grouped) row.classList.add('grouped');
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
    showEmpty(false);
    const stick = atBottom() || msg.from === getNick() || msg.system;
    const opensDay = opensNewDay(msg);
    if (opensDay) {
      relabelDays();
      logEl.appendChild(daySeparator(msg.ts));
      lastTs = msg.ts;
    }
    msg.grouped = !opensDay && sameGroup(lastMsg, msg);
    if (!msg.system) lastMsg = msg;
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

  function showEmpty(on) {
    logEmpty.hidden = !on;
    if (on) logEmpty.textContent = emptyText();
  }

  function render() {
    animation.disable();
    logEl.replaceChildren();
    lastTs = null;
    lastMsg = null;
    const messages = getMessages();
    showEmpty(messages.length === 0);
    for (const msg of messages) {
      const opensDay = opensNewDay(msg);
      if (opensDay) {
        logEl.appendChild(daySeparator(msg.ts));
        lastTs = msg.ts;
      }
      msg.grouped = !opensDay && sameGroup(lastMsg, msg);
      lastMsg = msg;
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
    showEmpty(false);
    logEl.replaceChildren();
    lastTs = null;
    lastMsg = null;
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

  return { render, append, system, update, remove, clear, scrollTo, scrollToBottom, rowOf, edit };
}

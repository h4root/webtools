import { icon } from './icons.js';
import { keyOf } from './keys.js';
import { isOnline, orderDms } from './roster.js';
import { avatarHue } from './grouping.js';
import { channelListEl, dmListEl, membersListEl } from './dom.js';

export function deleteButton(question, onConfirm) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chan-del';
  btn.title = 'Удалить';
  btn.appendChild(icon('cross', 12));
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    if (confirm(question)) onConfirm();
  });
  return btn;
}

export function createNav({ getState, send, onOpen }) {
  function navItem(kind, id, label, offline = false) {
    const { active, unread, channels } = getState();
    const key = keyOf(kind, id);
    const item = document.createElement('li');
    item.dataset.kind = kind;
    item.dataset.name = id;
    const isActive = kind === active.kind && id.toLowerCase() === active.id.toLowerCase();
    item.className = isActive ? 'channel active' : 'channel';
    if (offline) item.classList.add('offline');

    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);

    const count = unread.get(key) ?? 0;
    if (count > 0 && !isActive) {
      item.classList.add('unread');
      const badge = document.createElement('span');
      badge.className = 'badge';
      // Четырёхзначный счётчик растянул бы строку и вытеснил имя канала.
      badge.textContent = count > 99 ? '99+' : String(count);
      item.appendChild(badge);
    }

    if (kind === 'channel' && channels.length > 1) {
      item.appendChild(deleteButton(`Удалить канал #${id} вместе с историей?`, () => send({ type: 'channel-delete', name: id })));
    }

    item.addEventListener('click', () => onOpen(kind, id));
    return item;
  }

  function renderChannels() {
    const state = getState();
    channelListEl.replaceChildren();
    for (const name of state.channels) {
      channelListEl.appendChild(navItem('channel', name, `# ${name}`));
    }
    dmListEl.replaceChildren();
    for (const nick of orderDms(state)) {
      dmListEl.appendChild(navItem('dm', nick, `@ ${nick}`, !isOnline(nick, state)));
    }
  }

  function memberRow(nick) {
    const { me } = getState();
    const row = document.createElement('div');
    row.className = 'member';
    row.dataset.nick = nick.toLowerCase();
    row.dataset.name = nick;
    const av = document.createElement('span');
    av.className = 'm-avatar';
    av.style.setProperty('--hue', avatarHue(nick));
    av.textContent = nick.slice(0, 1).toUpperCase();
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = nick === me ? `${nick} (вы)` : nick;
    row.append(av, name);
    if (nick !== me) row.addEventListener('click', () => onOpen('dm', nick));
    return row;
  }

  function memberGroup(label, nicks, iconName) {
    const wrap = document.createElement('div');
    wrap.className = 'member-group';
    const head = document.createElement('div');
    head.className = 'member-head';
    if (iconName) head.appendChild(icon(iconName, 13));
    const text = document.createElement('span');
    text.textContent = `${label} — ${nicks.length}`;
    head.appendChild(text);
    wrap.appendChild(head);
    for (const nick of nicks) wrap.appendChild(memberRow(nick));
    return wrap;
  }

  function renderMembers() {
    const { me, online, voicePresence } = getState();
    membersListEl.replaceChildren();
    const inVoice = new Set();
    for (const [ch, nicks] of Object.entries(voicePresence)) {
      if (!nicks.length) continue;
      for (const n of nicks) inVoice.add(n.toLowerCase());
      membersListEl.appendChild(memberGroup(ch, nicks, 'sound-on'));
    }
    const rest = [me, ...online]
      .filter((n, i, arr) => arr.indexOf(n) === i && !inVoice.has(n.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    membersListEl.appendChild(memberGroup('В сети', rest));
  }

  function applySpeaking(nicks) {
    const set = new Set(nicks.map((n) => n.toLowerCase()));
    for (const row of membersListEl.querySelectorAll('.member')) {
      row.classList.toggle('speaking', set.has(row.dataset.nick));
    }
  }

  return { renderChannels, renderMembers, applySpeaking };
}
